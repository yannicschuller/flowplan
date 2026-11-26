import { test, expect, type Page } from "@playwright/test";

// The workspace menu at the top of the sidebar carries the account as well
// (#565): who is signed in, the workspaces, then the account's entries
// (design, about, what's new, legal) and signing out last, apart. The
// profile row at the bottom has no "⋯" menu of its own any more.
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
// Screenshots on request: WORKSPACE_MENU_SCREENSHOTS=<path prefix>.
const shots = process.env.WORKSPACE_MENU_SCREENSHOTS || "";

const sidebar = (page: Page) => page.locator("aside.sidebar");
async function signIn(page: Page) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  await page.addInitScript(() => {
    try {
      localStorage.setItem("flowplan-app-promo", "1");
    } catch {}
  });
}
async function showSidebar(page: Page, phone: boolean) {
  if (!phone) return;
  await page.locator(".topbar").getByRole("button", { name: "Navigation öffnen", exact: true }).click();
  await expect(page.locator(".nav-open .sidebar")).toBeVisible();
}
async function openMenu(page: Page) {
  await sidebar(page).locator(".workspace-switch").click();
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem").first()).toBeVisible();
  return menu;
}

test("the workspace menu shows the person, the workspaces and the account, signing out last", async ({ page }, info) => {
  const phone = info.project.name === "mobile";
  await signIn(page);
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const name = `Menü ${info.project.name} ${Date.now()}`;
  await command({ action: "workspace.create", name });
  await page.goto("/#home");
  await showSidebar(page, phone);

  // No account row below the tools any more (#570), no "⋯" either: who is
  // signed in is at the top of the workspace menu.
  await expect(sidebar(page).locator(".sidebar-bottom")).not.toContainText(boot.user.name);
  await expect(sidebar(page).getByRole("button", { name: "Kontomenü" })).toHaveCount(0);

  const menu = await openMenu(page);
  // The person on top: name and e-mail, not an entry of its own.
  const person = menu.locator(".workspace-menu-person");
  await expect(person).toContainText(boot.user.name);
  if (boot.user.email) await expect(person).toContainText(boot.user.email);
  await expect(person).not.toHaveAttribute("role", "menuitem");
  // The workspaces, then creating one.
  const texts = (await menu.getByRole("menuitem").allTextContents()).map((s) => s.trim());
  // (A workspace's entry starts with its letter tile.)
  const workspace = (n: string) => texts.findIndex((s) => s.endsWith(n));
  expect(workspace(boot.workspace.name)).toBeGreaterThanOrEqual(0);
  expect(workspace(name)).toBeGreaterThanOrEqual(0);
  const create = texts.indexOf("Arbeitsbereich erstellen");
  expect(create).toBeGreaterThan(workspace(name));
  // The account's entries in one group below, signing out last.
  const account = menu.getByRole("group", { name: "Konto" });
  const entries = (await account.getByRole("menuitem").allTextContents()).map((s) => s.trim());
  expect(entries.slice(0, 3)).toEqual(["Dunkles Design", "Über Flowplan", "Was ist neu"]);
  expect(texts.slice(create + 1, create + 1 + entries.length)).toEqual(entries);
  expect(texts.at(-1)).toBe("Abmelden");
  await expect(account.getByRole("menuitem", { name: "Abmelden" })).toHaveCount(0);

  // A proper menu: arrow keys, End and typeahead move the focus.
  await page.keyboard.press("End");
  await expect(menu.getByRole("menuitem", { name: "Abmelden" })).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(menu.getByRole("menuitem").nth(texts.length - 2)).toBeFocused();
  await page.keyboard.press("Home");
  // (Radix moves the focus a moment later; typing waits for it.)
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.type("Was");
  await expect(menu.getByRole("menuitem", { name: "Was ist neu" })).toBeFocused();

  // The design switches.
  await menu.getByRole("menuitem", { name: "Dunkles Design" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await showSidebar(page, phone && !(await page.locator(".app-shell.nav-open").count()));
  await (await openMenu(page)).getByRole("menuitem", { name: "Helles Design" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  // "Über Flowplan" leads to the settings' about page.
  await showSidebar(page, phone && !(await page.locator(".app-shell.nav-open").count()));
  await (await openMenu(page)).getByRole("menuitem", { name: "Über Flowplan" }).click();
  await expect(page).toHaveURL(/#settings\/about$/);

  // Switching the workspace works as before, and back.
  await showSidebar(page, phone && !(await page.locator(".app-shell.nav-open").count()));
  await (await openMenu(page)).getByRole("menuitem").filter({ hasText: name }).click();
  await expect(sidebar(page).locator(".workspace-switch")).toContainText(name);
  await showSidebar(page, phone && !(await page.locator(".app-shell.nav-open").count()));
  const back = await openMenu(page);
  await expect(back.locator(".workspace-menu-person")).toContainText(boot.user.name);
  await back.getByRole("menuitem").filter({ hasText: boot.workspace.name }).first().click();
  await expect(sidebar(page).locator(".workspace-switch")).toContainText(boot.workspace.name);
});

test("signing out from the workspace menu", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "One run covers the shared code path.");
  // A context of its own: signing out ends the shared demo session only here.
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await signIn(page);
    await page.goto(`${origin}/#home`);
    await (await openMenu(page)).getByRole("menuitem", { name: "Abmelden" }).click();
    await page.waitForURL((url) => url.hash === "");
    expect((await page.request.get(`${origin}/api/bootstrap`)).ok()).toBe(false);
  } finally {
    await context.close();
  }
});

// The open menu (desktop, light and dark) and the sidebar's bottom.
for (const scheme of ["light", "dark"] as const)
  test(`screenshots of the workspace menu, ${scheme}`, async ({ page }, info) => {
    test.skip(!shots || info.project.name !== "desktop", "screenshots on request, desktop layout");
    await page.emulateMedia({ colorScheme: scheme });
    await signIn(page);
    await page.goto("/#home");
    await expect(sidebar(page).locator(".sidebar-bottom")).toBeVisible();
    await page.waitForTimeout(600);
    // (The development server's indicator covers the sidebar's bottom.)
    await page.evaluate(() => document.querySelector("nextjs-portal")?.remove());
    await sidebar(page).locator(".sidebar-bottom").screenshot({ path: `${shots}-bottom-${scheme}.png` });
    await sidebar(page).locator(".workspace-switch").click();
    await expect(page.getByRole("menu")).toBeVisible();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${shots}-menu-${scheme}.png`, clip: { x: 0, y: 0, width: 560, height: 640 } });
  });
