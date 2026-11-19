import { test, expect, type Page } from "@playwright/test";

// The workspace's library (#329 follow-up): "Bibliothek" in the main
// navigation once a space is shown as a library; its start lists the
// person's own shelves and the shared ones with their books, "Weiterlesen"
// and "Wer sieht dieses Regal?"; the search covers all shelves and groups
// its hits by level (shelves, books, chapters, pages and content), each
// group folds, the arrow keys walk through them and a hit opens its level.
// LIBRARY_SHOTS=<dir> keeps screenshots (light and dark, lib329- prefix).
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
  const shelf = async (name: string, isPrivate: boolean) => {
    const spaceId = (await command({ action: "space.create", workspaceId: boot.workspace.id, name, private: isPrivate })).id as string;
    await command({ action: "space.update", spaceId, name, private: isPrivate, library: true });
    return spaceId;
  };
  const create = async (spaceId: string, title: string, parentId?: string) =>
    (await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId, title, ...(parentId ? { parentId } : {}) })).id as string;
  const team = await shelf(`Wissen ${tag}`, false);
  const guide = await create(team, `Anleitung ${tag}`);
  const chapter = await create(team, `Kapitel ${tag}`, guide);
  const deep = await create(team, `Seite ${tag}`, chapter);
  await create(team, "Betrieb");
  // A book with text: found by its content.
  const service = (await command({ action: "page.import", workspaceId: boot.workspace.id, spaceId: team, title: "Wartung", content: `<p>Die Kalib${tag} des Sensors einmal im Jahr.</p>`, format: "html" })).id as string;
  const own = await shelf(`Notizen ${tag}`, true);
  const recipes = await create(own, "Rezepte");
  return { boot, team, guide, chapter, deep, service, own, recipes };
}
async function openNavigation(page: Page, mobile: boolean) {
  if (mobile && !(await page.locator(".app-shell").getAttribute("class"))?.includes("nav-open"))
    await page.locator(".topbar").getByRole("button", { name: "Navigation öffnen", exact: true }).click();
}
const shot = async (page: Page, name: string, mobile: boolean) => {
  if (!shots) return;
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${shots}/lib329-${mobile ? "390" : "1440"}-${name}.png` });
};

test("the library: shelves side by side, continue reading, who can see a shelf", async ({ page }, info) => {
  const mobile = info.project.name === "mobile";
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const tag = `${info.project.name}${Date.now()}`;
  const f = await setup(page, tag);
  // Read a page first: "Weiterlesen" picks it up (a chapter is an
  // overview, its pages are read).
  await page.goto(`/#page=${f.deep}`);
  await expect(page.getByRole("navigation", { name: "Im Buch" })).toBeVisible();

  await page.goto("/#home");
  await openNavigation(page, mobile);
  const entry = page.locator(".main-nav").getByRole("button", { name: "Bibliothek", exact: true });
  await expect(entry).toBeVisible();
  await entry.click();
  await expect(page).toHaveURL(/#library$/);
  await expect(page.getByRole("heading", { name: "Bibliothek", level: 1 })).toBeVisible();
  // The drawer closed on phones; on wide screens the entry is current.
  if (!mobile) await expect(entry).toHaveAttribute("aria-current", "page");

  const mine = page.getByRole("region", { name: "Meine Regale" });
  const shared = page.getByRole("region", { name: "Geteilte Regale" });
  await expect(mine.getByRole("heading", { name: `Notizen ${tag}` })).toBeVisible();
  await expect(shared.getByRole("heading", { name: `Wissen ${tag}` })).toBeVisible();
  await expect(mine.getByRole("heading", { name: `Wissen ${tag}` })).toHaveCount(0);
  const books = shared.getByRole("list", { name: `Bücher in Wissen ${tag}` }).getByRole("link");
  await expect(books).toHaveCount(3);
  await expect(books.nth(0)).toContainText(`Anleitung ${tag}`);
  await expect(books.nth(0)).toContainText("3 Seiten");
  await expect(books.nth(0)).toContainText("1 Kapitel");
  // Side by side on wide screens, one below the other on phones.
  const [a, b] = [await mine.boundingBox(), await shared.boundingBox()];
  if (mobile) expect(b!.y).toBeGreaterThan(a!.y + a!.height - 1);
  else expect(Math.abs(a!.y - b!.y)).toBeLessThan(2);

  // Continue reading: the page read before, with its place in the book.
  const reading = page.getByRole("region", { name: "Weiterlesen" });
  const resume = reading.getByRole("link", { name: new RegExp(`Anleitung ${tag}.*Seite ${tag}.*Seite 1 von 1`) });
  await expect(resume).toBeVisible();
  await shot(page, "light-home", mobile);

  // Who can see the shelf: the space's visibility and the groups' access.
  await shared.getByRole("button", { name: "Wer sieht dieses Regal?" }).first().click();
  const menu = page.getByRole("menu");
  await expect(menu).toContainText("Alle Mitglieder des Arbeitsbereichs sehen dieses Regal.");
  await expect(menu.getByRole("menuitem", { name: "Zugriff für Gruppen …" })).toBeVisible();
  await menu.getByRole("menuitem", { name: "Sichtbarkeit des Bereichs …" }).click();
  const manager = page.getByRole("dialog", { name: "Bereich verwalten" });
  await expect(manager).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(manager).toHaveCount(0);

  // A shelf leads to its books, a book's contents to "Wer sieht dieses Buch?".
  await shared.getByRole("link", { name: new RegExp(`Wissen ${tag}`) }).first().click();
  await expect(page).toHaveURL(new RegExp(`#library/${f.team}$`));
  await expect(page.getByRole("link", { name: "Alle Regale" })).toBeVisible();
  await page.goto(`/#library/${f.team}/${f.guide}`);
  await page.getByRole("button", { name: "Wer sieht dieses Buch?" }).click();
  await expect(page).toHaveURL(new RegExp(`#page=${f.guide}`));
  await expect(page.getByRole("dialog", { name: "Seite teilen" })).toBeVisible();
  await page.keyboard.press("Escape");

  // The book's own page was opened last now (to share it): its description,
  // which leads to the book's overview.
  await page.goto("/#library");
  await page.getByRole("region", { name: "Weiterlesen" }).getByRole("link", { name: new RegExp(`Anleitung ${tag}.*Beschreibung`) }).click();
  await expect(page).toHaveURL(new RegExp(`#library/${f.team}/${f.guide}$`));

  if (shots) {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/#library");
    await expect(page.getByRole("region", { name: "Geteilte Regale" })).toBeVisible();
    await shot(page, "dark-home", mobile);
    await openNavigation(page, mobile);
    await shot(page, "dark-nav", mobile);
  }
  expect(errors).toEqual([]);
});

