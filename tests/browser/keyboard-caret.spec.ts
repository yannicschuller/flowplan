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
// `safari`: Safari keeps innerHeight at the full height (the keyboard and
// its accessory bar only shrink the visual viewport); the app's WKWebView on
// iOS 26 shortens it by what it moved the visible area down the page.
async function fakeIosKeyboard(page: Page, { safari = false } = {}) {
  await page.addInitScript((safari) => {
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
    Object.defineProperty(window, "innerHeight", { configurable: true, get: () => fullHeight() - (safari || state.height === null ? 0 : state.offsetTop) });
    // `silent`: iOS sometimes reports the keyboard's final size (or the moved
    // visible area) without a resize or scroll event.
    (window as unknown as { __keyboard: (height: number, offsetTop?: number, silent?: boolean) => void }).__keyboard = (height, offsetTop = 0, silent = false) => {
      state.height = height ? fullHeight() - height : null;
      state.offsetTop = height ? offsetTop : 0;
      if (silent) return;
      target.dispatchEvent(new Event("resize"));
      target.dispatchEvent(new Event("scroll"));
    };
  }, safari);
}
const keyboard = (page: Page, height: number, offsetTop = 0, silent = false) =>
  page.evaluate(
    ([h, o, s]) => (window as unknown as { __keyboard: (h: number, o: number, s: boolean) => void }).__keyboard(h as number, o as number, s as boolean),
    [height, offsetTop, silent] as const,
  );

async function openNewPage(page: Page, title = `Neu ${Date.now()}`) {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const created = await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind: "document" },
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

// #181, follow-up: an EXISTING document, scrolled to its end, and a tap on
// its last line – the keyboard comes up after the tap, in steps, the last
// step reported late (without an event), and iOS may move the visible area.
// The app's WKWebView (iOS 26: innerHeight shortened by that move) and
// Safari (innerHeight stays full; the keyboard plus its accessory bar, ^ v ✓,
// only shrink the visual viewport). Afterwards the docked toolbar lies right
// on the visible area's end, the tapped line above it, and the pane scrolls
// far enough for the last line to clear the toolbar.
async function openLongDocument(page: Page, lines: number) {
  // A title of its own: no "related pages" under the text that would give
  // the pane room to scroll on their own.
  const editor = await openNewPage(page, Array.from({ length: 3 }, () => Math.random().toString(36).slice(2, 7)).join(" "));
  await page.evaluate((n) => {
    const dom = document.querySelector(".page-layout .ProseMirror") as HTMLElement & {
      editor: { commands: { insertContent: (html: string) => boolean } };
    };
    dom.editor.commands.insertContent(Array.from({ length: n }, (_, i) => `<p>Absatz ${i + 1} mit etwas Text</p>`).join(""));
  }, lines);
  await expect(editor.locator("p")).toHaveCount(lines);
  // Saved, then opened again with the keyboard closed: an existing document.
  await page.waitForTimeout(1500);
  await page.reload();
  await expect(editor.locator("p").last()).toHaveText(`Absatz ${lines} mit etwas Text`, { timeout: 20_000 });
  await expect(page.locator(".app-shell")).not.toHaveClass(/keyboard-open/);
  return editor;
}

const geometry = (page: Page) =>
  page.evaluate(() => {
    const vv = window.visualViewport!;
    const toolbar = document.querySelector(".page-layout .editor-toolbar")!.getBoundingClientRect();
    const selection = window.getSelection()!;
    const node = selection.focusNode;
    const block = node ? (node.nodeType === 1 ? (node as Element) : node.parentElement!).closest("p") : null;
    const line = block?.getBoundingClientRect();
    const pane = document.querySelector(".main-scroll") as HTMLElement;
    return {
      visibleTop: vv.offsetTop,
      visibleEnd: vv.offsetTop + vv.height,
      toolbarTop: toolbar.top,
      toolbarBottom: toolbar.bottom,
      lineTop: line?.top ?? NaN,
      lineBottom: line?.bottom ?? NaN,
      lineText: block?.textContent ?? "",
      scrollTop: pane.scrollTop,
      maxScroll: pane.scrollHeight - pane.clientHeight,
    };
  });

