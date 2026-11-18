import { test, expect, type Page } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";

// Flashcards (docs/specs/flashcards.md): a database becomes a deck in the
// setup dialog, the view "Lernen" counts what is left today within the daily
// limits, and the focus mode studies with the keyboard (desktop) or by
// swiping (phone), with undo. A reader studies with their own learning
// state but cannot change the mapping.
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

async function signedIn(page: Page) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  return { boot, command };
}
// Swipes the revealed card (mouse pointer events, as the card listens to
// pointer events of any kind).
async function swipe(page: Page, dx: number, dy: number) {
  const box = (await page.locator(".study-card").boundingBox())!;
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(x + (dx * i) / 8, y + (dy * i) / 8);
  await page.mouse.up();
}

test("a database is set up as a deck and studied with keys or swipes, with limits and undo", async ({ page }, info) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { boot, command } = await signedIn(page);
  const mobile = info.project.name === "mobile";
  const created = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Vokabeln ${info.project.name} ${Date.now()}`, kind: "database", databaseKind: "empty" });
  const pageId = created.id as string;
  const db = (await (await page.request.get(`/api/pages/${pageId}`)).json()).database;
  await command({
    action: "database.update",
    pageId,
    version: db.version,
    fields: [
      { id: "title", name: "Wort", type: "text" },
      { id: "answer", name: "Übersetzung", type: "text" },
    ],
    views: [
      { id: "study", name: "Lernen", type: "study", filters: [], sorts: [], default: true },
      { id: "table", name: "Tabelle", type: "table", filters: [], sorts: [] },
    ],
  });
  for (const [word, answer] of [["hola", "hallo"], ["perro", "Hund"], ["gato", "Katze"]]) await command({ action: "row.create", pageId, cells: { title: word, answer } });

  await page.goto(`/#page=${pageId}`);
  // No mapping yet: the setup opens with a suggestion (first two texts).
  const setup = page.getByRole("dialog", { name: "Karten einrichten" });
  await expect(setup).toBeVisible();
  await expect(setup.getByRole("combobox", { name: "Vorderseite", exact: true })).toHaveValue("field:title");
  await expect(setup.getByRole("combobox", { name: "Rückseite", exact: true })).toHaveValue("field:answer");
  await expect(setup).toContainText("3 Einträge → 3 Karten");
  await setup.getByLabel("Neue Karten pro Tag").fill("2");
  await setup.getByRole("button", { name: "Speichern" }).click();
  await expect(setup).toBeHidden();

  // The daily limit: two of three new cards today.
  const today = page.locator(".study-today");
  await expect(today.locator(".study-count.new strong")).toHaveText("2");
  await expect(page.locator(".study-deck")).toContainText("3 Karten");
  await page.getByRole("button", { name: "Lernen starten" }).click();
  const focus = page.getByRole("dialog", { name: /^Lernen: / });
  await expect(focus).toBeVisible();
  await expect(focus.getByRole("region", { name: "Karte 1 von 2" })).toContainText("hola");
  await expect(focus.locator(".study-focus-count.new b")).toHaveText("2");
  if (mobile) await focus.locator(".study-card").click();
  else await page.keyboard.press("Space");
  await expect(focus.locator(".study-back")).toContainText("hallo");
  // The intervals come with the buttons; Easy goes straight to review.
  await expect(focus.getByRole("button", { name: /^Leicht, nächste Wiederholung / })).toBeVisible();
  if (mobile) await swipe(page, 0, -300);
  else await page.keyboard.press("4");
  await expect(focus.getByRole("region", { name: /^Karte 2 von/ })).toContainText("perro");
  await expect(focus.locator(".study-focus-count.new b")).toHaveText("1");
  // Undo: the first card again, unrated; the new count back to two.
  if (mobile) await focus.getByRole("button", { name: "Letzte Wertung rückgängig" }).click();
  else await page.keyboard.press("z");
  await expect(focus.locator(".study-front")).toContainText("hola");
  await expect(focus.locator(".study-focus-count.new b")).toHaveText("2");
  await expect(focus.locator(".study-back")).toHaveCount(0);
  for (const expected of ["hola", "perro"]) {
    await expect(focus.locator(".study-front")).toContainText(expected);
    if (mobile) {
      await focus.locator(".study-card").click();
      await expect(focus.locator(".study-back")).toBeVisible();
      await swipe(page, 0, -300);
    } else {
      await page.keyboard.press("Enter");
      await page.keyboard.press("4");
    }
  }
  await expect(focus.getByRole("heading", { name: "Geschafft für heute" })).toBeVisible();
  // Cards, not ratings: two cards; the ratings by button below.
  const cardsTile = focus.locator(".study-summary-tile").first();
  await expect(cardsTile.locator("strong")).toHaveText("2");
  await expect(cardsTile).toContainText("Karten · 2 neu");
  await expect(focus.locator(".study-spread-legend")).toContainText("Leicht 2");
  await page.screenshot({ path: `test-results/study-summary-${info.project.name}.png` });
  // Study more today: one more new card (the third record).
  await focus.getByRole("button", { name: /^Heute mehr lernen/ }).click();
  await expect(focus.locator(".study-front")).toContainText("gato");
  await page.keyboard.press("Escape");
  await expect(focus).toBeHidden();
  await expect(today.locator(".study-count.new strong")).toHaveText("1");
  // A rating is the person's own state, not an edit: no record changed.
  const rows = (await (await page.request.get(`/api/pages/${pageId}`)).json()).rows as { version: number }[];
  expect(rows.every((r) => r.version === rows[0].version)).toBe(true);
  expect(errors).toEqual([]);
});

