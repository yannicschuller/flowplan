import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import * as Y from "yjs";

// AI on whiteboards (components/whiteboard/ai-panel.tsx) against a mock
// OpenAI-compatible provider: notes grouped by theme (one undo step), a
// summary page, a mind map from a description, cancelling a slow request,
// and notes → database records (with "Mit KI aufteilen") that a second
// person sees live as record cards. A person who switched AI off sees no
// AI entry but can still turn notes into records.

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const shots = process.env.WB_AI_SCREENSHOTS || "";
test.setTimeout(180_000);

type Mock = { base: string; slow: boolean; requests: string[]; close: () => Promise<void> };
async function startMock(): Promise<Mock> {
  const mock: Mock = { base: "", slow: false, requests: [], close: async () => {} };
  const answer = (system: string, prompt: string) => {
    if (system.includes("group the sticky notes")) {
      const refs = [...prompt.matchAll(/^(n\d+): (.*)$/gm)];
      const speed = refs.filter(([, , text]) => /langsam|dauern|warten/i.test(text)).map(([, ref]) => ref);
      return JSON.stringify({ groups: [{ theme: "Geschwindigkeit", notes: speed }, { theme: "Zusammenarbeit", notes: refs.map(([, ref]) => ref).filter((r) => !speed.includes(r)) }] });
    }
    if (system.includes("summarise the content of a whiteboard"))
      return JSON.stringify({
        summary: "Das Team will schneller werden und mehr zusammenarbeiten.",
        themes: [{ title: "Geschwindigkeit", points: ["Builds und Tests sind langsam"] }],
        decisions: ["Die Pipeline wird parallelisiert"],
        questions: ["Wer bezahlt zusätzliche Runner?"],
        actions: [{ text: "Runner bestellen", owner: null, due: null }],
      });
    if (system.includes("create a mind map"))
      return JSON.stringify({ root: { text: "Sommerfest", children: [{ text: "Essen", children: [{ text: "Grill" }] }, { text: "Musik" }, { text: "Spiele" }] } });
    if (system.includes("turn sticky notes"))
      return JSON.stringify({ records: [...prompt.matchAll(/^(n\d+): /gm)].map(([, ref]) => ({ note: ref, cells: { Priorität: "Hoch" } })) });
    return "- ok";
  };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      if (!req.url?.endsWith("/chat/completions")) {
        res.writeHead(404).end();
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const messages = (body.messages || []) as { role: string; content: string }[];
      const system = messages.find((m) => m.role === "system")?.content || "";
      const prompt = messages.filter((m) => m.role !== "system").map((m) => m.content).join("\n");
      mock.requests.push(system.slice(0, 60));
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (mock.slow) await new Promise((r) => setTimeout(r, 15_000));
      if (res.destroyed) return;
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: answer(system, prompt) } }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  mock.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  mock.close = () => new Promise((resolve) => server.close(() => resolve()));
  return mock;
}

