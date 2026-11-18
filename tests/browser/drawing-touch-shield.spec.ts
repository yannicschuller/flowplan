import { test, expect, type CDPSession, type Page } from "@playwright/test";

// The touch shield of a drawing block (#311, components/ink/touch-shield.tsx):
// on an iPad the hand rests beside the block while the pen draws. Entered by
// pen or finger, everything outside the block swallows touches – no taps on
// the top bar or sidebar, no scrolling – until Done (the toolbar's, the
// pill's on the shield, or Escape). A mouse user is not shielded.
test.use({ viewport: { width: 1024, height: 1366 }, isMobile: true, hasTouch: true });

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
type Point = { x: number; y: number };

async function pen(cdp: CDPSession, points: Point[]) {
  const base = { pointerType: "pen" as const, button: "left" as const, buttons: 1 };
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: points[0].x, y: points[0].y, clickCount: 1, force: 0.4, ...base });
  for (const p of points.slice(1)) await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y, force: 0.4, ...base });
  const last = points[points.length - 1];
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: last.x, y: last.y, clickCount: 1, ...base });
}
const line = (from: Point, to: Point, steps = 12) => Array.from({ length: steps + 1 }, (_, i) => ({ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps + Math.sin(i) * 4 }));

async function swipe(cdp: CDPSession, page: Page, x: number, from: number, to: number) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: from }] });
  for (let i = 1; i <= 12; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: from + ((to - from) * i) / 12 }] });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(400);
}

async function setup(page: Page) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    if (!response.ok()) throw new Error(await response.text());
    return response.json();
  };
  await command({ action: "profile.onboarded" });
  const id = (await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Skizzen ${Date.now()}`, kind: "document" })).id as string;
  return id;
}

// A document with a drawing block near the top and enough text below it to scroll.
async function documentWithBlock(page: Page, id: string, typeWith: "touch" | "mouse") {
  await page.goto(`/#page=${id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor).toBeVisible({ timeout: 30_000 });
  if (typeWith === "touch") await editor.tap();
  else await editor.click();
  await page.keyboard.type("Skizze:");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/zeichnen");
  await expect(page.getByRole("option", { name: /Zeichnen/ }).first()).toBeVisible();
  await page.keyboard.press("Enter");
  const block = page.locator(".ink-block");
  await expect(block.locator(".ink-layer")).toHaveCount(1, { timeout: 15_000 });
  // The new block starts in drawing mode; Escape goes on in the text below it.
  await expect(block).toHaveClass(/is-active/);
  // Inserted by touch, the shield is up (with the hint, the first one of the session).
  if (typeWith === "touch") await expect(page.locator(".ink-shield .ink-shield-hint")).toHaveText("Berührungen außerhalb der Zeichnung werden ignoriert");
  else await expect(page.locator(".ink-shield")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(block).not.toHaveClass(/is-active/);
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest(".ProseMirror"))).toBe(true);
  await page.keyboard.type("Zeile 0");
  // The rest at once (typing 45 lines is slow on a busy machine).
  await page.evaluate(() => {
    const editor = (document.querySelector(".ProseMirror") as unknown as { editor: { commands: { insertContent: (content: unknown) => boolean } } }).editor;
    editor.commands.insertContent(Array.from({ length: 44 }, (_, i) => ({ type: "paragraph", content: [{ type: "text", text: `Zeile ${i + 1}` }] })));
  });
  await expect(editor.locator("p", { hasText: "Zeile 44" })).toHaveCount(1);
  await page.locator(".main-scroll").evaluate((el) => (el.scrollTop = 0));
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  return block;
}

const strokes = (scope: ReturnType<Page["locator"]>) => scope.locator(".ink-strokes > g[clip-path] > path:not(.ink-draft):not(.ink-lasso)");

