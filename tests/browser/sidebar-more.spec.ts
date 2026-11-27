import { test, expect, type Page, type Browser, type TestInfo } from "@playwright/test";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

// On phones the sidebar's less used places sit behind "Mehr", the last
// entry of the drawer's list right below the spaces (#629; wider windows
// show the row of symbols), and open as a list in a sheet (#185, #613,
// components/sidebar-tools.tsx). The sheet holds the tools alone: the
// account's entries are in the workspace menu at the top (#613), and phones
// have no "Tastenkürzel" (#620).
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const PLACES = ["Vorlagen", "Medien", "Lernen", "Tags", "Graph", "Papierkorb", "Einstellungen", "Tastenkürzel"];
const PHONE_PLACES = PLACES.filter((name) => name !== "Tastenkürzel");

async function signIn(page: Page) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
}
const sidebar = (page: Page) => page.locator("aside.sidebar");
const more = (page: Page) => sidebar(page).getByRole("button", { name: "Mehr", exact: true });
const sheet = (page: Page) => page.getByRole("dialog", { name: "Mehr" });
async function openDrawer(page: Page) {
  await page.locator(".topbar").getByRole("button", { name: "Navigation öffnen", exact: true }).click();
  await expect(page.locator(".nav-open .sidebar")).toBeVisible();
}

