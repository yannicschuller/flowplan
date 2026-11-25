import { test, expect } from "@playwright/test";

// Formulas from the keyboard (#541): Backspace after a formula opens it at
// the formula with the caret at the end of its LaTeX, the arrow keys leave
// it at its edges (saving) and enter it from beside it, Esc cancels, and an
// empty formula saved is removed.
test("Backspace and the arrow keys edit an inline formula in place", async ({ page }, testInfo) => {
  // Phones get the dialog (a sheet) instead of the popover.
  test.skip(testInfo.project.name === "mobile", "the popover is for wider windows");
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const created = await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Math keys ${Date.now()}`, kind: "document" },
  });
  const pageId = (await created.json()).id;
  await page.goto(`/#page=${pageId}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await editor.click();

  await page.keyboard.type("so $a<0$");
  const formula = editor.locator(".math-inline");
  await expect(formula).toHaveCount(1);
  await expect(formula).toHaveAttribute("data-math", "a<0");
  await expect(formula).toHaveAttribute("aria-label", "Formel bearbeiten: a<0");
  await expect(formula.locator(".katex")).toHaveCount(1, { timeout: 20_000 });

  // Backspace right after it: the editor at the formula, caret at the end.
  await page.keyboard.press("Backspace");
  const popover = page.getByRole("dialog", { name: "Inline-Formel" });
  await expect(popover).toBeVisible();
  await expect(popover).toHaveClass(/math-popover/);
  const latex = popover.getByLabel("LaTeX-Formel");
  await expect(latex).toBeFocused();
  await expect.poll(() => latex.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([3, 3]);
  // Just below the formula.
  const [box, at] = [await popover.boundingBox(), await formula.boundingBox()];
  expect(box!.y).toBeGreaterThanOrEqual(at!.y + at!.height - 1);
  expect(box!.y).toBeLessThan(at!.y + at!.height + 40);
  await expect(formula).toHaveCount(1);

  // Backspace in the field removes the "0"; typed again, ArrowRight at the
  // end leaves: saved, the caret after the formula in the text.
  await page.keyboard.press("Backspace");
  await expect(latex).toHaveValue("a<");
  await expect(popover.locator(".math-preview")).toContainText("a<");
  await page.keyboard.type("0");
  await page.keyboard.press("ArrowRight");
  await expect(popover).toBeHidden();
  await expect(editor).toBeFocused();
  await expect(formula).toHaveAttribute("data-math", "a<0");
  await expect(formula.locator(".katex")).toHaveCount(1);
  await page.keyboard.type("!");
  await expect(editor.locator("p").first()).toHaveText(/a<0.*!$/);
  await page.keyboard.press("Backspace");

  // ArrowLeft from right after the formula enters it at its end; Esc
  // cancels: nothing saved, the caret back after the formula.
  await page.keyboard.press("ArrowLeft");
  await expect(popover).toBeVisible();
  await expect(latex).toBeFocused();
  await expect.poll(() => latex.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(3);
  await page.keyboard.type("9");
  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();
  await expect(editor).toBeFocused();
  await expect(formula).toHaveAttribute("data-math", "a<0");

  // ArrowLeft at the start of the field leaves before the formula; from
  // there ArrowRight enters it at its start.
  await page.keyboard.press("ArrowLeft");
  await expect(popover).toBeVisible();
  await expect(latex).toBeFocused();
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowLeft");
  await expect(popover).toBeHidden();
  await page.keyboard.press("ArrowRight");
  await expect(popover).toBeVisible();
  await expect.poll(() => latex.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(0);
  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();

  // A click opens the same popover; emptied and saved, the formula is gone.
  await formula.click();
  await expect(popover).toBeVisible();
  await latex.fill("");
  await page.keyboard.press("Enter");
  await expect(popover).toBeHidden();
  await expect(formula).toHaveCount(0);
  await expect(editor).toBeFocused();
  await expect(editor.locator("p").first()).toHaveText(/^so\s*$/);
  expect(errors).toEqual([]);
});

// A formula block: Backspace at the start of the line below and ArrowUp
// from it open it at its end, ArrowDown on its last line leaves it below.
test("Backspace and the arrow keys edit a formula block in place", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "the popover is for wider windows");
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const created = await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Math block keys ${Date.now()}`, kind: "document" },
  });
  const pageId = (await created.json()).id;
  await page.goto(`/#page=${pageId}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await editor.click();
  await page.evaluate(() => {
    const el = document.querySelector(".ProseMirror") as HTMLElement & {
      editor: { chain: () => { focus: () => { insertContent: (c: object) => { run: () => void } } } };
    };
    el.editor
      .chain()
      .focus()
      .insertContent([
        { type: "paragraph", content: [{ type: "text", text: "above" }] },
        { type: "mathBlock", attrs: { expression: "x^2" } },
        { type: "paragraph", content: [{ type: "text", text: "below" }] },
      ])
      .run();
  });
  const block = editor.locator(".math-block");
  await expect(block).toHaveAttribute("data-math", "x^2");
  await editor.locator("p", { hasText: "below" }).click();
  await page.keyboard.press("Home");
  await page.keyboard.press("Backspace");
  const popover = page.getByRole("dialog", { name: "Mathematische Formel" });
  await expect(popover).toBeVisible();
  const latex = popover.getByLabel("LaTeX-Formel");
  await expect(latex).toBeFocused();
  await expect.poll(() => latex.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(3);
  // Enter is a new line in a formula block; ArrowDown on the last line
  // leaves it below, saved.
  await page.keyboard.press("Enter");
  await page.keyboard.type("+1");
  await page.keyboard.press("ArrowDown");
  await expect(popover).toBeHidden();
  await expect(block).toHaveAttribute("data-math", "x^2\n+1");
  await expect(editor).toBeFocused();
  // ArrowUp from the first line below enters it at its end; Esc cancels.
  await page.keyboard.press("ArrowUp");
  await expect(popover).toBeVisible();
  await expect.poll(() => latex.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(6);
  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();
  await expect(block).toHaveAttribute("data-math", "x^2\n+1");
  await expect(editor.locator("p", { hasText: "below" })).toHaveCount(1);
  expect(errors).toEqual([]);
});