test("touches outside an active drawing block are ignored until Done", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "The tablet is set up by this file; one run is enough.");
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const id = await setup(page);
  const block = await documentWithBlock(page, id, "touch");
  const surface = block.locator(".ink-block-surface");
  const box = (await surface.boundingBox())!;

  // #322: the pen on the existing block draws nothing and does not enter
  // drawing – only "Zeichnen" does; then the pen draws, and the shield is up.
  const cdp = await page.context().newCDPSession(page);
  await pen(cdp, line({ x: box.x + 60, y: box.y + 60 }, { x: box.x + 300, y: box.y + 110 }));
  await page.waitForTimeout(200);
  await expect(block).not.toHaveClass(/is-active/);
  await expect(strokes(block)).toHaveCount(0);
  await expect(page.locator(".ink-shield")).toHaveCount(0);
  await block.getByRole("button", { name: "Zeichnen" }).tap();
  await expect(block).toHaveClass(/is-active/);
  // Opened with "Zeichnen", an existing block shows no height tip (#324).
  await expect(block.locator(".ink-block-tip")).toHaveCount(0);
  await pen(cdp, line({ x: box.x + 60, y: box.y + 60 }, { x: box.x + 300, y: box.y + 110 }));
  await expect(strokes(block)).toHaveCount(1);
  const shield = page.locator(".ink-shield");
  await expect(shield).toBeAttached();
  await expect(shield).toHaveAttribute("aria-hidden", "true");
  // The hint came with the first shield (the new block's).
  await expect(shield.locator(".ink-shield-hint")).toHaveCount(0);

  // A tap on the top bar's workspace link and on the sidebar does nothing.
  const home = page.locator(".topbar .breadcrumb-workspace");
  const homeBox = (await home.boundingBox())!;
  const hash = await page.evaluate(() => location.hash);
  await page.evaluate(() => {
    const w = window as unknown as { __hits: string[] };
    w.__hits = [];
    for (const type of ["click", "focusin"]) document.addEventListener(type, (e) => w.__hits.push(`${type}:${(e.target as Element).className}`), true);
  });
  await page.touchscreen.tap(homeBox.x + homeBox.width / 2, homeBox.y + homeBox.height / 2);
  const sidebar = (await page.locator(".sidebar .sidebar-scroll").boundingBox())!;
  await page.touchscreen.tap(sidebar.x + 40, sidebar.y + 30);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => location.hash)).toBe(hash);
  await expect(block).toHaveClass(/is-active/);
  const hits = await page.evaluate(() => (window as unknown as { __hits: string[] }).__hits);
  expect(hits.filter((h) => !h.includes("ink-shield-panel"))).toEqual([]);

  // A swipe outside the block (below it, and on the sidebar) does not scroll the document.
  const scroller = page.locator(".main-scroll");
  expect(await scroller.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(100);
  const before = await scroller.evaluate((el) => el.scrollTop);
  const below = box.y + box.height + 120;
  await swipe(cdp, page, box.x + box.width / 2, below + 300, below);
  await swipe(cdp, page, sidebar.x + 60, sidebar.y + 500, sidebar.y + 100);
  expect(await scroller.evaluate((el) => el.scrollTop)).toBe(before);

  // Drawing inside still works.
  await pen(cdp, line({ x: box.x + 80, y: box.y + 160 }, { x: box.x + 320, y: box.y + 200 }));
  await expect(strokes(block)).toHaveCount(2);

  // Done in the block's toolbar ends it; taps outside work again.
  await page.getByRole("toolbar", { name: "Zeichenwerkzeuge" }).getByRole("button", { name: "Fertig" }).tap();
  await expect(shield).toHaveCount(0);
  await expect(block).not.toHaveClass(/is-active/);
  await swipe(cdp, page, box.x + box.width / 2, below + 300, below);
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(before);
  await scroller.evaluate((el) => (el.scrollTop = 0));

  // #322: a finger swiping across the existing block scrolls the document
  // and does not enter drawing; "Zeichnen" does.
  const inside = (await surface.boundingBox())!;
  await swipe(cdp, page, inside.x + inside.width / 2, inside.y + inside.height - 20, inside.y + 20);
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await expect(block).not.toHaveClass(/is-active/);
  await expect(strokes(block)).toHaveCount(2);
  await block.getByRole("button", { name: "Zeichnen" }).tap();
  await expect(block).toHaveClass(/is-active/);
  await page.getByRole("toolbar", { name: "Zeichenwerkzeuge" }).getByRole("button", { name: "Fertig" }).tap();
  await expect(block).not.toHaveClass(/is-active/);
  await scroller.evaluate((el) => (el.scrollTop = 0));

  // Again with the pen – a pen tap on "Zeichnen" (no hint the second time).
  // The block's Done is on screen, so the shield has none of its own;
  // scrolled away, the shield's Done pill is the way out and ends it.
  const start = (await block.getByRole("button", { name: "Zeichnen" }).boundingBox())!;
  await pen(cdp, [{ x: start.x + start.width / 2, y: start.y + start.height / 2 }]);
  await expect(block).toHaveClass(/is-active/);
  await pen(cdp, line({ x: box.x + 400, y: box.y + 140 }, { x: box.x + 560, y: box.y + 170 }));
  await expect(shield).toBeAttached();
  await expect(shield.locator(".ink-shield-hint")).toHaveCount(0);
  const pill = shield.getByRole("button", { name: "Fertig", includeHidden: true });
  await expect(pill).toBeHidden();
  await scroller.evaluate((el) => (el.scrollTop += el.querySelector(".ink-block")!.getBoundingClientRect().top - el.getBoundingClientRect().top + 20));
  await expect(pill).toBeVisible();
  await pill.tap();
  await expect(shield).toHaveCount(0);
  await expect(block).not.toHaveClass(/is-active/);
  await scroller.evaluate((el) => (el.scrollTop = 0));

  // And once more; Escape ends it.
  await block.getByRole("button", { name: "Zeichnen" }).tap();
  await expect(shield).toBeAttached();
  await page.keyboard.press("Escape");
  await expect(shield).toHaveCount(0);
  await expect(block).not.toHaveClass(/is-active/);

  // Now the top bar link works.
  await page.touchscreen.tap(homeBox.x + homeBox.width / 2, homeBox.y + homeBox.height / 2);
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#home");
  expect(errors).toEqual([]);
});

