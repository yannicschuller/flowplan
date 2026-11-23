import { test, expect } from "@playwright/test";

// Formulas written with dollars (#446): $…$ while typing, amounts stay
// text, undo brings the text back, "$$" + Enter opens the formula dialog,
// and the dialog's keys (⌘/Ctrl+Enter, Esc, Enter in an inline formula).
test("dollar formulas while typing and the formula dialog's keys", async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const created = await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Dollar ${Date.now()}`, kind: "document" },
  });
  const pageId = (await created.json()).id;
  await page.goto(`/#page=${pageId}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await editor.click();

  // The closing "$" makes the formula; amounts stay text.
  await page.keyboard.type("so $a^2$ and costs $5 and $10");
  const inline = editor.locator(".math-inline");
  await expect(inline).toHaveCount(1);
  await expect(inline.first()).toHaveAttribute("data-math", "a^2");
  await expect(inline.first().locator(".katex")).toHaveCount(1, { timeout: 20_000 });
  await expect(editor).toContainText("and costs $5 and $10");

  // Undo right after the conversion restores what was typed.
  await page.keyboard.press("Enter");
  await page.keyboard.type("then $b$");
  await expect(inline).toHaveCount(2);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(inline).toHaveCount(1);
  await expect(editor).toContainText("then $b$");

  // "$$" + Enter in an empty line opens the dialog for a formula block:
  // Enter is a new line there, ⌘/Ctrl+Enter inserts.
  await page.keyboard.press("Enter");
  await page.keyboard.type("$$");
  await page.keyboard.press("Enter");
  const block = page.getByRole("dialog", { name: "Mathematische Formel" });
  await expect(block).toBeVisible();
  const latex = block.getByLabel("LaTeX-Formel");
  await expect(latex).toBeFocused();
  const insert = block.getByRole("button", { name: /^Einfügen/ });
  await expect(insert).toHaveAttribute("title", /^Einfügen \((⌘ ↵|Ctrl \+ Enter)\)$/);
  await expect(insert.locator("kbd")).toHaveText(/^(⌘ ↵|Ctrl \+ Enter)$/);
  await page.keyboard.type("x^2");
  await page.keyboard.press("Enter");
  await page.keyboard.type("+1");
  await expect(latex).toHaveValue("x^2\n+1");
  await expect(block).toBeVisible();
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(block).toBeHidden();
  await expect(editor.locator(".math-block")).toHaveCount(1);
  await expect(editor.locator(".math-block")).toHaveAttribute("data-math", "x^2\n+1");

  // "$$" + space, then Esc: nothing inserted, the "$$" is gone.
  await editor.locator("p").last().click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("$$ ");
  await expect(block).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(block).toBeHidden();
  await expect(editor.locator(".math-block")).toHaveCount(1);
  await expect(editor).not.toContainText("$$");
  await expect(editor).toBeFocused();

  // An inline formula: ⇧Enter is a new line, Enter inserts.
  await page.keyboard.type("/inlinemath");
  await page.locator(".slash-menu").getByRole("option", { name: /^Inline-Formel/ }).first().click();
  const dialog = page.getByRole("dialog", { name: "Inline-Formel" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: /^Einfügen/ })).toHaveAttribute("title", /^Einfügen \((↵|Enter)\)$/);
  await page.keyboard.type("y_1");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("+z");
  await expect(dialog.getByLabel("LaTeX-Formel")).toHaveValue("y_1\n+z");
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(inline).toHaveCount(2);
  await expect(inline.nth(1)).toHaveAttribute("data-math", "y_1\n+z");
  expect(errors).toEqual([]);
});
