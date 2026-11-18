import { test, expect, type Browser, type Page, type TestInfo } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { diagramPng } from "../helpers/png";

// Flashcards on a public link (docs/specs/flashcards.md §7.3): a published
// deck shows its cards to browse (a click turns one) and to practise
// without an account – the state in localStorage under
// flowplan-study:<token>, no cookie, nothing sent to the server; the
// one-time note with "Fortschritt löschen". Private records and
// properties with a read rule stay out, pictures come through the share,
// a signed-in member gets "In Flowplan lernen", a password protects the
// cards like everything else of the link. "In Flowplan lernen" starts the
// session of the view in the app (#340); without JavaScript a card turns
// with <details>.
// PUBLIC_STUDY_SCREENSHOTS=<dir> keeps pictures (light and dark).
const shots = process.env.PUBLIC_STUDY_SCREENSHOTS || "";
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

async function deck(page: Page, title: string, space?: "private") {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const spaceId = space ? (await command({ action: "space.create", workspaceId: boot.workspace.id, name: `Privat ${Date.now()}`, private: true })).id : boot.spaces[0].id;
  const { id: pageId } = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId, title, kind: "database", databaseKind: "flashcards" });
  const row = async (cells: Record<string, unknown>) => (await command({ action: "row.create", pageId, cells })).id as string;
  await row({ title: "¿Dónde está la estación?", back: "Wo ist der Bahnhof?" });
  await row({ title: "Me llamo {{c1::Ana}} y vivo en {{c2::Madrid}}.", back: "", type: "Lückentext" });
  await row({ title: "gracias", back: "danke", type: "Antwort eintippen" });
  const secret = await row({ title: "Nur für mich", back: "geheim" });
  const pictured = await row({ title: "Welche Region ist markiert?", back: "Aus dem Atlas", type: "Bildverdeckung" });
  const upload = await page.request.post("/api/upload", { headers: { origin }, multipart: { pageId, file: { name: "atlas.png", mimeType: "image/png", buffer: diagramPng() } } });
  expect(upload.ok()).toBe(true);
  const { url } = await upload.json();
  const masks = { v: 1, mode: "hide-all", masks: [{ id: "a1", shape: "rect", x: 0.07, y: 0.17, w: 0.28, h: 0.44, label: "Nordregion" }, { id: "a2", shape: "ellipse", x: 0.41, y: 0.55, w: 0.32, h: 0.34, label: "Süden" }] };
  const attr = JSON.stringify(masks).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const current = await (await page.request.get(`/api/pages/${pageId}/rows/${pictured}`)).json();
  const { htmlState } = await import("../../lib/document-server");
  await command({ action: "row.document.sync", pageId, rowId: pictured, generation: current.generation, update: Buffer.from(htmlState(`<p>Karte der Regionen</p><img src="${url}" alt="Karte" data-occlusion="${attr}">`)).toString("base64") });
  await command({ action: "row.access", pageId, rowId: secret, access: "private", grants: [] });
  return { command, pageId, boot };
}

