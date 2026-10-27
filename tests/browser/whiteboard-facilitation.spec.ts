import { test, expect, type Page } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { join } from "node:path";
import * as Y from "yjs";

// Workshop facilitation with two people: private mode, planning poker,
// timer music and "Alle zu mir holen" (components/whiteboard/facilitation.tsx).
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const shots = process.env.FACILITATION_SHOTS;

test("two people: private brainstorming, planning poker, gathering and timer music", async ({ page, browser }, info) => {
  test.skip(info.project.name === "mobile", "Two people with mouse gestures; the phone layout has its own test");
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "Needs the isolated test data directory");
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const r = await page.request.post("/api/command", { headers: { origin }, data });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  };
  await command({ action: "profile.onboarded" });
  const board = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Workshop ${Date.now()}`, kind: "whiteboard" });
  // A frame for the brainstorming and a note to estimate.
  const data = await (await page.request.get(`/api/pages/${board.id}`)).json();
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Buffer.from(data.whiteboard.state, "base64"));
  const before = Y.encodeStateVector(doc);
  const add = (props: Record<string, unknown>) => {
    const map = new Y.Map<unknown>();
    for (const [k, v] of Object.entries(props)) map.set(k, v);
    doc.getMap("items").set(randomUUID(), map);
  };
  add({ type: "frame", x: 0, y: 0, w: 640, h: 420, z: -1, text: "Ideen" });
  add({ type: "sticky", x: 760, y: 120, w: 180, h: 180, z: 1, text: "Login per Passkey" });
  await command({ action: "whiteboard.sync", pageId: board.id, generation: data.whiteboard.generation, update: Buffer.from(Y.encodeStateAsUpdate(doc, before)).toString("base64") });

  // Mira joins as a second person.
  const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  const uid = randomUUID(),
    token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO users(id,subject,name,email,onboarded_at) VALUES(?,?,?,?,?)").run(uid, uid, "Mira Moderation", `${uid}@test.invalid`, Date.now());
  db.prepare("INSERT INTO members VALUES(?,?,?)").run(boot.workspace.id, uid, "editor");
  db.prepare("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)").run(createHash("sha256").update(token).digest("hex"), uid, "[]", Date.now() + 3600000);
  db.close();
  const context = await browser.newContext({ viewport: page.viewportSize(), locale: "de-DE" });
  await context.addCookies([{ name: "flowplan_session", value: token, url: origin }]);
  const mira = await context.newPage();
  mira.on("pageerror", (e) => errors.push(e.message));

  await page.goto(`/#page=${board.id}`);
  await mira.goto(`${origin}/#page=${board.id}`);
  const wb = (p: Page) => p.getByLabel("Whiteboard", { exact: true });
  await expect(wb(page).locator(".wb-frame")).toBeVisible();
  await expect(wb(mira).locator(".wb-frame")).toBeVisible();

  // ---- private mode in the frame ----
  await wb(page).getByRole("button", { name: "Privater Modus", exact: true }).click();
  const panel = wb(page).getByRole("dialog", { name: "Privater Modus" });
  await panel.getByLabel("Bereich").selectOption({ label: "Rahmen: Ideen" });
  await panel.getByRole("button", { name: "Privaten Modus starten" }).click();
  await expect(wb(page).locator(".wb-private-banner")).toContainText("Privater Modus");
  await expect(wb(mira).locator(".wb-private-banner")).toContainText("im Rahmen „Ideen“", { timeout: 8000 });
  // Mira writes a note in the frame: only she sees it.
  const frame = (await wb(mira).locator(".wb-frame").boundingBox())!;
  await wb(mira).getByRole("button", { name: "Notizzettel", exact: true }).click();
  await mira.mouse.click(frame.x + frame.width / 3, frame.y + frame.height / 2);
  await mira.keyboard.type("Geheime Idee von Mira");
  await mira.keyboard.press("Escape");
  await expect(wb(mira).locator(".wb-sticky", { hasText: "Geheime Idee von Mira" })).toBeVisible();
  await expect(wb(mira).locator(".wb-private-mine")).toHaveCount(1);
  await expect(wb(page).locator(".wb-private-banner")).toContainText("1 verdeckte Beiträge von anderen", { timeout: 8000 });
  await expect(wb(page).locator(".wb-private-placeholders rect")).toHaveCount(1);
  expect(await page.content()).not.toContain("Geheime Idee");
  // A reload keeps her note (private, still hidden for Mara).
  await mira.reload();
  await expect(wb(mira).locator(".wb-sticky", { hasText: "Geheime Idee von Mira" })).toBeVisible({ timeout: 8000 });
  if (shots) {
    await page.screenshot({ path: `${shots}/private-mode-facilitator.png` });
    await mira.screenshot({ path: `${shots}/private-mode-participant.png` });
  }
  // Reveal: both see it, Mira hears about it.
  await wb(page).locator(".wb-private-banner").getByRole("button", { name: "Aufdecken" }).click();
  await expect(wb(page).locator(".wb-sticky", { hasText: "Geheime Idee von Mira" })).toBeVisible({ timeout: 8000 });
  await expect(wb(mira).locator(".wb-fac-notice")).toContainText("Aufgedeckt: 1 Beiträge", { timeout: 8000 });
  await expect(wb(mira).locator(".wb-private-banner")).toHaveCount(0);
  await expect(wb(mira).locator(".wb-private-mine")).toHaveCount(0);

  // ---- planning poker ----
  await wb(page).locator(".wb-sticky", { hasText: "Login per Passkey" }).click();
  await wb(page).locator(".wb-style-bar").getByRole("button", { name: "Schätzen" }).click();
  await wb(page).getByRole("dialog", { name: "Schätzen" }).getByRole("button", { name: "Schätzen starten" }).click();
  const poker = (p: Page) => wb(p).getByRole("region", { name: "Schätzen" });
  await expect(poker(mira)).toContainText("Login per Passkey", { timeout: 8000 });
  await poker(mira).getByRole("button", { name: "5", exact: true }).click();
  await expect(poker(mira).getByRole("button", { name: "5", exact: true })).toHaveAttribute("aria-pressed", "true");
  await poker(page).getByRole("button", { name: "8", exact: true }).click();
  await expect(poker(page)).toContainText("2 haben geschätzt", { timeout: 8000 });
  // Hidden: nobody's card shows before the reveal.
  await expect(poker(page).locator(".wb-poker-votes")).toHaveCount(0);
  if (shots) await page.screenshot({ path: `${shots}/estimation-voting.png` });
  await poker(page).getByRole("button", { name: "Karten aufdecken" }).click();
  await expect(poker(mira).locator(".wb-poker-votes")).toContainText("Mira Moderation 5", { timeout: 8000 });
  await expect(poker(mira)).toContainText("Median 6,5");
  await expect(poker(mira)).toContainText("Kein Konsens");
  if (shots) await mira.screenshot({ path: `${shots}/estimation-revealed.png` });
  await poker(page).getByLabel("Ergebnis").selectOption("8");
  await poker(page).getByRole("button", { name: "Ergebnis übernehmen" }).click();
  await expect(wb(mira).locator(".wb-sticky", { hasText: "Login per Passkey" }).locator(".wb-estimate-tag")).toHaveText("8", { timeout: 8000 });
  await poker(page).getByRole("button", { name: "Fertig" }).click();
  await expect(poker(mira)).toHaveCount(0, { timeout: 8000 });

  // ---- Alle zu mir holen ----
  const canvas = wb(mira).locator(".wb-canvas");
  const area = (await canvas.boundingBox())!;
  await mira.mouse.move(area.x + area.width / 2, area.y + area.height / 2);
  await mira.mouse.wheel(4000, 3000);
  await expect(wb(mira).locator(".wb-frame")).not.toBeInViewport();
  await wb(page).getByRole("button", { name: "Alle zu mir holen" }).click();
  const notice = wb(mira).locator(".wb-fac-notice");
  await expect(notice).toContainText("hat alle hierher geholt", { timeout: 8000 });
  await expect(wb(mira).locator(".wb-frame")).toBeInViewport();
  await notice.getByRole("button", { name: "Zurück" }).click();
  await expect(wb(mira).locator(".wb-frame")).not.toBeInViewport();

  // ---- timer music: started with the timer for everyone ----
  await wb(page).getByRole("button", { name: "Timer", exact: true }).click();
  await wb(page).getByLabel("Musik während des Timers").selectOption("calm");
  await wb(page).getByRole("dialog", { name: "Timer einstellen" }).getByRole("button", { name: "1 Min" }).click();
  // Mira has not touched the page since: the browser may block sound – then "Ton an".
  await expect(wb(mira).locator(".wb-timer .wb-music button")).toBeVisible({ timeout: 8000 });
  await wb(mira).locator(".wb-timer .wb-music button").click();
  await expect(wb(mira).locator(".wb-timer").getByRole("button", { name: /Musik: Lautstärke/ })).toBeVisible();
  if (shots) await mira.screenshot({ path: `${shots}/timer-music.png` });
  await wb(page).getByRole("button", { name: "Timer beenden" }).click();
  await expect(wb(mira).locator(".wb-music")).toHaveCount(0, { timeout: 8000 });

  expect(errors).toEqual([]);
  await context.close();
  await command({ action: "page.delete", pageId: board.id });
});

