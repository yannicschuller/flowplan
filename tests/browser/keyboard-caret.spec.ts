import { test, expect, type Page } from "@playwright/test";

// #181: typing on in a new document on an iPhone, the lines went behind the
// on-screen keyboard and the text could not even be dragged up – until the
// keyboard had been closed and opened again.
//
// iOS (Safari and the app's WKWebView, which the app does not resize) keeps
// the layout at its full height and only shrinks the visual viewport; when it
// moves the visible area down the page (offsetTop), iOS 26 also reports
// innerHeight shorter by that offset – measured on an iPhone for #120:
// innerHeight 528, visual viewport 384 high at 186, a toolbar at bottom: 0
// 144 px under the keyboard (528 + 186 = 714, the height from before the
// keyboard). Chromium cannot open a keyboard: the page gets a stand-in
// visualViewport (and innerHeight) the test sets, as hide-keyboard.spec.ts.
const KEYBOARD = 336;
const HEIGHT = 844;
async function fakeIosKeyboard(page: Page) {
  await page.addInitScript(() => {
    const real = window.visualViewport;
    if (!real) return;
    const target = new EventTarget();
    const state: { height: number | null; offsetTop: number } = { height: null, offsetTop: 0 };
    const fake = new Proxy(target, {
      get(obj, key) {
        if (key === "height") return state.height ?? real.height;
        if (key === "offsetTop") return state.offsetTop;
        if (key === "pageTop") return window.scrollY + state.offsetTop;
        if (key in obj) {
          const value = Reflect.get(obj, key, obj);
          return typeof value === "function" ? value.bind(obj) : value;
        }
        const value = Reflect.get(real, key, real);
        return typeof value === "function" ? value.bind(real) : value;
      },
    });
    real.addEventListener("resize", () => target.dispatchEvent(new Event("resize")));
    Object.defineProperty(window, "visualViewport", { configurable: true, get: () => fake });
    const innerHeight = Object.getOwnPropertyDescriptor(window, "innerHeight") ?? Object.getOwnPropertyDescriptor(Window.prototype, "innerHeight");
    const fullHeight = () => (innerHeight?.get ? innerHeight.get.call(window) : document.documentElement.clientHeight);
    // iOS 26: innerHeight loses what the visible area moved down the page.
    Object.defineProperty(window, "innerHeight", { configurable: true, get: () => fullHeight() - (state.height === null ? 0 : state.offsetTop) });
    (window as unknown as { __keyboard: (height: number, offsetTop?: number) => void }).__keyboard = (height, offsetTop = 0) => {
      state.height = height ? fullHeight() - height : null;
      state.offsetTop = height ? offsetTop : 0;
      target.dispatchEvent(new Event("resize"));
      target.dispatchEvent(new Event("scroll"));
    };
  });
}
const keyboard = (page: Page, height: number, offsetTop = 0) =>
  page.evaluate(([h, o]) => (window as unknown as { __keyboard: (h: number, o: number) => void }).__keyboard(h, o), [height, offsetTop]);

async function openNewPage(page: Page) {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const created = await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Neu ${Date.now()}`, kind: "document" },
  });
  const pageId = (await created.json()).id;
  await page.goto(`/#page=${pageId}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor).toBeVisible();
  const welcome = page.getByRole("dialog", { name: "Willkommen bei Flowplan" });
  await page.waitForTimeout(300);
  if (await welcome.isVisible()) {
    await page.keyboard.press("Escape");
    await expect(welcome).toBeHidden();
  }
  return editor;
}

// The caret's line (the block it is in, so an empty new line counts too) and
// the room between the top of the visible area and the docked toolbar.
const caretAndRoom = (page: Page) =>
  page.evaluate(() => {
    const selection = window.getSelection()!;
    const node = selection.focusNode!;
    const block = (node.nodeType === 1 ? (node as Element) : node.parentElement!).closest("p, li, h1, h2, h3, pre, blockquote")!;
    const line = block.getBoundingClientRect();
    const vv = window.visualViewport!;
    const toolbar = document.querySelector(".page-layout .editor-toolbar")!.getBoundingClientRect();
    return { top: line.top, bottom: line.bottom, visibleTop: vv.offsetTop, visibleBottom: Math.min(vv.offsetTop + vv.height, toolbar.top) };
  });

// Where the keyboard would be, and what iOS moved out of view above.
const drawKeyboard = (page: Page, top: number, hiddenAbove: number) =>
  page.evaluate(
    ([top, above]) => {
      for (const [id, css, text] of [
        ["test-keyboard", `top:${top}px;bottom:0;background:#d1d3d9ee`, "Tastatur"],
        ["test-above", `top:0;height:${above}px;background:#00000055`, ""],
      ]) {
        const el = document.createElement("div");
        el.id = id;
        el.textContent = text;
        el.style.cssText = `position:fixed;left:0;right:0;${css};z-index:2147483647;display:flex;align-items:center;justify-content:center;font:600 18px system-ui;color:#555;pointer-events:none`;
        document.body.append(el);
      }
    },
    [top, hiddenAbove],
  );
const shots = process.env.KB181_SHOTS;

for (const pan of [0, 186]) {
  test(`iOS: typing on in a new document keeps the caret above the keyboard (visible area moved ${pan} px)`, async ({ page }, info) => {
    test.skip(info.project.name !== "mobile", "The keyboard of a touch phone.");
    test.setTimeout(180_000);
    await fakeIosKeyboard(page);
    const editor = await openNewPage(page);
    await editor.tap();
    // The keyboard's first appearance: iOS reports it once, and may have
    // moved the visible area down the page to show the caret.
    await keyboard(page, KEYBOARD, pan);
    await expect(page.locator(".app-shell")).toHaveClass(/keyboard-open/);
    // The keyboard's reach into the content pane, measured against the pane:
    // the inset from innerHeight is 0 here once iOS moved the visible area.
    await expect
      .poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--keyboard-cover")))
      .toBe(`${KEYBOARD - pan}px`);
    for (let i = 1; i <= 28; i++) {
      await page.keyboard.type(`Zeile ${i} mit etwas Text`);
      await page.keyboard.press("Enter");
      if (i % 4 === 0 || i > 20) {
        await expect
          .poll(async () => {
            const c = await caretAndRoom(page);
            return c.bottom <= c.visibleBottom && c.top >= c.visibleTop;
          }, { message: `line ${i}` })
          .toBe(true);
      }
    }
    await page.keyboard.type("Hier schreibe ich gerade");
    await expect.poll(async () => {
      const c = await caretAndRoom(page);
      return c.bottom <= c.visibleBottom && c.top >= c.visibleTop;
    }).toBe(true);
    if (shots) {
      const c = await caretAndRoom(page);
      await drawKeyboard(page, pan + HEIGHT - KEYBOARD, pan);
      await page.screenshot({ path: `${shots}/typing-new-document-pan-${pan}${process.env.KB181_SUFFIX ?? ""}.png` });
      await page.evaluate(() => document.querySelectorAll("#test-keyboard, #test-above").forEach((el) => el.remove()));
      expect(c.bottom).toBeLessThanOrEqual(c.visibleBottom);
    }

    // The text can be dragged up: the pane scrolls far enough that its last
    // line clears the keyboard and the docked toolbar.
    const pane = page.locator(".main-scroll").first();
    await pane.evaluate((el) => (el.scrollTop = el.scrollHeight));
    const last = editor.locator("p").last();
    const lastBox = (await last.boundingBox())!;
    const room = await caretAndRoom(page);
    expect(lastBox.y + lastBox.height).toBeLessThanOrEqual(room.visibleBottom);
  });
}