// What the iPad's text input sees (#311): Scribble writes into a focused
// editable element or one with a caret near the pen; the on-screen keyboard
// comes for a focused editable element. Real Scribble and the keyboard
// cannot run here – these are the conditions behind them.
const textState = (page: Page) =>
  page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    const editor = document.querySelector(".ProseMirror") as HTMLElement;
    const selection = window.getSelection();
    return {
      inEditor: !!active && editor.contains(active),
      editable: !!active?.isContentEditable,
      caretInText: !!selection?.rangeCount && editor.contains(selection.anchorNode),
      editorEditable: editor.getAttribute("contenteditable"),
      inputmode: [...document.querySelectorAll("[inputmode='none']")].length,
      readonly: !!active?.closest("[readonly]"),
    };
  });

// A stylus touch on the canvas is cancelled (WebKit starts no Scribble for
// it); a finger's is not while the block is not drawing (fingers scroll).
const touchCancelled = (page: Page, type: "stylus" | "direct") =>
  page.locator(".ink-block-surface").evaluate((surface, touchType) => {
    const box = surface.getBoundingClientRect();
    const target = surface.querySelector(".ink-layer") || surface;
    const touch = new Touch({ identifier: Date.now(), target, clientX: box.left + 50, clientY: box.top + 50 });
    // Chromium's Touch has no touchType (WebKit's has); set it by hand.
    Object.defineProperty(touch, "touchType", { value: touchType });
    const event = new TouchEvent("touchstart", { bubbles: true, cancelable: true, touches: [touch], targetTouches: [touch], changedTouches: [touch] });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  }, type);

