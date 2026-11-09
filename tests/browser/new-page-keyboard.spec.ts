import { test, expect, type Page } from "@playwright/test";

// The "Neue Seite" sheet on an iPhone: opened, the name has the focus and
// the keyboard slides in. The sheet came out too high – its heading and the
// name under the status bar, above the screen, and a large empty gap above
// the buttons – until the app had been left and opened again. iOS had moved
// the visible area down the page (visualViewport.offsetTop) for the
// keyboard, and the sheet's upper limit was measured from 0 instead of from
// where the visible area starts (app/new-page-dialog.css).
//
// Chromium cannot open a keyboard: the page gets a stand-in visualViewport
// (and innerHeight, shortened by the offset as on iOS 26) the test sets, as
// keyboard-caret.spec.ts and hide-keyboard.spec.ts.
const KEYBOARD = 336;
const HEIGHT = 844;
const SAFE_TOP = 47;
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
  page.evaluate(([h, o]) => (window as unknown as { __keyboard: (h: number, o: number) => void }).__keyboard(h, o), [height, offsetTop]);

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
async function openDialog(page: Page) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const created = await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Neu ${Date.now()}`, kind: "document" },
  });
  await page.goto(`/#page=${(await created.json()).id}`);
  await expect(page.getByLabel("Dokumentinhalt", { exact: true })).toBeVisible();
  const welcome = page.getByRole("dialog", { name: "Willkommen bei Flowplan" });
  await page.waitForTimeout(300);
  if (await welcome.isVisible()) {
    await page.keyboard.press("Escape");
    await expect(welcome).toBeHidden();
  }
  // The status bar of an iPhone.
  await page.addStyleTag({ content: `html:root { --safe-top: ${SAFE_TOP}px; }` });
  await page.locator(".mobile-tab-bar").getByRole("button", { name: "Neue Seite" }).tap();
  const dialog = page.getByRole("dialog", { name: "Neue Seite", exact: true });
  const name = dialog.getByLabel("Name", { exact: true });
  await expect(name).toBeVisible();
  // The name has the focus (and on a phone the keyboard comes).
  await expect.poll(() => name.evaluate((el) => el === document.activeElement)).toBe(true);
  // Done sliding in.
  await page.waitForTimeout(450);
  return dialog;
}

// Edges in the frame getBoundingClientRect and position: fixed use; the
// visible area runs from offsetTop to offsetTop + height there.
const layout = (page: Page) =>
  page.evaluate(() => {
    const sheet = document.querySelector(".np-dialog")!;
    const box = (selector: string) => {
      const r = sheet.querySelector(selector)!.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom };
    };
    const vv = window.visualViewport!;
    const r = sheet.getBoundingClientRect();
    return {
      visibleTop: vv.offsetTop,
      visibleEnd: vv.offsetTop + vv.height,
      sheet: { top: r.top, bottom: r.bottom },
      heading: box(".modal-heading"),
      name: box(".np-name input"),
      space: box(".np-space"),
      footer: box(".np-footer"),
      scrolls: sheet.scrollHeight > sheet.clientHeight + 1,
    };
  });

// Heading and name below the status bar, the buttons right above the
// keyboard, and no empty space above them: the sheet is as high as its
// content, or – when that does not fit – reaches up to just below the
// status bar and its middle scrolls.
async function expectFitted(page: Page) {
  await expect
    .poll(async () => {
      const l = await layout(page);
      return Math.abs(l.sheet.bottom - l.visibleEnd) <= 2 && Math.abs(l.footer.bottom - l.visibleEnd) <= 2;
    })
    .toBe(true);
  const l = await layout(page);
  const ceiling = l.visibleTop + SAFE_TOP;
  expect(l.sheet.top).toBeGreaterThanOrEqual(ceiling);
  expect(l.heading.top).toBeGreaterThanOrEqual(ceiling);
  expect(l.name.top).toBeGreaterThanOrEqual(ceiling);
  expect(l.name.bottom).toBeLessThanOrEqual(l.footer.top);
  if (l.scrolls) expect(l.sheet.top - ceiling).toBeLessThanOrEqual(14);
  // The space row's own margin (20 px) and nothing more.
  else expect(l.footer.top - l.space.bottom).toBeLessThanOrEqual(24);
  return l;
}

test("iOS: the new-page sheet fits between the status bar and the keyboard", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "The keyboard of a touch phone.");
  test.setTimeout(120_000);
  await fakeIosKeyboard(page);
  const dialog = await openDialog(page);
  const visibleBottom = HEIGHT - KEYBOARD;

  // The keyboard slides in after the dialog opened: the visible area shrinks
  // in steps.
  for (const height of [90, 200, KEYBOARD]) {
    await keyboard(page, height);
    await expectFitted(page);
  }
  expect((await layout(page)).footer.bottom).toBeCloseTo(visibleBottom, 0);

  // iOS moves the visible area down the page for the focused field (the
  // report: 216 px; the sheet's top then lay under the status bar).
  await keyboard(page, KEYBOARD, 216);
  const moved = await expectFitted(page);
  expect(moved.footer.bottom).toBeCloseTo(216 + visibleBottom, 0);

  // The layout viewport scrolled as well (window.scrollY): what is fixed
  // follows the visible area all the same.
  await page.evaluate(() => window.scrollTo(0, 120));
  await keyboard(page, KEYBOARD, 140);
  await expectFitted(page);
  await page.evaluate(() => window.scrollTo(0, 0));

  // A taller content (a database with its kinds): the sheet reaches up to
  // the status bar and its middle scrolls, the buttons stay at the keyboard.
  await keyboard(page, KEYBOARD, 216);
  await dialog.getByRole("radio", { name: "Datenbank", exact: true }).click();
  await expect(dialog.locator(".np-options")).toBeVisible();
  expect((await expectFitted(page)).scrolls).toBe(true);
  await dialog.getByRole("radio", { name: "Dokument", exact: true }).click();
  await expect(dialog.locator(".np-options")).toHaveCount(0);
  await expectFitted(page);
  // Shorter again: no gap above the buttons.
  await keyboard(page, 200, 216);
  expect((await expectFitted(page)).scrolls).toBe(false);

  // The keyboard closes: a sheet at the bottom edge again.
  await keyboard(page, 0);
  await expect(page.locator("html")).not.toHaveClass(/keyboard-docked/);
  await expect.poll(async () => Math.round((await layout(page)).sheet.bottom)).toBe(HEIGHT);
  const closed = await layout(page);
  expect(closed.sheet.top).toBeGreaterThanOrEqual(SAFE_TOP);
  await expect(dialog.getByLabel("Name", { exact: true })).toBeInViewport();
});

test("app: the new-page sheet fits above a keyboard that resizes the web view", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "The keyboard of a touch phone.");
  test.setTimeout(120_000);
  await openDialog(page);
  // Android (interactive-widget=resizes-content, the app's web view): the
  // layout viewport itself ends at the keyboard.
  await page.setViewportSize({ width: 390, height: HEIGHT - KEYBOARD });
  const l = await expectFitted(page);
  expect(l.visibleTop).toBe(0);
  expect(l.footer.bottom).toBeCloseTo(HEIGHT - KEYBOARD, 0);
  await page.setViewportSize({ width: 390, height: HEIGHT });
  await expect.poll(async () => Math.round((await layout(page)).sheet.bottom)).toBe(HEIGHT);
});
