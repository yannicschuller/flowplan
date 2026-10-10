import { test, expect } from "@playwright/test";

// Calculating in documents: a hint after "=", results for a selection and
// fractions as formulas.
test("calculate in a document: hint after =, selection and fractions", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Selecting text with the mouse is desktop-only here.");
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const created = await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Rechnen ${Date.now()}`, kind: "document" },
  });
  const pageId = (await created.json()).id;
  await page.goto(`/#page=${pageId}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await editor.click();

  // Typing "=" after a calculation shows the result; Tab writes it.
  await page.keyboard.type("Budget: 12 × 2.400 € =");
  // The first hint may wait for the calculator to load.
  await expect(editor.locator(".calc-hint")).toContainText("28.800 €", { timeout: 30_000 });
  await page.keyboard.press("Tab");
  await expect(editor.locator(".calc-hint")).toHaveCount(0);
  await expect(editor).toContainText("Budget: 12 × 2.400 € = 28.800 €");
  // Back in front of the written result: no second hint.
  await page.keyboard.press("ArrowLeft", { delay: 20 });
  for (let i = 0; i < " 28.800 €".length - 1; i++) await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(400);
  await expect(editor.locator(".calc-hint")).toHaveCount(0);
  await page.keyboard.press("End");

  // Without Tab nothing is written.
  await page.keyboard.press("Enter");
  await page.keyboard.type("3/4 + 1/6 =");
  await expect(editor.locator(".calc-hint")).toContainText("11/12");
  await page.keyboard.press("Escape");
  await expect(editor.locator(".calc-hint")).toHaveCount(0);

  // A fraction written as a formula counts too; the result is a formula.
  await page.keyboard.press("Enter");
  await page.evaluate(() => {
    const el = document.querySelector(".ProseMirror") as HTMLElement & {
      editor: { chain: () => { focus: () => { insertContent: (c: object) => { run: () => void } } } };
    };
    el.editor.chain().focus().insertContent({ type: "mathInline", attrs: { expression: "\\frac{12}{23}" } }).run();
  });
  await page.keyboard.type(" +3,5=");
  await expect(editor.locator(".calc-hint")).toContainText("185/46");
  await page.keyboard.press("Tab");
  await expect(editor.locator(".calc-hint")).toHaveCount(0);
  await expect(editor.locator(".math-inline")).toHaveCount(2);
  await expect(editor.locator(".math-inline").nth(1)).toHaveAttribute("data-math", "\\frac{185}{46}");

  // A selected term: the text menu offers to expand and factor.
  await page.keyboard.press("Enter");
  await page.keyboard.type("x² − 9");
  const term = editor.getByText("x² − 9");
  const box = (await term.boundingBox())!;
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  const calc = page.getByRole("group", { name: "Rechnen" });
  await expect(calc).toBeVisible();
  await calc.getByRole("menuitem", { name: /Faktorisieren/ }).click();
  await expect(editor).toContainText("x² − 9 = (x − 3)(x + 3)");

  // Fractions: the slash command opens the formula editor with \frac.
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/Bruch");
  await page.locator(".slash-menu").getByRole("button", { name: /^Bruch/ }).click();
  const dialog = page.getByRole("dialog", { name: "Inline-Formel" });
  const latex = dialog.getByLabel("LaTeX-Formel");
  await expect(latex).toHaveValue("\\frac{}{}");
  await latex.fill("\\frac{3}{4} + \\frac{1}{6}");
  await dialog.getByRole("group", { name: "Rechnen" }).getByRole("button", { name: /Ergebnis/ }).click();
  await expect(latex).toHaveValue("\\frac{3}{4} + \\frac{1}{6} = \\frac{11}{12}");
  await dialog.getByRole("button", { name: "Einfügen" }).click();
  await expect(editor.locator(".math-inline .katex")).toHaveCount(3);
  expect(errors).toEqual([]);
});
