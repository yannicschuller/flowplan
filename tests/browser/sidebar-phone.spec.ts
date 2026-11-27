import { test, expect, type Page, type CDPSession } from "@playwright/test";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

// The sidebar on phones (#613–#622): Favoriten and Sammlungen start folded
// there, the spaces open (#616), and a page dragged by its handle with a
// finger lands where it is let go and leaves no drop marks behind –
// whether it is dropped, cancelled by the browser or stopped with Esc (#618).
// While it is dragged a light copy follows the finger, only the target row
// is marked, and the workspace does not render again per move (#637).
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

// A person of their own, made directly in the test server's database: the
// folds are stored with the account, and the shared demo account carries
// those of other specs.
async function setUp(page: Page) {
  const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  const uid = randomUUID(),
    token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO users(id,subject,name,email,onboarded_at) VALUES(?,?,?,?,?)").run(uid, `sidebar-phone:${uid}`, "Sidebar Phone", `${uid}@example.test`, Date.now());
  db.prepare("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)").run(
    createHash("sha256").update(token).digest("hex"),
    uid,
    "[]",
    Date.now() + 300000,
  );
  db.close();
  await page.context().addCookies([{ name: "flowplan_session", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
  await page.addInitScript(() => {
    try {
      localStorage.setItem("flowplan-app-promo", "1");
    } catch {}
  });
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  // A workspace of their own (a new person starts without one).
  let boot = await (await page.request.get("/api/bootstrap")).json();
  if (!boot.workspace?.id) {
    const workspace = await command({ action: "workspace.create", name: "Seitenleiste" });
    boot = await (await page.request.get(`/api/bootstrap?workspace=${workspace.id}`)).json();
  }
  expect(boot.spaces?.length).toBeGreaterThan(0);
  const create = async (title: string) =>
    (await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind: "document" })).id as string;
  return { boot, command, create };
}

const sidebar = (page: Page) => page.locator("aside.sidebar");
const toggle = (page: Page, section: string) => sidebar(page).locator(`${section} > .nav-section-title > .space-toggle`);
async function openDrawer(page: Page) {
  await page.getByRole("navigation", { name: "Schnellnavigation" }).getByRole("button", { name: /^Navigation öffnen/ }).tap();
  await expect(page.locator(".app-shell.nav-open")).toBeVisible();
}

test("Favoriten and Sammlungen start folded on phones, the spaces open; a choice is kept (#616)", async ({ page }, info) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "FLOWPLAN_DATA_DIR of the test server is required.");
  const phone = info.project.name === "mobile";
  const { boot, command, create } = await setUp(page);
  const favourite = await create(`Favorit ${Date.now()}`);
  await command({ action: "favorite", pageId: favourite, value: true });
  await page.goto("/#home");
  if (phone) await openDrawer(page);
  const space = sidebar(page).locator(`.nav-section[data-space-id="${boot.spaces[0].id}"] > .nav-section-title > .space-toggle`);
  await expect(space).toHaveAttribute("aria-expanded", "true");
  await expect(toggle(page, ".favorites-section")).toHaveAttribute("aria-expanded", phone ? "false" : "true");
  await expect(toggle(page, ".collections-section")).toHaveAttribute("aria-expanded", phone ? "false" : "true");
  if (!phone) return;
  await expect(sidebar(page).locator("#favorites-list")).toHaveCount(0);

  // Opened by hand: open after a reload too.
  await toggle(page, ".favorites-section").tap();
  await expect(sidebar(page).locator("#favorites-list .favorite-nav").first()).toBeVisible();
  await expect
    .poll(async () => ((await (await page.request.get("/api/bootstrap")).json()).sidebar?.keys ?? []) as string[])
    .toContain("go:favorites");
  await page.reload();
  await openDrawer(page);
  await expect(toggle(page, ".favorites-section")).toHaveAttribute("aria-expanded", "true");
  await expect(toggle(page, ".collections-section")).toHaveAttribute("aria-expanded", "false");
});

// One finger, as the phone sends it (touch events; Chromium makes the
// pointer events from them).
function finger(cdp: CDPSession) {
  const send = (type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel", x = 0, y = 0) =>
    cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" || type === "touchCancel" ? [] : [{ x, y }] });
  return {
    down: (x: number, y: number) => send("touchStart", x, y),
    move: (x: number, y: number) => send("touchMove", x, y),
    up: () => send("touchEnd"),
    cancel: () => send("touchCancel"),
  };
}
const center = async (page: Page, selector: string) => {
  const box = (await page.locator(selector).boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, top: box.y, height: box.height };
};
// Nothing left of a drag: no drop line or frame, no lifted or pressed
// handle, no copy following the finger.
async function noMarks(page: Page) {
  await expect(page.locator(".drop-before, .drop-after, .drop-inside, .drop-records, .file-drop, .space-file-drop")).toHaveCount(0);
  await expect(page.locator("[data-drag-lifted], [data-drag-pressing], [data-drag-source]")).toHaveCount(0);
  await expect(page.locator("html.pointer-dragging")).toHaveCount(0);
  await expect(page.locator(".pointer-drag-preview")).toHaveCount(0);
}
// How often WorkspaceApp has rendered (the specs' build counts, #610).
const renders = (page: Page) =>
  page.evaluate(() => (window as unknown as { __flowplanWorkspaceRenders?: number }).__flowplanWorkspaceRenders ?? -1);
// Exactly one row carries a drop mark: the one given.
async function onlyMarked(page: Page, id: string, placement: "before" | "after" | "inside") {
  await expect(page.locator(`.page-nav[data-page-id="${id}"].drop-${placement}`)).toHaveCount(1);
  await expect(page.locator(".page-nav.drop-before, .page-nav.drop-after, .page-nav.drop-inside, .page-nav.drop-records")).toHaveCount(1);
}
// Holds the handle of `from` and moves the finger to `y` in steps.
async function liftAndMove(page: Page, hand: ReturnType<typeof finger>, from: string, x: number, y: number) {
  const handle = await center(page, `.page-nav[data-page-id="${from}"] .nav-drag`);
  await hand.down(handle.x, handle.y);
  // Held past the long press (lib/pointer-drag.ts LONG_PRESS_MS).
  await page.waitForTimeout(450);
  // The row fades in place and a copy of it follows the finger (#637).
  await expect(page.locator(`.page-nav[data-page-id="${from}"][data-drag-source]`)).toHaveCount(1);
  await expect(page.locator(".pointer-drag-preview")).toHaveCount(1);
  // The copy is no row of the tree.
  await expect(page.locator(".pointer-drag-preview [data-page-id]")).toHaveCount(0);
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    await hand.move(handle.x + ((x - handle.x) * i) / steps, handle.y + ((y - handle.y) * i) / steps);
    await page.waitForTimeout(16);
  }
}

