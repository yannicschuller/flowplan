import { test, expect, type Page, type CDPSession } from "@playwright/test";

// Drawing with a pen (Apple Pencil, styluses): pressure, pen-only drawing,
// the eraser and the Pencil's double-tap from the iPad app (lib/stylus.ts).
// Pen and touch input come from the browser itself (DevTools protocol), as on
// a tablet.
test.use({ hasTouch: true });

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
type Point = { x: number; y: number };

async function pen(cdp: CDPSession, from: Point, to: Point) {
  const base = { pointerType: "pen" as const, button: "left" as const, buttons: 1, force: 0.6 };
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, clickCount: 1, ...base });
  for (let i = 1; i <= 10; i++)
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: from.x + ((to.x - from.x) * i) / 10,
      y: from.y + ((to.y - from.y) * i) / 10,
      ...base,
      force: 0.3 + i * 0.05,
    });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, clickCount: 1, ...base });
}
async function finger(cdp: CDPSession, from: Point, to: Point) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from.x, y: from.y }] });
  for (let i = 1; i <= 8; i++)
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: from.x + ((to.x - from.x) * i) / 8, y: from.y + ((to.y - from.y) * i) / 8 }],
    });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}
async function board(page: Page) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const created = await (
    await page.request.post("/api/command", {
      headers: { origin },
      data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Pencil ${Date.now()}`, kind: "whiteboard" },
    })
  ).json();
  await page.goto(`/#page=${created.id}`);
  const wb = page.getByLabel("Whiteboard", { exact: true });
  await expect(wb).toBeVisible();
  const box = (await wb.locator(".wb-canvas").boundingBox())!;
  const at = (x: number, y: number) => ({ x: box.x + box.width / 2 + x, y: box.y + box.height / 2 + y });
  return { wb, at };
}

test("the pen draws with pressure; then fingers move the board; the eraser and Pencil double-tap", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "One run covers pen and touch.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { wb, at } = await board(page);
  const cdp = await page.context().newCDPSession(page);

  await wb.getByRole("button", { name: "Stift", exact: true }).click();
  await pen(cdp, at(-100, -60), at(80, 40));
  await expect(wb.locator(".wb-pen")).toHaveCount(1);
  // A pressure stroke is a filled outline.
  await expect(wb.locator(".wb-pen path").first()).toHaveAttribute("stroke", "none");
  // The first pen switched on pen-only drawing.
  await expect(wb.getByLabel("Nur mit dem Stift zeichnen")).toBeChecked();

  // A finger (a resting hand) does not draw, it moves the board.
  const before = (await wb.locator(".wb-pen").boundingBox())!;
  await finger(cdp, at(-150, 100), at(-50, 160));
  await expect(wb.locator(".wb-pen")).toHaveCount(1);
  await expect.poll(async () => (await wb.locator(".wb-pen").boundingBox())!.x).toBeGreaterThan(before.x + 40);

  // Pencil double-tap set to "switch to eraser" (iPad settings), from the app.
  const tap = (preferred: string) =>
    page.evaluate((p) => window.dispatchEvent(new CustomEvent("flowplan:pencil", { detail: { gesture: "tap", preferred: p } })), preferred);
  await tap("switchEraser");
  await expect(wb.getByRole("button", { name: "Radierer", exact: true })).toHaveAttribute("aria-pressed", "true");
  // Erasing across the stroke removes it.
  const stroke = (await wb.locator(".wb-pen").boundingBox())!;
  await pen(cdp, { x: stroke.x + stroke.width / 2, y: stroke.y - 20 }, { x: stroke.x + stroke.width / 2, y: stroke.y + stroke.height + 20 });
  await expect(wb.locator(".wb-pen")).toHaveCount(0);
  // Double-tap again: back to the pen.
  await tap("switchEraser");
  await expect(wb.getByRole("button", { name: "Stift", exact: true })).toHaveAttribute("aria-pressed", "true");

  // Pen-only drawing switched off: fingers draw again.
  await wb.getByLabel("Nur mit dem Stift zeichnen").uncheck();
  await finger(cdp, at(-150, 100), at(-50, 160));
  await expect(wb.locator(".wb-pen")).toHaveCount(1);
  expect(errors).toEqual([]);
});

// A palm resting on the screen while the pen draws neither cuts the stroke,
// adds to it nor moves the board.
test("a resting palm does not disturb the pen", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "One run covers pen and touch.");
  const { wb, at } = await board(page);
  const cdp = await page.context().newCDPSession(page);
  await wb.getByRole("button", { name: "Stift", exact: true }).click();
  const base = { pointerType: "pen" as const, button: "left" as const, buttons: 1, force: 0.5 };
  const from = at(-120, -40),
    to = at(120, -40);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, clickCount: 1, ...base });
  const palm = at(60, 140);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [palm] });
  for (let i = 1; i <= 10; i++) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x + ((to.x - from.x) * i) / 10, y: from.y, ...base });
    if (i < 6) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: palm.x + i * 3, y: palm.y + i * 2 }] });
    // The palm lifts halfway through the stroke.
    if (i === 6) await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  }
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, clickCount: 1, ...base });
  await expect(wb.locator(".wb-pen")).toHaveCount(1);
  // One straight stroke along the pen's path: as wide as the pen moved, not
  // pulled down to the palm.
  const box = (await wb.locator(".wb-pen").boundingBox())!;
  expect(box.width).toBeGreaterThan(180);
  expect(box.height).toBeLessThan(60);
});