for (const variant of [
  { name: "iOS app", safari: false, keyboard: KEYBOARD, pan: 0 },
  { name: "iOS app", safari: false, keyboard: KEYBOARD, pan: 186 },
  { name: "iOS Safari", safari: true, keyboard: KEYBOARD + 44, pan: 0 },
  { name: "iOS Safari", safari: true, keyboard: KEYBOARD + 44, pan: 150 },
  // A browser or web view that resizes the page for the keyboard.
  { name: "Android", android: true, keyboard: 300, pan: 0 },
]) {
  test(`${variant.name}: tapping the last line of an existing document keeps it above the keyboard (visible area moved ${variant.pan} px)`, async ({ page }, info) => {
    test.skip(info.project.name !== "mobile", "The keyboard of a touch phone.");
    test.setTimeout(180_000);
    if (!variant.android) await fakeIosKeyboard(page, { safari: variant.safari });
    // An iPhone's home indicator room (env(safe-area-inset-bottom)); over
    // the keyboard the docked toolbar does not keep it.
    await page.addInitScript(() =>
      document.addEventListener("DOMContentLoaded", () => {
        const style = document.createElement("style");
        style.textContent = ":root:root { --safe-bottom: 34px; }";
        document.head.append(style);
      }),
    );
    const lines = 45;
    const editor = await openLongDocument(page, lines);
    const pane = page.locator(".main-scroll").first();
    await pane.evaluate((el) => (el.scrollTop = el.scrollHeight));
    const last = editor.locator("p").last();
    await last.tap();
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest(".ProseMirror"))).toBe(true);
    // The keyboard slides in after the tap; iOS reports its final size (and
    // where it moved the visible area) late, without an event.
    await page.waitForTimeout(120);
    if (variant.android) {
      await page.setViewportSize({ width: 390, height: HEIGHT - 150 });
      await page.waitForTimeout(120);
      await page.setViewportSize({ width: 390, height: HEIGHT - variant.keyboard });
    } else {
      await keyboard(page, 120);
      await page.waitForTimeout(120);
      await keyboard(page, 260);
      await page.waitForTimeout(150);
      await keyboard(page, variant.keyboard, variant.pan, true);
    }
    await expect(page.locator(".app-shell")).toHaveClass(/keyboard-open/);

    // (a) The toolbar sits right on the end of the visible area.
    await expect
      .poll(async () => {
        const g = await geometry(page);
        return Math.abs(g.toolbarBottom - g.visibleEnd) <= 2;
      }, { message: "toolbar on the keyboard" })
      .toBe(true);
    const docked = await geometry(page);
    expect(docked.toolbarBottom - docked.toolbarTop, "toolbar without the home indicator's room").toBeLessThanOrEqual(56);
    // (c) The tapped line shows between the visible area's top and the toolbar.
    await expect
      .poll(async () => {
        const g = await geometry(page);
        return g.lineText === `Absatz ${lines} mit etwas Text` && g.lineBottom <= g.toolbarTop && g.lineTop >= g.visibleTop;
      }, { message: "tapped line above the toolbar", timeout: 4000 })
      .toBe(true);
    if (shots) {
      if (!variant.android) await drawKeyboard(page, variant.pan + HEIGHT - variant.keyboard, variant.pan);
      await page.screenshot({ path: `${shots}/existing-${variant.name.replace(/ /g, "-")}-pan-${variant.pan}${process.env.KB181_SUFFIX ?? ""}.png` });
      await page.evaluate(() => document.querySelectorAll("#test-keyboard, #test-above").forEach((el) => el.remove()));
    }
    // (b) Scrolled to the end, the last line clears the toolbar; and the page
    // can be scrolled back up.
    await pane.evaluate((el) => (el.scrollTop = el.scrollHeight));
    const end = await geometry(page);
    const lastBox = (await last.boundingBox())!;
    expect(lastBox.y + lastBox.height).toBeLessThanOrEqual(end.toolbarTop);
    expect(end.maxScroll).toBeGreaterThan(0);
    await pane.evaluate((el) => (el.scrollTop = 0));
    expect((await geometry(page)).scrollTop).toBe(0);
    // A tap on a line in the middle with the keyboard already up keeps that
    // line where it is (in view), and typing there keeps the caret in view.
    await pane.evaluate((el) => (el.scrollTop = el.scrollHeight / 2));
    const middle = editor.locator("p").nth(Math.floor(lines / 2));
    await middle.scrollIntoViewIfNeeded();
    await middle.tap();
    await page.keyboard.type(" und mehr");
    await expect
      .poll(async () => {
        const g = await geometry(page);
        return g.lineBottom <= g.toolbarTop && g.lineTop >= g.visibleTop;
      }, { message: "typing in the middle" })
      .toBe(true);
  });
}