async function commander(page: Page) {
  return async (data: Record<string, unknown>) => {
    const r = await page.request.post("/api/command", { headers: { origin }, data });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  };
}
// A signed-in person (an instance administrator) in the workspace.
async function person(browser: import("@playwright/test").Browser, workspaceId: string, name: string, viewport: { width: number; height: number } | null, options: { admin?: boolean; dark?: boolean; mobile?: boolean } = {}) {
  const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  db.exec("PRAGMA busy_timeout=5000;");
  const uid = randomUUID(),
    token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO users(id,subject,name,email,onboarded_at) VALUES(?,?,?,?,?)").run(uid, `wb-ai:${uid}`, name, `${uid}@test.invalid`, Date.now());
  db.prepare("INSERT INTO members VALUES(?,?,?)").run(workspaceId, uid, "editor");
  db.prepare("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)").run(
    createHash("sha256").update(token).digest("hex"),
    uid,
    JSON.stringify(options.admin ? ["flowplan-admins"] : []),
    Date.now() + 3600_000,
  );
  db.close();
  const context: BrowserContext = await browser.newContext({
    viewport: viewport || undefined,
    locale: "de-DE",
    extraHTTPHeaders: { "Accept-Language": "de-DE,de;q=0.9" },
    colorScheme: options.dark ? "dark" : "light",
    ...(options.mobile ? { isMobile: true, hasTouch: true } : {}),
  });
  await context.addCookies([{ name: "flowplan_session", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
  return { context, page: await context.newPage(), uid };
}

// "Alles anzeigen" (⇧1): the generated content sits next to the notes.
async function showAll(page: Page) {
  await page.getByLabel("Whiteboard", { exact: true }).focus();
  await page.keyboard.press("Shift+Digit1");
}

const notes = [
  ["Builds dauern zu lange", "#ffc9c9"],
  ["Tests sind langsam", "#ffc9c9"],
  ["Mehr Pairing", "#b2f2bb"],
  ["Gemeinsames Frühstück", "#b2f2bb"],
  ["Warten auf Reviews", "#fff6b6"],
  ["Retro öfter machen", "#fff6b6"],
] as const;
// The board's notes, written like an edit from the browser.
async function seedBoard(command: (data: Record<string, unknown>) => Promise<{ state: string }>, page: Page, boardId: string, author: string) {
  const data = await (await page.request.get(`/api/pages/${boardId}`)).json();
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Buffer.from(data.whiteboard.state, "base64"));
  const before = Y.encodeStateVector(doc);
  const items = doc.getMap<Y.Map<unknown>>("items");
  notes.forEach(([text, fill], i) => {
    const m = new Y.Map<unknown>();
    for (const [key, value] of Object.entries({ type: "sticky", text, fill, author, x: (i % 3) * 190, y: Math.floor(i / 3) * 150, w: 160, h: 120, z: i + 1 })) m.set(key, value);
    items.set(randomUUID(), m);
  });
  await command({ action: "whiteboard.sync", pageId: boardId, generation: data.whiteboard.generation, update: Buffer.from(Y.encodeStateAsUpdate(doc, before)).toString("base64") });
}

test("AI on the whiteboard: themes, summary page, mind map, cancel, notes → records", async ({ page, browser }, info) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "Needs the isolated test data directory");
  test.skip(info.project.name === "mobile", "Desktop run; the phone layout is the next test");
  const errors: string[] = [];
  const mock = await startMock();
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const demoCommand = await commander(page);
  const tag = Date.now();
  const folder = await demoCommand({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Workshops ${tag}`, kind: "document" });
  const board = await demoCommand({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, parentId: folder.id, title: `Retro ${tag}`, kind: "whiteboard" });
  const db = await demoCommand({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Backlog ${tag}`, kind: "database", starterTemplate: "tasks" });
  await demoCommand({ action: "profile.onboarded" });
  // (On an instance with demo mode this is a demo account: no AI either.)
  if (!boot.user.demo) await demoCommand({ action: "ai.settings", enabled: false });
  const ada = await person(browser, boot.workspace.id, "Ada Admin", { width: 1440, height: 1000 }, { admin: true });
  ada.page.on("pageerror", (e) => errors.push(e.message));
  const command = await commander(ada.page);
  await seedBoard(command, ada.page, board.id, ada.uid);
  await command({ action: "admin.ai", settings: { enabled: true, provider: { kind: "openai", baseUrl: mock.base, model: "mock-model", embeddingModel: "" } } });
  try {
    // AI switched off for the first person: no AI entry, but notes → records works.
    await page.goto(`/#page=${board.id}`);
    const demoBoard = page.getByLabel("Whiteboard", { exact: true });
    await expect(demoBoard.locator(".wb-sticky")).toHaveCount(6, { timeout: 60_000 });
    await expect(demoBoard.getByRole("button", { name: "KI", exact: true })).toHaveCount(0);

    await ada.page.goto(`${origin}/#page=${board.id}`);
    const wb = ada.page.getByLabel("Whiteboard", { exact: true });
    await expect(wb.locator(".wb-sticky")).toHaveCount(6, { timeout: 60_000 });

    // 1. Group by theme: nothing selected → the notes in view.
    await wb.getByRole("button", { name: "KI", exact: true }).click();
    const dialog = ada.page.getByRole("dialog", { name: "KI auf dem Whiteboard" });
    await expect(dialog.getByText(/Daten gehen an 127\.0\.0\.1|lokal/)).toBeVisible();
    if (shots) await ada.page.screenshot({ path: `${shots}/menu-desktop-light.png` });
    await dialog.getByRole("button", { name: /Nach Thema gruppieren/ }).click();
    // (The first request also compiles the route in development.)
    await expect(wb.locator("g.wb-item.wb-text", { hasText: "Geschwindigkeit" })).toBeVisible({ timeout: 45_000 });
    await expect(wb.locator("g.wb-item.wb-text", { hasText: "Zusammenarbeit" })).toBeVisible();
    const slow = (await wb.locator(".wb-sticky", { hasText: "Tests sind langsam" }).boundingBox())!;
    const builds = (await wb.locator(".wb-sticky", { hasText: "Builds dauern" }).boundingBox())!;
    const pairing = (await wb.locator(".wb-sticky", { hasText: "Mehr Pairing" }).boundingBox())!;
    expect(Math.abs(slow.x - builds.x)).toBeLessThan(2);
    expect(pairing.x).toBeGreaterThan(slow.x + slow.width);
    await expect(ada.page.locator(".toast")).toContainText("in 2 Themen gruppiert");
    if (shots) await ada.page.screenshot({ path: `${shots}/cluster-desktop-light.png` });
    // One undo step takes headings and positions back.
    await wb.getByRole("button", { name: "Rückgängig", exact: true }).click();
    await expect(wb.locator("g.wb-item.wb-text")).toHaveCount(0);
    await wb.getByRole("button", { name: "Wiederholen", exact: true }).click();
    await expect(wb.locator("g.wb-item.wb-text")).toHaveCount(2);

    // 2. A mind map from a description, at the view centre.
    await wb.getByRole("button", { name: "KI", exact: true }).click();
    await dialog.getByRole("button", { name: /Mit KI erzeugen/ }).click();
    const create = ada.page.getByRole("dialog", { name: "Mit KI erzeugen …" });
    await create.getByLabel("Beschreibung").fill("Ideen für unser Sommerfest");
    await create.getByRole("button", { name: "Erzeugen" }).click();
    await expect(wb.locator("g.wb-item.wb-shape", { hasText: "Sommerfest" })).toBeVisible({ timeout: 20_000 });
    await expect(wb.locator("g.wb-item.wb-shape")).toHaveCount(5);
    await expect(wb.locator("g.wb-item.wb-connector")).toHaveCount(4);
    if (shots) await ada.page.screenshot({ path: `${shots}/mindmap-desktop-light.png` });
    await ada.page.keyboard.press("Escape");
    // One undo step removes the whole mind map again.
    await wb.getByRole("button", { name: "Rückgängig", exact: true }).click();
    await expect(wb.locator("g.wb-item.wb-shape")).toHaveCount(0);
    await expect(wb.locator("g.wb-item.wb-connector")).toHaveCount(0);

    // 3. Cancel: a slow answer is stopped, nothing changes.
    mock.slow = true;
    await wb.getByRole("button", { name: "KI", exact: true }).click();
    await dialog.getByRole("button", { name: /Mit KI erzeugen/ }).click();
    await create.getByLabel("Beschreibung").fill("Noch eine Mindmap");
    await create.getByRole("button", { name: "Erzeugen" }).click();
    await expect(create.getByRole("status")).toContainText("Mindmap");
    await create.getByRole("button", { name: "Abbrechen" }).click();
    await expect(create.getByRole("status")).toHaveCount(0);
    await expect(create.getByRole("button", { name: "Erzeugen" })).toBeVisible();
    await create.getByRole("button", { name: "Abbrechen" }).click();
    await expect(wb.locator("g.wb-item.wb-shape")).toHaveCount(0);
    mock.slow = false;

    // 4. Summary page next to the board, with tasks.
    await wb.getByRole("button", { name: "KI", exact: true }).click();
    await dialog.getByRole("button", { name: /Zusammenfassen als Seite/ }).click();
    const summary = ada.page.getByRole("dialog", { name: "Zusammenfassen als Seite" });
    await expect(summary.getByLabel(/Aufgaben übernehmen/)).toBeChecked();
    if (shots) await ada.page.screenshot({ path: `${shots}/summary-dialog-desktop-light.png` });
    await summary.getByRole("button", { name: "Seite erstellen" }).click();
    await expect(summary.getByText(/wurde neben dem Board angelegt/)).toBeVisible({ timeout: 20_000 });
    await expect(summary.getByText("1 Themen · 1 Entscheidungen · 1 offene Fragen · 1 Aufgaben")).toBeVisible();
    await summary.getByRole("button", { name: "Seite öffnen" }).click();
    const editor = ada.page.locator(".ProseMirror").first();
    await expect(editor).toContainText("Entscheidungen");
    await expect(editor).toContainText("Die Pipeline wird parallelisiert");
    await expect(editor.locator(`a[href="/#page=${board.id}"]`)).toBeVisible();
    await expect(editor.locator("li", { hasText: "Runner bestellen" }).getByRole("checkbox")).toBeVisible();
    if (shots) await ada.page.screenshot({ path: `${shots}/summary-page-desktop-light.png` });
    const tree = await (await ada.page.request.get("/api/bootstrap")).json();
    const created = tree.pages.find((p: { title: string }) => p.title === `Zusammenfassung: Retro ${tag}`);
    expect(created?.parent_id).toBe(folder.id);

    // 5. Notes → records with "Mit KI aufteilen"; the demo person sees the cards live.
    await ada.page.goto(`${origin}/#page=${board.id}`);
    await expect(wb.locator(".wb-sticky")).toHaveCount(6);
    await showAll(ada.page);
    await wb.locator(".wb-sticky", { hasText: "Tests sind langsam" }).click();
    await ada.page.keyboard.down("Shift");
    await wb.locator(".wb-sticky", { hasText: "Builds dauern" }).click();
    await ada.page.keyboard.up("Shift");
    await wb.getByRole("button", { name: "Als Einträge in Datenbank …" }).click();
    const records = ada.page.getByRole("dialog", { name: "Als Einträge in Datenbank …" });
    await expect(records.getByText("2 Zettel werden zu Einträgen.")).toBeVisible();
    await records.getByRole("radio", { name: `Backlog ${tag}` }).check();
    await records.getByLabel("Eigenschaft für den Autor").selectOption({ label: "Verantwortlich" });
    await records.getByLabel(/Mit KI aufteilen/).check();
    await records.getByRole("button", { name: "Vorschau mit KI" }).click();
    await expect(records.getByRole("list", { name: "Vorschau" })).toContainText("Priorität: Hoch");
    if (shots) await ada.page.screenshot({ path: `${shots}/records-desktop-light.png` });
    await records.getByRole("button", { name: "2 Einträge anlegen" }).click();
    await expect(ada.page.locator(".toast")).toContainText(`2 Einträge in „Backlog ${tag}“ angelegt.`);
    await expect(wb.locator(".wb-row-card")).toHaveCount(2);
    await expect(wb.locator(".wb-sticky")).toHaveCount(4);
    await expect(demoBoard.locator(".wb-row-card")).toHaveCount(2, { timeout: 15_000 });
    await expect(demoBoard.locator(".wb-row-card", { hasText: "Tests sind langsam" })).toBeVisible({ timeout: 15_000 });
    const rows = (await (await ada.page.request.get(`/api/pages/${db.id}`)).json()).rows as { cells: Record<string, unknown> }[];
    const made = rows.filter((r) => ["Tests sind langsam", "Builds dauern zu lange"].includes(String(r.cells.title)));
    expect(made).toHaveLength(2);
    for (const row of made) expect(row.cells).toMatchObject({ priority: "Hoch", assignee: ada.uid });
    await expect(wb.getByText("Gespeichert", { exact: true })).toBeVisible({ timeout: 10_000 });

    // The person without AI turns a note into a record.
    await demoBoard.locator(".wb-sticky", { hasText: "Mehr Pairing" }).click();
    await demoBoard.getByRole("button", { name: "Als Einträge in Datenbank …" }).click();
    const demoRecords = page.getByRole("dialog", { name: "Als Einträge in Datenbank …" });
    await demoRecords.getByRole("radio", { name: `Backlog ${tag}` }).check();
    await expect(demoRecords.getByLabel(/Mit KI aufteilen/)).toHaveCount(0);
    await demoRecords.getByRole("radio", { name: "Behalten und verknüpfen" }).check();
    await demoRecords.getByRole("button", { name: "1 Eintrag anlegen" }).click();
    await expect(demoBoard.locator(".wb-row-card")).toHaveCount(3, { timeout: 15_000 });
    await expect(demoBoard.locator(".wb-sticky", { hasText: "Mehr Pairing" })).toBeVisible();

    // Dark mode.
    if (shots) {
      const dark = await person(browser, boot.workspace.id, "Dora Dunkel", { width: 1440, height: 1000 }, { dark: true });
      await dark.page.goto(`${origin}/#page=${board.id}`);
      const darkBoard = dark.page.getByLabel("Whiteboard", { exact: true });
      await expect(darkBoard.locator(".wb-row-card")).toHaveCount(3, { timeout: 15_000 });
      await dark.page.screenshot({ path: `${shots}/board-desktop-dark.png` });
      await darkBoard.getByRole("button", { name: "KI", exact: true }).click();
      await dark.page.screenshot({ path: `${shots}/menu-desktop-dark.png` });
      await dark.page.getByRole("dialog").getByRole("button", { name: /Zusammenfassen als Seite/ }).click();
      await dark.page.screenshot({ path: `${shots}/summary-dialog-desktop-dark.png` });
      await dark.page.keyboard.press("Escape");
      await darkBoard.locator(".wb-sticky", { hasText: "Retro öfter" }).click();
      await darkBoard.getByRole("button", { name: "Als Einträge in Datenbank …" }).click();
      await dark.page.getByRole("dialog").getByRole("radio", { name: `Backlog ${tag}` }).check();
      await dark.page.getByRole("dialog").getByLabel("Eigenschaft für die Farbe").selectOption({ label: "Status" });
      await dark.page.screenshot({ path: `${shots}/records-desktop-dark.png` });
      await dark.page.keyboard.press("Escape");
      await darkBoard.getByRole("button", { name: "KI", exact: true }).click();
      await dark.page.getByRole("dialog").getByRole("button", { name: /Mit KI erzeugen/ }).click();
      await dark.page.screenshot({ path: `${shots}/generate-desktop-dark.png` });
      await dark.context.close();
    }
    expect(errors).toEqual([]);
  } finally {
    await command({ action: "admin.ai", settings: { enabled: false } }).catch(() => {});
    await ada.context.close();
    await mock.close();
  }
});

