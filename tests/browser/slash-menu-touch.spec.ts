import { test, expect, type Page } from "@playwright/test";

// iOS app: typing "/" in a document with the keyboard open, the block menu
// could not be scrolled. It was placed against innerHeight: below the caret
// it lay behind the keyboard and the toolbar docked on it (where a blocker
// takes the touches – a swipe there closed the menu), above it up under the
// status bar and out of view when iOS had moved the visible area down the
// page. It belongs inside the visible area, right at the caret's line, and
// scrolls under the finger without closing, blurring the editor or touching
// the block handles.
//
// Chromium cannot open a keyboard: like keyboard-caret.spec.ts the page gets
// a stand-in visualViewport (and innerHeight as the app's WKWebView on iOS 26
// reports it), and the touches go in through the DevTools protocol.
const KEYBOARD = 336;

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
  page.evaluate(([h, o]) => (window as unknown as { __keyboard: (h: number, o: number) => void }).__keyboard(h, o), [height, offsetTop] as const);

// The menu, the visible area (above the docked toolbar) and the caret's line.
const layout = (page: Page) =>
  page.evaluate(() => {
    const menu = document.querySelector(".slash-menu")!.getBoundingClientRect();
    const list = document.querySelector<HTMLElement>(".slash-menu-list")!;
    const vv = window.visualViewport!;
    const toolbar = document.querySelector(".page-layout .editor-toolbar")!.getBoundingClientRect();
    const node = window.getSelection()!.focusNode!;
    const line = (node.nodeType === 1 ? (node as Element) : node.parentElement!).closest("p")!.getBoundingClientRect();
    return {
      menu: { top: menu.top, bottom: menu.bottom },
      line: { top: line.top, bottom: line.bottom },
      visibleTop: vv.offsetTop,
      visibleBottom: Math.min(vv.offsetTop + vv.height, toolbar.top),
      scrollTop: list.scrollTop,
      scrolls: list.scrollHeight > list.clientHeight + 20,
    };
  });

async function swipeUp(page: Page) {
  const box = (await page.locator(".slash-menu-list").boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  const x = box.x + box.width / 2,
    from = box.y + box.height * 0.85,
    to = box.y + box.height * 0.15;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: from }] });
  for (let i = 1; i <= 10; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: from + ((to - from) * i) / 10 }] });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

async function expectUsable(page: Page, editor: ReturnType<Page["getByLabel"]>) {
  const menu = page.locator(".slash-menu");
  await expect(menu).toBeVisible();
  const at = await layout(page);
  // Inside the visible area, at the caret's line (above or below it).
  expect(at.menu.top).toBeGreaterThanOrEqual(at.visibleTop);
  expect(at.menu.bottom).toBeLessThanOrEqual(at.visibleBottom);
  const gap = at.menu.top >= at.line.bottom ? at.menu.top - at.line.bottom : at.line.top - at.menu.bottom;
  expect(gap).toBeGreaterThanOrEqual(0);
  expect(gap).toBeLessThanOrEqual(12);
  expect(at.scrolls).toBe(true);
  // A swipe scrolls the entries – the menu stays, the keyboard too (the
  // editor keeps the focus), no block handle is taken.
  await swipeUp(page);
  await expect.poll(async () => (await layout(page)).scrollTop).toBeGreaterThan(40);
  await expect(menu).toBeVisible();
  await expect(editor).toBeFocused();
  await expect(page.locator(".document-block-handle.selected")).toHaveCount(0);
  await expect(page.locator(".block-action-message")).toHaveCount(0);
}

test("iOS keyboard: the / menu lies in the visible area at the caret and scrolls by touch", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "The keyboard of a touch phone.");
  test.setTimeout(180_000);
  await fakeIosKeyboard(page);
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const created = await (
    await page.request.post("/api/command", {
      headers: { origin },
      data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Slash touch ${Date.now()}`, kind: "document" },
    })
  ).json();
  await page.goto(`/#page=${created.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor).toBeVisible();
  const welcome = page.getByRole("dialog", { name: "Willkommen bei Flowplan" });
  await page.waitForTimeout(300);
  if (await welcome.isVisible()) {
    await page.keyboard.press("Escape");
    await expect(welcome).toBeHidden();
  }
  await editor.tap();
  const menu = page.locator(".slash-menu");

  // A new document: the first line, the keyboard just come up. There was
  // room below it by innerHeight – behind the keyboard.
  await keyboard(page, KEYBOARD, 0);
  await expect(page.locator(".app-shell")).toHaveClass(/keyboard-open/);
  await page.keyboard.type("/");
  await expectUsable(page, editor);
  // A tap on an entry still chooses it.
  await menu.getByRole("option", { name: /Überschrift 1/ }).tap();
  await expect(menu).toHaveCount(0);
  await expect(editor.locator("h1")).toHaveCount(1);
  await page.keyboard.type("Titel");
  await page.keyboard.press("Enter");

  // Lines down to the docked toolbar, iOS moved the visible area down the
  // page (186 px, measured for #120): the menu went up under the status bar.
  for (let i = 1; i <= 24; i++) {
    await page.keyboard.type(`Zeile ${i}`);
    await page.keyboard.press("Enter");
  }
  await keyboard(page, KEYBOARD, 186);
  await page.waitForTimeout(400);
  await page.keyboard.type("/");
  await expectUsable(page, editor);
  const at = await layout(page);
  // The caret's line sits low: the menu is above it.
  expect(at.menu.bottom).toBeLessThanOrEqual(at.line.top);
  await page.keyboard.press("Escape");
});