test("the template “Lernkarten-Datenbank” is a deck at once", async ({ page }, info) => {
  const { boot, command } = await signedIn(page);
  const created = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Karten ${info.project.name} ${Date.now()}`, kind: "database", starterTemplate: "flashcards" });
  await page.goto(`/#page=${created.id}`);
  await expect(page.locator(".study-today .study-count.new strong")).toHaveText("8");
  await expect(page.getByRole("dialog", { name: "Karten einrichten" })).toHaveCount(0);
  await page.getByRole("button", { name: "Lernen starten" }).click();
  const focus = page.getByRole("dialog", { name: /^Lernen: / });
  await focus.getByRole("button", { name: /^Antwort zeigen/ }).click();
  await expect(focus.locator(".study-ratings button")).toHaveCount(4);
  await page.keyboard.press("Escape");
  await expect(focus).toBeHidden();
});

test("a reader studies with their own state but cannot set up the cards", async ({ page, browser }, info) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "FLOWPLAN_DATA_DIR of the test server is required.");
  test.setTimeout(120_000);
  const { boot, command } = await signedIn(page);
  const created = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Lesend ${info.project.name} ${Date.now()}`, kind: "database", databaseKind: "flashcards" });
  const pageId = created.id as string;
  await command({ action: "row.create", pageId, cells: { title: "uno", back: "eins" } });
  const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  db.exec("PRAGMA busy_timeout=5000;");
  const reader = randomUUID();
  db.prepare("INSERT INTO users(id,subject,name,email,onboarded_at) VALUES(?,?,?,?,?)").run(reader, `self:${reader}`, "Lea Lesend", `${reader}@example.test`, Date.now());
  db.prepare("INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,'viewer')").run(boot.workspace.id, reader);
  const token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)").run(createHash("sha256").update(token).digest("hex"), reader, "[]", Date.now() + 600000);
  db.close();
  const context = await browser.newContext({
    locale: "de-DE",
    viewport: page.viewportSize()!,
    isMobile: info.project.name === "mobile",
    hasTouch: info.project.name === "mobile",
    storageState: { cookies: [], origins: [{ origin: new URL(origin).origin, localStorage: [{ name: "flowplan-offline-offer", value: "never" }] }] },
  });
  await context.addCookies([{ name: "flowplan_session", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
  const errors: string[] = [];
  try {
    const other = await context.newPage();
    other.on("pageerror", (e) => errors.push(e.message));
    await other.goto(`${origin}/?workspace=${boot.workspace.id}#page=${pageId}`);
    await expect(other.locator(".study-today .study-count.new strong")).toHaveText("1");
    await expect(other.getByRole("button", { name: "Karten einrichten" })).toHaveCount(0);
    await other.getByRole("button", { name: "Lernen starten" }).click();
    const focus = other.getByRole("dialog", { name: /^Lernen: / });
    await focus.getByRole("button", { name: /^Antwort zeigen/ }).click();
    await focus.getByRole("button", { name: /^Leicht, / }).click();
    await expect(focus.getByRole("heading", { name: "Geschafft für heute" })).toBeVisible();
    await focus.getByRole("button", { name: "Zurück zum Stapel" }).click();
    await expect(other.locator(".study-today .study-count.new strong")).toHaveText("0");
    // The mapping and the records stay closed to a reader.
    const refused = await other.request.post("/api/command", { headers: { origin }, data: { action: "study.settings", pageId, settings: null } });
    expect(refused.status()).toBe(403);
    const edit = await other.request.post("/api/command", { headers: { origin }, data: { action: "row.create", pageId, cells: { title: "x" } } });
    expect(edit.ok()).toBe(false);
    // The owner's own state is untouched: the card is still new for them.
    await page.goto(`/#page=${pageId}`);
    await expect(page.locator(".study-today .study-count.new strong")).toHaveText("1");
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