// With pen-only drawing off, fingers draw – but not the hand holding the pen
// right after a stroke (lib/stylus.ts palmLikely).
test("the palm after a stroke does not draw, also with pen-only drawing off", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "One run covers pen and touch.");
  const { wb, at } = await board(page);
  const cdp = await page.context().newCDPSession(page);
  await wb.getByRole("button", { name: "Stift", exact: true }).click();
  // Switched off on purpose (not "not decided yet").
  await wb.getByLabel("Nur mit dem Stift zeichnen").check();
  await wb.getByLabel("Nur mit dem Stift zeichnen").uncheck();
  await pen(cdp, at(-100, -60), at(80, 40));
  await expect(wb.locator(".wb-pen")).toHaveCount(1);
  // The setting stays off after the first pen (it was decided).
  await expect(wb.getByLabel("Nur mit dem Stift zeichnen")).not.toBeChecked();
  // At once: the palm.
  await finger(cdp, at(-150, 100), at(-50, 160));
  await expect(wb.locator(".wb-pen")).toHaveCount(1);
  // A moment later a finger draws.
  await page.waitForTimeout(700);
  await finger(cdp, at(-150, 100), at(-50, 160));
  await expect(wb.locator(".wb-pen")).toHaveCount(2);
});

// Scribble: handwriting into a sticky note's text runs past its edges; the
// pen there writes, it does not close the note or draw.
test("Scribble next to an open text field keeps it open", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "One run covers the pen.");
  const { wb, at } = await board(page);
  const cdp = await page.context().newCDPSession(page);
  // A double click makes a note and opens its text.
  const start = at(0, -80);
  await page.mouse.dblclick(start.x, start.y);
  const editor = wb.locator("textarea.wb-editor");
  await expect(editor).toBeFocused();
  await page.keyboard.type("Hallo");
  const box = (await editor.boundingBox())!;
  const near = { x: box.x + box.width + 12, y: box.y + box.height / 2 };
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: near.x, y: near.y, clickCount: 1, pointerType: "pen", button: "left", buttons: 1, force: 0.5 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: near.x, y: near.y, clickCount: 1, pointerType: "pen", button: "left", buttons: 1, force: 0.5 });
  await expect(editor).toBeVisible();
  // Far from the field the pen closes it as before.
  const far = at(-200, 150);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: far.x, y: far.y, clickCount: 1, pointerType: "pen", button: "left", buttons: 1, force: 0.5 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: far.x, y: far.y, clickCount: 1, pointerType: "pen", button: "left", buttons: 1, force: 0.5 });
  await expect(editor).toHaveCount(0);
  await expect(wb.locator(".wb-sticky", { hasText: "Hallo" })).toBeVisible();
});
