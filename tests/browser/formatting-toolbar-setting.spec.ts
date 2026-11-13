import { test, expect, type Page, type Locator } from "@playwright/test";

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

async function selectWord(page: Page, paragraph: Locator, word: string) {
  const at = await paragraph.evaluate((p, word) => {
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const i = node.textContent!.indexOf(word);
      if (i < 0) continue;
      const range = document.createRange();
      range.setStart(node, i);
      range.setEnd(node, i + word.length);
      const r = range.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    throw new Error(`no ${word}`);
  }, word);
  await page.mouse.dblclick(at.x, at.y);
}

async function setup(page: Page, title: string) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await command({ action: "profile.onboarded" });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const host = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `${title} ${Date.now()}`, kind: "document" });
  const { htmlState } = await import("../../lib/document-server");
  const html = "<p>Erster Absatz mit Wort darin.</p><p>Zweiter Absatz zum Umwandeln.</p>";
  const generation = (await (await page.request.get(`/api/pages/${host.id}`)).json()).generation;
  await command({ action: "document.sync", pageId: host.id, generation, update: Buffer.from(htmlState(html)).toString("base64") });
  return { command, host };
}

// #235: "Formatierungsleiste: Ausblenden" – no fixed toolbar on pages and
// records; the text menu over a selection carries the whole set.
test("hiding the formatting toolbar: no toolbar, the text menu offers every format", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "selecting with a mouse; on a phone the keyboard row stays");
  test.setTimeout(120_000);
  const { command, host } = await setup(page, "Leiste ausblenden");
  try {
    // The setting, chosen in the settings.
    await page.goto(`/#settings/appearance`);
    const row = page.getByRole("radiogroup", { name: "Formatierungsleiste" });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByText("Ausblenden").click();
    await expect.poll(async () => (await (await page.request.get("/api/bootstrap")).json()).formattingToolbar).toBe("hide");

    await page.goto(`/#page=${host.id}`);
    const editor = page.getByLabel("Dokumentinhalt", { exact: true });
    await expect(editor).toBeVisible({ timeout: 30_000 });
    const first = editor.locator("p", { hasText: "Erster" });
    const second = editor.locator("p", { hasText: "Zweiter" });
    await expect(first).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("toolbar", { name: "Textformatierung" })).toHaveCount(0);

    // Selecting with the mouse: the full menu.
    await selectWord(page, first, "Wort");
    const menu = page.locator(".text-menu.selection");
    await expect(menu).toBeVisible();
    const format = menu.getByRole("group", { name: "Formatieren" });
    await expect(format.getByRole("button", { name: "Umwandeln in: Text" })).toBeVisible();
    for (const name of ["Fett", "Kursiv", "Unterstrichen", "Durchgestrichen", "Code", "Markieren", "Text- und Hintergrundfarbe", "Link", "Inline-Formel", "Formatierung entfernen", "Weitere Formatierungen"])
      await expect(format.getByLabel(name, { exact: true }), name).toHaveCount(1);
    for (const name of ["Kommentieren", "Fußnote", "Kopieren"]) await expect(menu.getByRole("menuitem", { name })).toBeVisible();
    await page.screenshot({ path: `test-results/formatting-toolbar-hidden-${info.project.name}.png` });

    // Underline, then a colour from the menu's colour list.
    await format.getByLabel("Unterstrichen", { exact: true }).click();
    await expect(first.locator("u")).toHaveText("Wort");
    await format.getByLabel("Text- und Hintergrundfarbe", { exact: true }).click();
    await page.getByRole("menuitem", { name: "Textfarbe Rot" }).click();
    await expect(first.locator("span[style*='color']")).toHaveText("Wort");
    // Clearing takes both off again.
    await selectWord(page, first, "Wort");
    await expect(menu).toBeVisible();
    await menu.getByLabel("Formatierung entfernen", { exact: true }).click();
    await expect(first.locator("u")).toHaveCount(0);
    await expect(first.locator("span[style*='color']")).toHaveCount(0);

    // "Turn into": the second paragraph becomes a heading.
    await selectWord(page, second, "Umwandeln");
    await expect(menu).toBeVisible();
    await menu.getByRole("button", { name: "Umwandeln in: Text" }).click();
    await page.getByRole("menuitem", { name: "Überschrift 2" }).click();
    await expect(editor.locator("h2")).toHaveText("Zweiter Absatz zum Umwandeln.");

    // A selection made with Shift + arrows shows it too.
    await editor.locator("h2").click();
    await page.keyboard.press("End");
    await page.keyboard.press("Shift+ArrowLeft");
    await page.keyboard.press("Shift+ArrowLeft");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("button", { name: "Umwandeln in: Überschrift 2" })).toBeVisible();

    // Shown again: the toolbar is back, the menu trimmed as before (#210).
    await command({ action: "profile.formattingToolbar", formattingToolbar: "show" });
    await page.reload();
    await expect(page.getByRole("toolbar", { name: "Textformatierung" })).toBeVisible({ timeout: 30_000 });
    await selectWord(page, first, "Wort");
    await expect(menu).toBeVisible();
    await expect(format.getByLabel("Unterstrichen", { exact: true })).toHaveCount(0);
    await expect(format.getByRole("button", { name: /Umwandeln in/ })).toHaveCount(0);
  } finally {
    await command({ action: "profile.formattingToolbar", formattingToolbar: "show" });
  }
});

// On a phone the row docked on the keyboard stays even when hidden.
test("hidden, a phone keeps the formatting row on the keyboard", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "phone only");
  test.setTimeout(120_000);
  const { command, host } = await setup(page, "Leiste Handy");
  try {
    await command({ action: "profile.formattingToolbar", formattingToolbar: "hide" });
    await page.goto(`/#page=${host.id}`);
    const editor = page.getByLabel("Dokumentinhalt", { exact: true });
    await expect(editor).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("toolbar", { name: "Textformatierung" })).toHaveCount(1);
  } finally {
    await command({ action: "profile.formattingToolbar", formattingToolbar: "show" });
  }
});
