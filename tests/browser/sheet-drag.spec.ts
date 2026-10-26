import { test, expect, type Page } from "@playwright/test";

// Sheets on phones (components/sheet-drag.ts): a dialog with `sheet` rises
// from the bottom edge with a grab handle and is dragged down to close – by
// the handle, or anywhere while its content is at the top. Touches are real
// touch events (Chrome DevTools Protocol), as a finger sends them.

// As in the app (flowplan-app's bridge): window.FlowplanApp is there, so the
// page installs window.FlowplanNavigation and reports whether back would do
// something.
async function setup(page: Page) {
  await page.addInitScript(() => {
    const states: boolean[] = [];
    (window as unknown as { __backStates: boolean[] }).__backStates = states;
    (window as unknown as { FlowplanApp: unknown }).FlowplanApp = {
      platform: "android",
      version: "1.0.0",
      refresh: () => {},
      haptic: () => {},
      backState: (value: boolean) => states.push(value),
    };
  });
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  // Past the introduction new accounts see first.
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
}

type Point = { x: number; y: number };
async function touchDrag(page: Page, from: Point, to: Point, { steps = 12, ms = 240, hold = 0 } = {}) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from.x, y: from.y, id: 1 }] });
  for (let i = 1; i <= steps; i++) {
    const x = from.x + ((to.x - from.x) * i) / steps;
    const y = from.y + ((to.y - from.y) * i) / steps;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y, id: 1 }] });
    if (ms) await page.waitForTimeout(ms / steps);
  }
  if (hold) await page.waitForTimeout(hold);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

async function openNewPage(page: Page) {
  await page.goto("/#new");
  const sheet = page.getByRole("dialog", { name: "Neue Seite" });
  await expect(sheet).toBeVisible();
  await expect(sheet).toHaveClass(/modal-sheet/);
  // Wait for it to rise in.
  await expect.poll(() => sheet.evaluate((el) => el.getAnimations().filter((a) => a.playState === "running").length)).toBe(0);
  return sheet;
}
const handleOf = async (page: Page) => {
  const box = (await page.locator(".modal-sheet > .sheet-handle").boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};
const offsetOf = (page: Page) =>
  page.locator(".modal-sheet").evaluate((el) => {
    const t = getComputedStyle(el).transform;
    return t === "none" ? 0 : new DOMMatrixReadOnly(t).m42;
  });

test.beforeEach(({}, info) => {
  test.skip(info.project.name !== "mobile", "Sheets are a phone matter.");
});

test("a sheet stands on the bottom edge; a short pull springs back, a long one closes it", async ({ page }) => {
  await setup(page);
  const sheet = await openNewPage(page);
  const box = (await sheet.boundingBox())!;
  expect(Math.round(box.y + box.height)).toBe(844);
  await expect(page.locator(".modal-sheet > .sheet-handle")).toBeVisible();

  // Slowly, a little way, held before letting go: back up.
  const handle = await handleOf(page);
  await touchDrag(page, handle, { x: handle.x, y: handle.y + 40 }, { ms: 400, hold: 150 });
  await expect(sheet).toBeVisible();
  await expect.poll(() => offsetOf(page)).toBe(0);

  // Far enough: it leaves downwards and the dialog closes.
  await touchDrag(page, handle, { x: handle.x, y: handle.y + 260 }, { ms: 300 });
  await expect(sheet).toBeHidden();
  // Closing by dragging is closing: the app hears that back has nothing
  // left to close, as after Escape.
  expect(await page.evaluate(() => (window as unknown as { FlowplanNavigation: { canGoBack: () => boolean } }).FlowplanNavigation.canGoBack())).toBe(false);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __backStates: boolean[] }).__backStates.at(-1))).toBe(false);
});

test("a quick flick down closes the sheet from anywhere while its content is at the top; the same way slowly does not", async ({ page }) => {
  await setup(page);
  const sheet = await openNewPage(page);
  const label = (await sheet.getByText("Name", { exact: true }).boundingBox())!;
  const from = { x: label.x + 40, y: label.y + 4 };
  // 120 px is short of the distance that closes a sheet this tall …
  await touchDrag(page, from, { x: from.x, y: from.y + 120 }, { steps: 6, ms: 600, hold: 200 });
  await expect.poll(() => offsetOf(page)).toBe(0);
  await expect(sheet).toBeVisible();
  // … but flicked, it closes.
  await touchDrag(page, from, { x: from.x, y: from.y + 120 }, { steps: 4, ms: 0 });
  await expect(sheet).toBeHidden();
});

test("scrolled content scrolls instead of moving the sheet; the handle still closes it", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 520 });
  await setup(page);
  const sheet = await openNewPage(page);
  const scroll = await sheet.evaluate((el) => {
    el.scrollTop = 120;
    return { top: el.scrollTop, max: el.scrollHeight - el.clientHeight };
  });
  expect(scroll.max).toBeGreaterThan(100);
  expect(scroll.top).toBeGreaterThan(0);
  const middle = (await sheet.boundingBox())!;
  const from = { x: middle.x + middle.width / 2, y: middle.y + middle.height / 2 };
  await touchDrag(page, from, { x: from.x, y: from.y + 200 }, { ms: 300 });
  await expect(sheet).toBeVisible();
  expect(await offsetOf(page)).toBe(0);
  // The finger scrolled the content up instead.
  expect(await sheet.evaluate((el) => el.scrollTop)).toBeLessThan(scroll.top);

  await sheet.evaluate((el) => (el.scrollTop = 120));
  const handle = await handleOf(page);
  await touchDrag(page, handle, { x: handle.x, y: handle.y + 300 }, { ms: 300 });
  await expect(sheet).toBeHidden();
});

test("with reduced motion the sheet appears and leaves without animating", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await setup(page);
  await page.goto("/#new");
  const sheet = page.getByRole("dialog", { name: "Neue Seite" });
  await expect(sheet).toBeVisible();
  expect(await sheet.evaluate((el) => getComputedStyle(el).animationName)).not.toBe("sheet-in");
  const handle = await handleOf(page);
  await touchDrag(page, handle, { x: handle.x, y: handle.y + 300 }, { ms: 200 });
  // Closed at once, without a closing transition first.
  await expect(sheet).toBeHidden({ timeout: 100 });
});

test("Android's predictive back previews the top sheet and closes it on commit", async ({ page }) => {
  await setup(page);
  const sheet = await openNewPage(page);
  type Nav = { backProgress: (phase: string, progress?: number, edge?: string) => boolean; back: () => boolean };
  const progress = (phase: string, value = 0) =>
    page.evaluate(([p, v]) => (window as unknown as { FlowplanNavigation: Nav }).FlowplanNavigation.backProgress(p as string, v as number, "left"), [phase, value] as const);
  expect(await progress("start")).toBe(true);
  await progress("progress", 0.6);
  // It sinks and shrinks a little.
  const moved = await sheet.evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el).transform));
  expect(moved.m42).toBeGreaterThan(20);
  expect(moved.a).toBeLessThan(1);
  // Cancelled: back into place.
  await progress("cancel");
  await expect.poll(() => offsetOf(page)).toBe(0);
  // Committed: back() follows and closes it, as the app does.
  await progress("start");
  await progress("progress", 0.9);
  await progress("commit");
  expect(await page.evaluate(() => (window as unknown as { FlowplanNavigation: Nav }).FlowplanNavigation.back())).toBe(true);
  await expect(sheet).toBeHidden();
});