test("a new drawing block starts drawing without a caret in the text; afterwards a tap brings the keyboard back", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "The tablet is set up by this file; one run is enough.");
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const id = await setup(page);
  await page.goto(`/#page=${id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor).toBeVisible({ timeout: 30_000 });
  await editor.tap();
  await page.keyboard.type("Oben");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/zeichnen");
  await expect(page.getByRole("option", { name: /Zeichnen/ }).first()).toBeVisible();
  await page.getByRole("option", { name: /Zeichnen/ }).first().tap();

  // 1. Active at once, shielded (a touch device), and the text has neither
  // the focus nor a caret.
  const block = page.locator(".ink-block");
  await expect(block).toHaveClass(/is-active/, { timeout: 30_000 });
  const shield = page.locator(".ink-shield");
  await expect(shield).toBeAttached();
  await expect.poll(() => textState(page)).toMatchObject({ editable: false, caretInText: false });
  expect(await page.evaluate(() => document.activeElement?.classList.contains("ink-block"))).toBe(true);
  // The block is no editable target: its node is contenteditable=false.
  await expect(page.locator(".ink-block-node")).toHaveAttribute("contenteditable", "false");
  await expect(shield.locator("[contenteditable]")).toHaveCount(0);
  // Scribble's way in: stylus touches on the canvas are cancelled.
  expect(await touchCancelled(page, "stylus")).toBe(true);

  // The pen draws, and the text still gets nothing.
  const cdp = await page.context().newCDPSession(page);
  const box = (await block.locator(".ink-block-surface").boundingBox())!;
  await pen(cdp, line({ x: box.x + 60, y: box.y + 60 }, { x: box.x + 300, y: box.y + 110 }));
  await expect(strokes(block)).toHaveCount(1);
  await expect.poll(() => textState(page)).toMatchObject({ editable: false, caretInText: false });
  await expect(editor.locator("p").filter({ hasText: /\S/ })).toHaveText(["Oben"]);

  // 3. One Done: the block's own is on screen, the shield shows none.
  const tools = page.getByRole("toolbar", { name: "Zeichenwerkzeuge" });
  await expect(tools.getByRole("button", { name: "Fertig" })).toBeVisible();
  await expect(shield.locator(".ink-shield-done")).toBeHidden();

  // 4. Done; a tap on the text focuses the editor (editable, no
  // inputmode=none, nothing read-only) and typing works.
  await tools.getByRole("button", { name: "Fertig" }).tap();
  await expect(shield).toHaveCount(0);
  await expect(block).not.toHaveClass(/is-active/);
  expect(await page.evaluate(() => !!document.activeElement?.closest(".ink-block"))).toBe(false);
  const first = editor.locator("p", { hasText: "Oben" });
  const at = (await first.boundingBox())!;
  await page.touchscreen.tap(at.x + at.width - 4, at.y + at.height / 2);
  await expect.poll(() => textState(page)).toEqual({ inEditor: true, editable: true, caretInText: true, editorEditable: "true", inputmode: 0, readonly: false });
  await page.keyboard.type(" weiter");
  await expect(first).toHaveText(/Oben weiter/);
  // A finger on the canvas of the inactive block is not cancelled (it scrolls)
  // – once the pen is away: until PALM_MS after its last stroke a finger
  // counts as the palm holding it (lib/stylus.ts), and against the
  // production build the steps since the stroke take less than that.
  const { PALM_MS } = await import("../../lib/stylus");
  await page.waitForTimeout(PALM_MS);
  expect(await touchCancelled(page, "direct")).toBe(false);
  // Neither is the Pencil's (#322): on a block that is not being drawn on,
  // it scrolls like a finger – and draws nothing, enters nothing.
  expect(await touchCancelled(page, "stylus")).toBe(false);
  expect(await pointer(page, ".ink-block .ink-block-surface", "pointerdown", { pointerType: "pen", buttons: 1, dx: 80, dy: 80 })).toBe(false);
  await pointer(page, ".ink-block .ink-block-surface", "pointerup", { pointerType: "pen", dx: 80, dy: 80 });
  await pen(cdp, line({ x: box.x + 80, y: box.y + 160 }, { x: box.x + 320, y: box.y + 200 }));
  await page.waitForTimeout(200);
  await expect(block).not.toHaveClass(/is-active/);
  await expect(strokes(block)).toHaveCount(1);
  await expect(shield).toHaveCount(0);

  // Escape ends drawing too, with the caret in the text below the block.
  await block.getByRole("button", { name: "Zeichnen" }).tap();
  await pen(cdp, line({ x: box.x + 80, y: box.y + 160 }, { x: box.x + 320, y: box.y + 200 }));
  await expect(block).toHaveClass(/is-active/);
  await expect(strokes(block)).toHaveCount(2);
  await expect.poll(() => textState(page)).toMatchObject({ editable: false, caretInText: false });
  await page.keyboard.press("Escape");
  await expect(block).not.toHaveClass(/is-active/);
  await expect.poll(() => textState(page)).toMatchObject({ inEditor: true, editable: true });
  await page.keyboard.type("Unten");
  await expect(editor.locator("p", { hasText: "Unten" })).toHaveCount(1);
  expect(
    await editor.evaluate((el) => {
      const blockNode = el.querySelector(".ink-block-node")!;
      const paragraph = [...el.querySelectorAll("p")].find((p) => p.textContent === "Unten")!;
      return !!(blockNode.compareDocumentPosition(paragraph) & Node.DOCUMENT_POSITION_FOLLOWING);
    }),
  ).toBe(true);

  // Deleting the block while drawing: shield gone, the text takes taps and keys.
  await block.getByRole("button", { name: "Zeichnen" }).tap();
  await expect(shield).toBeAttached();
  // (As a collaborator's change or undo would: not through the block's own UI.)
  await page.evaluate(() => {
    type Node = { type: { name: string }; nodeSize: number };
    type View = { state: { doc: { descendants: (f: (n: Node, pos: number) => void) => void }; tr: { delete: (a: number, b: number) => unknown } }; dispatch: (tr: unknown) => void };
    const { view } = (document.querySelector(".ProseMirror") as unknown as { editor: { view: View } }).editor;
    let found: [number, number] | null = null;
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === "drawBlock") found = [pos, pos + node.nodeSize];
    });
    if (found) view.dispatch(view.state.tr.delete(...(found as [number, number])));
  });
  await expect(block).toHaveCount(0);
  await expect(shield).toHaveCount(0);
  await page.touchscreen.tap(at.x + at.width - 4, at.y + at.height / 2);
  await expect.poll(() => textState(page)).toMatchObject({ inEditor: true, editable: true, editorEditable: "true", inputmode: 0 });
  await page.keyboard.type("!");
  await expect(first).toHaveText(/Oben weiter!/);
  expect(errors).toEqual([]);
});

// The hovering Apple Pencil (#315). Synthetic pointer events: Chromium's
// own pen input does not hover. Real Pencil hover and Scribble are not
// available here; these check the mechanism.
const pointer = (page: Page, selector: string, type: string, init: { pointerType: string; buttons?: number; dx?: number; dy?: number }) =>
  page.locator(selector).first().evaluate(
    (el, { type, init }) => {
      const box = el.getBoundingClientRect();
      const event = new PointerEvent(type, {
        bubbles: type !== "pointerleave",
        cancelable: true,
        pointerId: 7,
        pointerType: init.pointerType,
        buttons: init.buttons ?? 0,
        clientX: box.left + (init.dx ?? box.width / 2),
        clientY: box.top + (init.dy ?? box.height / 2),
      });
      el.dispatchEvent(event);
      return event.defaultPrevented;
    },
    { type, init },
  );

test("the hovering pen: controls light up, a dot shows where it draws, a pen tap on Done feeds no Scribble", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "The tablet is set up by this file; one run is enough.");
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const id = await setup(page);
  await page.goto(`/#page=${id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor).toBeVisible({ timeout: 30_000 });
  await editor.tap();
  await page.keyboard.type("/zeichnen");
  await page.getByRole("option", { name: /Zeichnen/ }).first().tap();
  const block = page.locator(".ink-block");
  await expect(block).toHaveClass(/is-active/, { timeout: 30_000 });
  const tools = page.getByRole("toolbar", { name: "Zeichenwerkzeuge" });

  // Hover feedback on a colour, a tool and the paper menu – only for the pen.
  const swatch = ".ink-block .ink-toolbar .ink-swatch:not(.active)";
  await pointer(page, swatch, "pointerover", { pointerType: "pen" });
  await expect(page.locator(swatch).first()).toHaveClass(/is-pen-hover/);
  await pointer(page, ".ink-block .ink-toolbar [role='radio'][aria-label='Radierer']", "pointermove", { pointerType: "pen" });
  await expect(page.locator(swatch).first()).not.toHaveClass(/is-pen-hover/);
  await expect(tools.getByRole("radio", { name: "Radierer" })).toHaveClass(/is-pen-hover/);
  await pointer(page, ".ink-block-paper select", "pointermove", { pointerType: "pen" });
  await expect(page.locator(".ink-block-paper select")).toHaveClass(/is-pen-hover/);
  // A finger or the mouse: no pen hover (and nothing sticky after a tap).
  await pointer(page, swatch, "pointermove", { pointerType: "touch" });
  await expect(page.locator(".is-pen-hover")).toHaveCount(0);
  await pointer(page, swatch, "pointerover", { pointerType: "pen" });
  await pointer(page, swatch, "pointerdown", { pointerType: "pen", buttons: 1 });
  await expect(page.locator(".is-pen-hover")).toHaveCount(0);
  await pointer(page, swatch, "pointerup", { pointerType: "pen" });

  // The dot follows the hovering pen over the canvas, in the pen's colour.
  const dot = block.locator(".ink-pen-dot");
  await expect(dot).not.toHaveClass(/is-shown/);
  await pointer(page, ".ink-block .ink-layer", "pointermove", { pointerType: "pen", dx: 120, dy: 80 });
  await expect(dot).toHaveClass(/is-shown/);
  expect(await dot.evaluate((el) => [el.style.getPropertyValue("--dot-x"), el.style.getPropertyValue("--dot-y")])).toEqual(["120px", "80px"]);
  const dotBox = (await dot.boundingBox())!;
  const layerBox = (await block.locator(".ink-layer").boundingBox())!;
  expect(Math.abs(dotBox.x + dotBox.width / 2 - (layerBox.x + 120))).toBeLessThan(2);
  // A pinpoint, not a blob over the line one aims at (#315).
  expect(dotBox.width).toBeLessThanOrEqual(2.5);
  // Drawing (pen down), a mouse, a finger, leaving: no dot.
  await pointer(page, ".ink-block .ink-layer", "pointermove", { pointerType: "pen", buttons: 1, dx: 130, dy: 80 });
  await expect(dot).not.toHaveClass(/is-shown/);
  await pointer(page, ".ink-block .ink-layer", "pointermove", { pointerType: "pen", dx: 140, dy: 80 });
  await expect(dot).toHaveClass(/is-shown/);
  await pointer(page, ".ink-block .ink-layer", "pointermove", { pointerType: "mouse", dx: 150, dy: 80 });
  await expect(dot).not.toHaveClass(/is-shown/);
  await pointer(page, ".ink-block .ink-layer", "pointermove", { pointerType: "pen", dx: 160, dy: 80 });
  await expect(dot).toHaveClass(/is-shown/);
  await pointer(page, ".ink-block .ink-block-surface", "pointerleave", { pointerType: "pen" });
  await expect(dot).not.toHaveClass(/is-shown/);
  // The eraser's ring is as wide as what it erases: the whole-stroke
  // eraser's radius of 6 screen pixels (lib/ink/eraser.ts).
  await tools.getByRole("radio", { name: "Radierer" }).click();
  await pointer(page, ".ink-block .ink-layer", "pointermove", { pointerType: "pen", dx: 170, dy: 80 });
  await expect(dot).toHaveClass(/is-shown/);
  expect(Math.round((await dot.boundingBox())!.width)).toBe(12);
  await pointer(page, ".ink-block .ink-block-surface", "pointerleave", { pointerType: "pen" });

  // A stylus touch on the toolbar is cancelled (no Scribble), and the pen's
  // tap on Done still ends drawing – clicked once, on pointerup.
  const done = ".ink-block .ink-toolbar .ink-done";
  expect(
    await page.locator(done).evaluate((el) => {
      const box = el.getBoundingClientRect();
      const touch = new Touch({ identifier: 3, target: el, clientX: box.left + 5, clientY: box.top + 5 });
      Object.defineProperty(touch, "touchType", { value: "stylus" });
      const event = new TouchEvent("touchstart", { bubbles: true, cancelable: true, touches: [touch], targetTouches: [touch], changedTouches: [touch] });
      const w = window as unknown as { __clicks: number };
      w.__clicks = 0;
      el.addEventListener("click", () => w.__clicks++);
      el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "pen", buttons: 1, clientX: box.left + 5, clientY: box.top + 5 }));
      el.dispatchEvent(event);
      return event.defaultPrevented;
    }),
  ).toBe(true);
  // The paper menu keeps its stylus touch (its picker opens natively).
  expect(await touchOn(page, ".ink-block-paper select")).toBe(false);
  await pointer(page, done, "pointerup", { pointerType: "pen", dx: 5, dy: 5 });
  await expect(block).not.toHaveClass(/is-active/);
  expect(await page.evaluate(() => (window as unknown as { __clicks: number }).__clicks)).toBe(1);
  await expect(page.locator(".ink-shield")).toHaveCount(0);
  expect(errors).toEqual([]);
});

