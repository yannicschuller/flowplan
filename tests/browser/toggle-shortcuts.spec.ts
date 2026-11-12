import { test, expect, type Page } from "@playwright/test";

// Toggles without a dialog (#230): /toggle inserts one right away with the
// caret in its empty title, "> " makes a toggle (or a quote, as chosen in
// the settings), '" ' a quote, ↵ in titles makes a list of toggles or ends
// it, the block menu turns paragraphs and list items into toggles, and
// closed toggles stay closed after a reload.
async function fixture(page: Page, title: string, html: string) {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await command({ action: "profile.onboarded" });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const host = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, kind: "document", title });
  const read = async () => (await page.request.get(`/api/pages/${host.id}`)).json();
  const { htmlState } = await import("../../lib/document-server");
  await command({
    action: "document.sync",
    pageId: host.id,
    generation: (await read()).generation,
    update: Buffer.from(htmlState(html)).toString("base64"),
  });
  return { host, command };
}
const focusedTitle = (page: Page) => page.evaluate(() => !!document.activeElement?.classList.contains("toggle-title"));

test("toggles from /toggle, '> ' and Enter; quotes from '\" '; the '>' setting; pasted quotes", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Keyboard shortcuts: desktop.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const f = await fixture(page, `Toggles ${Date.now()}`, "<p>Alpha</p><p></p>");
  await page.goto(`/#page=${f.host.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor.locator(":scope > p", { hasText: "Alpha" })).toBeVisible({ timeout: 20_000 });
  const toggles = editor.locator(":scope > details.toggle-block");

  // /toggle: no dialog, the caret in the empty title with its placeholder.
  await editor.locator(":scope > p").nth(1).click();
  await page.keyboard.type("/aufklapp");
  await expect(page.getByText("Aufklappbarer Block").first()).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(toggles).toHaveCount(1);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(() => focusedTitle(page)).toBe(true);
  const title = toggles.first().locator(".toggle-title");
  await expect(title).toHaveText("");
  expect(await title.evaluate((el) => getComputedStyle(el, "::before").content)).toBe('"Aufklappbarer Block"');
  await page.screenshot({ path: "test-results/toggle-placeholder.png" });
  // Typing names it; Enter in an open toggle goes into its content.
  await page.keyboard.type("Erster");
  await page.keyboard.press("Enter");
  await expect.poll(() => focusedTitle(page)).toBe(false);
  await page.keyboard.type("Inhalt eins");
  await expect(toggles.first().locator(":scope > div > p")).toHaveText("Inhalt eins");

  // Enter at the end of a closed toggle's title: the next toggle, closed, the caret in its title.
  await toggles.first().locator(".toggle-arrow").click();
  await expect(toggles.first()).not.toHaveAttribute("open", "");
  await title.click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expect(toggles).toHaveCount(2);
  await expect.poll(() => focusedTitle(page)).toBe(true);
  await expect(toggles.nth(1)).not.toHaveAttribute("open", "");
  await page.keyboard.type("Zweiter");
  await page.keyboard.press("Enter");
  await expect(toggles).toHaveCount(3);
  // Enter in the empty title: back to a paragraph – the list ends.
  await page.keyboard.press("Enter");
  await expect(toggles).toHaveCount(2);
  await expect.poll(() => focusedTitle(page)).toBe(false);
  await expect(toggles.nth(1).locator(".toggle-title")).toHaveText("Zweiter");

  // "> " at the start of an empty line: a toggle, the caret in its title.
  await page.keyboard.type("> ");
  await expect(toggles).toHaveCount(3);
  await expect.poll(() => focusedTitle(page)).toBe(true);
  await page.keyboard.type("Per Kürzel");
  await page.keyboard.press("Enter");
  await expect(toggles.nth(2).locator(".toggle-title")).toHaveText("Per Kürzel");
  // '" ' makes a quote (the typographic marks too).
  await page.keyboard.press("Escape");
  await editor.locator(":scope > p").last().click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type('" Zitat eins');
  await expect(editor.locator(":scope > blockquote")).toHaveText("Zitat eins");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("„ Zitat zwei");
  await expect(editor.locator("blockquote", { hasText: "Zitat zwei" })).not.toHaveCount(0);
  // Out of the quotes again (an empty line at the end of a quote).
  await page.keyboard.press("Enter");
  await page.keyboard.press("Backspace");

  // Pasted Markdown "> text" stays a quote.
  await editor.locator(":scope > p", { hasText: "Alpha" }).click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await editor.evaluate((el) => {
    const data = new DataTransfer();
    data.setData("text/plain", "## Notiz\n\n> Eingefügt zitiert");
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(editor.locator(":scope > blockquote", { hasText: "Eingefügt zitiert" })).toHaveCount(1);
  const togglesBefore = await toggles.count();

  // The setting: "> " makes a quote again, as in Markdown.
  await page.goto("/#settings/appearance");
  const quote = page.getByRole("radiogroup", { name: "„>“ erzeugt", exact: true }).getByText("Zitat", { exact: true });
  await quote.click();
  await expect(page.locator('input[name="quote-shortcut"]').nth(1)).toBeChecked();
  await page.waitForTimeout(500);
  const boot = await (await page.request.get("/api/bootstrap")).json();
  expect(boot.quoteShortcut).toBe("quote");
  await page.goto(`/#page=${f.host.id}`);
  await expect(editor.locator(":scope > p", { hasText: "Alpha" })).toBeVisible({ timeout: 20_000 });
  await editor.locator(":scope > p", { hasText: "Alpha" }).click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("> Markdown-Zitat");
  await expect(editor.locator(":scope > blockquote", { hasText: "Markdown-Zitat" })).toHaveCount(1);
  await expect(toggles).toHaveCount(togglesBefore);
  await f.command({ action: "profile.quoteShortcut", quoteShortcut: "toggle" });
  expect(errors).toEqual([]);
});

