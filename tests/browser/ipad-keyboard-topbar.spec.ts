import { test, expect, type Page } from "@playwright/test";

// #307: in the iPad app, writing a note with the docked on-screen keyboard,
// the top bar (breadcrumb, saving state) sometimes went out of view above the
// screen. iOS keeps the layout at its full height and, when the caret would
// end up behind the keyboard, moves the visible area down the page
// (visualViewport.offsetTop) – the whole app with it, the top bar included.
// While the keyboard is open, the top bar (and what sits above the pane)
// follows the visible area's top, and the caret's line stays between it and
// the keyboard.
//
// Chromium cannot open a keyboard: like keyboard-caret.spec.ts the page gets
// a stand-in visualViewport (and innerHeight as the app's WKWebView on iOS 26
// reports it: shorter by what iOS moved the visible area down the page).
test.use({ viewport: { width: 1024, height: 1366 }, isMobile: true, hasTouch: true });

// An iPad's docked keyboard with its shortcut bar (portrait, 12.9").
const KEYBOARD = 420;

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

// The visible area, the top bar and the caret's line (the block it is in, so
// an empty new line counts too), in the page's coordinates.
const geometry = (page: Page) =>
  page.evaluate(() => {
    const vv = window.visualViewport!;
    const bar = document.querySelector(".topbar")!.getBoundingClientRect();
    const node = window.getSelection()!.focusNode!;
    const line = (node.nodeType === 1 ? (node as Element) : node.parentElement!).closest("p, li, h1, h2, h3")!.getBoundingClientRect();
    return { visibleTop: vv.offsetTop, visibleEnd: vv.offsetTop + vv.height, barTop: bar.top, barBottom: bar.bottom, lineTop: line.top, lineBottom: line.bottom };
  });

test("iPad: with the keyboard open the top bar stays in view while typing new blocks near the bottom", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "One run covers the tablet (its viewport is set here).");
  test.setTimeout(180_000);
  await fakeIosKeyboard(page);
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const created = await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Notiz ${Date.now()}`, kind: "document" },
  });
  await page.goto(`/#page=${(await created.json()).id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor).toBeVisible({ timeout: 30_000 });
  // The wide layout (no phone tab bar), with the top bar at the top.
  await expect(page.locator(".mobile-tab-bar")).toBeHidden();
  const bar = page.locator(".topbar");
  await expect(bar).toBeVisible();
  const before = (await bar.boundingBox())!;

  await editor.tap();
  await keyboard(page, KEYBOARD);
  await expect(page.locator(".app-shell")).toHaveClass(/keyboard-open/);

  // Typing new blocks; whenever the caret nears the keyboard, iOS moves the
  // visible area down the page – by a different amount each time, up to the
  // keyboard's height.
  const pans = new Map([[14, 120], [20, 260], [26, KEYBOARD]]);
  let pan = 0;
  for (let i = 1; i <= 34; i++) {
    await page.keyboard.type(`Zeile ${i}`);
    await page.keyboard.press("Enter");
    await page.keyboard.type(" ");
    if (pans.has(i)) {
      pan = pans.get(i)!;
      await keyboard(page, KEYBOARD, pan);
    }
    if (i % 3 === 0 || pans.has(i) || i > 28) {
      await expect
        .poll(async () => {
          const g = await geometry(page);
          return {
            bar: g.barTop >= g.visibleTop - 1 && g.barBottom <= g.visibleEnd,
            caret: g.lineTop >= g.barBottom - 1 && g.lineBottom <= g.visibleEnd,
          };
        }, { message: `line ${i}, visible area moved ${pan} px` })
        .toEqual({ bar: true, caret: true });
    }
  }
  // The top bar sits right at the visible area's top, as before the keyboard
  // at the top of the screen.
  const g = await geometry(page);
  expect(Math.abs(g.barTop - g.visibleTop)).toBeLessThanOrEqual(1);
  expect(Math.round(g.barBottom - g.barTop)).toBe(Math.round(before.height));
  // What lies above the bar on the page is not left showing through: the
  // bar has a background of its own.
  expect(await bar.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");

  // The caret going to a line the bar now covers (arrow keys, a search hit):
  // the pane brings it out from under the bar.
  const hidden = await page.evaluate(() => {
    const dom = document.querySelector(".page-layout .ProseMirror") as HTMLElement & {
      editor: { view: { posAtDOM: (node: Node, offset: number) => number }; chain: () => { setTextSelection: (pos: number) => { scrollIntoView: () => { run: () => boolean } } } };
    };
    const vv = window.visualViewport!;
    const barBottom = document.querySelector(".topbar")!.getBoundingClientRect().bottom;
    const line = [...dom.querySelectorAll("p")].find((p) => {
      const r = p.getBoundingClientRect();
      return r.top >= vv.offsetTop && r.top < barBottom - 10;
    });
    if (!line) return null;
    dom.editor.chain().setTextSelection(dom.editor.view.posAtDOM(line, 0) + 1).scrollIntoView().run();
    return line.textContent;
  });
  expect(hidden, "a line under the bar").toBeTruthy();
  await page.keyboard.type("x");
  await expect
    .poll(async () => {
      const g = await geometry(page);
      return g.lineTop >= g.barBottom - 1 && g.lineBottom <= g.visibleEnd && g.barTop >= g.visibleTop - 1;
    }, { message: "the caret's line out from under the bar" })
    .toBe(true);

  // The keyboard goes: the bar is back in its place.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await keyboard(page, 0);
  await expect(page.locator(".app-shell")).not.toHaveClass(/keyboard-open/);
  await expect.poll(async () => (await bar.boundingBox())!.y).toBe(before.y);
});