test("phone: the private mode banner and the estimation panel fit the screen", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "Phone layout");
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const post = (data: Record<string, unknown>) => page.request.post("/api/command", { headers: { origin }, data }).then((r) => r.json());
  await post({ action: "profile.onboarded" });
  const board = await post({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Handy ${Date.now()}`, kind: "whiteboard" });
  const data = await (await page.request.get(`/api/pages/${board.id}`)).json();
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Buffer.from(data.whiteboard.state, "base64"));
  const map = new Y.Map<unknown>();
  const key = randomUUID();
  for (const [k, v] of Object.entries({ type: "sticky", x: 0, y: 0, w: 180, h: 180, z: 1, text: "Suche" })) map.set(k, v);
  doc.getMap("items").set(key, map);
  await post({ action: "whiteboard.sync", pageId: board.id, generation: data.whiteboard.generation, update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64") });
  const api = (body: Record<string, unknown>) => page.request.post(`/api/whiteboards/${board.id}/facilitation`, { headers: { origin }, data: body });
  expect((await api({ action: "private.start" })).ok()).toBe(true);
  expect((await api({ action: "estimate.start", items: [key], deck: { kind: "tshirt", values: ["XS", "S", "M", "L", "XL"] } })).ok()).toBe(true);
  await page.goto(`/#page=${board.id}`);
  const wb = page.getByLabel("Whiteboard", { exact: true });
  await expect(wb.locator(".wb-private-banner")).toBeVisible();
  const poker = wb.getByRole("region", { name: "Schätzen" });
  await expect(poker).toBeVisible();
  await poker.getByRole("button", { name: "M", exact: true }).click();
  await expect(poker.getByRole("button", { name: "M", exact: true })).toHaveAttribute("aria-pressed", "true");
  const width = page.viewportSize()!.width;
  for (const el of [wb.locator(".wb-private-banner"), poker]) {
    const box = (await el.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  if (shots) await page.screenshot({ path: `${shots}/phone.png` });
  await post({ action: "page.delete", pageId: board.id });
});
