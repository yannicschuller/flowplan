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

// Every other text field (#120): titles, tags, properties, the new-page
// dialog … get a round "Tastatur ausblenden" at the right edge right above
// the keyboard (components/hide-keyboard-button.tsx); a record's content
// docks its formatting toolbar above the keyboard like a document.
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
async function command(page: Page, data: Record<string, unknown>) {
  const response = await page.request.post("/api/command", { headers: { origin }, data });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function dismissWelcome(page: Page) {
  const welcome = page.getByRole("dialog", { name: "Willkommen bei Flowplan" });
  await page.waitForTimeout(300);
  if (await welcome.isVisible()) {
    await page.keyboard.press("Escape");
    await expect(welcome).toBeHidden();
  }
}
// A database with one record, opened at its page.
async function openDatabase(page: Page) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const db = await command(page, {
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `Aufgaben ${Date.now()}`,
    kind: "database",
  });
  const read = async () => (await page.request.get(`/api/pages/${db.id}`)).json();
  await command(page, {
    action: "database.update",
    pageId: db.id,
    version: (await read()).database.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "note", name: "Notiz", type: "text" },
    ],
    views: [{ id: "table", name: "Tabelle", type: "table", filters: [], sorts: [] }],
  });
  const row = await command(page, { action: "row.create", pageId: db.id, cells: { title: "Steuer", note: "Belege" } });
  await page.goto(`/#page=${db.id}`);
  await expect(page.getByLabel("Seitentitel", { exact: true })).toBeVisible();
  await dismissWelcome(page);
  return { db, row };
}
const fab = (page: Page) => page.locator(".hide-keyboard-fab");
const activeIs = (page: Page, selector: string) =>
  page.evaluate((s) => !!document.activeElement?.closest(s), selector);
// The floating button sits at the right edge, its lower edge a few pixels
// above the keyboard.
async function expectFabAboveKeyboard(page: Page, visibleBottom: number) {
  await expect(fab(page)).toBeVisible();
  await expect(fab(page)).toHaveAttribute("aria-label", "Tastatur ausblenden");
  const box = (await fab(page).boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(390 - (box.x + box.width)).toBeLessThan(16);
  expect(box.y + box.height).toBeLessThanOrEqual(visibleBottom);
  expect(visibleBottom - (box.y + box.height)).toBeLessThan(16);
}

test("iOS: a record's content docks its toolbar with the hide button above the keyboard", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "The keyboard of a touch phone.");
  test.setTimeout(120_000);
  await fakeVisualViewport(page);
  const { db, row } = await openDatabase(page);
  await page.evaluate(([p, r]) => (location.hash = `page=${p}&row=${r}`), [db.id, row.id]);
  const dialog = page.getByRole("dialog", { name: "Eintrag", exact: true });
  const editor = dialog.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor).toBeVisible();
  const toolbar = dialog.getByRole("toolbar", { name: "Textformatierung" });
  const hide = dialog.getByRole("button", { name: "Tastatur ausblenden" });
  // In place and without the button while nobody writes in the record.
  await expect(hide).toHaveCount(0);
  await editor.scrollIntoViewIfNeeded();
  await editor.tap();
  await page.keyboard.type("Im Eintrag");
  await keyboard(page, KEYBOARD);
  const visibleBottom = 844 - KEYBOARD;
  await expect.poll(() => activeIs(page, ".row-document .ProseMirror")).toBe(true);
  await expect(hide).toBeVisible();
  await expect.poll(async () => Math.round((await toolbar.boundingBox())!.y + (await toolbar.boundingBox())!.height)).toBe(visibleBottom);
  const bar = (await toolbar.boundingBox())!;
  expect(bar.x).toBeLessThanOrEqual(1);
  expect(bar.width).toBeGreaterThanOrEqual(388);
  const button = (await hide.boundingBox())!;
  expect(button.x + button.width).toBeLessThanOrEqual(390);
  expect(button.y + button.height).toBeLessThanOrEqual(visibleBottom);
  // One button only: the floating one stays away.
  await page.waitForTimeout(500);
  await expect(fab(page)).toHaveCount(0);
  // Room below the text, so its end scrolls above the docked toolbar.
  expect(await dialog.locator(".row-document .editor-wrapper").evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom))).toBeGreaterThanOrEqual(56);
  if (shots) {
    await drawKeyboard(page, visibleBottom);
    await page.screenshot({ path: `${shots}/record-content-toolbar.png` });
    await page.evaluate(() => document.getElementById("test-keyboard")?.remove());
  }

  await hide.tap();
  await expect.poll(() => activeIs(page, ".ProseMirror")).toBe(false);
  await keyboard(page, 0);
  await expect(hide).toHaveCount(0);
  // The dialog stays open, the toolbar goes back into place, the text stays.
  await expect(dialog).toBeVisible();
  expect(await toolbar.evaluate((el) => getComputedStyle(el).position)).toBe("static");
  await expect(editor).toHaveText("Im Eintrag");
});

