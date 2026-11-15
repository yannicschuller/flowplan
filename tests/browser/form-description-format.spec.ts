import { test, expect, type Locator, type Page } from "@playwright/test";

// Formatted form descriptions (#306): the form's description and a
// question's hint get bold, italic, a link, a colour and underline in the
// form designer's small editor; the form in the app and the published form
// show them; a hint saved before as plain text keeps its line breaks.
const press = async (page: Page, key: string, times = 1) => {
  for (let i = 0; i < times; i++) {
    await page.keyboard.press(key);
    await page.waitForTimeout(60);
  }
};

// Selects a word in an editor as a person would, through the page's
// selection (the editor follows it).
async function select(editor: Locator, word: string) {
  await editor.focus();
  await editor.page().waitForTimeout(100);
  await editor.evaluate((root, word) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent!.indexOf(word);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + word.length);
      const selection = getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    throw new Error(`"${word}" not found`);
  }, word);
  // The editor has taken the selection over when its format bar shows.
  await expect(editor.page().getByRole("toolbar", { name: "Formatieren" })).toBeVisible();
  await editor.page().waitForTimeout(200);
}

async function rendered(scope: Locator | Page) {
  const description = scope.locator(".form-heading .form-description");
  await expect(description.locator("strong")).toHaveText("Fett");
  await expect(description.locator("em")).toHaveText("kursiv");
  const link = description.getByRole("link", { name: "Link" });
  await expect(link).toHaveAttribute("href", "https://example.com");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(description.locator(".text-color-blue")).toHaveText("Farbe");
  const name = scope.getByRole("group", { name: "Name", exact: true });
  await expect(name.locator(".question-description u")).toHaveText("Wichtig");
  // The legacy hint: plain text with its line break.
  const note = scope.getByRole("group", { name: "Notiz", exact: true }).locator(".question-description");
  await expect(note).toHaveText("Zeile einsZeile zwei");
  expect(await note.innerHTML()).toContain("Zeile eins<br>Zeile zwei");
  // No style attributes anywhere in the texts (strict CSP).
  expect(await scope.locator(".form-heading [style], .question-description [style]").count()).toBe(0);
}

test("form and question descriptions take inline formatting", async ({ page, browser }, info) => {
  test.setTimeout(150_000);
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
  await command({ action: "profile.onboarded" });
  const db = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Formatiertes Formular ${info.project.name} ${Date.now()}`, kind: "database" });
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
  // A hint from before #306: plain text with a line break.
  await command({ action: "form.update", pageId: db.id, enabled: true, internal: false, anonymous: true, config: { descriptions: { notes: "Zeile eins\nZeile zwei" } } });

  await page.goto(`/#page=${db.id}`);
  await page.getByRole("button", { name: /^Weitere Ansichten/ }).click();
  await page.getByRole("menuitem", { name: "Formular" }).click();
  await page.getByRole("button", { name: "Formular gestalten", exact: true }).click();
  const design = page.getByRole("dialog", { name: "Formular gestalten" });

  const description = design.getByRole("textbox", { name: "Beschreibung", exact: true });
  await description.click();
  await page.keyboard.type("Fett kursiv Link Farbe");
  const bar = design.getByRole("toolbar", { name: "Formatieren" });
  // "Fett" bold with the keyboard.
  await select(description, "Fett");
  await press(page, "ControlOrMeta+b");
  await expect(description.locator("strong")).toHaveText("Fett");
  // "kursiv" italic from the format bar.
  await select(description, "kursiv");
  await bar.getByRole("button", { name: /^Kursiv/ }).click();
  await expect(description.locator("em")).toHaveText("kursiv");
  // "Link" a link (⌘/Ctrl K); Enter applies it and does not submit the
  // designer around the editor.
  await select(description, "Link");
  await press(page, "ControlOrMeta+k");
  const address = design.getByRole("textbox", { name: "Link-Adresse" });
  await address.fill("example.com");
  await address.press("Enter");
  await expect(description.locator("a")).toHaveText("Link");
  await expect(design).toBeVisible();
  // "Farbe" blue.
  await select(description, "Farbe");
  await bar.getByRole("button", { name: "Textfarbe", exact: true }).click();
  await bar.getByRole("button", { name: "Textfarbe Blau" }).click();
  await expect(description.locator(".text-color-blue")).toHaveText("Farbe");

  // The hint of "Name": underlined with the keyboard.
  const hint = design.getByRole("textbox", { name: "Hinweis zu Name", exact: true });
  await hint.click();
  await page.keyboard.type("Wichtig");
  await select(hint, "Wichtig");
  await press(page, "ControlOrMeta+u");
  await expect(hint.locator("u")).toHaveText("Wichtig");
  // The legacy hint shows as written in its editor.
  await expect(design.getByRole("textbox", { name: "Hinweis zu Notiz", exact: true })).toHaveText("Zeile einsZeile zwei");

  await design.getByRole("button", { name: "Formular speichern", exact: true }).click();
  await expect(design).not.toBeVisible();
  const saved = (await read()).form.config;
  expect(saved.description).toBe("**Fett** _kursiv_ [Link](https://example.com) [Farbe]{.color-blue}");
  expect(saved.descriptions.title).toBe("[Wichtig]{.underline}");
  expect(saved.descriptions.notes).toBe("Zeile eins\nZeile zwei");

  // The form in the app.
  await rendered(page.locator(".form-preview"));

  // The published form.
  const visitor = await browser.newContext({
    viewport: info.project.name === "mobile" ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
  });
  const tab = await visitor.newPage();
  tab.on("pageerror", (e) => errors.push(e.message));
  await tab.goto(`${origin}/forms/${(await read()).form.token}`);
  await rendered(tab);
  await visitor.close();

  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: db.id });
});
