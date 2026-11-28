import { test, expect, type CDPSession, type Page } from "@playwright/test";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

// #647: with "Wischen vom linken Rand" on "Zurück" (in the app), a swipe
// from the right edge goes forward – only then, only with a step forward,
// with a chevron that comes in with the finger, and not over a table that
// still scrolls to the right. The back arrow at the top left (on phones
// too) lists the places visited in this tab on a long press – settings
// screens among them, the current one marked – and goes to the one chosen.

const IPHONE_APP_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 FlowplanMobile/1.4.0";
const shots = process.env.FORWARD_SHOTS;

// Chromium's own back and forward swipes (overscroll history navigation)
// would answer sideways swipes the page leaves alone.
test.use({
  launchOptions: {
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
    args: ["--overscroll-history-navigation=0", "--disable-features=OverscrollHistoryNavigation"],
  },
  userAgent: IPHONE_APP_UA,
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});

const origin = () => process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

async function setUp(page: Page, edge: "back" | "drawer") {
  await page.request.post("/api/auth/demo", { headers: { origin: origin() } });
  await page.request.post("/api/command", { headers: { origin: origin() }, data: { action: "profile.onboarded" } });
  await page.addInitScript((edge) => {
    try {
      localStorage.setItem("flowplan-app-promo", "1");
      if (edge === "back") localStorage.setItem("flowplan.edge-swipe", "back");
    } catch {}
    const w = window as unknown as Record<string, unknown>;
    // What the page told the app (src/bridge-script.ts in flowplan-app).
    const told: { edge: string[]; forward: boolean[]; haptics: string[] } = { edge: [], forward: [], haptics: [] };
    w.__told = told;
    w.ReactNativeWebView = { postMessage: () => {} };
    w.FlowplanApp = {
      platform: "ios",
      version: "1.1.11",
      refresh: () => {},
      haptic: (kind: string) => told.haptics.push(kind),
      backState: () => {},
      openSettings: () => {},
      edgeSwipe: (mode: string) => told.edge.push(mode),
      forwardState: (on: boolean) => told.forward.push(on),
    };
    const hideDevBadge = () => {
      const style = document.createElement("style");
      style.textContent = "nextjs-portal { display: none !important; }";
      document.head.append(style);
    };
    if (document.head) hideDevBadge();
    else document.addEventListener("DOMContentLoaded", hideDevBadge);
  }, edge);
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin: origin() }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const create = async (title: string, kind = "document") =>
    (await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind })).id as string;
  return { command, create };
}

// The workspace is listening: it told the app which way the left edge goes.
async function ready(page: Page, mode: string) {
  await expect.poll(() => page.evaluate(() => (window as unknown as { __told: { edge: string[] } }).__told.edge.at(-1))).toBe(mode);
}
const told = (page: Page) => page.evaluate(() => (window as unknown as { __told: { edge: string[]; forward: boolean[]; haptics: string[] } }).__told);

// A one-finger swipe from (x0, y) to (x1, y); `during` runs before the
// finger lifts.
async function swipe(page: Page, x0: number, x1: number, y = 420, during?: () => Promise<void>) {
  const cdp: CDPSession = await page.context().newCDPSession(page);
  const steps = 10;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x0, y }] });
  for (let i = 1; i <= steps; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x0 + ((x1 - x0) * i) / steps, y }] });
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(120);
  if (during) await during();
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x1, y }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
  await page.waitForTimeout(300);
}

const title = (page: Page) => page.locator(".page-title");
const open = async (page: Page, hash: string, expected: string) => {
  await page.evaluate((h) => (location.hash = h), hash);
  await expect(title(page)).toHaveValue(expected);
};

