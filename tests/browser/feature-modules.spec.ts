import { test, expect, type Browser, type Page } from "@playwright/test";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

// #378: features switched off per person (Settings → Darstellung & Sprache →
// Funktionen) leave "Neue Seite", the "/" menu and the sidebar – what exists
// keeps opening, also someone else's whiteboard. The administration's
// default (Administration → Instanz) reaches accounts that never chose.
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const command = (page: Page, data: Record<string, unknown>) => page.request.post("/api/command", { headers: { origin }, data });
const modulesOf = async (page: Page) => (await (await page.request.get("/api/bootstrap")).json()).modules as { hidden: string[]; own: boolean };

function database() {
  const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  return db;
}
// An account of its own with a session (groups: administrators or none).
function account(name: string, groups: string[] = [], workspace?: string) {
  const db = database();
  const uid = randomUUID();
  const token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO users(id,subject,name,email,onboarded_at,email_verified) VALUES(?,?,?,?,?,1)").run(uid, `modules:${uid}`, name, `${uid}@example.test`, Date.now());
  db.prepare("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)").run(createHash("sha256").update(token).digest("hex"), uid, JSON.stringify(groups), Date.now() + 600_000);
  if (workspace) db.prepare("INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,'editor')").run(workspace, uid);
  db.close();
  return { uid, token };
}
async function signedIn(browser: Browser, token: string, mobile: boolean) {
  const context = await browser.newContext({
    locale: "de-DE",
    extraHTTPHeaders: { "Accept-Language": "de-DE,de;q=0.9" },
    storageState: { cookies: [], origins: [{ origin, localStorage: [{ name: "flowplan-offline-offer", value: "never" }] }] },
    ...(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 1000 } }),
  });
  await context.addCookies([{ name: "flowplan_session", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
  return context;
}
async function openNewPage(page: Page, mobile: boolean) {
  if (mobile) await page.locator(".mobile-tab-bar").getByRole("button", { name: "Neue Seite" }).tap();
  else await page.getByRole("button", { name: /Neue Seite/ }).first().click();
  const dialog = page.getByRole("dialog", { name: "Neue Seite", exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}
// The sidebar's places: the row of symbols, on phones the "Mehr" sheet.
async function sidebarTools(page: Page, mobile: boolean) {
  if (mobile) {
    await page.locator("aside.sidebar .sidebar-more").click();
    return page.getByRole("dialog", { name: "Mehr" });
  }
  return page.locator("aside.sidebar .sidebar-tools");
}
async function openDrawer(page: Page, mobile: boolean) {
  if (!mobile) return;
  const menu = page.locator(".mobile-tab-bar").getByRole("button", { name: /Navigation öffnen|Menü/ });
  await menu.click();
  await expect(page.locator("aside.sidebar .sidebar-more")).toBeInViewport();
}
// Screenshots for the review (MOD378_SHOTS: a folder), light and dark.
async function shot(page: Page, name: string) {
  const dir = process.env.MOD378_SHOTS;
  if (!dir) return;
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(dir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

test("switched-off flashcards and whiteboards leave new page, slash menu and sidebar; someone else's whiteboard still opens", async ({ page, browser }, info) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "Needs the test server data directory.");
  test.setTimeout(150_000);
  const mobile = info.project.name === "mobile";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await command(page, { action: "profile.onboarded" });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const tag = `${info.project.name} ${Date.now()}`;
  try {
    // A whiteboard and a flashcard deck by someone else in the workspace.
    const olga = account("Olga Brett", [], boot.workspace.id);
    const other = await signedIn(browser, olga.token, false);
    const made = await other.request.post("/api/command", { headers: { origin }, data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Brett von Olga ${tag}`, kind: "whiteboard" } });
    expect(made.ok(), await made.text()).toBe(true);
    const board = (await made.json()) as { id: string };
    await other.close();
    const doc = (await (await command(page, { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Funktionen ${tag}`, kind: "document" })).json()) as { id: string };

    // Everything shown first; then both switched off in Settings.
    await command(page, { action: "profile.modules", hidden: [] });
    await page.goto("/#settings/appearance");
    const card = page.locator("#modules");
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.getByText(/Vorhandenes bleibt/)).toBeVisible();
    await card.getByRole("switch", { name: "Lernkarten" }).click();
    await card.getByRole("switch", { name: "Whiteboards" }).click();
    await expect.poll(() => modulesOf(page)).toEqual(expect.objectContaining({ hidden: ["flashcards", "whiteboards"], own: true }));
    await expect(card.getByRole("switch", { name: "Whiteboards" })).not.toBeChecked();
    await card.scrollIntoViewIfNeeded();
    await shot(page, `mod378-settings-${mobile ? 390 : 1440}`);

    // "Neue Seite": no whiteboard tile, no flashcard database.
    await page.goto("/");
    const dialog = await openNewPage(page, mobile);
    await expect(dialog.getByRole("radio", { name: "Dokument" })).toBeVisible();
    await expect(dialog.getByRole("radio", { name: "Journal" })).toBeVisible();
    await expect(dialog.getByRole("radio", { name: "Whiteboard" })).toHaveCount(0);
    await dialog.getByRole("radio", { name: "Datenbank" }).click();
    const kinds = dialog.getByLabel("Art der Datenbank");
    await expect(kinds.locator("option", { hasText: "Aufgaben" })).toHaveCount(1);
    await expect(kinds.locator("option", { hasText: "Lernkarten" })).toHaveCount(0);
    await shot(page, `mod378-new-page-${mobile ? 390 : 1440}`);
    await dialog.getByRole("button", { name: "Abbrechen" }).click();

    // The sidebar: no "Lernen".
    await openDrawer(page, mobile);
    const tools = await sidebarTools(page, mobile);
    await expect(tools.getByRole("button", { name: "Papierkorb", exact: true })).toBeVisible();
    await expect(tools.getByRole("button", { name: "Lernen", exact: true })).toHaveCount(0);
    if (mobile) await page.keyboard.press("Escape");

    // The "/" menu: no whiteboard, no cloze; other blocks as always.
    await page.goto(`/#page=${doc.id}`);
    const editor = page.getByLabel("Dokumentinhalt", { exact: true });
    await editor.click();
    const menu = page.locator(".slash-menu");
    // The whole menu: the other media blocks are there, these two are not.
    await page.keyboard.type("/");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("option", { name: /Besprechung/ }).first()).toBeAttached();
    await expect(menu.getByRole("option", { name: /Tabelle/ }).first()).toBeAttached();
    await expect(menu.getByRole("option", { name: /Whiteboard/ })).toHaveCount(0);
    await expect(menu.getByRole("option", { name: /Lücke/ })).toHaveCount(0);
    await shot(page, `mod378-slash-${mobile ? 390 : 1440}`);
    // Typed, no match either: the menu closes on a query without hits.
    await page.keyboard.type("whiteb");
    await expect(menu.getByRole("option", { name: /Whiteboard/ })).toHaveCount(0);
    await page.keyboard.press("Escape");

    // Olga's whiteboard: in the tree and it opens as always.
    await page.goto(`/#page=${board.id}`);
    await expect(page.getByLabel("Whiteboard", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("heading", { name: `Brett von Olga ${tag}` }).or(page.getByText(`Brett von Olga ${tag}`).first())).toBeVisible();
  } finally {
    // The demo account is shared by the specs: back to the default.
    await command(page, { action: "profile.modules", hidden: null });
  }
});

test("the administration's default reaches new accounts, and can be applied to everyone", async ({ browser }, info) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "Needs the test server data directory.");
  test.skip(info.project.name !== "desktop", "Instance settings are global.");
  test.setTimeout(150_000);
  const admin = account("Instanz Admin", ["flowplan-admins"]);
  const adminContext = await signedIn(browser, admin.token, false);
  const adminPage = await adminContext.newPage();
  try {
    await adminPage.goto(`${origin}/#admin/general`);
    const card = adminPage.locator("#modules-default");
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.getByRole("switch", { name: "Whiteboards" }).click();
    await card.getByRole("switch", { name: "KI" }).click();
    await expect
      .poll(async () => (await (await adminPage.request.get("/api/admin")).json()).settings.modulesDefault)
      .toEqual(["whiteboards", "ai"]);
    await card.scrollIntoViewIfNeeded();
    await shot(adminPage, "mod378-admin-1440");

    // A new account follows it.
    const fresh = account("Neu Konto");
    const freshContext = await signedIn(browser, fresh.token, false);
    const freshPage = await freshContext.newPage();
    // The first visit makes the account's workspace.
    await freshPage.goto(`${origin}/`);
    await expect(freshPage.getByRole("button", { name: /Neue Seite/ }).first()).toBeVisible({ timeout: 30_000 });
    const freshBoot = await (await freshPage.request.get(`${origin}/api/bootstrap`)).json();
    expect(freshBoot.modules).toEqual({ hidden: ["whiteboards", "ai"], own: false, standard: ["whiteboards", "ai"] });
    await freshPage.goto(`${origin}/`);
    const dialog = await openNewPage(freshPage, false);
    await expect(dialog.getByRole("radio", { name: "Dokument" })).toBeVisible();
    await expect(dialog.getByRole("radio", { name: "Whiteboard" })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Abbrechen" }).click();
    // In Settings: the instance's default, the hint says so.
    await freshPage.goto(`${origin}/#settings/appearance`);
    await expect(freshPage.locator("#modules").getByText("Standard der Instanz")).toBeVisible({ timeout: 30_000 });
    await expect(freshPage.locator("#modules").getByRole("switch", { name: "Whiteboards" })).not.toBeChecked();
    // Their own choice, then "Allen zuweisen" puts it back on the default.
    await freshPage.locator("#modules").getByRole("switch", { name: "Whiteboards" }).click();
    await expect.poll(async () => (await (await freshPage.request.get(`${origin}/api/bootstrap`)).json()).modules.own).toBe(true);
    adminPage.once("dialog", (d) => void d.accept());
    await card.getByRole("button", { name: "Allen zuweisen" }).click();
    await expect(card.getByText(/Zugewiesen/)).toBeVisible();
    expect((await (await freshPage.request.get(`${origin}/api/bootstrap`)).json()).modules).toEqual({ hidden: ["whiteboards", "ai"], own: false, standard: ["whiteboards", "ai"] });
    await freshContext.close();
  } finally {
    await adminPage.request.post(`${origin}/api/command`, { headers: { origin }, data: { action: "admin.settings", settings: { modulesDefault: [] } } });
    await adminContext.close();
  }
});