test("a published deck: browse, practise in the browser only, delete the progress", async ({ page, browser }, info) => {
  const { command, pageId } = await deck(page, `Spanisch ${info.project.name} ${Date.now()}`);
  await command({ action: "page.publish", pageId, enabled: true });
  const token = (await (await page.request.get(`/api/pages/${pageId}`)).json()).page.public_token as string;

  // A signed-in member is offered the deck in Flowplan.
  await page.goto(`/share/${token}`);
  await expect(page.getByRole("link", { name: "In Flowplan lernen" })).toHaveAttribute("href", new RegExp(`^/#page=${pageId}&view=[\\w-]+&study=1$`));
  // With the script the cards turn with their button, not <details>.
  await expect(page.locator(".public-flashcard-turn").first()).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".public-flashcard-reveal")).toHaveCount(0);

  const context = await browser.newContext({ ...(info.project.use.viewport ? { viewport: info.project.use.viewport } : {}), isMobile: info.project.name === "mobile", hasTouch: info.project.name === "mobile", locale: "de-DE" });
  const visitor = await context.newPage();
  const errors: string[] = [];
  visitor.on("pageerror", (e) => errors.push(e.message));
  await visitor.goto(`${origin}/share/${token}`);
  const cards = visitor.locator(".public-flashcard");
  // A card, two clozes, a typed one and two masks; the private record not.
  await expect(cards).toHaveCount(6);
  await expect(visitor.getByRole("link", { name: "In Flowplan lernen" })).toHaveCount(0);
  await expect(visitor.locator("body")).not.toContainText("Nur für mich");
  await expect(visitor.locator(".public-flashcard .occlusion-card img").first()).toHaveAttribute("src", new RegExp(`^/api/share/${token}/files/`));
  // A click turns a card over.
  const first = cards.first();
  await expect(first).not.toContainText("Wo ist der Bahnhof?");
  await first.click();
  await expect(first).toContainText("Wo ist der Bahnhof?");
  await expect(first.getByRole("button", { name: "Vorderseite" })).toHaveAttribute("aria-pressed", "true");
  if (shots) await visitor.screenshot({ path: `${shots}/fc7-browse-${info.project.name}-light.png`, fullPage: true });

  // Practising sends nothing: only the cards are loaded.
  const requests: string[] = [];
  visitor.on("request", (r) => {
    if (new URL(r.url()).pathname.startsWith("/api/")) requests.push(`${r.method()} ${new URL(r.url()).pathname}${new URL(r.url()).search}`);
  });
  await visitor.getByRole("button", { name: "Üben" }).click();
  const focus = visitor.getByRole("dialog", { name: /^Lernen: / });
  await expect(focus.locator(".public-study-note")).toContainText("Dein Fortschritt bleibt nur in diesem Browser. Flowplan speichert nichts davon.");
  if (shots) await visitor.screenshot({ path: `${shots}/fc7-practice-${info.project.name}-light.png` });
  await focus.getByRole("button", { name: "Verstanden" }).click();
  await expect(focus.locator(".public-study-note")).toHaveCount(0);
  for (let i = 0; i < 3; i++) {
    const card = focus.locator(".study-card");
    await expect(card).toBeVisible();
    if (await focus.locator(".study-typed-input").count()) await focus.locator(".study-typed-input").fill("danke");
    await focus.getByRole("button", { name: /^(Antwort zeigen|Prüfen)/ }).click();
    if (i === 0 && shots) await visitor.screenshot({ path: `${shots}/fc7-practice-revealed-${info.project.name}-light.png` });
    await focus.getByRole("button", { name: /^Gut/ }).click();
  }
  await expect(focus.locator(".study-progress")).toHaveAttribute("value", "3");
  expect(requests.every((r) => r.startsWith(`GET /api/share/${token}?study=1`)), requests.join("\n")).toBe(true);
  expect(requests.length).toBe(1);
  const stored = await visitor.evaluate((key) => localStorage.getItem(key), `flowplan-study:${token}`);
  const progress = JSON.parse(stored || "{}");
  expect(progress.noted).toBe(true);
  expect(progress.decks[pageId].reviews).toHaveLength(3);
  expect(await context.cookies()).toEqual([]);
  // Undo takes the last rating back in the browser.
  await visitor.keyboard.press("z");
  await expect(focus.locator(".study-progress")).toHaveAttribute("value", "2");
  await visitor.keyboard.press("Escape");
  await expect(focus).toHaveCount(0);

  // Again: the note does not come back, the state is there.
  await visitor.getByRole("button", { name: "Üben" }).click();
  await expect(focus.locator(".study-card")).toBeVisible();
  await expect(focus.locator(".public-study-note")).toHaveCount(0);
  await visitor.keyboard.press("Escape");
  // "Fortschritt löschen" removes it.
  await visitor.getByRole("button", { name: "Fortschritt löschen" }).click();
  expect(await visitor.evaluate((key) => localStorage.getItem(key), `flowplan-study:${token}`)).toBeNull();
  await expect(visitor.getByRole("button", { name: "Fortschritt löschen" })).toHaveCount(0);

  if (shots) {
    await visitor.emulateMedia({ colorScheme: "dark" });
    await visitor.reload();
    await visitor.locator(".public-flashcard").first().click();
    await visitor.screenshot({ path: `${shots}/fc7-browse-${info.project.name}-dark.png`, fullPage: true });
    await visitor.getByRole("button", { name: "Üben" }).click();
    await expect(focus.locator(".public-study-note")).toBeVisible();
    await visitor.screenshot({ path: `${shots}/fc7-practice-${info.project.name}-dark.png` });
    await focus.getByRole("button", { name: "Verstanden" }).click();
    await focus.getByRole("button", { name: /^Antwort zeigen/ }).click();
    await visitor.screenshot({ path: `${shots}/fc7-practice-revealed-${info.project.name}-dark.png` });
  }
  expect(errors).toEqual([]);
  await context.close();
});

