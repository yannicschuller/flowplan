import { test, expect, type CDPSession, type Locator, type Page } from "@playwright/test";

// The drawing block on a tablet with a pen (#440, #441):
// - palm rejection: the hand resting on the block while the pen draws
//   neither draws nor scrolls the page – also once the pen is lifted for a
//   moment and the hand slides on (lib/stylus.ts createPalmGuard), and when
//   the hand was there before the pen; a finger with the pen away scrolls;
// - a block inserted at the end of a long page comes into view with its
//   toolbar, also when the window grows as the on-screen keyboard goes, and
//   the page can be scrolled (two fingers while drawing, one after Done).
test.use({ viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true });

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
type Point = { x: number; y: number };
const pen = { pointerType: "pen" as const, button: "left" as const, buttons: 1, force: 0.5 };
const line = (from: Point, to: Point, steps = 12) => Array.from({ length: steps + 1 }, (_, i) => ({ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps }));
const strokes = (scope: Locator) => scope.locator(".ink-strokes > g[clip-path] > path:not(.ink-draft):not(.ink-lasso)");

async function setup(page: Page) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    if (!response.ok()) throw new Error(await response.text());
    return response.json();
  };
  await command({ action: "profile.onboarded" });
  return (await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Hand ${Date.now()}`, kind: "document" })).id as string;
}
async function openEditor(page: Page, id: string) {
  await page.goto(`/#page=${id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor).toBeVisible({ timeout: 30_000 });
  return editor;
}
const insertLines = (page: Page, from: number, count: number) =>
  page.evaluate(
    ({ from, count }) => {
      const editor = (document.querySelector(".ProseMirror") as unknown as { editor: { commands: { insertContent: (content: unknown) => boolean } } }).editor;
      editor.commands.insertContent(Array.from({ length: count }, (_, i) => ({ type: "paragraph", content: [{ type: "text", text: `Zeile ${from + i}` }] })));
    },
    { from, count },
  );
async function swipe(cdp: CDPSession, page: Page, x: number, from: number, to: number, fingers = 1) {
  const at = (y: number) => Array.from({ length: fingers }, (_, i) => ({ x: x + i * 60, y, id: i + 1 }));
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: at(from) });
  for (let i = 1; i <= 12; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: at(from + ((to - from) * i) / 12) });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(400);
}

test("the palm resting on a drawing block neither draws nor scrolls the page while the pen draws (#441)", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "The tablet is set up by this file; one run is enough.");
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const editor = await openEditor(page, await setup(page));
  await editor.tap();
  await page.keyboard.type("Skizze:");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/zeichnen");
  await expect(page.getByRole("option", { name: /Zeichnen/ }).first()).toBeVisible();
  await page.keyboard.press("Enter");
  const block = page.locator(".ink-block");
  await expect(block).toHaveClass(/is-active/, { timeout: 30_000 });
  await page.keyboard.press("Escape");
  await expect(block).not.toHaveClass(/is-active/);
  await insertLines(page, 0, 45);
  await expect(editor.locator("p", { hasText: "Zeile 44" })).toHaveCount(1);
  const scroller = page.locator(".main-scroll");
  // Room above the block too: a page scroll shows either way.
  await scroller.evaluate((el) => (el.scrollTop = 40));
  const scrollTop = () => scroller.evaluate((el) => el.scrollTop);
  const before = await scrollTop();
  expect(before).toBe(40);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await block.getByRole("button", { name: "Zeichnen" }).tap();
  await expect(block).toHaveClass(/is-active/);
  const layer = block.locator(".ink-layer");
  const box = (await block.locator(".ink-block-surface").boundingBox())!;
  const at = (fx: number, fy: number) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });
  const cdp = await page.context().newCDPSession(page);

  // 1. No pen on this device yet (fingers draw): the hand comes down first
  // and starts a stroke; the pen comes and that stroke goes. The hand slides
  // along while the pen draws, and on once the pen has lifted.
  const palm = { ...at(0.6, 0.8), radiusX: 8, radiusY: 8 };
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [palm] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...palm, x: palm.x + 4, y: palm.y + 3 }] });
  const first = line(at(0.08, 0.2), at(0.4, 0.35));
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: first[0].x, y: first[0].y, clickCount: 1, ...pen });
  for (const [i, p] of first.slice(1).entries()) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y, ...pen });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...palm, x: palm.x + 4 + i * 6, y: palm.y - i * 8 }] });
  }
  // The pen down (and pen-only drawing on now): the surface takes no touch gesture.
  await expect(layer).toHaveClass(/is-pen-near/);
  await expect(layer).toHaveAttribute("data-fingers", "scroll");
  const end = first[first.length - 1];
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: end.x, y: end.y, clickCount: 1, ...pen });
  // Lifted for longer than the palm window: the hand slides on (to the next line).
  const { PALM_MS } = await import("../../lib/stylus");
  await page.waitForTimeout(PALM_MS + 100);
  for (let i = 1; i <= 10; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...palm, x: palm.x + 80, y: palm.y - 40 - i * 10 }] });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(300);
  expect(await scrollTop()).toBe(before);
  // One stroke, the pen's: as far as the pen went, nowhere near the hand.
  await expect(strokes(block)).toHaveCount(1);
  const drawn = (await strokes(block).first().boundingBox())!;
  expect(drawn.x + drawn.width).toBeLessThan(at(0.45, 0).x);
  expect(drawn.width).toBeGreaterThan(box.width * 0.28);
  expect(drawn.y + drawn.height).toBeLessThan(at(0, 0.45).y);

  // 2. Pen-only drawing now (fingers scroll): a palm coming down while the
  // pen draws, also a large one, does not scroll the page – not while the
  // pen draws, and not as it slides on after the pen lifted.
  const second = line(at(0.08, 0.5), at(0.4, 0.6));
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: second[0].x, y: second[0].y, clickCount: 1, ...pen });
  const hand = { ...at(0.65, 0.85), radiusX: 30, radiusY: 34 };
  for (const [i, p] of second.slice(1).entries()) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y, ...pen });
    if (i === 2) await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [hand] });
    if (i > 2) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...hand, y: hand.y - (i - 2) * 20 }] });
  }
  const end2 = second[second.length - 1];
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: end2.x, y: end2.y, clickCount: 1, ...pen });
  await page.waitForTimeout(PALM_MS * 2);
  for (let i = 1; i <= 10; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...hand, y: hand.y - 180 + i * 20 }] });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(300);
  expect(await scrollTop()).toBe(before);
  await expect(strokes(block)).toHaveCount(2);

  // 2b. The hand rests before the pen comes (where fingers would scroll):
  // it becomes the hand with the pen's first touch, and stays it.
  await expect(layer).not.toHaveClass(/is-pen-near/);
  const early = { ...at(0.7, 0.4), radiusX: 8, radiusY: 8 };
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [early] });
  const third = line(at(0.08, 0.75), at(0.4, 0.8));
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: third[0].x, y: third[0].y, clickCount: 1, ...pen });
  for (const [i, p] of third.slice(1).entries()) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y, ...pen });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...early, y: early.y + i * 12 }] });
  }
  const end3 = third[third.length - 1];
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: end3.x, y: end3.y, clickCount: 1, ...pen });
  await page.waitForTimeout(PALM_MS * 2);
  for (let i = 1; i <= 8; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...early, y: early.y + 140 - i * 15 }] });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(300);
  expect(await scrollTop()).toBe(before);
  await expect(strokes(block)).toHaveCount(3);

  // 3. With the pen away, a fingertip on the block scrolls the page (and draws nothing).
  await page.waitForTimeout(PALM_MS * 2);
  await expect(layer).not.toHaveClass(/is-pen-near/);
  await swipe(cdp, page, box.x + box.width / 2, box.y + box.height - 20, box.y + 20);
  await expect.poll(scrollTop).toBeGreaterThan(before);
  await expect(strokes(block)).toHaveCount(3);
  expect(errors).toEqual([]);
});

