import { test, expect, type Page } from "@playwright/test";

// Formatted text properties (#126): a table cell edits bold, links and line
// breaks with the keyboard and shows them formatted; existing values with
// stars show literally; nothing in a value becomes HTML or a script link;
// the record edits the same text with Enter as a line break.
const shots = process.env.RT126_SHOTS;
// The editor reads the browser's selection after each key, as for a person
// typing; keys a few milliseconds apart would outrun it.
const press = async (page: Page, key: string, times = 1) => {
  for (let i = 0; i < times; i++) {
    await page.keyboard.press(key);
    await page.waitForTimeout(60);
  }
};

async function setup(page: Page, name: string) {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  // No welcome tour over the table.
  await command({ action: "profile.onboarded" });
  const db = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: name, kind: "database" });
  const read = async () => (await page.request.get(`/api/pages/${db.id}`)).json();
  const first = await read();
  await command({
    action: "database.update",
    pageId: db.id,
    version: first.database.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "notes", name: "Notiz", type: "text" },
    ],
    views: first.database.views,
  });
  const notes = async (title: string) => ((await read()).rows as { cells: Record<string, string> }[]).find((r) => r.cells.title === title)?.cells.notes;
  return { db, command, read, notes };
}

test("a table cell: bold, a line break and a link with the keyboard", async ({ page }, info) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => {
    errors.push(`dialog: ${d.message()}`);
    void d.dismiss();
  });
  const { db, command, notes } = await setup(page, `Formatiert ${info.project.name} ${Date.now()}`);
  await command({ action: "row.create", pageId: db.id, cells: { title: "Alpha" } });
  // An existing value from before #126, escaped by the migration.
  await command({ action: "row.create", pageId: db.id, cells: { title: "Beta", notes: "\\*stars\\* and snake\\_case" } });
  // Nothing in a value runs: a script link stays text, HTML is text.
  await command({ action: "row.create", pageId: db.id, cells: { title: "Gamma", notes: "[evil](javascript:alert(1)) <b>html</b> <img src=x onerror=alert(2)>" } });
  await page.goto(`/#page=${db.id}`);

  const row = (title: string) => page.locator("tr", { has: page.getByText(title, { exact: true }) });
  await expect(row("Beta")).toContainText("*stars* and snake_case");
  await expect(row("Beta").locator("em, strong")).toHaveCount(0);
  await expect(row("Gamma")).toContainText("evil <b>html</b> <img src=x onerror=alert(2)>");
  await expect(row("Gamma").locator("a, b, img")).toHaveCount(0);

  // Type, make one word bold (⌘/Ctrl B), a line break (Shift+Enter), Enter ends the edit.
  await row("Alpha").getByRole("gridcell").filter({ hasText: "—" }).click();
  const editor = page.getByRole("textbox", { name: "Notiz" });
  await expect(editor).toBeFocused({ timeout: 30_000 });
  await page.keyboard.type("Hello world");
  await press(page, "Shift+ArrowLeft", 5);
  // The format bar over the selection.
  const bar = page.getByRole("toolbar", { name: "Formatieren" });
  await expect(bar).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/table-format-bar.png` });
  await press(page, "ControlOrMeta+b");
  await expect(editor.locator("strong")).toHaveText("world");
  await press(page, "End");
  await press(page, "Shift+Enter");
  // Bold goes on after the bold word, as in any editor: off again.
  await press(page, "ControlOrMeta+b");
  await page.keyboard.type("second line");
  await page.keyboard.press("Enter");
  await expect.poll(() => notes("Alpha")).toBe("Hello **world**\nsecond line");
  await expect(editor).toBeHidden();
  // Shown formatted; in the table the line break reads as a space.
  await expect(row("Alpha").locator("strong")).toHaveText("world");
  await expect(row("Alpha")).toContainText("Hello world second line");
  if (shots) await page.screenshot({ path: `${shots}/table-formatted.png` });

  // Editing again keeps the formatting; ⌘/Ctrl K links the selection.
  await row("Alpha").getByRole("gridcell").filter({ hasText: "second line" }).click();
  await expect(editor).toBeFocused();
  await expect(editor.locator("strong")).toHaveText("world");
  // The caret is placed at the end once the editor is ready.
  await page.waitForTimeout(300);
  await expect(editor.locator("br")).not.toHaveCount(0);
  await press(page, "ControlOrMeta+Home");
  await press(page, "Shift+ArrowRight", 5);
  await press(page, "ControlOrMeta+k");
  const address = page.getByLabel("Link-Adresse");
  await expect(address).toBeFocused();
  // Only http, https and mailto.
  await address.fill("javascript:alert(1)");
  await address.press("Enter");
  await expect(page.getByText("Nur http-, https- und mailto-Links.")).toBeVisible();
  await address.fill("example.com/docs");
  await address.press("Enter");
  await expect(editor.locator("a")).toHaveText("Hello");
  await page.keyboard.press("Enter");
  await expect.poll(() => notes("Alpha")).toBe("[Hello](https://example.com/docs) **world**\nsecond line");
  const link = row("Alpha").getByRole("link", { name: "Hello" });
  await expect(link).toHaveAttribute("href", "https://example.com/docs");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", /noopener/);

  // The record: line breaks shown, Enter makes another one.
  await row("Alpha").getByText("Alpha", { exact: true }).click();
  const entry = page.getByRole("dialog", { name: "Eintrag", exact: true });
  const property = entry.getByRole("textbox", { name: "Notiz" });
  await expect(property.locator("strong")).toHaveText("world", { timeout: 30_000 });
  await expect(property.locator("a")).toHaveText("Hello");
  await property.click();
  await press(page, "ControlOrMeta+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("third");
  await press(page, "Shift+ArrowLeft", 5);
  await press(page, "ControlOrMeta+i");
  if (shots) await entry.screenshot({ path: `${shots}/record-dialog.png` });
  // Leaving the field saves.
  await entry.getByRole("heading").first().click();
  await expect.poll(() => notes("Alpha")).toBe("[Hello](https://example.com/docs) **world**\nsecond line\n_third_");
  expect(errors).toEqual([]);
});

test("pasting rich text keeps bold and links, drops headings", async ({ page, context, browserName }, info) => {
  test.skip(browserName !== "chromium", "clipboard permissions");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const { db, command, notes } = await setup(page, `Einfügen ${info.project.name} ${Date.now()}`);
  await command({ action: "row.create", pageId: db.id, cells: { title: "Delta" } });
  await page.goto(`/#page=${db.id}`);
  const row = page.locator("tr", { has: page.getByText("Delta", { exact: true }) });
  await row.getByRole("gridcell").filter({ hasText: "—" }).click();
  const editor = page.getByRole("textbox", { name: "Notiz" });
  await expect(editor).toBeFocused({ timeout: 30_000 });
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData("text/html", '<h1>Titel</h1><p>Ein <b>fetter</b> <a href="https://x.test/">Link</a> *nicht*</p><script>alert(1)</script>');
    data.setData("text/plain", "Titel Ein fetter Link");
    document.activeElement!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(editor.locator("h1")).toHaveCount(0);
  await expect(editor.locator("a")).toHaveText("Link");
  await page.keyboard.press("Enter");
  await expect.poll(() => notes("Delta")).toBe("**Titel**\n\nEin **fetter** [Link](https://x.test/) \\*nicht\\*");
});