test("on phones the less used places open from Mehr as a labelled list", async ({ browser }, info) => {
  test.skip(info.project.name !== "mobile", "The drawer is the phone layout's.");
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "FLOWPLAN_DATA_DIR of the test server is required.");
  // A member: the demo account administers a development instance.
  const { context, page } = await sessionPage(browser, info, []);
  try {
  await page.goto(`${origin}/#home`);
  await openDrawer(page);

  // One button instead of the row of symbols.
  await expect(sidebar(page).locator(".sidebar-tools")).toBeHidden();
  await expect(more(page)).toBeVisible();
  await expect(more(page)).toHaveAttribute("aria-haspopup", "dialog");
  await expect(more(page)).toHaveAttribute("aria-expanded", "false");
  // An entry of the list right below "Bereich hinzufügen", as large as the
  // others and on the axes of Startseite (#629) – no bar of its own above
  // the tab bar; still a 44 px target.
  await expect(sidebar(page).locator(".sidebar-bottom")).toHaveCount(0);
  await expect(sidebar(page).locator(".sidebar-scroll > .add-space + .sidebar-more")).toHaveCount(1);
  // (Measured in one frame: the drawer may still be sliding in.)
  const [button, add, home] = await sidebar(page).evaluate((aside) =>
    [".sidebar-more", ".add-space", ".main-nav > button.selected"].map((selector) => {
      const el = aside.querySelector(selector)!;
      const { x, y, width, height } = el.getBoundingClientRect();
      return { x, y, width, height, fontSize: getComputedStyle(el).fontSize };
    }),
  );
  expect(button.height).toBeGreaterThanOrEqual(44);
  expect(Math.abs(button.y - (add.y + add.height))).toBeLessThan(1);
  expect(Math.abs(button.x - home.x)).toBeLessThan(1);
  expect(Math.abs(button.width - home.width)).toBeLessThan(1);
  for (const entry of [button, add, home]) expect(entry.fontSize).toBe("15px");

  await more(page).tap();
  await expect(sheet(page)).toBeVisible();
  // (Behind the dialog the drawer is hidden from the accessibility tree.)
  await expect(sidebar(page).locator(".sidebar-more")).toHaveAttribute("aria-expanded", "true");
  // Every place with its name, in the order of the row – no keyboard
  // shortcuts on a phone (#620).
  const items = sheet(page).locator(".sidebar-more-list button");
  await expect(items).toHaveText(PHONE_PLACES);
  for (const name of PHONE_PLACES) {
    const box = await sheet(page).getByRole("button", { name, exact: true }).boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
  // The tools alone: the account's entries are in the workspace menu.
  await expect(sheet(page).getByRole("group", { name: "Konto" })).toHaveCount(0);
  await expect(sheet(page).getByText("Abmelden")).toHaveCount(0);
  await expect(sheet(page).getByText("Dunkles Design")).toHaveCount(0);

  // Escape closes it, the focus goes back to "Mehr".
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toBeHidden();
  await expect(more(page)).toBeFocused();
  await expect(more(page)).toHaveAttribute("aria-expanded", "false");

  // A place opens and the sheet and drawer close.
  await more(page).tap();
  await sheet(page).getByRole("button", { name: "Papierkorb", exact: true }).tap();
  await expect(page.getByRole("heading", { name: "Papierkorb", level: 1 })).toBeVisible();
  await expect(sheet(page)).toBeHidden();
  await expect(page.locator(".app-shell")).not.toHaveClass(/nav-open/);

  // The current screen is marked.
  await openDrawer(page);
  await more(page).tap();
  await expect(sheet(page).getByRole("button", { name: "Papierkorb", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(sheet(page).getByRole("button", { name: "Medien", exact: true })).not.toHaveAttribute("aria-current", "page");

  // Dialogs open from it as well.
  await sheet(page).getByRole("button", { name: "Vorlagen", exact: true }).tap();
  await expect(page.getByRole("dialog", { name: "Vorlagen", exact: true })).toBeVisible();
  await expect(sheet(page)).toBeHidden();

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Vorlagen", exact: true })).toBeHidden();
  // (The drawer stays open behind a dialog.)
  await expect(page.locator(".nav-open .sidebar")).toBeVisible();

  // Every entry the sheet had for the account is in the workspace menu at
  // the top on phones too (#613); signing out last.
  await sidebar(page).locator(".workspace-switch").tap();
  const menu = page.getByRole("menu");
  const account = menu.getByRole("group", { name: "Konto" });
  await expect(account.getByRole("menuitem")).toHaveText(["Dunkles Design", "Über Flowplan", "Was ist neu"]);
  await expect(menu.getByRole("menuitem").last()).toHaveText("Abmelden");
  for (const entry of await account.getByRole("menuitem").all()) await expect(entry).toBeInViewport();
  await account.getByRole("menuitem", { name: "Über Flowplan" }).tap();
  await expect(page).toHaveURL(/#settings\/about$/);
  } finally {
    await context.close();
  }
});

test("wider windows keep the row of symbols", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "The row is the wide layout's.");
  await signIn(page);
  await page.goto("/#home");
  const row = sidebar(page).locator(".sidebar-tools");
  await expect(row).toBeVisible();
  await expect(more(page)).toBeHidden();
  // The account's entries are in the workspace menu at the top (#565), not
  // behind a "⋯" in the profile row.
  await expect(sidebar(page).getByRole("button", { name: "Kontomenü" })).toHaveCount(0);
  for (const name of PLACES) await expect(row.getByRole("button", { name, exact: true })).toBeVisible();
  await row.getByRole("button", { name: "Medien", exact: true }).click();
  await expect(row.getByRole("button", { name: "Medien", exact: true })).toHaveClass(/selected/);
});

// A narrow window with a mouse keeps "Mehr" in the bar below the list:
// the entry in the list is a phone's in the hand (#629).
test("a narrow window with a mouse keeps Mehr below the list", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "A window with a mouse.");
  await signIn(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#home");
  await page.locator(".topbar").getByRole("button", { name: "Navigation öffnen", exact: true }).click();
  await expect(page.locator(".nav-open .sidebar")).toBeVisible();
  await expect(sidebar(page).locator(".sidebar-bottom .sidebar-more")).toBeVisible();
  await expect(sidebar(page).locator(".sidebar-scroll .sidebar-more")).toHaveCount(0);
});

// A session with these groups, made directly in the test server's database.
async function sessionPage(browser: Browser, info: TestInfo, groups: string[]) {
  const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  const uid = randomUUID(),
    token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO users(id,subject,name,email,onboarded_at) VALUES(?,?,?,?,?)").run(
    uid,
    `more-${groups.length ? "admin" : "member"}:${uid}`,
    groups.length ? "More Admin" : "More Member",
    `${uid}@example.test`,
    Date.now(),
  );
  db.prepare("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)").run(
    createHash("sha256").update(token).digest("hex"),
    uid,
    JSON.stringify(groups),
    Date.now() + 300000,
  );
  db.close();
  const context = await browser.newContext(
    info.project.name === "mobile" ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : {},
  );
  await context.addCookies([{ name: "flowplan_session", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
  return { context, page: await context.newPage() };
}

// #532: no Administration entry of its own – the instance is part of
// Einstellungen, whose start page shows it to admins.
test("administrators find the instance in Einstellungen behind Mehr", async ({ browser }, info) => {
  test.skip(info.project.name !== "mobile", "The drawer is the phone layout's.");
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "FLOWPLAN_DATA_DIR of the test server is required.");
  const { context, page } = await sessionPage(browser, info, ["flowplan-admins"]);
  try {
    await page.goto(`${origin}/#home`);
    await openDrawer(page);
    await more(page).tap();
    await expect(sheet(page).locator(".sidebar-more-list button")).toHaveText(PHONE_PLACES);
    await sheet(page).getByRole("button", { name: "Einstellungen", exact: true }).tap();
    await expect(page.getByRole("heading", { name: "Instanz auf einen Blick" })).toBeVisible({ timeout: 30_000 });
    await expect(sheet(page)).toBeHidden();
  } finally {
    await context.close();
  }
});
