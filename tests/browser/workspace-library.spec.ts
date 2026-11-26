import { test, expect, type Page } from "@playwright/test";
import { join } from "node:path";

// The workspace as a library (#564): Settings → Arbeitsbereich → Allgemein →
// "Arbeitsbereich als Bibliothek". Switching it on asks which places to
// hide (My tasks and the journal ticked); every space then shows as a
// library in the sidebar, My tasks leaves the navigation and the quick
// search, its address still opens. Off again: each space as it is set.
// LIBRARY564_SHOTS=<dir> keeps screenshots (light and dark).
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

async function setup(page: Page, tag: string) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBeTruthy();
    return await response.json();
  };
  await command({ action: "profile.onboarded" });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  await command({ action: "workspace.update", workspaceId: boot.workspace.id, library: false, hidden: [] });
  const name = `Richtlinien ${tag}`;
  const spaceId = (await command({ action: "space.create", workspaceId: boot.workspace.id, name })).id as string;
  await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId, title: `Urlaub ${tag}` });
  return { boot, command, spaceId, name };
}
const navigationOf = async (page: Page) => (await (await page.request.get("/api/bootstrap")).json()).navigation;
async function openNavigation(page: Page, mobile: boolean) {
  if (mobile && !(await page.locator(".app-shell").getAttribute("class"))?.includes("nav-open"))
    await page.locator(".topbar").getByRole("button", { name: "Navigation öffnen", exact: true }).click();
}
// A fresh load: the settings open from their address, not after the app
// has settled on the start page.
async function openSettings(page: Page) {
  await page.goto("about:blank");
  await page.goto("/#settings/workspace");
}
// `open`/`close`: something shown only for the picture (a dialog), opened
// after the colour scheme changed so it paints in that scheme throughout.
async function shot(page: Page, name: string, mobile: boolean, around?: { open: () => Promise<void>; close: () => Promise<void> }) {
  const dir = process.env.LIBRARY564_SHOTS;
  if (!dir) return;
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    // Past the colours' transitions.
    await page.waitForTimeout(600);
    await around?.open();
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(dir, `564-library-${name}-${mobile ? "phone" : "desktop"}-${scheme}.png`) });
    await around?.close();
  }
  await page.emulateMedia({ colorScheme: "light" });
}

test("workspace as library: every space a shelf, My tasks and journal hidden; off again restores", async ({ page }, info) => {
  test.setTimeout(150_000);
  const mobile = info.project.name === "mobile";
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const tag = `${info.project.name}${Date.now()}`;
  const f = await setup(page, tag);
  try {
    await page.goto("/#home");
    await openNavigation(page, mobile);
    const nav = page.locator("aside.sidebar nav.main-nav");
    const section = page.locator(`.sidebar .nav-section[data-space-id="${f.spaceId}"]`);
    // As it was: My tasks in the navigation, the space's page tree.
    await expect(nav.getByRole("button", { name: "Meine Aufgaben" })).toBeVisible({ timeout: 30_000 });
    await expect(section.getByRole("treeitem", { name: new RegExp(`Urlaub ${tag}`) })).toBeVisible();
    await expect(section.getByRole("link", { name: "Bibliothek öffnen" })).toHaveCount(0);

    // Switched on in the settings: the question with My tasks and journal ticked.
    await openSettings(page);
    const card = page.locator("#library");
    await expect(card).toBeVisible({ timeout: 30_000 });
    const dialog = page.getByRole("dialog", { name: "Arbeitsbereich als Bibliothek" });
    await shot(page, "dialog", mobile, {
      open: async () => {
        await card.getByRole("switch", { name: "Arbeitsbereich als Bibliothek" }).click();
        await expect(dialog).toBeVisible();
      },
      close: async () => {
        await dialog.getByRole("button", { name: "Abbrechen" }).click();
        await expect(dialog).toHaveCount(0);
      },
    });
    // Cancelled: nothing changed.
    expect(await navigationOf(page)).toEqual({ library: false, hidden: [] });
    await card.getByRole("switch", { name: "Arbeitsbereich als Bibliothek" }).click();
    await expect(dialog.getByRole("checkbox", { name: /Meine Aufgaben/ })).toBeChecked();
    await expect(dialog.getByRole("checkbox", { name: /^Journal/ })).toBeChecked();
    await expect(dialog.getByRole("checkbox", { name: /^Lernen/ })).not.toBeChecked();
    await expect(dialog.getByRole("checkbox", { name: /^Graph/ })).not.toBeChecked();
    await dialog.getByRole("button", { name: "Einschalten" }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => navigationOf(page)).toEqual({ library: true, hidden: ["tasks", "journal"] });
    await expect(card.getByRole("switch", { name: "Arbeitsbereich als Bibliothek" })).toBeChecked();
    await expect(card.getByRole("switch", { name: "Meine Aufgaben" })).toBeChecked();
    await expect(card.getByRole("switch", { name: "Lernen" })).not.toBeChecked();
    await card.scrollIntoViewIfNeeded();
    await shot(page, "settings", mobile);

    // The sidebar: shelves instead of trees, the library in the navigation,
    // no My tasks.
    await page.goto("/#home");
    await openNavigation(page, mobile);
    await expect(nav.getByRole("button", { name: "Bibliothek" })).toBeVisible({ timeout: 30_000 });
    await expect(nav.getByRole("button", { name: "Meine Aufgaben" })).toHaveCount(0);
    await expect(section.getByRole("link", { name: "Bibliothek öffnen" })).toBeVisible();
    await expect(section.getByRole("treeitem", { name: new RegExp(`Urlaub ${tag}`) })).toHaveCount(0);
    const first = page.locator(`.sidebar .nav-section[data-space-id="${f.boot.spaces[0].id}"]`);
    await expect(first.getByRole("link", { name: "Bibliothek öffnen" })).toBeVisible();
    await shot(page, "sidebar", mobile);
    // The library shows the new space as a shelf with its book.
    await nav.getByRole("button", { name: "Bibliothek" }).click();
    await expect(page.getByText(`Urlaub ${tag}`).first()).toBeVisible({ timeout: 15_000 });
    // A direct link still opens My tasks.
    await page.goto("/#tasks");
    await expect(page.locator(".topbar").getByText("Meine Aufgaben").first()).toBeVisible({ timeout: 30_000 });

    // Off again: the space shows its tree; My tasks stays hidden until its
    // switch goes off too.
    await openSettings(page);
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.getByRole("switch", { name: "Arbeitsbereich als Bibliothek" }).click();
    await expect.poll(() => navigationOf(page)).toEqual({ library: false, hidden: ["tasks", "journal"] });
    await card.getByRole("switch", { name: "Meine Aufgaben" }).click();
    await expect.poll(() => navigationOf(page)).toEqual({ library: false, hidden: ["journal"] });
    await page.goto("/#home");
    await openNavigation(page, mobile);
    await expect(nav.getByRole("button", { name: "Meine Aufgaben" })).toBeVisible({ timeout: 30_000 });
    await expect(section.getByRole("treeitem", { name: new RegExp(`Urlaub ${tag}`) })).toBeVisible();
    await expect(section.getByRole("link", { name: "Bibliothek öffnen" })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await f.command({ action: "workspace.update", workspaceId: f.boot.workspace.id, library: false, hidden: [] });
  }
});
