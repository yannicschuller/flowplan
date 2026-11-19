import { test, expect, type Page } from "@playwright/test";

// Books are like shelves (#329 follow-up): "Neues Buch" asks for a name in
// a small dialog that keeps its place while typing, and the new book opens
// as its overview; chapters and pages come from the overview, a chapter is
// a directory of its pages, the editor appears with a page. A book's own
// text shows read-only above its contents, "Beschreibung bearbeiten" opens
// it in the editor; a link to the book (#page=…) lands on the overview.
// LIBRARY_SHOTS=<dir> keeps screenshots (light and dark).
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const shots = process.env.LIBRARY_SHOTS;

async function setup(page: Page, tag: string) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBeTruthy();
    return await response.json();
  };
  const name = `Regal ${tag}`;
  const spaceId = (await command({ action: "space.create", workspaceId: boot.workspace.id, name })).id as string;
  await command({ action: "space.update", spaceId, name, private: false, library: true });
  // A book with a text of its own (as from BookStack) and a chapter with a page.
  const book = (
    await command({
      action: "page.import",
      workspaceId: boot.workspace.id,
      spaceId,
      title: "Handbuch",
      content: "<p>Alles über den Betrieb – zuerst lesen.</p>",
      format: "html",
    })
  ).id as string;
  const chapter = (await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId, parentId: book, title: "Grundlagen" })).id as string;
  const first = (await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId, parentId: chapter, title: `Erste Schritte ${tag}` })).id as string;
  return { boot, spaceId, name, book, chapter, first };
}
const shot = async (page: Page, name: string, mobile: boolean) => {
  if (!shots) return;
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${shots}/${mobile ? "phone" : "desktop"}-${name}.png` });
};
const bookOverview = (page: Page, title: string) => page.getByRole("heading", { name: title, level: 1 });

test("Neues Buch: a small dialog that stays in place, the new book opens as its overview", async ({ page }, info) => {
  const mobile = info.project.name === "mobile";
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const tag = `${info.project.name}${Date.now()}`;
  const f = await setup(page, tag);
  await page.goto(`/#library/${f.spaceId}`);
  await page.getByRole("button", { name: "Neues Buch" }).click();
  const dialog = page.getByRole("dialog", { name: "Neues Buch" });
  await expect(dialog).toBeVisible();
  // Name only: no kinds of page, no space to choose.
  await expect(dialog.getByRole("radiogroup")).toHaveCount(0);
  await expect(dialog.getByText("Bereich", { exact: true })).toHaveCount(0);
  await expect(dialog).toContainText(`Im Regal „${f.name}“`);
  const name = dialog.getByRole("textbox", { name: "Name des Buchs" });
  await expect(name).toBeFocused();
  await page.waitForTimeout(400);
  const before = (await dialog.boundingBox())!;
  // Typing (names like an existing one too) and moving the mouse: the box stays.
  for (const text of ["H", "Handbuch", "Handbuch 2", "Test", "Test3"]) {
    await name.fill(text);
    if (!mobile) await page.mouse.move(before.x + before.width + 40 + text.length * 7, before.y + 20);
    await page.waitForTimeout(250);
    const box = (await dialog.boundingBox())!;
    expect(Math.abs(box.x - before.x), `x after "${text}"`).toBeLessThan(1);
    expect(Math.abs(box.y - before.y), `y after "${text}"`).toBeLessThan(1);
  }
  await shot(page, "book-dialog", mobile);
  if (shots) {
    await page.emulateMedia({ colorScheme: "dark" });
    await shot(page, "book-dialog-dark", mobile);
    await page.emulateMedia({ colorScheme: "light" });
  }
  await name.fill(`Neues Buch ${tag}`);
  await dialog.getByRole("button", { name: "Buch erstellen" }).click();
  await expect(dialog).toHaveCount(0);
  // The book's overview, not the editor.
  await expect(page).toHaveURL(new RegExp(`#library/${f.spaceId}/[0-9a-f-]{36}$`));
  await expect(bookOverview(page, `Neues Buch ${tag}`)).toBeVisible();
  await expect(page.getByLabel("Dokumentinhalt", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Noch keine Kapitel" })).toBeVisible();
  const bookId = page.url().split("/").pop()!;

  // "Neues Kapitel": the chapter's overview, a directory of its pages.
  await page.getByRole("button", { name: "Neues Kapitel" }).click();
  const chapterDialog = page.getByRole("dialog", { name: "Neues Kapitel" });
  await chapterDialog.getByRole("textbox", { name: "Name des Kapitels" }).fill("Einleitung");
  await chapterDialog.getByRole("button", { name: "Kapitel erstellen" }).click();
  await expect(page).toHaveURL(new RegExp(`#library/${f.spaceId}/${bookId}/[0-9a-f-]{36}$`));
  await expect(bookOverview(page, "Einleitung")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Noch keine Seiten" })).toBeVisible();
  await expect(page.getByLabel("Dokumentinhalt", { exact: true })).toHaveCount(0);

  // "Neue Seite" in the chapter: the page opens in the editor.
  await page.locator(".library-toolbar").getByRole("button", { name: "Neue Seite" }).click();
  const pageDialog = page.getByRole("dialog", { name: "Neue Seite" });
  await expect(pageDialog).toContainText("Im Kapitel „Einleitung“");
  await pageDialog.getByRole("textbox", { name: "Name der Seite" }).fill("Worum es geht");
  await pageDialog.getByRole("button", { name: "Seite erstellen" }).click();
  await expect(page).toHaveURL(/#page=[0-9a-f-]{36}$/);
  await expect(page.getByLabel("Dokumentinhalt", { exact: true })).toBeVisible();
  const nav = page.getByRole("navigation", { name: "Im Buch" });
  await expect(nav.getByRole("link", { name: `Neues Buch ${tag}`, exact: true })).toBeVisible();
  // The chapter in the way leads to its overview.
  await nav.getByRole("link", { name: "Einleitung", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#library/${f.spaceId}/${bookId}/[0-9a-f-]{36}$`));
  await expect(page.getByRole("navigation", { name: "Seiten des Kapitels" }).getByRole("link", { name: "Worum es geht" })).toBeVisible();

  // "Neue Seite" from the book's overview: into a chapter to choose.
  await page.goto(`/#library/${f.spaceId}/${bookId}`);
  await page.locator(".library-toolbar").getByRole("button", { name: "Neue Seite" }).click();
  const fromBook = page.getByRole("dialog", { name: "Neue Seite" });
  await fromBook.getByRole("textbox", { name: "Name der Seite" }).fill("Zweite Seite");
  await fromBook.getByRole("button", { name: "Seite erstellen" }).click();
  await expect(page.getByLabel("Dokumentinhalt", { exact: true })).toBeVisible();
  await page.goto(`/#library/${f.spaceId}/${bookId}`);
  const contents = page.getByRole("navigation", { name: "Inhaltsverzeichnis" });
  await expect(contents.getByRole("link")).toHaveText(["Einleitung", "Worum es geht", "Zweite Seite"]);
  expect(errors).toEqual([]);
});

test("a book's own text shows above its contents; links to the book land on the overview", async ({ page }, info) => {
  const mobile = info.project.name === "mobile";
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const tag = `${info.project.name}${Date.now()}t`;
  const f = await setup(page, tag);
  // A link to the book page lands on its overview (and Back does not return to the link).
  await page.goto(`/#page=${f.book}`);
  await expect(page).toHaveURL(new RegExp(`#library/${f.spaceId}/${f.book}$`));
  await expect(bookOverview(page, "Handbuch")).toBeVisible();
  const intro = page.getByRole("region", { name: "Über dieses Buch" });
  await expect(intro).toContainText("Alles über den Betrieb – zuerst lesen.");
  await expect(page.getByLabel("Dokumentinhalt", { exact: true })).toHaveCount(0);
  const contents = page.getByRole("navigation", { name: "Inhaltsverzeichnis" });
  await expect(contents.getByRole("link")).toHaveText(["Grundlagen", `Erste Schritte ${tag}`]);
  await expect(contents).toContainText("1 Seite");
  await shot(page, "book-overview", mobile);
  if (shots) {
    await page.emulateMedia({ colorScheme: "dark" });
    await shot(page, "book-overview-dark", mobile);
    await page.emulateMedia({ colorScheme: "light" });
  }
  // A chapter's link likewise.
  await page.goto(`/#page=${f.chapter}`);
  await expect(page).toHaveURL(new RegExp(`#library/${f.spaceId}/${f.book}/${f.chapter}$`));
  await expect(bookOverview(page, "Grundlagen")).toBeVisible();
  await expect(page.getByRole("link", { name: "Beschreibung hinzufügen" })).toBeVisible();

  // "Lesen beginnen": the first page, in the editor.
  await page.goto(`/#library/${f.spaceId}/${f.book}`);
  await page.getByRole("link", { name: "Lesen beginnen" }).click();
  await expect(page).toHaveURL(new RegExp(`#page=${f.first}$`));
  await expect(page.getByLabel("Dokumentinhalt", { exact: true })).toBeVisible();

  // "Beschreibung bearbeiten": the book's text in the editor, nothing lost.
  await page.goto(`/#library/${f.spaceId}/${f.book}`);
  await page.getByRole("link", { name: "Beschreibung bearbeiten" }).click();
  await expect(page).toHaveURL(new RegExp(`#page=${f.book}&edit=1$`));
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor).toContainText("Alles über den Betrieb – zuerst lesen.");
  await editor.getByText("zuerst lesen.").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Neu ergänzt.");
  await expect(editor).toContainText("Neu ergänzt.");
  // The way back to the overview, which shows the new text.
  await page.waitForTimeout(1500);
  await page.getByRole("navigation", { name: "Im Buch" }).getByRole("link", { name: "Handbuch", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#library/${f.spaceId}/${f.book}$`));
  await expect(page.getByRole("region", { name: "Über dieses Buch" })).toContainText("Neu ergänzt.");
  expect(errors).toEqual([]);
});
