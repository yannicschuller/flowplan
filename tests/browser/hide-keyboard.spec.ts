import { test, expect, type Page } from "@playwright/test";

// #120: on a touch phone the formatting toolbar that docks above the
// on-screen keyboard ends with "Tastatur ausblenden". It ends the input (the
// keyboard closes), the text stays; on a desktop the button does not exist.
async function openNewPage(page: Page) {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const created = await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Tastatur ${Date.now()}`, kind: "document" },
  });
  const pageId = (await created.json()).id;
  await page.goto(`/#page=${pageId}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor).toBeVisible();
  // A new account's welcome tour.
  const welcome = page.getByRole("dialog", { name: "Willkommen bei Flowplan" });
  if (await welcome.isVisible()) {
    await page.keyboard.press("Escape");
    await expect(welcome).toBeHidden();
  }
  return editor;
}

const focusInEditor = (page: Page) =>
  page.evaluate(() => !!document.activeElement?.closest(".ProseMirror"));

test("the docked toolbar hides the on-screen keyboard on a touch phone", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "The keyboard of a touch phone.");
  test.setTimeout(120_000);
  const editor = await openNewPage(page);
  const hide = page.getByRole("button", { name: "Tastatur ausblenden" });
  await expect(hide).toHaveCount(0);
  await editor.tap();
  await page.keyboard.type("Hinter der Tastatur");
  await expect.poll(() => focusInEditor(page)).toBe(true);
  await expect(page.locator(".app-shell")).toHaveClass(/keyboard-open/);
  // At the right end of the docked toolbar, inside the screen.
  await expect(hide).toBeVisible();
  await expect(hide).toHaveAttribute("title", "Tastatur ausblenden");
  const box = (await hide.boundingBox())!;
  const bar = (await page.locator(".page-layout .editor-toolbar").boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(bar.x + bar.width - (box.x + box.width)).toBeLessThan(16);

  await hide.tap();
  await expect.poll(() => focusInEditor(page)).toBe(false);
  // The toolbar goes back onto the tab bar, the button with the keyboard.
  await expect(page.locator(".app-shell")).not.toHaveClass(/keyboard-open/);
  await expect(hide).toHaveCount(0);
  await expect(page.locator(".mobile-tab-bar")).toBeVisible();
  await expect(editor).toHaveText("Hinter der Tastatur");

  // A tap into the text brings the keyboard back, typing goes on.
  await editor.tap();
  await expect.poll(() => focusInEditor(page)).toBe(true);
  await expect(hide).toBeVisible();
  await page.keyboard.press("End");
  await page.keyboard.type(" weiter");
  await expect(editor).toHaveText("Hinter der Tastatur weiter");
});

test("there is no hide-keyboard button on a desktop", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Desktop layout.");
  test.setTimeout(120_000);
  const editor = await openNewPage(page);
  await editor.click();
  await page.keyboard.type("Am Schreibtisch");
  await expect.poll(() => focusInEditor(page)).toBe(true);
  await expect(page.getByRole("toolbar", { name: "Textformatierung" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Tastatur ausblenden" })).toHaveCount(0);
});

// iOS (Safari, and the app's WKWebView, which the app does not resize) only
// shrinks the visual viewport for the keyboard: the layout viewport – what
// position: fixed refers to – keeps its height, and a toolbar at bottom: 0
// lies behind the keyboard. Chromium cannot open a keyboard, so the page
// gets a stand-in visualViewport whose height the test sets.
const KEYBOARD = 336;
async function fakeVisualViewport(page: Page) {
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
    (window as unknown as { __keyboard: (height: number, offsetTop?: number) => void }).__keyboard = (height, offsetTop = 0) => {
      state.height = height ? window.innerHeight - height : null;
      state.offsetTop = offsetTop;
      target.dispatchEvent(new Event("resize"));
      target.dispatchEvent(new Event("scroll"));
    };
  });
}
const keyboard = (page: Page, height: number, offsetTop = 0) =>
  page.evaluate(([h, o]) => (window as unknown as { __keyboard: (h: number, o: number) => void }).__keyboard(h, o), [height, offsetTop]);
