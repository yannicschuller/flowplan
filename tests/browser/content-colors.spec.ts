import { test, expect, type Page } from "@playwright/test";

// Text marks and diagrams in light and dark (#241): a highlight without a
// colour uses the palette's yellow (see-through in dark) with the theme's
// text colour, inline code its accent colour on a grey tint, bold stays on
// inline code, and Mermaid diagrams follow the theme (also when it changes
// while the page is open).
// SHOTS=<dir> keeps screenshots of each theme there.
const shots = process.env.SHOTS;

async function documentWith(page: Page, title: string, html: (upload: string) => string) {
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
  // A picture for the image (a plain PNG, drawn in the page).
  await page.goto("/#home");
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 480;
    canvas.height = 160;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#4f70d5";
    context.fillRect(0, 0, 480, 160);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  const upload = await page.request.post("/api/upload", {
    headers: { origin },
    multipart: { pageId: host.id, file: { name: "bild.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") } },
  });
  const { url } = await upload.json();
  const { htmlState } = await import("../../lib/document-server");
  const generation = (await (await page.request.get(`/api/pages/${host.id}`)).json()).generation;
  await command({ action: "document.sync", pageId: host.id, generation, update: Buffer.from(htmlState(html(url))).toString("base64") });
  return host;
}
const setTheme = (page: Page, theme: "light" | "dark") =>
  page.evaluate((value) => {
    localStorage.setItem("flowplan-theme", value);
    document.documentElement.dataset.theme = value;
  }, theme);

test("highlights, inline code and Mermaid follow light and dark", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Colours: desktop.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const host = await documentWith(
    page,
    `Farben ${Date.now()}`,
    () =>
      "<p>Ein <mark>markierter</mark> und ein <mark data-color=\"#c5e0fa\" style=\"background-color: #c5e0fa\">blauer</mark> Abschnitt, " +
      "der Befehl <code>npm install</code> und <strong><code>fett</code></strong> im Text.</p>" +
      '<div data-mermaid="graph LR&#10;A[Start] --&gt; B{Prüfen}&#10;B --&gt; C[Ende]">graph</div>' +
      '<pre data-code-view="preview"><code class="language-mermaid">graph LR\nX[Code] --&gt; Y[Vorschau]</code></pre>' +
      "<p>Ende.</p>",
  );
  await page.goto("/#home");
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    await page.goto(`/#page=${host.id}`);
    await page.reload();
    const editor = page.getByLabel("Dokumentinhalt", { exact: true });
    const plain = editor.locator("mark:not([data-color])");
    await expect(plain).toBeVisible({ timeout: 20_000 });
    const look = (selector: string) =>
      editor.locator(selector).first().evaluate((el) => {
        const s = getComputedStyle(el);
        return { color: s.color, background: s.backgroundColor, size: s.fontSize, radius: s.borderRadius, padding: s.padding, weight: s.fontWeight };
      });
    const line = editor.locator("p", { hasText: "Ein markierter" });
    const text = await line.evaluate((el) => getComputedStyle(el).color);
    // 1. A highlight without a colour: not the browser's yellow and black.
    const mark = await look("mark:not([data-color])");
    expect(mark.background).not.toBe("rgb(255, 255, 0)");
    expect(mark.color).toBe(text);
    expect(mark.background).toBe(theme === "light" ? "rgb(255, 236, 153)" : "rgba(230, 190, 20, 0.3)");
    // The coloured ones as before: their own tint.
    const blue = await look("mark[data-color]");
    expect(blue.background).toBe(theme === "light" ? "rgb(197, 224, 250)" : "rgba(60, 140, 230, 0.32)");
    // 5. Inline code: the accent on a grey tint, 85 %, 4 px corners.
    const code = await look("p > code");
    expect(code.color).toBe(theme === "light" ? "rgb(189, 41, 49)" : "rgb(233, 105, 94)");
    expect(code.background).toBe(theme === "light" ? "rgba(135, 131, 120, 0.15)" : "rgba(255, 255, 255, 0.055)");
    expect(code.radius).toBe("4px");
    const paragraphSize = parseFloat(await line.evaluate((el) => getComputedStyle(el).fontSize));
    expect(Math.abs(parseFloat(code.size) - paragraphSize * 0.85)).toBeLessThan(0.1);
    // 3. Bold stays on inline code.
    const bold = await look("strong > code");
    expect(Number(bold.weight)).toBeGreaterThanOrEqual(600);
    // 2. Mermaid in the theme's colours: the block and the code preview.
    const block = editor.locator(".mermaid-block");
    await expect(block).toHaveAttribute("data-diagram-state", "ready", { timeout: 30_000 });
    await expect(block).toHaveAttribute("data-diagram-theme", theme);
    const preview = editor.locator('.code-block-preview[data-preview-kind="mermaid"]');
    await expect(preview).toHaveAttribute("data-preview-state", "ready", { timeout: 30_000 });
    await expect(preview).toHaveAttribute("data-diagram-theme", theme);
    for (const box of [block, preview]) {
      const background = await box.evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(background).toBe(theme === "light" ? "rgb(255, 255, 255)" : "rgb(29, 28, 35)");
    }
    // Mermaid's dark theme draws light lines and text.
    const svg = decodeURIComponent((await block.locator("img").getAttribute("src"))!.split(",")[1]);
    if (theme === "dark") expect(svg).not.toMatch(/fill:#333;|color:#333/);
    if (shots) {
      await line.screenshot({ path: `${shots}/highlight-code-${theme}.png` });
      await block.screenshot({ path: `${shots}/mermaid-block-${theme}.png` });
      await preview.screenshot({ path: `${shots}/mermaid-preview-${theme}.png` });
    }
  }
  // Switching while the page is open draws the diagrams again.
  await setTheme(page, "light");
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor.locator(".mermaid-block")).toHaveAttribute("data-diagram-theme", "light", { timeout: 30_000 });
  await expect(editor.locator('.code-block-preview[data-preview-kind="mermaid"]')).toHaveAttribute("data-diagram-theme", "light", { timeout: 30_000 });
  expect(errors).toEqual([]);
});

