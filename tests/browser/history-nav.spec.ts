import { test, expect, type Page } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

// Back and forward at the top left (#125, lib/history-nav.ts): A → B → C,
// back twice with the arrow, forward, the disabled ends, ⌘[ / Alt+← (not
// while typing), the list of a right click, the browser's own back in step
// with the arrows, a dialog adds no step, a record does and closing it
// does not add another. The back arrow's list (#647): the places visited in
// this tab, the current one first and marked, by right click and by the
// keyboard (the context menu key, Shift+F10).
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const shots = process.env.HISTORY_SHOTS;

async function setup(page: Page) {
  const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  db.exec("PRAGMA busy_timeout=5000;");
  const uid = randomUUID(),
    token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO users(id,subject,name,email,onboarded_at) VALUES(?,?,?,?,?)").run(uid, `history-nav:${uid}`, "Hanna Verlauf", `${uid}@example.test`, Date.now());
  db.prepare("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)").run(createHash("sha256").update(token).digest("hex"), uid, "[]", Date.now() + 3_600_000);
  db.close();
  await page.context().addCookies([{ name: "flowplan_session", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await command({ action: "workspace.create", name: "Verlauf" });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const create = async (title: string, kind = "document") =>
    (await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind })).id as string;
  const a = await create("Seite A"),
    b = await create("Seite B"),
    c = await create("Seite C"),
    table = await create("Liste", "database");
  const row = (await command({ action: "row.create", pageId: table, cells: { title: "Eintrag Eins" } })).id as string;
  return { a, b, c, table, row };
}

const title = (page: Page) => page.locator(".page-title");
const back = (page: Page) => page.locator(".topbar .history-button[data-direction=back]");
const forward = (page: Page) => page.locator(".topbar .history-button[data-direction=forward]");
// Nothing focused: the shortcuts outside of text.
const blur = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
const open = async (page: Page, hash: string, expected: string) => {
  await page.evaluate((h) => (location.hash = h), hash);
  await expect(title(page)).toHaveValue(expected);
};

test("back and forward: arrows, shortcuts, the list, the browser's back, dialogs and records", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Both arrows are for wider screens (phones: tests/browser/forward-swipe.spec.ts).");
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "Needs the test server data directory.");
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { a, b, c, table, row } = await setup(page);

  await page.goto(`/#page=${a}`);
  await expect(title(page)).toHaveValue("Seite A");
  // Nothing before the first page, nothing after.
  await expect(back(page)).toBeDisabled();
  await expect(forward(page)).toBeDisabled();
  await expect(back(page)).toHaveAttribute("title", "Zurück (Alt + ←)");
  await expect(forward(page)).toHaveAttribute("title", "Vorwärts (Alt + →)");

  // A → B (from the page tree) → C.
  await page.locator(`.page-nav[data-page-id="${b}"]`).first().click();
  await expect(title(page)).toHaveValue("Seite B");
  await open(page, `page=${c}`, "Seite C");
  await expect(back(page)).toBeEnabled();
  await expect(forward(page)).toBeDisabled();

  // Back twice with the arrow: A, and nothing further back.
  await back(page).click();
  await expect(title(page)).toHaveValue("Seite B");
  await back(page).click();
  await expect(title(page)).toHaveValue("Seite A");
  await expect(back(page)).toBeDisabled();
  await expect(forward(page)).toBeEnabled();
  // Forward: B.
  await forward(page).click();
  await expect(title(page)).toHaveValue("Seite B");
  await expect(page).toHaveURL(new RegExp(`#page=${b}$`));

  // The shortcuts (Linux: Alt+← and Ctrl+[ / Ctrl+]).
  await blur(page);
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(title(page)).toHaveValue("Seite A");
  await page.keyboard.press("Control+BracketRight");
  await expect(title(page)).toHaveValue("Seite B");
  await page.keyboard.press("Control+BracketLeft");
  await expect(title(page)).toHaveValue("Seite A");
  await page.keyboard.press("Alt+ArrowRight");
  await expect(title(page)).toHaveValue("Seite B");
  // While typing, Alt+← moves through the text and stays on the page.
  await title(page).click();
  await page.keyboard.press("End");
  await page.keyboard.press("Alt+ArrowLeft");
  await page.waitForTimeout(400);
  await expect(title(page)).toHaveValue("Seite B");
  await expect(page).toHaveURL(new RegExp(`#page=${b}$`));
  await blur(page);

  // A right click lists what lies ahead: C, chosen directly.
  await forward(page).click({ button: "right" });
  const list = page.locator(".history-list");
  await expect(list).toBeVisible();
  await expect(list.getByRole("menuitem")).toHaveText(["Seite C"]);
  // Back from B: the places visited, B (here) first, then A and C.
  await page.keyboard.press("Escape");
  await back(page).click({ button: "right" });
  await expect(list.getByRole("menuitem")).toHaveText(["Seite B", "Seite A", "Seite C"]);
  await expect(list.getByRole("menuitem").first()).toHaveAttribute("aria-current", "page");
  await expect(list.getByText("Zuletzt besucht", { exact: true })).toBeVisible();
  if (shots) {
    mkdirSync(shots, { recursive: true });
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(shots, "history-list-back.png"), clip: { x: 0, y: 0, width: 760, height: 260 } });
  }
  await page.keyboard.press("Escape");
  await forward(page).click({ button: "right" });
  await list.getByRole("menuitem", { name: "Seite C" }).click();
  await expect(title(page)).toHaveValue("Seite C");
  await expect(forward(page)).toBeDisabled();

  // The browser's own back and forward: the same steps, the arrows follow.
  await page.goBack();
  await expect(title(page)).toHaveValue("Seite B");
  await expect(forward(page)).toBeEnabled();
  await page.goForward();
  await expect(title(page)).toHaveValue("Seite C");
  await expect(forward(page)).toBeDisabled();
  await back(page).click();
  await expect(title(page)).toHaveValue("Seite B");
  await page.goBack();
  await expect(title(page)).toHaveValue("Seite A");
  await expect(back(page)).toBeDisabled();
  await forward(page).click();
  await forward(page).click();
  await expect(title(page)).toHaveValue("Seite C");

  // A dialog (the search) adds no step.
  const length = await page.evaluate(() => history.length);
  await blur(page);
  await page.keyboard.press("Control+K");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await page.evaluate(() => history.length)).toBe(length);
  await back(page).click({ button: "right" });
  await expect(list.getByRole("menuitem")).toHaveText(["Seite C", "Seite B", "Seite A"]);
  await page.keyboard.press("Escape");

  // A record has its address: a step. Closing it goes back to its database
  // (no further step), so back from the database is C again.
  await page.evaluate((h) => (location.hash = h), `page=${table}`);
  await expect(page.locator(".page-title")).toHaveValue("Liste");
  await page.evaluate((h) => (location.hash = h), `page=${table}&row=${row}`);
  const record = page.locator(".modal.record-dialog");
  await expect(record.locator(".row-title-input")).toHaveValue("Eintrag Eins");
  // (The record's title is kept for the lists while it is open.)
  await page.waitForTimeout(600);
  await page.keyboard.press("Escape");
  await expect(record).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`#page=${table}$`));
  await expect(forward(page)).toBeEnabled();
  await forward(page).click({ button: "right" });
  await expect(list.getByRole("menuitem")).toHaveText(["Eintrag EinsListe"]);
  await page.keyboard.press("Escape");
  await back(page).click({ button: "right" });
  await expect(list.getByRole("menuitem")).toHaveText(["Liste", "Eintrag EinsListe", "Seite C", "Seite B", "Seite A"]);
  if (shots) await page.waitForTimeout(400);
  if (shots) await page.screenshot({ path: join(shots, "history-list-after-record.png"), clip: { x: 0, y: 0, width: 760, height: 300 } });
  await page.keyboard.press("Escape");
  await back(page).click();
  await expect(title(page)).toHaveValue("Seite C");
  if (shots) await page.locator(".topbar").screenshot({ path: join(shots, "history-buttons.png") });
  expect(errors).toEqual([]);
});

