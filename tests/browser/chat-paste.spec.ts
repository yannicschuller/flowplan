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

// ChatGPT in the browser copies HTML in which formulas are still \[ … \]
// text; formulas already pasted as text can be turned into formulas later.
test("formulas written as text in copied HTML and in the document become formulas", async ({ page }, info) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const created = await page.request.post("/api/command", {
    headers: { origin },
    data: {
      action: "page.create",
      workspaceId: boot.workspace.id,
      spaceId: boot.spaces[0].id,
      title: `HTML ${Date.now()}`,
      kind: "document",
    },
  });
  const pageId = (await created.json()).id;
  await page.goto(`/#page=${pageId}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await editor.click();
  const html =
    "<h2>1. Grundlagen: Was ist ein Vektor?</h2><p>Ein Vektor beschreibt eine <strong>Richtung</strong>.</p><p>\\[ \\vec{v}= \\begin{pmatrix} 3\\\\ 2\\\\ 1 \\end{pmatrix} \\]</p><p>\\[ A(2;3;1) \\]\\[ B(5;7;4) \\]</p><p>Setzen wir \\(t=0\\) ein:</p><p>☐ Stützpunkt?<br>☐ Richtungsvektor?</p>";
  await editor.evaluate((el, h) => {
    const data = new DataTransfer();
    data.setData("text/plain", "plain");
    data.setData("text/html", h);
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, html);
  await expect(editor.locator("h2")).toHaveText("1. Grundlagen: Was ist ein Vektor?");
  await expect(editor.locator("div[data-math]")).toHaveCount(3);
  await expect(editor.locator("p", { hasText: "Setzen wir" }).locator("[data-math]")).toHaveCount(1);
  await expect(editor.locator('ul[data-type="taskList"] li')).toHaveCount(2);
  await expect(editor).not.toContainText("\\[");

  if (info.project.name !== "desktop") return;
  // Text pasted earlier: select everything and turn it into formulas.
  await editor.locator("p").last().click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Formel: \\(x^2\\) und");
  await page.keyboard.press("Enter");
  await page.keyboard.type("\\[ a^2+b^2=c^2 \\]");
  await page.keyboard.press("ControlOrMeta+a");
  await editor.locator("p", { hasText: "Formel:" }).click({ button: "right" });
  await page.keyboard.press("ControlOrMeta+a");
  await page.getByRole("menuitem", { name: "In Formeln umwandeln" }).click();
  await expect(editor.locator("div[data-math]")).toHaveCount(4);
  await expect(editor.locator("p", { hasText: "Formel:" }).locator("[data-math]")).toHaveCount(1);
  await expect(editor).not.toContainText("\\(");
  expect(errors).toEqual([]);
});