test("a drawing block inserted at the end of a long page comes into view, and the page still scrolls (#440)", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "The tablet is set up by this file; one run is enough.");
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const editor = await openEditor(page, await setup(page));
  await editor.tap();
  await page.keyboard.type("Anfang");
  await insertLines(page, 0, 60);
  await expect(editor.locator("p", { hasText: "Zeile 59" })).toHaveCount(1);
  // The caret at the very end, in view; the on-screen keyboard (as in the
  // Android app, which shrinks its web view for it) takes the lower part.
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.setViewportSize({ width: 820, height: 560 });
  await page.keyboard.type("/zeichnen");
  await expect(page.getByRole("option", { name: /Zeichnen/ }).first()).toBeVisible();
  await page.getByRole("option", { name: /Zeichnen/ }).first().tap();
  const block = page.locator(".ink-block");
  await expect(block).toHaveClass(/is-active/, { timeout: 30_000 });
  const tools = page.getByRole("toolbar", { name: "Zeichenwerkzeuge" });
  await expect(tools).toBeVisible();
  const scroller = page.locator(".main-scroll");
  const seen = async () => {
    const pane = (await scroller.boundingBox())!;
    const bar = (await tools.boundingBox())!;
    const surface = (await block.locator(".ink-block-surface").boundingBox())!;
    return { pane, bar, surface };
  };
  // With the keyboard: the toolbar and the top of the block in view.
  await expect
    .poll(async () => {
      const { pane, bar, surface } = await seen();
      return bar.y >= pane.y && surface.y > bar.y && surface.y + 40 <= pane.y + pane.height;
    })
    .toBe(true);
  // The keyboard goes (the text lost the focus): the window grows, and the
  // block is fully in view with its toolbar.
  await page.setViewportSize({ width: 820, height: 1180 });
  await expect
    .poll(async () => {
      const { pane, bar, surface } = await seen();
      return bar.y >= pane.y && surface.y + surface.height <= pane.y + pane.height;
    })
    .toBe(true);
  expect(await page.evaluate(() => document.activeElement?.classList.contains("ink-block"))).toBe(true);

  // While drawing with fingers (no pen yet), two of them scroll the page;
  // the drawing gets nothing from them.
  const cdp = await page.context().newCDPSession(page);
  const top = () => scroller.evaluate((el) => el.scrollTop);
  const drawingAt = await top();
  const box = (await block.locator(".ink-block-surface").boundingBox())!;
  // (Below the tip at the block's top, #324.)
  await swipe(cdp, page, box.x + 120, box.y + box.height * 0.3, box.y + box.height * 0.95, 2);
  await expect.poll(top).toBeLessThan(drawingAt - 50);
  await expect(block).toHaveClass(/is-active/);
  await expect(strokes(block)).toHaveCount(0);

  // Done: one finger scrolls the page anywhere, up and down.
  await scroller.evaluate((el) => el.querySelector(".ink-block")!.scrollIntoView({ block: "center" }));
  await tools.getByRole("button", { name: "Fertig" }).tap();
  await expect(block).not.toHaveClass(/is-active/);
  await expect(page.locator(".ink-shield")).toHaveCount(0);
  const done = await top();
  const pane = (await scroller.boundingBox())!;
  await swipe(cdp, page, pane.x + pane.width / 2, pane.y + 200, pane.y + 700);
  await expect.poll(top).toBeLessThan(done);
  expect(errors).toEqual([]);
});