test("turn into toggle from the block menu, and closed toggles stay closed after a reload", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Block menu: desktop.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const f = await fixture(
    page,
    `Umwandeln ${Date.now()}`,
    "<p>Intro</p><p>Wird Titel</p><ul><li><p>Oben</p></li><li><p>Mitte</p><ul><li><p>Kind A</p></li><li><p>Kind B</p></li></ul></li><li><p>Unten</p></li></ul><p>Ende</p>",
  );
  await page.goto(`/#page=${f.host.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor.locator(":scope > p", { hasText: "Wird Titel" })).toBeVisible({ timeout: 20_000 });
  const toggles = editor.locator(":scope > details.toggle-block");

  // A paragraph: its text becomes the title, an empty paragraph inside.
  await editor.locator(":scope > p", { hasText: "Wird Titel" }).hover();
  await page.getByRole("button", { name: /Blockaktionen: .*Wird Titel/ }).click();
  await page.getByRole("menuitem", { name: /Umwandeln in/ }).click();
  await expect(page.getByRole("menuitemradio", { name: "Aufklappbarer Block" })).toBeVisible();
  await page.screenshot({ path: "test-results/toggle-turn-into.png" });
  await page.getByRole("menuitemradio", { name: "Aufklappbarer Block" }).click();
  await expect(toggles).toHaveCount(1);
  await expect(toggles.first().locator(".toggle-title")).toHaveText("Wird Titel");
  await expect(toggles.first().locator(":scope > div > p")).toHaveCount(1);
  // One undo step brings the paragraph back.
  await page.keyboard.press("ControlOrMeta+z");
  await expect(toggles).toHaveCount(0);
  await expect(editor.locator(":scope > p", { hasText: "Wird Titel" })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(toggles).toHaveCount(1);

  // A list item with a sub-list: titled with its text, holding the sub-list.
  await editor.locator("li", { hasText: "Mitte" }).first().locator(":scope > p").hover();
  await page.getByRole("button", { name: /Blockaktionen: .*Mitte/ }).click();
  await page.getByRole("menuitem", { name: /Umwandeln in/ }).click();
  await page.getByRole("menuitemradio", { name: "Aufklappbarer Block" }).click();
  await expect(toggles).toHaveCount(2);
  const listToggle = toggles.nth(1);
  await expect(listToggle.locator(".toggle-title")).toHaveText("Mitte");
  await expect(listToggle.locator(":scope > div > ul > li")).toHaveText(["Kind A", "Kind B"]);
  await expect(editor.locator(":scope > ul")).toHaveCount(2);

  // Closed toggles are remembered on this device for this person.
  await listToggle.locator(".toggle-arrow").click();
  await expect(listToggle).not.toHaveAttribute("open", "");
  await page.waitForTimeout(1500);
  await page.reload();
  await expect(editor.locator(":scope > p", { hasText: "Ende" })).toBeVisible({ timeout: 20_000 });
  await expect(toggles.nth(1)).not.toHaveAttribute("open", "");
  await expect(toggles.nth(0)).toHaveAttribute("open", "");
  await expect(toggles.nth(1).locator(":scope > div")).toBeHidden();
  const stored = await page.evaluate(() => localStorage.getItem("flowplan.toggles"));
  expect(stored).toMatch(/:/);
  expect(stored).not.toContain("Mitte");
  // Opened again: open after the next reload too.
  await toggles.nth(1).locator(".toggle-arrow").click();
  await expect(toggles.nth(1)).toHaveAttribute("open", "");
  await page.waitForTimeout(500);
  await page.reload();
  await expect(editor.locator(":scope > p", { hasText: "Ende" })).toBeVisible({ timeout: 20_000 });
  await expect(toggles.nth(1)).toHaveAttribute("open", "");
  expect(errors).toEqual([]);
});