// Where the keyboard would be, so the screenshot shows what a phone shows.
const drawKeyboard = (page: Page, top: number) =>
  page.evaluate((top) => {
    const el = document.createElement("div");
    el.id = "test-keyboard";
    el.textContent = "Tastatur";
    el.style.cssText = `position:fixed;left:0;right:0;top:${top}px;bottom:0;z-index:2147483647;background:#d1d3d9cc;display:flex;align-items:center;justify-content:center;font:600 18px system-ui;color:#555;pointer-events:none`;
    document.body.append(el);
  }, top);
const shots = process.env.KB120_SHOTS;

test("iOS: the toolbar sits above a keyboard that only shrinks the visual viewport", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "The keyboard of a touch phone.");
  test.setTimeout(120_000);
  await fakeVisualViewport(page);
  const editor = await openNewPage(page);
  const toolbar = page.getByRole("toolbar", { name: "Textformatierung" });
  const hide = page.getByRole("button", { name: "Tastatur ausblenden" });
  await editor.tap();
  await page.keyboard.type("Hello World");
  await keyboard(page, KEYBOARD);
  const visibleBottom = 844 - KEYBOARD;
  await expect(page.locator(".app-shell")).toHaveClass(/keyboard-open/);
  await expect(hide).toBeVisible();
  // The toolbar's lower edge meets the keyboard instead of lying behind it.
  await expect.poll(async () => Math.round((await toolbar.boundingBox())!.y + (await toolbar.boundingBox())!.height)).toBe(visibleBottom);
  const button = (await hide.boundingBox())!;
  expect(button.y + button.height).toBeLessThanOrEqual(visibleBottom);
  if (shots) {
    await drawKeyboard(page, visibleBottom);
    await page.screenshot({ path: `${shots}/safari-visual-viewport.png` });
    await page.evaluate(() => document.getElementById("test-keyboard")?.remove());
  }

  // iOS moved the visible area down the page to show the caret.
  await keyboard(page, KEYBOARD, 120);
  await expect.poll(async () => Math.round((await toolbar.boundingBox())!.y + (await toolbar.boundingBox())!.height)).toBe(120 + visibleBottom);

  // The button closes the keyboard; the toolbar goes back onto the tab bar.
  await hide.tap();
  await keyboard(page, 0);
  await expect(page.locator(".app-shell")).not.toHaveClass(/keyboard-open/);
  await expect(page.locator(".mobile-tab-bar")).toBeVisible();
  const bar = (await page.locator(".mobile-tab-bar").boundingBox())!;
  await expect.poll(async () => Math.round((await toolbar.boundingBox())!.y + (await toolbar.boundingBox())!.height)).toBe(Math.round(bar.y));
  await expect(editor).toHaveText("Hello World");
});

test("app: the toolbar sits above a keyboard that resizes the web view", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "The keyboard of a touch phone.");
  test.setTimeout(120_000);
  const editor = await openNewPage(page);
  const toolbar = page.getByRole("toolbar", { name: "Textformatierung" });
  const hide = page.getByRole("button", { name: "Tastatur ausblenden" });
  await editor.tap();
  await page.keyboard.type("Hello World");
  // The native layer makes the web view shorter by the keyboard.
  await page.setViewportSize({ width: 390, height: 844 - KEYBOARD });
  await expect(page.locator(".app-shell")).toHaveClass(/keyboard-open/);
  await expect(hide).toBeVisible();
  await expect.poll(async () => Math.round((await toolbar.boundingBox())!.y + (await toolbar.boundingBox())!.height)).toBe(844 - KEYBOARD);
  expect(await page.evaluate(() => document.documentElement.style.getPropertyValue("--keyboard-inset"))).toBe("");
  if (shots) await page.screenshot({ path: `${shots}/app-resized-webview.png` });

  await hide.tap();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".app-shell")).not.toHaveClass(/keyboard-open/);
  await expect(page.locator(".mobile-tab-bar")).toBeVisible();
  await expect(editor).toHaveText("Hello World");
});