test("AI on the whiteboard on a phone: from the tool sheet, as a bottom sheet", async ({ page, browser }, info) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "Needs the isolated test data directory");
  test.skip(info.project.name !== "mobile", "Phone layout");
  const mock = await startMock();
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const demoCommand = await commander(page);
  const board = await demoCommand({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Handy-Board ${Date.now()}`, kind: "whiteboard" });
  await demoCommand({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Handy-Backlog ${Date.now()}`, kind: "database", starterTemplate: "tasks" });
  for (const dark of [false, true]) {
    const ada = await person(browser, boot.workspace.id, dark ? "Dora Dunkel" : "Ada Admin", { width: 390, height: 844 }, { admin: true, dark, mobile: true });
    const command = await commander(ada.page);
    if (!dark) await seedBoard(command, ada.page, board.id, ada.uid);
    await command({ action: "admin.ai", settings: { enabled: true, provider: { kind: "openai", baseUrl: mock.base, model: "mock-model", embeddingModel: "" } } });
    try {
      await ada.page.goto(`${origin}/#page=${board.id}`);
      const wb = ada.page.getByLabel("Whiteboard", { exact: true });
      await expect(wb.locator(".wb-sticky").first()).toBeVisible({ timeout: 60_000 });
      await wb.getByRole("button", { name: "Weitere Werkzeuge" }).click();
      await ada.page.getByRole("dialog", { name: "Weitere Werkzeuge" }).getByRole("button", { name: "KI", exact: true }).click();
      const dialog = ada.page.getByRole("dialog", { name: "KI auf dem Whiteboard" });
      await expect(dialog.getByRole("button", { name: /Mit KI erzeugen/ })).toBeVisible();
      const box = (await dialog.boundingBox())!;
      expect(box.width).toBeLessThanOrEqual(390);
      if (shots) await ada.page.screenshot({ path: `${shots}/menu-phone-${dark ? "dark" : "light"}.png` });
      if (!dark) {
        await dialog.getByRole("button", { name: /Nach Thema gruppieren/ }).click();
        await expect(wb.locator("g.wb-item.wb-text", { hasText: "Geschwindigkeit" })).toBeVisible({ timeout: 30_000 });
        if (shots) await ada.page.screenshot({ path: `${shots}/cluster-phone-light.png` });
        await wb.getByRole("button", { name: "Weitere Werkzeuge" }).click();
        await ada.page.getByRole("dialog", { name: "Weitere Werkzeuge" }).getByRole("button", { name: "KI", exact: true }).click();
      }
      await dialog.getByRole("button", { name: /Mit KI erzeugen/ }).click();
      const create = ada.page.getByRole("dialog", { name: "Mit KI erzeugen …" });
      await create.getByLabel("Beschreibung").fill("Ideen für unser Sommerfest");
      if (shots) await ada.page.screenshot({ path: `${shots}/generate-phone-${dark ? "dark" : "light"}.png` });
      if (!dark) {
        await create.getByRole("button", { name: "Erzeugen" }).click();
        await expect(wb.locator("g.wb-item.wb-shape", { hasText: "Sommerfest" })).toBeVisible({ timeout: 20_000 });
        if (shots) await ada.page.screenshot({ path: `${shots}/mindmap-phone-light.png` });
        // Undo takes the mind map away again (it covers the notes).
        await wb.getByRole("button", { name: "Rückgängig", exact: true }).click();
        await expect(wb.locator("g.wb-item.wb-shape")).toHaveCount(0);
      } else await ada.page.keyboard.press("Escape");
      // Records on the phone.
      await showAll(ada.page);
      await wb.locator(".wb-sticky").first().click();
      await wb.getByRole("button", { name: "Als Einträge in Datenbank …" }).click();
      const records = ada.page.getByRole("dialog", { name: "Als Einträge in Datenbank …" });
      await expect(records.getByText(/wird zu einem Eintrag/)).toBeVisible();
      await expect(records.getByRole("radiogroup", { name: "Ziel-Datenbank" }).getByRole("radio").first()).toBeAttached();
      await expect(records.getByText("Wird geladen …")).toHaveCount(0);
      const width = await ada.page.evaluate(() => document.documentElement.scrollWidth);
      expect(width).toBeLessThanOrEqual(390);
      if (shots) await ada.page.screenshot({ path: `${shots}/records-phone-${dark ? "dark" : "light"}.png` });
    } finally {
      await command({ action: "admin.ai", settings: { enabled: false } }).catch(() => {});
      await ada.context.close();
    }
  }
  await mock.close();
});