test("the back arrow's list by keyboard: the context menu key and Shift+F10; a place no longer in the history opens anew (#647)", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Keyboard and mouse on the desktop.");
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "Needs the test server data directory.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { a, b, c } = await setup(page);
  await page.goto(`/#page=${a}`);
  await expect(title(page)).toHaveValue("Seite A");
  // A → settings → B, back to the settings, then C: B leaves the history.
  await page.evaluate(() => (location.hash = "settings/account"));
  await expect(page).toHaveURL(/#settings\/account$/);
  await open(page, `page=${b}`, "Seite B");
  await back(page).click();
  await expect(page).toHaveURL(/#settings\/account$/);
  await open(page, `page=${c}`, "Seite C");
  await expect(forward(page)).toBeDisabled();

  // The context menu key on the focused arrow opens the list.
  await back(page).focus();
  await page.keyboard.press("ContextMenu");
  const list = page.locator(".history-list");
  await expect(list).toBeVisible();
  await expect(list).toHaveAttribute("aria-label", "Zuletzt besucht");
  const items = list.getByRole("menuitem");
  await expect(items).toHaveCount(4);
  await expect(items.nth(0)).toHaveText("Seite C");
  await expect(items.nth(0)).toHaveAttribute("aria-current", "page");
  // A settings screen with its name and the area as detail.
  await expect(items.nth(1)).toContainText("Einstellungen");
  await expect(items.nth(2)).toHaveText("Seite B");
  await expect(items.nth(3)).toHaveText("Seite A");
  if (shots) {
    mkdirSync(shots, { recursive: true });
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(shots, "history-list-desktop.png"), clip: { x: 0, y: 0, width: 760, height: 320 } });
  }
  await page.keyboard.press("Escape");
  await expect(list).toHaveCount(0);
  await expect(back(page)).toBeFocused();

  // Shift+F10, then the arrow keys and Enter: B, not in the history any
  // more, opens as a new step.
  const length = await page.evaluate(() => history.length);
  await page.keyboard.press("Shift+F10");
  await expect(list).toBeVisible();
  await expect(items.nth(0)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(items.nth(2)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(title(page)).toHaveValue("Seite B");
  expect(await page.evaluate(() => history.length)).toBe(length + 1);

  // A by right click: in the history – back through it, forward follows.
  await back(page).click({ button: "right" });
  await list.getByRole("menuitem", { name: "Seite A" }).click();
  await expect(title(page)).toHaveValue("Seite A");
  expect(await page.evaluate(() => history.length)).toBe(length + 1);
  await expect(forward(page)).toBeEnabled();
  await forward(page).click({ button: "right" });
  await expect(page.locator(".history-list").getByRole("menuitem")).toHaveText([/Einstellungen/, "Seite C", "Seite B"]);
  await page.keyboard.press("Escape");
  expect(errors).toEqual([]);
});
