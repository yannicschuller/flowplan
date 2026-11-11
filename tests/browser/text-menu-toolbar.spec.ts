import { test, expect, type Page, type Locator } from "@playwright/test";

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

type Box = { x: number; y: number; width: number; height: number };
const overlap = (a: Box, b: Box) =>
  Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x) && Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y);

// Double-clicks a word of a paragraph and returns the word's box.
async function selectWord(page: Page, paragraph: Locator, word: string) {
  const at = await paragraph.evaluate((p, word) => {
    const text = p.firstChild!;
    const i = text.textContent!.indexOf(word);
    const range = document.createRange();
    range.setStart(text, i);
    range.setEnd(text, i + word.length);
    const r = range.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, top: r.top, bottom: r.bottom };
  }, word);
  await page.mouse.dblclick(at.x, at.y);
  return at;
}

// #210: a short line right under the formatting toolbar – the text menu
// opened above the selection and covered the toolbar. It opens below there,
// above where there is room, and leaves underline, strikethrough and
// highlight to the toolbar.
test("the text menu does not cover the formatting toolbar and leaves underline, strikethrough and highlight to it", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "selecting with a mouse");
  test.setTimeout(120_000);
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const db = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Kurzer Inhalt ${Date.now()}`, kind: "database" });
  const row = await command({ action: "row.create", pageId: db.id, cells: { title: "Kurzer Eintrag" } });
  await page.goto(`/#page=${db.id}&row=${row.id}`);
  const welcome = page.getByRole("dialog", { name: "Willkommen bei Flowplan" });
  const dialog = page.locator(".modal.record-dialog");
  const editor = dialog.locator(".ProseMirror");
  await expect(editor).toBeVisible({ timeout: 30_000 });
  if (await welcome.isVisible()) {
    await page.keyboard.press("Escape");
    await expect(welcome).toBeHidden();
  }
  await editor.click();
  await page.keyboard.type("Kurzer Text oben");
  for (let i = 0; i < 12; i++) await page.keyboard.press("Enter");
  await page.keyboard.type("Weiter unten mehr Platz");
  const toolbar = dialog.getByRole("toolbar", { name: "Textformatierung" });
  const menu = page.locator(".text-menu.selection");

  // The first line under the toolbar: the menu opens below the word.
  const word = await selectWord(page, editor.locator("p").first(), "Text");
  await expect(menu).toBeVisible();
  await page.waitForTimeout(250); // the opening animation
  const box = (await menu.boundingBox())!;
  const bar = (await toolbar.boundingBox())!;
  expect(overlap(box, bar), JSON.stringify({ box, bar })).toBe(false);
  expect(box.y).toBeGreaterThanOrEqual(word.bottom);
  expect(box.y - word.bottom).toBeLessThan(20);

  // Quick formatting at the text: bold, italic, code, link – no underline,
  // strikethrough or highlight (the toolbar has them).
  const format = menu.getByRole("group", { name: "Formatieren" });
  await expect(format.locator("button")).toHaveCount(4);
  for (const name of ["Fett", "Kursiv", "Code", "Link"]) await expect(format.getByLabel(name, { exact: true })).toHaveCount(1);
  for (const name of ["Unterstrichen", "Durchgestrichen", "Markieren"]) await expect(format.getByLabel(name, { exact: true })).toHaveCount(0);
  await expect(menu.getByRole("menuitem", { name: "Kommentieren" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Kopieren" })).toBeVisible();
  await format.getByLabel("Fett", { exact: true }).click();
  await expect(editor.locator("p").first().locator("strong")).toHaveText("Text");

  // Underline from the toolbar, strikethrough by its shortcut.
  // (A press outside the menu closes it.)
  await toolbar.getByRole("button", { name: "Unterstrichen", exact: true }).click();
  await expect(menu).toHaveCount(0);
  await expect(editor.locator("p").first().locator("u")).toHaveText("Text");
  await page.keyboard.press("ControlOrMeta+Shift+S");
  await expect(editor.locator("p").first().locator("s")).toHaveText("Text");

  // Further down, with room above: the menu opens above the selection.
  await selectWord(page, editor.locator("p").last(), "Platz");
  await expect(menu).toBeVisible();
  await page.waitForTimeout(250);
  // Where the selection is now (selecting may scroll the dialog a little).
  const lower = await page.evaluate(() => {
    const r = document.getSelection()!.getRangeAt(0).getBoundingClientRect();
    return { top: r.top, bottom: r.bottom };
  });
  const above = (await menu.boundingBox())!;
  expect(above.y + above.height).toBeLessThanOrEqual(lower.top);
  expect(lower.top - (above.y + above.height)).toBeLessThan(20);
  expect(overlap(above, (await toolbar.boundingBox())!)).toBe(false);
});