test("with “Zurück”, a swipe from the right edge goes forward – only with a step forward, with a chevron", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "Touch emulation runs in the mobile project.");
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "Needs the test server.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { create } = await setUp(page, "back");
  const a = await create("Vorwärts A"),
    b = await create("Vorwärts B");
  await page.goto(`/#page=${a}`);
  await expect(title(page)).toHaveValue("Vorwärts A");
  await ready(page, "back");
  await open(page, `page=${b}`, "Vorwärts B");

  // Nothing ahead: the swipe does nothing (no chevron either).
  const length = await page.evaluate(() => history.length);
  await swipe(page, 388, 150, 420, async () => {
    await expect(page.locator(".forward-swipe-chevron")).toHaveCount(0);
  });
  await expect(title(page)).toHaveValue("Vorwärts B");
  expect(await page.evaluate(() => history.length)).toBe(length);
  // The app hears the edge is not forward's.
  expect((await told(page)).forward.at(-1)).toBe(false);

  // Back (as the app's back swipe or the arrow does): B lies ahead now.
  await page.locator(".topbar .history-button[data-direction=back]").tap();
  await expect(title(page)).toHaveValue("Vorwärts A");
  await expect.poll(async () => (await told(page)).forward.at(-1)).toBe(true);

  // A short swipe springs back: nothing happens.
  await swipe(page, 388, 360);
  await expect(title(page)).toHaveValue("Vorwärts A");

  // From the right edge across: the chevron follows, passes the threshold
  // (one haptic tap) and letting go goes forward.
  await swipe(page, 388, 200, 420, async () => {
    const chevron = page.locator(".forward-swipe-chevron");
    await expect(chevron).toHaveCount(1);
    await expect(chevron).toHaveAttribute("data-armed", "");
    const box = (await chevron.boundingBox())!;
    expect(box.x + box.width).toBeLessThan(390);
    if (shots) {
      mkdirSync(shots, { recursive: true });
      await page.screenshot({ path: join(shots, "forward-swipe-chevron.png") });
    }
  });
  await expect(title(page)).toHaveValue("Vorwärts B");
  await expect(page.locator(".forward-swipe-chevron")).toHaveCount(0);
  expect((await told(page)).haptics).toEqual(["light"]);
  // Forward went through the history: back is A again, nothing ahead.
  await expect.poll(async () => (await told(page)).forward.at(-1)).toBe(false);
  expect(errors).toEqual([]);
});

test("with “Seitenleiste öffnen” (the default) the right edge does not go forward", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "Touch emulation runs in the mobile project.");
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "Needs the test server.");
  const { create } = await setUp(page, "drawer");
  const a = await create("Rand A"),
    b = await create("Rand B");
  await page.goto(`/#page=${a}`);
  await expect(title(page)).toHaveValue("Rand A");
  await ready(page, "drawer");
  await open(page, `page=${b}`, "Rand B");
  await page.goBack();
  await expect(title(page)).toHaveValue("Rand A");
  await swipe(page, 388, 150);
  await expect(title(page)).toHaveValue("Rand A");
  await expect(page.locator(".forward-swipe-chevron")).toHaveCount(0);
  expect((await told(page)).forward.every((on) => on === false)).toBe(true);
});

test("over a table that still scrolls to the right the swipe scrolls the table, not forward", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "Touch emulation runs in the mobile project.");
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "Needs the test server.");
  const { command, create } = await setUp(page, "back");
  const table = await create("Breite Liste", "database");
  const { database } = await (await page.request.get(`/api/pages/${table}`)).json();
  await command({
    action: "database.update",
    pageId: table,
    version: database.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      ...["a", "b", "c", "d", "e"].map((id) => ({ id, name: `Spalte ${id.toUpperCase()}`, type: "text" })),
    ],
    views: [{ id: "table", name: "Tabelle", type: "table", filters: [], sorts: [] }],
  });
  for (let i = 1; i <= 6; i++) await command({ action: "row.create", pageId: table, cells: { title: `Zeile ${i}`, a: `A${i}`, b: `B${i}`, c: `C${i}` } });
  const next = await create("Danach");
  await page.goto(`/#page=${table}`);
  await expect(page.locator("tbody tr")).toHaveCount(6);
  await ready(page, "back");
  await open(page, `page=${next}`, "Danach");
  await page.goBack();
  await expect(page.locator("tbody tr")).toHaveCount(6);
  await expect.poll(async () => (await told(page)).forward.at(-1)).toBe(true);
  const scroller = page.locator(".data-table-scroll");
  expect(await scroller.evaluate((el) => el.scrollWidth > el.clientWidth + 1 && el.scrollLeft === 0)).toBe(true);
  const row = (await page.locator("tbody tr").nth(1).boundingBox())!;
  const y = row.y + row.height / 2;
  // The finger starts on the table, within the right edge …
  const tableEnd = (await scroller.boundingBox())!;
  const onTable = Math.round(tableEnd.x + tableEnd.width - 3);
  expect(onTable).toBeGreaterThanOrEqual(390 - 24);
  expect(await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest(".data-table-scroll"), { x: onTable, y })).toBe(true);
  await swipe(page, onTable, 150, y);
  await expect(page).toHaveURL(new RegExp(`#page=${table}`));
  await expect(page.locator(".forward-swipe-chevron")).toHaveCount(0);
  // … or in the margin beside it at the very edge: the table's still.
  await swipe(page, 388, 150, y);
  await expect(page).toHaveURL(new RegExp(`#page=${table}`));
  await expect(page.locator(".forward-swipe-chevron")).toHaveCount(0);
  // Outside the table the same swipe goes forward.
  const head = (await page.locator(".page-title").boundingBox())!;
  await swipe(page, 388, 150, head.y + head.height / 2);
  await expect(title(page)).toHaveValue("Danach");
});

