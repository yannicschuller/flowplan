import { test, expect, type Locator, type Page } from "@playwright/test";

// #648: on a phone the formatting toolbar of a record's content docks at the
// bottom of the screen like a document's – not between "Inhalt" and the
// text – in the record's sheet and on the record's own page, also while one
// writes in it; it moves with the sheet while that is dragged and springs
// back with it. A document is the control.
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const shots = process.env.TOOLBAR648_SHOTS;

test.beforeEach(({}, info) => {
  test.skip(info.project.name !== "mobile", "The toolbar of a touch phone.");
});

async function command(page: Page, data: Record<string, unknown>) {
  const response = await page.request.post("/api/command", { headers: { origin }, data });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function signIn(page: Page) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await command(page, { action: "profile.onboarded" });
  return (await page.request.get("/api/bootstrap")).json();
}
const box = async (locator: Locator) => (await locator.boundingBox())!;
const bottomOf = async (locator: Locator) => {
  const b = await box(locator);
  return Math.round(b.y + b.height);
};
const focusIn = (page: Page, selector: string) => page.evaluate((s) => !!document.activeElement?.closest(s), selector);
const blur = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

// A database with one record whose document has a few lines of text.
async function recordWithContent(page: Page) {
  const boot = await signIn(page);
  const db = await command(page, { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Projekte ${Date.now()}`, kind: "database" });
  const row = await command(page, { action: "row.create", pageId: db.id, cells: { title: "Umzug" } });
  await page.goto(`/#page=${db.id}&row=${row.id}`);
  const dialog = page.getByRole("dialog", { name: "Eintrag", exact: true });
  const editor = dialog.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor).toBeVisible();
  await editor.scrollIntoViewIfNeeded();
  await editor.tap();
  await page.keyboard.type("Kartons besorgen");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Nachsendeauftrag stellen");
  // Saved before the record is opened elsewhere.
  await page.waitForTimeout(1500);
  await blur(page);
  await expect.poll(() => focusIn(page, ".ProseMirror")).toBe(false);
  return { db, row, dialog, editor };
}

test("a document's toolbar docks on the tab bar (control)", async ({ page }) => {
  test.setTimeout(120_000);
  const boot = await signIn(page);
  const doc = await command(page, { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Notiz ${Date.now()}`, kind: "document" });
  await page.goto(`/#page=${doc.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor).toBeVisible();
  const toolbar = page.getByRole("toolbar", { name: "Textformatierung" });
  const tabBar = page.locator(".mobile-tab-bar");
  await expect.poll(async () => (await bottomOf(toolbar)) - Math.round((await box(tabBar)).y)).toBe(0);
  if (shots) await page.screenshot({ path: `${shots}/document.png` });
  await editor.tap();
  await page.keyboard.type("Hallo");
  await expect.poll(() => bottomOf(toolbar)).toBe(844);
});

test("a record's toolbar docks at the bottom of its sheet, also while one writes and while the sheet is dragged", async ({ page }) => {
  test.setTimeout(120_000);
  const { dialog, editor } = await recordWithContent(page);
  const toolbar = dialog.getByRole("toolbar", { name: "Textformatierung" });
  const heading = dialog.getByRole("heading", { name: "Inhalt", exact: true });
  await expect(dialog).toHaveClass(/modal-sheet/);
  // At the bottom edge of the screen (the sheet covers the tab bar), across
  // the whole width – not in the text's flow under "Inhalt".
  await expect.poll(() => bottomOf(toolbar)).toBe(844);
  expect(await toolbar.evaluate((el) => getComputedStyle(el).position)).toBe("fixed");
  const bar = await box(toolbar);
  expect(bar.x).toBeLessThanOrEqual(1);
  expect(bar.width).toBeGreaterThanOrEqual(388);
  await heading.scrollIntoViewIfNeeded();
  // Nothing between "Inhalt" and the text: the toolbar lies below the text.
  const head = await box(heading);
  const text = await box(editor);
  expect(text.y).toBeGreaterThan(head.y);
  expect(bar.y).toBeGreaterThan(text.y + 20);
  if (shots) await page.screenshot({ path: `${shots}/record-sheet.png` });

  // Writing: it stays docked, with "Tastatur ausblenden" at its end.
  await editor.tap();
  await expect.poll(() => focusIn(page, ".row-document .ProseMirror")).toBe(true);
  await page.keyboard.type(" – ");
  await expect(dialog.getByRole("button", { name: "Tastatur ausblenden" })).toBeVisible();
  await expect.poll(() => bottomOf(toolbar)).toBe(844);
  if (shots) await page.screenshot({ path: `${shots}/record-sheet-typing.png` });
  await dialog.getByRole("button", { name: "Tastatur ausblenden" }).tap();
  await expect.poll(() => focusIn(page, ".ProseMirror")).toBe(false);
  await expect.poll(() => bottomOf(toolbar)).toBe(844);

  // The end of the sheet scrolls above the toolbar: its last button stays
  // reachable.
  const remove = dialog.getByRole("button", { name: "Eintrag löschen" });
  await remove.scrollIntoViewIfNeeded();
  await dialog.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await expect.poll(async () => (await bottomOf(remove)) <= Math.round((await box(toolbar)).y)).toBe(true);

  // Dragged by its handle and held: the toolbar goes down with the sheet
  // (scrolled to its end, the case a transformed sheet got wrong).
  const handle = await box(dialog.locator(".sheet-handle"));
  const from = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...from, id: 1 }] });
  for (let i = 1; i <= 8; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from.x, y: from.y + i * 10, id: 1 }] });
    await page.waitForTimeout(20);
  }
  const offset = await dialog.evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).m42);
  expect(offset).toBeGreaterThan(20);
  const dragged = await box(toolbar);
  expect(Math.abs(dragged.y + dragged.height - (844 + offset))).toBeLessThanOrEqual(2);
  expect(dragged.x).toBeLessThanOrEqual(1);
  if (shots) await page.screenshot({ path: `${shots}/record-sheet-dragged.png` });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
  // A short pull springs back; the toolbar is at the bottom again.
  await expect(dialog).toBeVisible();
  await expect.poll(() => dialog.evaluate((el) => getComputedStyle(el).transform)).toBe("none");
  await expect.poll(() => bottomOf(toolbar)).toBe(844);
});

test("on the record's own page the toolbar docks on the tab bar", async ({ page }) => {
  test.setTimeout(120_000);
  const { db, row } = await recordWithContent(page);
  await page.goto(`/#page=${db.id}&row=${row.id}&full=1`);
  const record = page.locator(".record-page");
  const editor = record.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor).toContainText("Kartons besorgen");
  const toolbar = record.getByRole("toolbar", { name: "Textformatierung" });
  const tabBar = page.locator(".mobile-tab-bar");
  await expect.poll(async () => (await bottomOf(toolbar)) - Math.round((await box(tabBar)).y)).toBe(0);
  if (shots) await page.screenshot({ path: `${shots}/record-page.png` });
  await editor.tap();
  await page.keyboard.type("!");
  await expect.poll(() => bottomOf(toolbar)).toBe(844);
});