test("a share link with a password: the cards only after it, practice included", async ({ page, browser }, info) => {
  const { command, pageId } = await deck(page, `Geschützt ${info.project.name} ${Date.now()}`);
  const { token } = await command({ action: "share.create", pageId, role: "viewer", name: "Kurs", password: "lernen-123" });
  // The card index is refused without the unlock cookie.
  const anonymous = await browser.newContext();
  expect((await anonymous.request.get(`${origin}/api/share/${token}?study=1&pageId=${pageId}`)).status()).toBe(401);
  await anonymous.close();

  const context = await browser.newContext({ ...(info.project.use.viewport ? { viewport: info.project.use.viewport } : {}), isMobile: info.project.name === "mobile", hasTouch: info.project.name === "mobile", locale: "de-DE" });
  const visitor = await context.newPage();
  await visitor.goto(`${origin}/share/${token}`);
  await expect(visitor.getByRole("heading", { name: "Passwort erforderlich" })).toBeVisible();
  await expect(visitor.locator(".public-flashcard")).toHaveCount(0);
  await visitor.getByLabel("Passwort").fill("lernen-123");
  await visitor.getByRole("button", { name: "Öffnen" }).click();
  await expect(visitor.locator(".public-flashcard")).toHaveCount(6);
  await visitor.getByRole("button", { name: "Üben" }).click();
  const focus = visitor.getByRole("dialog", { name: /^Lernen: / });
  await expect(focus.locator(".study-card")).toBeVisible();
  await focus.getByRole("button", { name: /^(Antwort zeigen|Prüfen)/ }).click();
  await expect(focus.locator(".study-ratings")).toBeVisible();
  // The link's end: the cards are gone with the page.
  await command({ action: "share.protect", pageId, token, expiresAt: Date.now() + 1500 });
  await visitor.waitForTimeout(1600);
  expect((await visitor.request.get(`${origin}/api/share/${token}?study=1&pageId=${pageId}`)).status()).toBe(410);
  await context.close();
});

// A browser context for another person or device, like the project's.
const contextFor = (browser: Browser, info: TestInfo, extra: Parameters<Browser["newContext"]>[0] = {}) =>
  browser.newContext({ ...(info.project.use.viewport ? { viewport: info.project.use.viewport } : {}), isMobile: info.project.name === "mobile", hasTouch: info.project.name === "mobile", locale: "de-DE", ...extra });

test("\"In Flowplan lernen\" starts the session of the view with the person's own state", async ({ page }, info) => {
  const title = `Lernlink ${info.project.name} ${Date.now()}`;
  const { command, pageId } = await deck(page, title);
  await command({ action: "page.publish", pageId, enabled: true });
  const token = (await (await page.request.get(`/api/pages/${pageId}`)).json()).page.public_token as string;
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`/share/${token}`);
  await page.getByRole("link", { name: "In Flowplan lernen" }).click();
  const focus = page.getByRole("dialog", { name: `Lernen: ${title}` });
  await expect(focus.locator(".study-card")).toBeVisible();
  // The view leaves the address: a reload does not start again.
  await expect.poll(() => new URL(page.url()).hash).toBe(`#page=${pageId}`);
  // The rating is the person's own, on the server.
  if (await focus.locator(".study-typed-input").count()) await focus.locator(".study-typed-input").fill("danke");
  await focus.getByRole("button", { name: /^(Antwort zeigen|Prüfen)/ }).click();
  const rated = page.waitForResponse((r) => r.url().endsWith("/api/command") && (r.request().postData() || "").includes('"study.review"'));
  await focus.getByRole("button", { name: /^Gut/ }).click();
  expect((await rated).ok()).toBe(true);
  await focus.getByRole("button", { name: "Sitzung beenden" }).click();
  await expect(focus).toHaveCount(0);
  await expect(page.locator(".study-overview .study-today")).toBeVisible();
  await page.reload();
  await expect(page.locator(".study-overview .study-today")).toBeVisible();
  await expect(focus).toHaveCount(0);

  // A view that is gone: the deck's study view without a session, a note.
  await page.goto(`/#page=${pageId}&view=gone&study=1`);
  await expect(page.getByText("Diese Ansicht gibt es nicht mehr – die Datenbank ist geöffnet.")).toBeVisible();
  await expect(page.locator(".study-overview .study-today")).toBeVisible();
  await expect(focus).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).hash).toBe(`#page=${pageId}`);
  expect(errors).toEqual([]);
});

