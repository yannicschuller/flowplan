import { test, expect, type Page } from "@playwright/test";

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

// A demo account with a document of two lines; "Menü bei Textauswahl"
// (#200) is set first – a new account has "computer"
// (tests/text-menu-pref.test.ts), but a test server may sign every test in
// as the same person.
async function documentWithText(page: Page, textMenu: "always" | "computer" | "never") {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const saved = await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.textMenu", textMenu } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const created = await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Menü ${Date.now()}`, kind: "document" },
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
  await editor.click();
  await page.keyboard.type("Erste Zeile");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Telekom SDSB");
  return editor;
}

// Back to the default for the specs that follow (see above).
test.afterEach(async ({ page }) => {
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.textMenu", textMenu: "computer" } });
});

// A selection as the handles of a touch selection make it: no mouseup.
const select = (page: Page, index: number, from: number, to: number) =>
  page.evaluate(
    ([index, from, to]) => {
      const p = document.querySelectorAll(".ProseMirror p")[index];
      const text = p.firstChild!;
      const range = document.createRange();
      range.setStart(text, from);
      range.setEnd(text, to);
      const sel = document.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    },
    [index, from, to] as const,
  );

// Where a word of a line is on screen.
const wordAt = (page: Page, index: number, from: number, to: number) =>
  page.evaluate(
    ([index, from, to]) => {
      const p = document.querySelectorAll(".ProseMirror p")[index];
      const range = document.createRange();
      range.setStart(p.firstChild!, from);
      range.setEnd(p.firstChild!, to);
      const r = range.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    },
    [index, from, to] as const,
  );

// With "Immer" a phone shows the menu on a touch selection (no mouseup),
// on screen, its rows wrapping instead of leaving the edge.
test("with Always the selection menu follows a touch selection and stays on screen", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "Touch selection on a phone.");
  test.setTimeout(120_000);
  await documentWithText(page, "always");
  const menu = page.locator(".text-menu.selection");
  const inside = async () => {
    await page.waitForTimeout(200); // the opening animation
    const box = (await menu.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(7);
    expect(box.x + box.width).toBeLessThanOrEqual(390 - 7);
    expect(box.y).toBeGreaterThanOrEqual(0);
    return box;
  };
  await select(page, 0, 0, 5);
  await expect(menu).toBeVisible();
  const first = await inside();
  // Dragging the handles to another line: the menu moves with it.
  await select(page, 1, 0, 12);
  await expect.poll(async () => (await menu.boundingBox())!.y).toBeGreaterThan(first.y + 10);
  await inside();
});

// #200: by default ("Nur am Computer") a finger selection on a phone shows
// nothing of Flowplan's own – the system's menu and the docked toolbar (with
// a comment button) take over; a right click still opens the menu.
test("by default a touch selection on a phone shows no text menu; the toolbar comments, a right click opens the menu", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "Touch selection on a phone.");
  test.setTimeout(120_000);
  const editor = await documentWithText(page, "computer");
  // A finger in the text first, then the handles select.
  const word = await wordAt(page, 0, 0, 5);
  await page.touchscreen.tap(word.x, word.y);
  await select(page, 0, 0, 5);
  await page.waitForTimeout(600); // longer than the menu waits for the selection to settle
  await expect(page.locator(".text-menu")).toHaveCount(0);
  await select(page, 1, 0, 7);
  await page.waitForTimeout(600);
  await expect(page.locator(".text-menu")).toHaveCount(0);

  // Comment from the toolbar: the composer opens for the selection.
  const toolbar = page.getByRole("toolbar", { name: "Textformatierung" });
  const comment = toolbar.getByRole("button", { name: "Kommentieren", exact: true });
  await expect(comment).toHaveCount(1);
  await comment.scrollIntoViewIfNeeded();
  await comment.click();
  await expect(page.getByRole("region", { name: "Textkommentare" }).or(page.locator(".inline-comment-panel"))).toBeVisible();
  await page.keyboard.press("Escape");

  // A right click (a long press where the browser reports one) opens it.
  await editor.click();
  const target = await wordAt(page, 1, 0, 7);
  await page.mouse.click(target.x, target.y, { button: "right" });
  const context = page.locator(".text-menu.context");
  await expect(context).toBeVisible();
  await expect(context.getByRole("menuitem", { name: "Kommentieren" })).toBeVisible();
  await expect(context.getByRole("group", { name: "Auf den Absatz reagieren" })).toBeVisible();
});

// On a computer the default is unchanged: selecting with the mouse shows the
// menu; "Nie" shows nothing on selecting, and a right click still opens it.
test("on a computer the mouse selection shows the menu by default; with Never only a right click opens it", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Mouse selection on a computer.");
  test.setTimeout(120_000);
  await documentWithText(page, "computer");
  const menu = page.locator(".text-menu.selection");
  const word = await wordAt(page, 1, 0, 7);
  await page.mouse.dblclick(word.x, word.y);
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  // Shift + arrow keys select too.
  await page.keyboard.press("End");
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("Shift+ArrowLeft");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");

  const saved = await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.textMenu", textMenu: "never" } });
  expect(saved.ok()).toBe(true);
  await page.reload();
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor).toContainText("Telekom");
  const again = await wordAt(page, 1, 0, 7);
  await page.mouse.dblclick(again.x, again.y);
  await page.waitForTimeout(400);
  await expect(page.locator(".text-menu")).toHaveCount(0);
  await page.mouse.click(again.x, again.y, { button: "right" });
  await expect(page.locator(".text-menu.context")).toBeVisible();
});
