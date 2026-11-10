import { test, expect } from "@playwright/test";

// The "@" dialog works from the keyboard like the slash menu and the
// command palette: the first hit is highlighted, the arrow keys move the
// highlight, Enter inserts it and Escape returns to the text – with the "@"
// and the search typed, as without the dialog. Inside a word (an e-mail
// address) "@" is typed without it.
test("the mention dialog is used with the arrow keys, Enter and Escape", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const tag = `${info.project.name}${Date.now()}`;
  const create = async (title: string, kind = "document") =>
    (await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind })).id as string;
  await create(`Anker ${tag} eins`);
  await create(`Anker ${tag} zwei`);
  const notes = await create(`Notizen ${tag}`, "database");
  const row = (await command({ action: "row.create", pageId: notes, cells: { title: `Wartung ${tag}` } })).id as string;
  const doc = await create(`Text ${tag}`);

  await page.goto(`/#page=${doc}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  // The introduction a new account sees first.
  const skip = page.getByRole("button", { name: "Überspringen" });
  if (await skip.waitFor({ timeout: 5000 }).then(() => true, () => false)) await skip.click();
  await editor.click();
  const dialog = page.getByRole("dialog", { name: "Seite, Eintrag oder Person erwähnen" });
  const search = dialog.getByRole("combobox", { name: "Seiten, Einträge und Personen suchen" });
  const list = dialog.getByRole("listbox");
  const selected = list.getByRole("option", { selected: true });

  // The first hit is highlighted; the arrows move the highlight and wrap
  // around, and the field names the highlighted option.
  await page.keyboard.press("@");
  await expect(search).toBeFocused();
  await page.keyboard.type(`Anker ${tag}`);
  await expect(list.getByRole("option")).toHaveCount(2);
  await expect(selected).toHaveCount(1);
  const first = (await selected.textContent()) || "";
  await page.keyboard.press("ArrowDown");
  await expect(selected).not.toHaveText(first);
  const second = (await selected.textContent()) || "";
  expect(await search.getAttribute("aria-activedescendant")).toBe(await selected.getAttribute("id"));
  await page.keyboard.press("ArrowDown");
  await expect(selected).toHaveText(first);
  await page.keyboard.press("ArrowUp");
  await expect(selected).toHaveText(second);

  // Enter during an IME composition is left to the input method.
  await search.dispatchEvent("keydown", { key: "Enter", isComposing: true });
  await expect(dialog).toBeVisible();

  // Enter inserts the highlighted page; the caret is back in the text.
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(editor.getByRole("link", { name: second })).toHaveCount(1);
  await page.keyboard.type(" weiter");
  await expect(editor).toContainText(`${second} weiter`);

  // Records arrive later from the server and are highlighted like pages.
  // The field starts empty again after a page was inserted.
  await page.keyboard.type(" ");
  await page.keyboard.press("@");
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("");
  await page.keyboard.type(`Wartung ${tag}`);
  await expect(selected).toContainText(`Wartung ${tag}`);
  await page.keyboard.press("Enter");
  await expect(editor.getByRole("link", { name: `Wartung ${tag}` })).toHaveAttribute("href", `/#page=${notes}&row=${row}`);

  // Without a hit Enter types the "@" and the search into the text; the
  // caret is back in the text behind them.
  await page.keyboard.type(" ");
  await page.keyboard.press("@");
  await page.keyboard.type(`nichts ${tag}`);
  await expect(selected).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(editor).toBeFocused();
  await expect(editor).toContainText(`Wartung ${tag} @nichts ${tag}`);
  // Escape does the same.
  await page.keyboard.type(" ");
  await page.keyboard.press("@");
  await expect(search).toBeFocused();
  await page.keyboard.type("x");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(editor).toBeFocused();
  await page.keyboard.type(" Ende");
  await expect(editor).toContainText(`@nichts ${tag} @x Ende`);
  // After a letter or digit – an e-mail address – "@" is typed at once.
  await page.keyboard.type(" ada");
  await page.keyboard.press("@");
  await page.keyboard.type("example.org");
  await expect(dialog).toHaveCount(0);
  await expect(editor).toContainText("ada@example.org");

  // The highlight is scrolled into view: ArrowUp from the first option
  // goes to the last one of the long list.
  await page.keyboard.type(" ");
  await page.keyboard.press("@");
  await expect(selected).toHaveCount(1);
  await page.keyboard.press("ArrowUp");
  await expect(selected).toBeInViewport();
  await expect(list.getByRole("option").last()).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  expect(errors).toEqual([]);
});

// Records and blocks arrive from the server after the pages. A hit the user
// has already highlighted stays highlighted when they arrive, so Enter
// inserts what the user chose and not the first hit.
test("the highlight stays on its hit when server results arrive", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const tag = `${info.project.name}${Date.now()}`;
  const create = async (title: string, kind = "document") =>
    (await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind })).id as string;
  await create(`Anker ${tag} eins`);
  await create(`Anker ${tag} zwei`);
  const notes = await create(`Notizen ${tag}`, "database");
  await command({ action: "row.create", pageId: notes, cells: { title: `Anker ${tag} drei` } });
  const doc = await create(`Text ${tag}`);

  // The record and block searches answer only when the test lets them.
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(/\/api\/(search\?.*kind=row|blocks\?)/, async (route) => {
    await held;
    await route.continue();
  });

  await page.goto(`/#page=${doc}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  const skip = page.getByRole("button", { name: "Überspringen" });
  if (await skip.waitFor({ timeout: 5000 }).then(() => true, () => false)) await skip.click();
  await editor.click();
  const dialog = page.getByRole("dialog", { name: "Seite, Eintrag oder Person erwähnen" });
  const list = dialog.getByRole("listbox");
  const options = list.getByRole("option");
  const selected = list.getByRole("option", { selected: true });

  await page.keyboard.press("@");
  await page.keyboard.type(`Anker ${tag}`);
  // Only the pages so far; the second one is highlighted.
  await expect(options).toHaveCount(2);
  await page.keyboard.press("ArrowDown");
  await expect(selected).toHaveText(await options.nth(1).textContent() || "");
  const second = (await selected.textContent()) || "";

  // The record arrives; the highlight stays where it was.
  const answered = page.waitForResponse(/\/api\/search\?.*kind=row/);
  release();
  await answered;
  await expect(options).toHaveCount(3);
  await expect(options.nth(2)).toContainText(`Anker ${tag} drei`);
  await expect(selected).toHaveText(second);

  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(editor.getByRole("link", { name: second })).toHaveCount(1);
  await expect(editor.getByRole("link")).toHaveCount(1);
  expect(errors).toEqual([]);
});