// Whether a stylus touchstart on the element is cancelled.
const touchOn = (page: Page, selector: string) =>
  page.locator(selector).first().evaluate((el) => {
    const touch = new Touch({ identifier: 4, target: el, clientX: 1, clientY: 1 });
    Object.defineProperty(touch, "touchType", { value: "stylus" });
    const event = new TouchEvent("touchstart", { bubbles: true, cancelable: true, touches: [touch], targetTouches: [touch], changedTouches: [touch] });
    el.dispatchEvent(event);
    return event.defaultPrevented;
  });

test("mouse users are not shielded: a click outside leaves drawing and does its work", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "One run is enough.");
  test.setTimeout(120_000);
  // browser.newContext() takes this file's test.use() (a touch tablet): a
  // mouse-only device says so.
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false, locale: "de-DE", storageState: { cookies: [], origins: [{ origin, localStorage: [{ name: "flowplan-offline-offer", value: "never" }] }] } });
  const page = await context.newPage();
  const id = await setup(page);
  const block = await documentWithBlock(page, id, "mouse");
  const box = (await block.locator(".ink-block-surface").boundingBox())!;
  // A click on an existing block's surface does not enter drawing (#322);
  // "Zeichnen" does.
  const drawn = await strokes(block).count();
  await page.mouse.click(box.x + 100, box.y + 100);
  await page.waitForTimeout(200);
  await expect(block).not.toHaveClass(/is-active/);
  await expect(strokes(block)).toHaveCount(drawn);
  // The height handle is there while not drawing, and gone while drawing
  // (#324: a resting palm must not resize the block).
  const handle = block.getByRole("separator", { name: "Höhe der Zeichnung" });
  await expect(handle).toBeVisible();
  await block.getByRole("button", { name: "Zeichnen" }).click();
  await expect(block).toHaveClass(/is-active/);
  await expect(page.getByRole("toolbar", { name: "Zeichenwerkzeuge" })).toBeVisible();
  await expect(handle).toHaveCount(0);
  await expect(page.locator(".ink-shield")).toHaveCount(0);
  await page.locator(".topbar .breadcrumb-workspace").click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#home");
  await context.close();
});