test("the library search: grouped by level, folding, keyboard, the right level", async ({ page }, info) => {
  const mobile = info.project.name === "mobile";
  const tag = `${info.project.name}${Date.now()}q`;
  const f = await setup(page, tag);
  // The same word outside any library is not found here.
  await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "page.create", workspaceId: f.boot.workspace.id, spaceId: f.boot.spaces[0].id, title: `Anleitung ${tag} woanders` },
  });
  await page.goto("/#library");
  const search = page.getByRole("searchbox", { name: "In allen Regalen suchen" });
  await search.fill(tag);
  const results = page.getByRole("region", { name: "Suchergebnisse" });
  const group = (name: string) => results.getByRole("button", { name: new RegExp(`^${name}`) });
  await expect(group("Regale")).toBeVisible({ timeout: 15000 });
  await expect(group("Bücher")).toBeVisible();
  await expect(group("Kapitel")).toBeVisible();
  await expect(group("Seiten und Inhalte")).toBeVisible();
  await expect(results.getByRole("link", { name: new RegExp(`^Wissen ${tag}`) })).toBeVisible();
  await expect(results.getByRole("link", { name: new RegExp(`^Anleitung ${tag}`) })).toHaveCount(1);
  // A hit shows where it stands: shelf › book › chapter.
  await expect(results.getByRole("link", { name: new RegExp(`^Seite ${tag}`) })).toContainText(`Wissen ${tag} › Anleitung ${tag} › Kapitel ${tag}`);
  await shot(page, "light-search", mobile);

  // The keyboard: down from the field to the first group, on to its hits.
  await search.focus();
  await page.keyboard.press("ArrowDown");
  await expect(group("Regale")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(results.getByRole("link").first()).toBeFocused();
  await page.keyboard.press("End");
  await expect(results.getByRole("link").last()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(search).toBeFocused();

  // A group folds.
  await group("Bücher").click();
  await expect(group("Bücher")).toHaveAttribute("aria-expanded", "false");
  await expect(results.getByRole("link", { name: new RegExp(`^Anleitung ${tag}`) })).toHaveCount(0);
  await group("Bücher").click();
  await expect(results.getByRole("link", { name: new RegExp(`^Anleitung ${tag}`) })).toHaveCount(1);

  // Content: the book's text with the word marked.
  await search.fill(`Kalib${tag}`);
  await expect(group("Seiten und Inhalte")).toBeVisible({ timeout: 15000 });
  const hit = results.getByRole("listitem").filter({ hasText: "Wartung" });
  await expect(hit.locator("mark")).toHaveText(`Kalib${tag}`);
  await expect(group("Bücher")).toHaveCount(0);

  // Each level opens where it belongs: a book and a chapter their overview.
  await search.fill(tag);
  await results.getByRole("link", { name: new RegExp(`^Anleitung ${tag}`) }).click();
  await expect(page).toHaveURL(new RegExp(`#library/${f.team}/${f.guide}$`));
  await page.goto("/#library");
  await page.getByRole("searchbox", { name: "In allen Regalen suchen" }).fill(tag);
  await results.getByRole("link", { name: new RegExp(`^Kapitel ${tag}`) }).click();
  await expect(page).toHaveURL(new RegExp(`#library/${f.team}/${f.guide}/${f.chapter}$`));
  await page.goto("/#library");
  await page.getByRole("searchbox", { name: "In allen Regalen suchen" }).fill(tag);
  await results.getByRole("link", { name: new RegExp(`^Notizen ${tag}`) }).click();
  await expect(page).toHaveURL(new RegExp(`#library/${f.own}$`));

  if (shots) {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/#library");
    await page.getByRole("searchbox", { name: "In allen Regalen suchen" }).fill(tag);
    await expect(group("Kapitel")).toBeVisible({ timeout: 15000 });
    await shot(page, "dark-search", mobile);
  }
});
