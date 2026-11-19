import { test, expect, type Page } from "@playwright/test";

// A space as a library (#329): switched on in the space's settings, the
// sidebar shows "Bibliothek öffnen" instead of the tree; the library lists
// the books, a book its chapters and pages; a page of the book has a book
// navigation with previous and next; the search stays in the space.
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
  const name = `Handbuch ${tag}`;
  const spaceId = (await command({ action: "space.create", workspaceId: boot.workspace.id, name })).id as string;
  const create = async (title: string, parentId?: string) =>
    (await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId, title, ...(parentId ? { parentId } : {}) })).id as string;
  const install = await create("Installation");
  const prepare = await create("Vorbereitung", install);
  const requirements = await create("Systemvoraussetzungen", prepare);
  const download = await create(`Download ${tag}`, prepare);
  const configure = await create("Einrichtung", install);
  const operate = await create("Betrieb");
  return { boot, spaceId, name, install, prepare, requirements, download, configure, operate };
}
async function openNavigation(page: Page, mobile: boolean) {
  if (mobile && !(await page.locator(".app-shell").getAttribute("class"))?.includes("nav-open"))
    await page.locator(".topbar").getByRole("button", { name: "Navigation öffnen", exact: true }).click();
}
const shot = async (page: Page, name: string, mobile: boolean) => {
  if (!shots) return;
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${shots}/${mobile ? "phone" : "desktop"}-${name}.png` });
};

test("a space switched to a library: books, contents, reading with previous and next", async ({ page }, info) => {
  const mobile = info.project.name === "mobile";
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const tag = `${info.project.name}${Date.now()}`;
  const f = await setup(page, tag);
  await page.goto("/#home");
  await openNavigation(page, mobile);
  const section = page.locator(`.sidebar .nav-section[data-space-id="${f.spaceId}"]`);
  // An ordinary space first: its tree, no library entry.
  await expect(section.getByRole("treeitem", { name: /Installation/ })).toBeVisible();
  await expect(section.getByRole("link", { name: "Bibliothek öffnen" })).toHaveCount(0);

  // Switched in the space's settings.
  await section.getByRole("button", { name: `Bereich ${f.name} verwalten`, exact: true }).click();
  await page.getByRole("menuitem", { name: "Bereich bearbeiten …" }).click();
  const dialog = page.getByRole("dialog", { name: "Bereich verwalten" });
  const toggle = dialog.getByRole("checkbox", { name: /Als Bibliothek anzeigen/ });
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(dialog).toHaveCount(0);

  // The sidebar: one entry, the tree folded – and it still unfolds.
  await openNavigation(page, mobile);
  const entry = section.getByRole("link", { name: "Bibliothek öffnen" });
  await expect(entry).toBeVisible();
  await expect(section.getByRole("treeitem", { name: /Installation/ })).toHaveCount(0);
  const toggleTree = section.locator(".space-toggle");
  await expect(toggleTree).toHaveAttribute("aria-expanded", "false");
  await shot(page, "sidebar", mobile);
  await toggleTree.click();
  await expect(section.getByRole("treeitem", { name: /Installation/ })).toBeVisible();
  await expect(toggleTree).toHaveAttribute("aria-expanded", "true");
  await toggleTree.click();
  await expect(section.getByRole("treeitem", { name: /Installation/ })).toHaveCount(0);

  // The library: the books in the tree's order with their numbers.
  await entry.click();
  await expect(page).toHaveURL(new RegExp(`#library/${f.spaceId}$`));
  await expect(page.getByRole("heading", { name: f.name, level: 1 })).toBeVisible();
  const books = page.getByRole("list", { name: "Bücher" }).getByRole("link");
  await expect(books).toHaveCount(2);
  await expect(books.nth(0)).toContainText("Installation");
  await expect(books.nth(0)).toContainText("5 Seiten");
  await expect(books.nth(0)).toContainText("2 Kapitel");
  await expect(books.nth(1)).toContainText("Betrieb");
  await expect(books.nth(1)).toContainText("1 Seite");
  await expect(page.getByRole("button", { name: "Neues Buch" })).toBeVisible();
  if (!mobile) await expect(entry).toHaveAttribute("aria-current", "page");
  await shot(page, "overview", mobile);

  // A book: its chapters with their pages, folding.
  await books.nth(0).click();
  await expect(page).toHaveURL(new RegExp(`#library/${f.spaceId}/${f.install}$`));
  await expect(page.getByRole("heading", { name: "Installation", level: 1 })).toBeVisible();
  const contents = page.getByRole("navigation", { name: "Inhaltsverzeichnis" });
  await expect(contents.getByRole("link")).toHaveText(["Vorbereitung", "Systemvoraussetzungen", `Download ${tag}`, "Einrichtung"]);
  const fold = contents.getByRole("button", { name: "Vorbereitung zuklappen" });
  await expect(fold).toHaveAttribute("aria-expanded", "true");
  await fold.click();
  await expect(contents.getByRole("link", { name: "Systemvoraussetzungen" })).toHaveCount(0);
  await contents.getByRole("button", { name: "Vorbereitung aufklappen" }).click();
  await expect(contents.getByRole("link", { name: "Systemvoraussetzungen" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Neues Kapitel" })).toBeVisible();
  await shot(page, "book", mobile);

  // Reading: the book and its chapters are overviews, reading starts with
  // the first page (#329 follow-up); Einrichtung is a chapter without pages.
  await page.getByRole("link", { name: "Lesen beginnen" }).click();
  await expect(page).toHaveURL(new RegExp(`#page=${f.requirements}`));
  const nav = page.getByRole("navigation", { name: "Im Buch" });
  await expect(nav).toBeVisible();
  if (!mobile) await expect(nav).toContainText("Seite 1 von 2");
  await expect(nav.getByRole("link", { name: /Vorherige Seite/ })).toHaveCount(0);
  // book › chapter above the page.
  await expect(nav.getByRole("link", { name: "Installation", exact: true })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Vorbereitung", exact: true })).toBeVisible();
  await nav.getByRole("link", { name: `Nächste Seite: Download ${tag}` }).click();
  await expect(page).toHaveURL(new RegExp(`#page=${f.download}`));
  await shot(page, "page", mobile);
  await nav.getByRole("link", { name: "Vorherige Seite: Systemvoraussetzungen" }).click();
  await expect(page).toHaveURL(new RegExp(`#page=${f.requirements}`));
  // At the end of the page: on to the next one by name.
  const next = page.getByRole("navigation", { name: "Weiterlesen" });
  await next.getByRole("link", { name: new RegExp(`Weiter.*Download ${tag}`) }).click();
  await expect(page).toHaveURL(new RegExp(`#page=${f.download}`));
  // The chapter in the way: its overview with its pages.
  await nav.getByRole("link", { name: "Vorbereitung", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#library/${f.spaceId}/${f.install}/${f.prepare}$`));
  await expect(page.getByRole("heading", { name: "Vorbereitung", level: 1 })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Seiten des Kapitels" }).getByRole("link")).toHaveText(["Systemvoraussetzungen", `Download ${tag}`]);
  // The sidebar's tree stays folded while reading in the library.
  await openNavigation(page, mobile);
  await expect(section.getByRole("treeitem", { name: /Installation/ })).toHaveCount(0);
  if (mobile) await page.keyboard.press("Escape");

  // Back to the contents: "Weiterlesen" leads to the page read last.
  await page.goto(`/#library/${f.spaceId}/${f.install}`);
  await expect(page.getByRole("link", { name: `Weiterlesen: Download ${tag}` })).toBeVisible();
  expect(errors).toEqual([]);
});

test("the library's search stays in the space; a new book comes from the overview", async ({ page }, info) => {
  const mobile = info.project.name === "mobile";
  const tag = `${info.project.name}${Date.now()}s`;
  const f = await setup(page, tag);
  // A page with the same word in another space is not found from here.
  await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "page.create", workspaceId: f.boot.workspace.id, spaceId: f.boot.spaces[0].id, title: `Download ${tag} woanders` },
  });
  await page.request.post("/api/command", { headers: { origin }, data: { action: "space.update", spaceId: f.spaceId, name: f.name, private: false, library: true } });
  await page.goto(`/#library/${f.spaceId}`);
  const search = page.getByRole("searchbox", { name: `In ${f.name} suchen` });
  await search.fill(`Download ${tag}`);
  const results = page.getByRole("region", { name: "Suchergebnisse" });
  await expect(results.getByRole("link")).toHaveCount(1, { timeout: 15000 });
  await expect(results.getByRole("link")).toContainText(`Download ${tag}`);
  await shot(page, "search", mobile);
  await search.press("Escape");
  await expect(results).toHaveCount(0);
  await expect(page.getByRole("list", { name: "Bücher" }).getByRole("link")).toHaveCount(2);

  // "Neues Buch": a page at the top of the space.
  await page.getByRole("button", { name: "Neues Buch" }).click();
  const create = page.getByRole("dialog", { name: "Neues Buch" });
  await expect(create).toBeVisible();
  await page.keyboard.press("Escape");

  // Dark: the overview and a book.
  if (shots) {
    await page.emulateMedia({ colorScheme: "dark" });
    await shot(page, "overview-dark", mobile);
    await page.goto(`/#library/${f.spaceId}/${f.install}`);
    await expect(page.getByRole("heading", { name: "Installation", level: 1 })).toBeVisible();
    await shot(page, "book-dark", mobile);
    await page.goto(`/#page=${f.requirements}`);
    await expect(page.getByRole("navigation", { name: "Im Buch" })).toBeVisible();
    await shot(page, "page-dark", mobile);
    await openNavigation(page, mobile);
    await shot(page, "sidebar-dark", mobile);
  }
});