test("a page dragged by its handle with a finger lands where it is let go, without stray drop marks (#618)", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "Touch: the phone's drawer.");
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "FLOWPLAN_DATA_DIR of the test server is required.");
  const { boot, create } = await setUp(page);
  const stamp = Date.now();
  const a = await create(`Erste ${stamp}`);
  const b = await create(`Zweite ${stamp}`);
  const c = await create(`Dritte ${stamp}`);
  const order = async () => {
    const ids = await sidebar(page).locator(`.nav-section[data-space-id="${boot.spaces[0].id}"] .page-nav[aria-level="1"]`).evaluateAll((rows) =>
      rows.map((row) => (row as HTMLElement).dataset.pageId),
    );
    return ids.filter((id) => id === a || id === b || id === c);
  };
  await page.goto("/#home");
  await openDrawer(page);
  await expect.poll(order).toEqual([a, b, c]);
  const cdp = await page.context().newCDPSession(page);
  const hand = finger(cdp);

  // "Dritte" above "Erste": the drop line shows on "Erste" while held there.
  await page.locator(`.page-nav[data-page-id="${b}"]`).evaluate((row) => row.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(300);
  let target = await center(page, `.page-nav[data-page-id="${a}"]`);
  await liftAndMove(page, hand, c, target.x, target.top + target.height * 0.15);
  // Only one row is marked at a time.
  await onlyMarked(page, a, "before");
  await hand.up();
  await noMarks(page);
  await expect.poll(order).toEqual([c, a, b]);
  // The drawer stayed open: the drag was not the swipe that closes it.
  await expect(page.locator(".app-shell.nav-open")).toBeVisible();

  // Cancelled by the browser half way: nothing moves, nothing stays marked.
  target = await center(page, `.page-nav[data-page-id="${b}"]`);
  await liftAndMove(page, hand, a, target.x, target.top + target.height * 0.9);
  await onlyMarked(page, b, "after");
  await hand.cancel();
  await noMarks(page);

  // Esc while dragging: the same, and letting go afterwards drops nothing.
  target = await center(page, `.page-nav[data-page-id="${c}"]`);
  await liftAndMove(page, hand, b, target.x, target.top + target.height * 0.5);
  await onlyMarked(page, c, "inside");
  await page.keyboard.press("Escape");
  await noMarks(page);
  await hand.up();
  await noMarks(page);
  await page.waitForTimeout(500);
  await expect.poll(order).toEqual([c, a, b]);
  await expect(page.locator(".app-shell.nav-open")).toBeVisible();

  // Many moves up and down over the rows: the workspace renders a few times
  // at most (no render per move), and one row at a time is marked (#637).
  const top = await center(page, `.page-nav[data-page-id="${c}"]`);
  const bottom = await center(page, `.page-nav[data-page-id="${b}"]`);
  const handle = await center(page, `.page-nav[data-page-id="${a}"] .nav-drag`);
  await hand.down(handle.x, handle.y);
  await page.waitForTimeout(450);
  await expect(page.locator(".pointer-drag-preview")).toHaveCount(1);
  const before = await renders(page);
  expect(before).toBeGreaterThan(0);
  for (let i = 0; i < 50; i++) {
    const t = (i % 25) / 24,
      down = Math.floor(i / 25) % 2 === 0;
    await hand.move(handle.x, top.top + 4 + (bottom.top + bottom.height - top.top - 8) * (down ? t : 1 - t));
    // Over the dragged page itself no row is marked.
    if (i % 5 === 4) expect(await page.locator(".page-nav.drop-before, .page-nav.drop-after, .page-nav.drop-inside").count()).toBeLessThanOrEqual(1);
  }
  await expect(page.locator(".page-nav.drop-before, .page-nav.drop-after, .page-nav.drop-inside")).toHaveCount(1);
  expect((await renders(page)) - before).toBeLessThanOrEqual(3);
  await page.keyboard.press("Escape");
  await hand.up();
  await noMarks(page);
  await expect.poll(order).toEqual([c, a, b]);
  await cdp.detach();
});