// The order of the document's blocks: "ink" for a drawing block, the text
// of the others (empty paragraphs left out).
const blockOrder = (page: Page) =>
  page.evaluate(() => {
    type Doc = { forEach: (f: (n: { type: { name: string }; textContent: string }) => void) => void };
    const { state } = (document.querySelector(".ProseMirror") as unknown as { editor: { state: { doc: Doc } } }).editor;
    const out: string[] = [];
    state.doc.forEach((n) => out.push(n.type.name === "drawBlock" ? "ink" : n.textContent));
    return out.filter(Boolean);
  });

// A document "Oben", a drawing block with one stroke, "Unten".
async function sandwich(page: Page, press: "tap" | "click") {
  const id = await setup(page);
  await page.goto(`/#page=${id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor).toBeVisible({ timeout: 30_000 });
  await editor[press]();
  await page.keyboard.type("Oben");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/zeichnen");
  await expect(page.getByRole("option", { name: /Zeichnen/ }).first()).toBeVisible();
  await page.keyboard.press("Enter");
  const block = page.locator(".ink-block").first();
  await expect(block).toHaveClass(/is-active/, { timeout: 30_000 });
  const cdp = await page.context().newCDPSession(page);
  const box = (await block.locator(".ink-block-surface").boundingBox())!;
  await pen(cdp, line({ x: box.x + 30, y: box.y + box.height - 60 }, { x: box.x + Math.min(300, box.width - 30), y: box.y + box.height - 40 }));
  await expect(strokes(block)).toHaveCount(1);
  // Saved (on a phone the toolbar has no room for its save state).
  const blockId = await page.locator("[data-ink-block]").first().getAttribute("data-ink-block");
  await expect
    .poll(async () => Number(((await (await page.request.get(`/api/pages/${id}/ink`)).json()) as { versions: Record<string, number> }).versions[blockId!] || 0), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(1);
  await page.keyboard.press("Escape");
  await expect(block).not.toHaveClass(/is-active/);
  await page.keyboard.type("Unten");
  await expect.poll(() => blockOrder(page)).toEqual(["Oben", "ink", "Unten"]);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  return { id, block };
}

// #322: on an iPad the block handle is out of reach once the block takes
// touches; the block's own "…" menu beside "Zeichnen" deletes, duplicates
// and moves it – with a mouse, on a phone (a bottom sheet) and on a tablet.
const menuDevices = [
  { project: "desktop", name: "mouse", press: "click", options: { viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false } },
  { project: "mobile", name: "phone", press: "tap", options: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  { project: "mobile", name: "tablet", press: "tap", options: { viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true } },
] as const;
for (const device of menuDevices)
  test(`the drawing block's … menu moves, duplicates, resets the height and deletes it (${device.name})`, async ({ browser }, info) => {
    test.skip(info.project.name !== device.project, "One device per run.");
    test.setTimeout(180_000);
    const context = await browser.newContext({ ...device.options, locale: "de-DE", storageState: { cookies: [], origins: [{ origin, localStorage: [{ name: "flowplan-offline-offer", value: "never" }] }] } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const { id } = await sandwich(page, device.press);
    const more = page.getByRole("button", { name: "Weitere Aktionen für den Zeichenblock" });
    await expect(more).toBeVisible();
    if (device.press === "tap") {
      // A finger's target: at least 40 px.
      const size = (await more.boundingBox())!;
      expect(Math.min(size.width, size.height)).toBeGreaterThanOrEqual(40);
    }
    const item = (name: string) => page.getByRole("menuitem", { name, exact: true });
    const choose = async (name: string, of = more) => {
      await of[device.press]();
      await expect(item(name)).toBeVisible();
      await item(name)[device.press]();
      await expect(item(name)).toHaveCount(0);
    };

    // Moves: down past "Unten", then the way back.
    await choose("Nach unten");
    await expect.poll(() => blockOrder(page)).toEqual(["Oben", "Unten", "ink"]);
    await more[device.press]();
    await expect(item("Höhe zurücksetzen")).toBeDisabled();
    await item("Nach oben")[device.press]();
    await expect.poll(() => blockOrder(page)).toEqual(["Oben", "ink", "Unten"]);
    await expect(page.locator(".ink-block")).not.toHaveClass(/is-active/);

    // The height back to the default once it was changed.
    const handle = page.getByRole("separator", { name: "Höhe der Zeichnung" });
    await handle.focus();
    await page.keyboard.press("ArrowDown");
    await expect(handle).toHaveAttribute("aria-valuenow", "340");
    await choose("Höhe zurücksetzen");
    await expect(handle).toHaveAttribute("aria-valuenow", "300");

    // Duplicate: a second block with an id of its own, starting with the ink.
    const nodes = page.locator("[data-ink-block]");
    const firstId = await nodes.first().getAttribute("data-ink-block");
    await choose("Duplizieren");
    await expect.poll(() => blockOrder(page)).toEqual(["Oben", "ink", "ink", "Unten"]);
    await expect(nodes).toHaveCount(2);
    const ids = await nodes.evaluateAll((els) => els.map((el) => el.getAttribute("data-ink-block")));
    expect(ids[0]).toBe(firstId);
    expect(ids[1]).not.toBe(firstId);
    const copy = page.locator(".ink-block").nth(1);
    await expect(strokes(copy)).toHaveCount(1, { timeout: 15_000 });
    // Delete the copy through its own menu.
    await choose("Löschen", more.nth(1));
    await expect.poll(() => blockOrder(page)).toEqual(["Oben", "ink", "Unten"]);
    await expect(nodes).toHaveCount(1);
    await expect(nodes).toHaveAttribute("data-ink-block", firstId!);

    if (device.name === "mouse") {
      // From the keyboard: Enter opens the menu on its first entry, Enter
      // runs it, and the focus stays on the moved block's "…".
      await more.focus();
      await page.keyboard.press("Enter");
      await expect(item("Nach oben")).toBeFocused();
      await page.keyboard.press("Enter");
      await expect.poll(() => blockOrder(page)).toEqual(["ink", "Oben", "Unten"]);
      await expect(more).toBeFocused();
      // At the top "Nach oben" is off; Escape closes the menu and gives the
      // focus back to "…".
      await page.keyboard.press("Enter");
      await expect(page.getByRole("menu")).toBeVisible();
      await expect(item("Nach oben")).toBeDisabled();
      await expect(item("Nach unten")).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toHaveCount(0);
      await expect(more).toBeFocused();
      await expect(page.locator(".ink-block")).not.toHaveClass(/is-active/);
      await choose("Nach unten");
      await expect.poll(() => blockOrder(page)).toEqual(["Oben", "ink", "Unten"]);

      // A locked page: no "…" (and no "Zeichnen").
      const lock = (locked: boolean) => page.request.post("/api/command", { headers: { origin }, data: { action: "page.update", pageId: id, patch: { locked } } });
      expect((await lock(true)).ok()).toBe(true);
      await page.reload();
      await expect(nodes).toHaveCount(1, { timeout: 30_000 });
      await page.waitForTimeout(1500);
      await expect(more).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Zeichnen" })).toHaveCount(0);
      expect((await lock(false)).ok()).toBe(true);
      await page.reload();
      await expect(more).toBeVisible({ timeout: 30_000 });
    }

    // Delete: the block goes, the text stays; undo brings it back.
    await choose("Löschen");
    await expect(page.locator(".ink-block")).toHaveCount(0);
    await expect.poll(() => blockOrder(page)).toEqual(["Oben", "Unten"]);
    if (device.name === "mouse") {
      await page.getByLabel("Dokumentinhalt", { exact: true }).locator("p", { hasText: "Unten" }).click();
      await page.keyboard.press("ControlOrMeta+z");
      await expect.poll(() => blockOrder(page)).toEqual(["Oben", "ink", "Unten"]);
      await expect(strokes(page.locator(".ink-block"))).toHaveCount(1, { timeout: 15_000 });
    }
    expect(errors).toEqual([]);
    await context.close();
  });

// #324: the first new drawing block on a device says, for a few seconds and
// at its top (the drawing hand covers the bottom), where its height is
// changed after Done. Not again with the next new block; a tap dismisses it.
test("the first new drawing block shows the height tip at its top, once", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "The tablet is set up by this file; one run is enough.");
  test.setTimeout(180_000);
  const id = await setup(page);
  await page.goto(`/#page=${id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor).toBeVisible({ timeout: 30_000 });
  await editor.tap();
  const insert = async () => {
    await page.keyboard.type("/zeichnen");
    await expect(page.getByRole("option", { name: /Zeichnen/ }).first()).toBeVisible();
    await page.keyboard.press("Enter");
    const block = page.locator(".ink-block.is-active");
    await expect(block).toHaveCount(1, { timeout: 30_000 });
    return block;
  };
  const block = await insert();
  const tip = block.locator(".ink-block-tip");
  await expect(tip).toHaveText(/Tipp: Nach „Fertig“ änderst du die Höhe am unteren Rand\./);
  await expect(tip).toHaveAttribute("role", "status");
  await expect(tip).toHaveAttribute("aria-live", "polite");
  // At the top of the block, clear of its lower half.
  const at = (await tip.boundingBox())!;
  const surface = (await block.locator(".ink-block-surface").boundingBox())!;
  expect(at.y - surface.y).toBeLessThan(20);
  expect(at.y + at.height).toBeLessThan(surface.y + surface.height / 2);
  // A few seconds, then gone by itself.
  await page.waitForTimeout(2500);
  await expect(tip).toBeVisible();
  await expect(tip).toHaveCount(0, { timeout: 6000 });
  await expect(block).toHaveClass(/is-active/);
  await page.keyboard.press("Escape");
  await expect(page.locator(".ink-block.is-active")).toHaveCount(0);

  // The second new block: no tip.
  await insert();
  await page.waitForTimeout(800);
  await expect(page.locator(".ink-block-tip")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.locator(".ink-block.is-active")).toHaveCount(0);

  // On a device that has not seen it yet, a tap dismisses it at once
  // (the block keeps drawing, the tap draws nothing).
  const { HEIGHT_TIP_KEY } = await import("../../lib/draw-block-actions");
  await page.evaluate((key) => localStorage.removeItem(key), HEIGHT_TIP_KEY);
  const third = await insert();
  const again = third.locator(".ink-block-tip");
  await expect(again).toBeVisible();
  await again.locator("span").tap();
  await expect(again).toHaveCount(0);
  await expect(third).toHaveClass(/is-active/);
  await expect(strokes(third)).toHaveCount(0);
});