test("“Add caption” below an image, a table and a code block never covers the next block", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Pointer hover: desktop.");
  const host = await documentWith(
    page,
    `Beschriftung ${Date.now()}`,
    (url) =>
      `<p>Vorher.</p><img src="${url}" alt="Bild"><p>Nach dem Bild.</p>` +
      "<table><tbody><tr><th><p>A</p></th><th><p>B</p></th></tr><tr><td><p>1</p></td><td><p>2</p></td></tr></tbody></table><p>Nach der Tabelle.</p>" +
      '<pre><code class="language-js">const a = 1;</code></pre><p>Nach dem Code.</p>',
  );
  for (const theme of ["light", "dark"] as const) {
    await page.goto("/#home");
    await setTheme(page, theme);
    await page.goto(`/#page=${host.id}`);
    await page.reload();
    const editor = page.getByLabel("Dokumentinhalt", { exact: true });
    await expect(editor.locator("img")).toBeVisible({ timeout: 20_000 });
    const cases = [
      { block: editor.locator("img").first(), next: editor.locator("p", { hasText: "Nach dem Bild." }), name: "image" },
      { block: editor.locator("table").first(), next: editor.locator("p", { hasText: "Nach der Tabelle." }), name: "table" },
      { block: editor.locator("pre").first(), next: editor.locator("p", { hasText: "Nach dem Code." }), name: "code" },
    ];
    for (const { block, next, name } of cases) {
      await block.hover();
      const add = next.locator("xpath=preceding-sibling::*[1]").locator(".block-caption-add");
      // Images and tables offer the caption in their own tools (#240):
      // the image's corner toolbar, the table's handle menus.
      if (name !== "code") {
        await expect(add).toBeHidden();
        continue;
      }
      await expect(add).toBeVisible();
      const a = (await add.boundingBox())!;
      const n = (await next.boundingBox())!;
      // Entirely above the next block's first line.
      expect.soft(a.y + a.height, `${name}: the button ends above the next block`).toBeLessThanOrEqual(n.y + 0.5);
      if (shots) {
        const b = (await block.boundingBox())!;
        await page.screenshot({ path: `${shots}/caption-${name}-${theme}.png`, clip: { x: b.x - 20, y: b.y - 10, width: Math.min(b.width + 40, 760), height: n.y + n.height - b.y + 20 } });
      }
    }
  }
});