test("\"In Flowplan lernen\" needs read access: no link and no session for a member outside the deck's space", async ({ page, browser }, info) => {
  const { command, pageId, boot } = await deck(page, `Privat ${info.project.name} ${Date.now()}`, "private");
  await command({ action: "page.publish", pageId, enabled: true });
  const token = (await (await page.request.get(`/api/pages/${pageId}`)).json()).page.public_token as string;
  await page.goto(`/share/${token}`);
  const href = (await page.getByRole("link", { name: "In Flowplan lernen" }).getAttribute("href"))!;
  // Another member of the workspace, outside the private space.
  const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  db.exec("PRAGMA busy_timeout=5000;");
  const other = randomUUID();
  db.prepare("INSERT INTO users(id,subject,name,email,onboarded_at) VALUES(?,?,?,?,?)").run(other, `self:${other}`, "Ole Ohne", `${other}@example.test`, Date.now());
  db.prepare("INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,'editor')").run(boot.workspace.id, other);
  const session = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)").run(createHash("sha256").update(session).digest("hex"), other, "[]", Date.now() + 600000);
  db.close();
  const context = await contextFor(browser, info, { storageState: { cookies: [], origins: [{ origin: new URL(origin).origin, localStorage: [{ name: "flowplan-offline-offer", value: "never" }] }] } });
  await context.addCookies([{ name: "flowplan_session", value: session, url: origin, httpOnly: true, sameSite: "Lax" }]);
  try {
    const visitor = await context.newPage();
    await visitor.goto(`${origin}/share/${token}`);
    await expect(visitor.locator(".public-flashcard")).toHaveCount(6);
    await expect(visitor.getByRole("link", { name: "In Flowplan lernen" })).toHaveCount(0);
    // The link itself: the page does not open, no session starts.
    const opened = visitor.waitForResponse((r) => new URL(r.url()).pathname === `/api/pages/${pageId}`);
    await visitor.goto(`${origin}/?workspace=${boot.workspace.id}${href.slice(1)}`);
    expect((await opened).ok()).toBe(false);
    await visitor.waitForTimeout(1000);
    await expect(visitor.getByRole("dialog", { name: /^Lernen: / })).toHaveCount(0);
    await expect(visitor.locator(".study-overview")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("without JavaScript a card turns with <details>", async ({ page, browser }, info) => {
  const { command, pageId } = await deck(page, `Ohne Skript ${info.project.name} ${Date.now()}`);
  await command({ action: "page.publish", pageId, enabled: true });
  const token = (await (await page.request.get(`/api/pages/${pageId}`)).json()).page.public_token as string;
  const context = await contextFor(browser, info, { javaScriptEnabled: false });
  try {
    const visitor = await context.newPage();
    await visitor.goto(`${origin}/share/${token}`);
    const cards = visitor.locator(".public-flashcard");
    await expect(cards).toHaveCount(6);
    const first = cards.first();
    await expect(first.getByText("Wo ist der Bahnhof?")).toBeHidden();
    await first.locator("summary").click();
    await expect(first.getByText("Wo ist der Bahnhof?")).toBeVisible();
    // A cloze shows its answers on the back.
    const cloze = cards.filter({ hasText: "Me llamo" }).first();
    await cloze.locator("summary").click();
    await expect(cloze.locator(".public-flashcard-back")).toContainText("Madrid");
    if (shots) await visitor.screenshot({ path: `${shots}/fc7-nojs-${info.project.name}-light.png`, fullPage: true });
  } finally {
    await context.close();
  }
});
