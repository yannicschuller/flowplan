import { test, expect } from "@playwright/test";

// Text copied from a chat assistant keeps its formulas, lists and tables.
test("pasting an answer from a chat assistant formats formulas, lists and tables", async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const created = await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Einfügen ${Date.now()}`, kind: "document" },
  });
  const pageId = (await created.json()).id;
  await page.goto(`/#page=${pageId}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await editor.click();
  const paste = async (text: string, html = "") =>
    editor.evaluate(
      (el, [t, h]) => {
        const data = new DataTransfer();
        data.setData("text/plain", t);
        if (h) data.setData("text/html", h);
        el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
      },
      [text, html],
    );
  await paste("Vektoren addieren\n\\[\n\\begin{pmatrix}2\\\\3\\end{pmatrix}+\\begin{pmatrix}4\\\\1\\end{pmatrix}\n\\]\nSetzen wir \\(t=0\\) ein:\n- erster Punkt\n- zweiter Punkt\nZeichen\tBedeutung\n\\(g\\)\tGerade\n☐ Stützpunkt?");
  await expect(editor.locator(".math-block, [data-math]").first()).toBeVisible();
  await expect(editor.locator("p", { hasText: "Vektoren addieren" })).toHaveCount(1);
  await expect(editor.locator("ul li")).toHaveCount(2 + 1);
  await expect(editor.locator("table th").first()).toHaveText("Zeichen");
  await expect(editor.locator('ul[data-type="taskList"] li')).toContainText(["Stützpunkt?"]);
  await expect(editor.locator(".katex").first()).toBeVisible();
  // A copied web page with KaTeX: the formula comes back as LaTeX.
  await paste("a² + b²", '<p>Satz: <span class="katex"><span class="katex-mathml"><math><semantics><mrow></mrow><annotation encoding="application/x-tex">a^2+b^2=c^2</annotation></semantics></math></span><span class="katex-html">a2+b2=c2</span></span></p>');
  await expect.poll(async () => (await (await page.request.get(`/api/pages/${pageId}`)).json()).html, { timeout: 20_000 }).toContain('data-math="a^2+b^2=c^2"');
  expect(errors).toEqual([]);
});