// A press held on the touch screen (longer than the arrow's 450 ms).
async function longPress(page: Page, x: number, y: number) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await page.waitForTimeout(700);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

test("a long press on the back arrow lists the places visited – settings too – and goes to the one chosen", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "Touch emulation runs in the mobile project.");
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "Needs the test server.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { create } = await setUp(page, "drawer");
  const a = await create("Liste A"),
    b = await create("Liste B"),
    c = await create("Liste C");
  await page.goto(`/#page=${a}`);
  await expect(title(page)).toHaveValue("Liste A");
  await ready(page, "drawer");
  const back = page.locator(".topbar .history-button[data-direction=back]");
  // On a phone: back beside the sidebar button, forward is not shown.
  await expect(back).toBeVisible();
  await expect(page.locator(".topbar .history-button[data-direction=forward]")).toBeHidden();
  await expect(back).toBeDisabled();
  await page.evaluate(() => (location.hash = "settings/account"));
  await expect(page.locator(".settings-shell, .settings-screen").first()).toBeVisible();
  await open(page, `page=${b}`, "Liste B");
  // Back to the settings, then C: B drops out of the history but stays in the list.
  await back.tap();
  await expect(page).toHaveURL(/#settings\/account$/);
  await open(page, `page=${c}`, "Liste C");

  const box = (await back.boundingBox())!;
  await longPress(page, box.x + box.width / 2, box.y + box.height / 2);
  const list = page.locator(".history-list");
  await expect(list).toBeVisible();
  await expect(list.getByText("Zuletzt besucht", { exact: true })).toBeVisible();
  const items = list.getByRole("menuitem");
  await expect(items).toHaveCount(4);
  await expect(items.nth(0)).toHaveText("Liste C");
  await expect(items.nth(0)).toHaveAttribute("aria-current", "page");
  await expect(items.nth(1)).toContainText("Einstellungen");
  await expect(items.nth(2)).toHaveText("Liste B");
  await expect(items.nth(3)).toHaveText("Liste A");
  if (shots) {
    mkdirSync(shots, { recursive: true });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(shots, "history-list-phone.png") });
  }
  // B is not in the history any more: it opens as a new step.
  const length = await page.evaluate(() => history.length);
  await items.nth(2).tap();
  await expect(title(page)).toHaveValue("Liste B");
  expect(await page.evaluate(() => history.length)).toBe(length + 1);
  await page.waitForTimeout(500);
  // The settings are: back through the history to them.
  await longPress(page, box.x + box.width / 2, box.y + box.height / 2);
  await expect(items.nth(0)).toHaveText("Liste B");
  await list.getByRole("menuitem", { name: /Einstellungen/ }).tap();
  await expect(page).toHaveURL(/#settings\/account$/);
  expect(await page.evaluate(() => history.length)).toBe(length + 1);
  expect(errors).toEqual([]);
});
