import { test, expect, type Page } from "@playwright/test";

// Footnotes, right-to-left text and the Markdown source view in the editor.
async function newPage(page: Page, title: string) {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  if (process.env.TEST_ADMIN_EMAIL)
    await page.request.post("/api/auth/password", { headers: { origin }, data: { email: process.env.TEST_ADMIN_EMAIL, password: process.env.TEST_ADMIN_PASSWORD } });
  else await page.request.post("/api/auth/demo", { headers: { origin } });
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const created = await (
    await page.request.post("/api/command", {
      headers: { origin },
      data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `${title} ${Date.now()}`, kind: "document" },
    })
  ).json();
  await page.goto(`/#page=${created.id}`);
  return created.id as string;
}

test("footnotes: inserted with /fußnote, numbered in order, listed at the end", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Keyboard test on the desktop.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await newPage(page, "Fußnoten");
  const editor = page.locator(".ProseMirror").first();
  await editor.click();
  await page.keyboard.type("Zweiter Satz");
  await page.keyboard.type("/fußnote");
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Fußnote einfügen" });
  await dialog.getByLabel("Text der Fußnote").fill("Zweite Quelle");
  await dialog.getByRole("button", { name: "Einfügen" }).click();
  await expect(editor.locator("sup.footnote-ref")).toHaveAttribute("data-footnote-number", "1");
  // A note in front of it takes number 1; the first becomes 2.
  await editor.locator("p").first().click({ position: { x: 2, y: 5 } });
  await page.keyboard.press("Home");
  await page.keyboard.type("Erster");
  await page.keyboard.press("Control+Alt+f");
  await page.getByRole("dialog", { name: "Fußnote einfügen" }).getByLabel("Text der Fußnote").fill("Erste Quelle https://example.test");
  await page.keyboard.press("Enter");
  const markers = editor.locator("sup.footnote-ref");
  await expect(markers).toHaveCount(2);
  await expect(markers.nth(0)).toHaveAttribute("data-footnote", "Erste Quelle https://example.test");
  await expect(markers.nth(0)).toHaveAttribute("data-footnote-number", "1");
  await expect(markers.nth(1)).toHaveAttribute("data-footnote-number", "2");
  const notes = editor.locator("section.footnotes li");
  await expect(notes).toHaveCount(2);
  await expect(notes.nth(0)).toContainText("Erste Quelle");
  await expect(notes.nth(0).locator("a")).toHaveAttribute("href", "https://example.test");
  await expect(notes.nth(1)).toContainText("Zweite Quelle");
  // Editing from the list, deleting renumbers.
  await notes.nth(1).locator(".footnote-text").click();
  await page.getByRole("dialog", { name: "Fußnote bearbeiten" }).getByRole("button", { name: "Fußnote entfernen" }).click();
  await expect(markers).toHaveCount(1);
  await expect(notes).toHaveCount(1);
  // Undo brings it back as number 2.
  await editor.click();
  await page.keyboard.press("Control+z");
  await expect(markers).toHaveCount(2);
  await page.screenshot({ path: "test-results/footnotes.png" });
  expect(errors).toEqual([]);
});

test("right-to-left paragraphs turn by themselves and on request; handles go right", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Keyboard test on the desktop.");
  await newPage(page, "RTL");
  const editor = page.locator(".ProseMirror").first();
  await editor.click();
  await page.keyboard.type("English line");
  await page.keyboard.press("Enter");
  await page.keyboard.type("مرحبا بالعالم");
  await page.keyboard.press("Enter");
  await page.keyboard.type("- שלום");
  await page.keyboard.press("Enter");
  await page.keyboard.type("עולם");
  const paragraphs = editor.locator(":scope > p");
  await expect(paragraphs.nth(0)).not.toHaveAttribute("dir", /.+/);
  await expect(paragraphs.nth(1)).toHaveAttribute("dir", "rtl");
  const list = editor.locator("ul").first();
  await expect(list).toHaveAttribute("dir", "rtl");
  // Bullets on the right: the list is padded on its right side.
  expect(await list.evaluate((n) => getComputedStyle(n).paddingRight)).toBe("25px");
  // The handle of the Arabic paragraph sits right of it.
  await paragraphs.nth(1).hover();
  const box = (await paragraphs.nth(1).boundingBox())!;
  const handle = page.locator(".document-block-handle").nth(1);
  const handleBox = (await handle.boundingBox())!;
  expect(handleBox.x).toBeGreaterThan(box.x + box.width - 5);
  // Manual override in the block menu.
  await page.locator(".document-block-handle").first().click();
  await page.getByRole("menuitem", { name: "Textrichtung" }).click();
  await page.getByRole("menuitemradio", { name: "Rechts nach links" }).click();
  await expect(paragraphs.nth(0)).toHaveAttribute("dir", "rtl");
  await page.screenshot({ path: "test-results/rtl.png" });
});

test("Markdown source view: edit, apply as one undoable change, kept blocks", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Keyboard test on the desktop.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await newPage(page, "Quelltext");
  const editor = page.locator(".ProseMirror").first();
  await editor.click();
  await page.keyboard.type("## Titel");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Ein **fetter** Absatz");
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "Seitenaktionen" }).click();
  await page.getByRole("menuitem", { name: "Als Markdown bearbeiten" }).click();
  const source = page.getByRole("textbox", { name: "Markdown" });
  await expect(source).toHaveValue(/^## Titel\n\nEin \*\*fetter\*\* Absatz\n$/);
  await expect(editor).toBeHidden();
  await source.fill("## Neuer Titel\n\n- eins\n- zwei\n\nText[^1]\n\n[^1]: Fußnote aus Markdown\n");
  await page.getByRole("button", { name: "Übernehmen" }).click();
  await expect(editor).toBeVisible();
  await expect(editor.locator("h2")).toHaveText("Neuer Titel");
  await expect(editor.locator("ul li")).toHaveCount(2);
  await expect(editor.locator("sup.footnote-ref")).toHaveAttribute("data-footnote", "Fußnote aus Markdown");
  // One undo step takes the whole change back.
  await editor.click();
  await page.keyboard.press("Control+z");
  await expect(editor.locator("h2")).toHaveText("Titel");
  await expect(editor.locator("ul")).toHaveCount(0);
  await page.screenshot({ path: "test-results/markdown-source.png" });
  expect(errors).toEqual([]);
});