// #307, too: the saving state's cloud sat left of its text and jumped
// whenever the text changed its width ("Ungespeicherte Änderungen",
// "Speichern …", "Gespeichert"). It sits on the right now and stays put.
test.describe("the saving state", () => {
  // Landscape: the portrait iPad's main area is too narrow for the text.
  test.use({ viewport: { width: 1366, height: 1024 } });
  test("keeps its cloud in place, right of the text", async ({ page }, info) => {
    test.skip(info.project.name !== "mobile", "One run covers it.");
    const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
    await page.request.post("/api/auth/demo", { headers: { origin } });
    await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
    const boot = await (await page.request.get("/api/bootstrap")).json();
    const created = await page.request.post("/api/command", {
      headers: { origin },
      data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Status ${Date.now()}`, kind: "document" },
    });
    await page.goto(`/#page=${(await created.json()).id}`);
    const editor = page.getByLabel("Dokumentinhalt", { exact: true });
    await expect(editor).toBeVisible({ timeout: 30_000 });
    const status = page.locator(".topbar .save-status");
    await expect(status).toContainText("Gespeichert", { timeout: 15_000 });
    // Where the cloud is in every frame while the text changes.
    type Sample = { text: string; iconLeft: number; textRight: number };
    await page.evaluate(() => {
      const seen: Sample[] = [];
      (window as unknown as { __seen: Sample[] }).__seen = seen;
      const sample = () => {
        const shown = document.querySelector(".topbar .save-status > span:not(.cross-fade-out)");
        const icon = shown?.querySelector("svg")?.getBoundingClientRect();
        // While typing only the cloud shows (#527); its words are for
        // screen readers only. Text that is visible sits left of it.
        const text = shown?.querySelector("span:not(.sr-only)")?.getBoundingClientRect();
        if (shown && icon) seen.push({ text: shown.textContent ?? "", iconLeft: Math.round(icon.left), textRight: text ? Math.round(text.right) : -1 });
        if (seen.length < 3000) requestAnimationFrame(sample);
      };
      sample();
    });
    await editor.click();
    await page.keyboard.type("Etwas Text");
    await expect.poll(() => page.evaluate(() => new Set((window as unknown as { __seen: Sample[] }).__seen.map((s) => s.text)).size)).toBeGreaterThan(1);
    await expect(status).toContainText("Gespeichert", { timeout: 15_000 });
    await page.waitForTimeout(400);
    const seen = await page.evaluate(() => (window as unknown as { __seen: Sample[] }).__seen);
    const states = [...new Set(seen.map((s) => `${s.text} @ ${s.iconLeft}`))];
    expect(new Set(seen.map((s) => s.iconLeft)).size, states.join(" | ")).toBe(1);
    expect(seen.every((s) => s.textRight <= s.iconLeft)).toBe(true);
  });
});
