import { test, expect, type Page } from "@playwright/test";
import { openPageMenu, phoneTopBar } from "./page-top-bar";

// Issue #537: a journal's "Heute" link as a favourite of its own –
// "<Journal> – Heute" in the sidebar's favourites opens the day of the date
// it is clicked on, next to (not instead of) the journal page's favourite.
const origin = () => process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const localDay = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

async function setup(page: Page) {
  await page.request.post("/api/auth/demo", { headers: { origin: origin() } });
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin: origin() }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await command({ action: "profile.onboarded" });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const title = `Tagebuch ${Date.now()}`;
  const journalId = (await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind: "journal" })).id as string;
  const docId = (await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: "Notizen", kind: "document" })).id as string;
  const bootstrap = async () => (await (await page.request.get("/api/bootstrap")).json()) as {
    favorites: string[];
    todayFavorites: string[];
    pages: { id: string; parent_id: string; journal_date?: string; deleted_at?: string }[];
  };
  const todayId = async () => (await bootstrap()).pages.find((p) => p.parent_id === journalId && p.journal_date === localDay() && !p.deleted_at)?.id;
  return { command, journalId, docId, title, bootstrap, todayId };
}
// The sidebar (on phones the drawer, opened first, whose favourites start
// folded, #616).
async function sidebar(page: Page) {
  if (phoneTopBar(page)) {
    await page.locator("button.mobile-menu").click();
    const toggle = page.locator(".favorites-section .space-toggle");
    if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
  }
  return page.locator("#favorites-list");
}

test("a journal's Heute favourite: added from the page menu, opens today's day, removed from its menu (#537)", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const s = await setup(page);
  await page.goto(`/#page=${s.journalId}`);
  await expect(page.locator(".journal-today")).toBeVisible();

  // The page menu adds it; the journal page's own favourite stays off.
  await (await openPageMenu(page)).getByRole("menuitem", { name: "Heute zu Favoriten", exact: true }).click();
  await expect.poll(async () => (await s.bootstrap()).todayFavorites).toContain(s.journalId);
  expect((await s.bootstrap()).favorites).not.toContain(s.journalId);
  // The menu now offers to remove it.
  await expect((await openPageMenu(page)).getByRole("menuitem", { name: "Heute aus Favoriten entfernen", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  // Both at once: the journal's favourite, then its "Heute" right after it.
  await s.command({ action: "favorite", pageId: s.journalId, value: true });
  await page.goto(`/#page=${s.docId}`);
  await page.reload();
  await expect(page.getByLabel("Dokumentinhalt", { exact: true })).toBeVisible();
  const list = await sidebar(page);
  const today = list.getByRole("button", { name: `${s.title} – Heute`, exact: true });
  await expect(today).toBeVisible();
  await expect(list.getByRole("button", { name: s.title, exact: true })).toBeVisible();
  const names = await list.locator(".favorite-nav").allInnerTexts();
  expect(names.indexOf(`${s.title} – Heute`)).toBe(names.indexOf(s.title) + 1);
  await expect(today).not.toHaveClass(/selected/);

  // Clicking it lands on today's day (made on opening: "Automatisch"),
  // highlighted while that day is open.
  await today.click();
  await expect.poll(s.todayId, { timeout: 20_000 }).toBeTruthy();
  const dayId = (await s.todayId())!;
  await expect.poll(() => page.evaluate(() => location.hash)).toContain(dayId);
  const again = await sidebar(page);
  await expect(again.getByRole("button", { name: `${s.title} – Heute`, exact: true })).toHaveClass(/selected/);
  // The journal page's favourite is not the open page.
  await expect(again.getByRole("button", { name: s.title, exact: true })).not.toHaveClass(/selected/);
  // A second click opens the same day, nothing new is made.
  await again.getByRole("button", { name: `${s.title} – Heute`, exact: true }).click();
  await expect.poll(async () => (await s.bootstrap()).pages.filter((p) => p.parent_id === s.journalId && !p.deleted_at).length).toBe(1);

  // Its own menu: open today, open the journal, remove.
  const entry = (await sidebar(page)).getByRole("button", { name: `${s.title} – Heute`, exact: true });
  await entry.click({ button: "right" });
  const menu = page.getByRole("menu", { name: `Aktionen für ${s.title} – Heute` });
  await expect(menu.getByRole("menuitem", { name: "Heute öffnen", exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Journal öffnen", exact: true })).toBeVisible();
  await menu.getByRole("menuitem", { name: "Heute aus Favoriten entfernen", exact: true }).click();
  await expect(page.locator("#favorites-list").getByRole("button", { name: `${s.title} – Heute`, exact: true })).toHaveCount(0);
  await expect.poll(async () => (await s.bootstrap()).todayFavorites).not.toContain(s.journalId);
  // The journal's own favourite stays.
  await expect(page.locator("#favorites-list").getByRole("button", { name: s.title, exact: true })).toHaveCount(1);
  expect((await s.bootstrap()).favorites).toContain(s.journalId);
  expect(errors).toEqual([]);
});

test("the sidebar's page menu of a journal adds the Heute favourite; trashing the journal removes it (#537)", async ({ page }) => {
  test.skip(phoneTopBar(page), "Right click: desktop.");
  const s = await setup(page);
  await page.goto(`/#page=${s.docId}`);
  await expect(page.getByLabel("Dokumentinhalt", { exact: true })).toBeVisible();
  await page.locator(`.page-nav[data-page-id="${s.journalId}"]`).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Heute zu Favoriten", exact: true }).click();
  const today = page.locator("#favorites-list").getByRole("button", { name: `${s.title} – Heute`, exact: true });
  await expect(today).toBeVisible();
  await s.command({ action: "page.delete", pageId: s.journalId });
  await page.reload();
  await expect(page.getByLabel("Dokumentinhalt", { exact: true })).toBeVisible();
  await expect(today).toHaveCount(0);
  await s.command({ action: "page.restore", pageId: s.journalId });
  await page.reload();
  await expect(today).toBeVisible();
});