test("iOS: titles and other fields get a floating hide button above the keyboard", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "The keyboard of a touch phone.");
  test.setTimeout(120_000);
  await fakeVisualViewport(page);
  const { db, row } = await openDatabase(page);
  const visibleBottom = 844 - KEYBOARD;

  // The database's title.
  const title = page.getByLabel("Seitentitel", { exact: true });
  const before = await title.inputValue();
  await expect(fab(page)).toHaveCount(0);
  await title.tap();
  await expect.poll(() => activeIs(page, "input.page-title")).toBe(true);
  await keyboard(page, KEYBOARD);
  await expectFabAboveKeyboard(page, visibleBottom);
  // Not over the title it ends.
  const field = (await title.boundingBox())!;
  const box = (await fab(page).boundingBox())!;
  expect(box.y).toBeGreaterThan(field.y + field.height);
  if (shots) {
    await drawKeyboard(page, visibleBottom);
    await page.screenshot({ path: `${shots}/page-title-fab.png` });
    await page.evaluate(() => document.getElementById("test-keyboard")?.remove());
  }
  await fab(page).tap();
  await expect.poll(() => activeIs(page, "input.page-title")).toBe(false);
  await keyboard(page, 0);
  await expect(fab(page)).toHaveCount(0);
  await expect(title).toHaveValue(before);

  // A record's title and a property, in the record dialog: the button sits
  // above the dialog, and tapping it does not close the dialog.
  await page.evaluate(([p, r]) => (location.hash = `page=${p}&row=${r}`), [db.id, row.id]);
  const dialog = page.getByRole("dialog", { name: "Eintrag", exact: true });
  const recordTitle = dialog.getByLabel("Titel des Eintrags", { exact: true });
  await expect(recordTitle).toBeVisible();
  await recordTitle.tap();
  await expect.poll(() => activeIs(page, ".row-title-input")).toBe(true);
  await keyboard(page, KEYBOARD);
  await expectFabAboveKeyboard(page, visibleBottom);
  // The record's content toolbar keeps its place and its button away.
  await expect(dialog.getByRole("button", { name: "Tastatur ausblenden" })).toHaveCount(0);
  if (shots) {
    await drawKeyboard(page, visibleBottom);
    await page.screenshot({ path: `${shots}/record-title-fab.png` });
    await page.evaluate(() => document.getElementById("test-keyboard")?.remove());
  }
  await fab(page).tap();
  await expect.poll(() => activeIs(page, ".row-title-input")).toBe(false);
  await expect(dialog).toBeVisible();
  await expect(recordTitle).toHaveValue("Steuer");
  await keyboard(page, 0);

  const note = dialog.getByLabel("Notiz", { exact: true });
  await note.tap();
  await keyboard(page, KEYBOARD);
  await expectFabAboveKeyboard(page, visibleBottom);
  await fab(page).tap();
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).not.toBe("INPUT");
  await expect(dialog).toBeVisible();
  await expect(note).toHaveValue("Belege");
  await keyboard(page, 0);
  await expect(fab(page)).toHaveCount(0);
});

test("iOS: the new-page dialog's title over a document gets the floating button, not the toolbar's", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "The keyboard of a touch phone.");
  test.setTimeout(120_000);
  await fakeVisualViewport(page);
  await openNewPage(page);
  const visibleBottom = 844 - KEYBOARD;
  await page.locator(".mobile-tab-bar").getByRole("button", { name: "Neue Seite" }).tap();
  const dialog = page.getByRole("dialog", { name: "Neue Seite", exact: true });
  const name = dialog.getByLabel("Name", { exact: true });
  await expect(name).toBeVisible();
  await name.tap();
  await page.keyboard.type("Reiseplan");
  await keyboard(page, KEYBOARD);
  // The document's docked toolbar lies under the dialog: its button does not
  // count, the floating one shows.
  await expectFabAboveKeyboard(page, visibleBottom);
  await fab(page).tap();
  await expect.poll(() => activeIs(page, ".modal input")).toBe(false);
  await expect(dialog).toBeVisible();
  await expect(name).toHaveValue("Reiseplan");
  await keyboard(page, 0);
  await expect(fab(page)).toHaveCount(0);
});

test("iOS: in a document only the toolbar's hide button shows", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "The keyboard of a touch phone.");
  test.setTimeout(120_000);
  await fakeVisualViewport(page);
  const editor = await openNewPage(page);
  const hide = page.getByRole("button", { name: "Tastatur ausblenden" });
  await editor.tap();
  await page.keyboard.type("Nur eine");
  await keyboard(page, KEYBOARD);
  await expect(hide).toHaveCount(1);
  await expect(page.locator(".page-layout .editor-toolbar .editor-hide-keyboard")).toBeVisible();
  await page.waitForTimeout(500);
  await expect(fab(page)).toHaveCount(0);
  // The page's title: the docked toolbar is there with its button already.
  await page.getByLabel("Seitentitel", { exact: true }).tap();
  await expect.poll(() => activeIs(page, "input.page-title")).toBe(true);
  await page.waitForTimeout(500);
  await expect(hide).toHaveCount(1);
  await expect(fab(page)).toHaveCount(0);
  await hide.tap();
  await expect.poll(() => activeIs(page, "input.page-title")).toBe(false);
  await keyboard(page, 0);
  // No field, no keyboard: nothing.
  await expect(hide).toHaveCount(0);
  await expect(fab(page)).toHaveCount(0);
});

test("there is no floating hide-keyboard button on a desktop", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Desktop layout.");
  test.setTimeout(120_000);
  await fakeVisualViewport(page);
  await openDatabase(page);
  const title = page.getByLabel("Seitentitel", { exact: true });
  await title.click();
  await expect.poll(() => activeIs(page, "input.page-title")).toBe(true);
  // Even a viewport that shrinks (a narrow window, a tablet's keyboard).
  await keyboard(page, KEYBOARD);
  await page.waitForTimeout(600);
  await expect(fab(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Tastatur ausblenden" })).toHaveCount(0);
});
