import { test, expect, type Page, type Browser, type TestInfo } from "@playwright/test";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

// On phones the sidebar's less used places sit behind one labelled "Mehr"
// button in the drawer's profile row and open as a list in a sheet; wider
// windows keep the row of symbols (#185, components/sidebar-tools.tsx).
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const PLACES = ["Vorlagen", "Medien", "Tags", "Graph", "Papierkorb", "Einstellungen", "Tastenkürzel"];

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
  const button = await more(page).boundingBox();
  expect(button!.height).toBeGreaterThanOrEqual(44);
  // The bottom block is the profile row alone.
  const bottom = await sidebar(page).locator(".sidebar-bottom").boundingBox();
  expect(bottom!.height).toBeLessThan(70);

  await more(page).tap();
  await expect(sheet(page)).toBeVisible();
  // (Behind the dialog the drawer is hidden from the accessibility tree.)
  await expect(sidebar(page).locator(".sidebar-more")).toHaveAttribute("aria-expanded", "true");
  // Every place with its name, in the order of the row; no Administration
  // for members.
  const items = sheet(page).locator(".sidebar-more-list button");
  await expect(items).toHaveText(PLACES);
  for (const name of PLACES) {
    const box = await sheet(page).getByRole("button", { name, exact: true }).boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
  await expect(sheet(page).getByRole("button", { name: "Administration" })).toHaveCount(0);

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
  for (const name of PLACES) await expect(row.getByRole("button", { name, exact: true })).toBeVisible();
  await row.getByRole("button", { name: "Medien", exact: true }).click();
  await expect(row.getByRole("button", { name: "Medien", exact: true })).toHaveClass(/selected/);
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

test("administrators find Administration behind Mehr too", async ({ browser }, info) => {
  test.skip(info.project.name !== "mobile", "The drawer is the phone layout's.");
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "FLOWPLAN_DATA_DIR of the test server is required.");
  const { context, page } = await sessionPage(browser, info, ["flowplan-admins"]);
  try {
    await page.goto(`${origin}/#home`);
    await openDrawer(page);
    await more(page).tap();
    await expect(sheet(page).locator(".sidebar-more-list button")).toHaveText([...PLACES, "Administration"]);
    await sheet(page).getByRole("button", { name: "Administration", exact: true }).tap();
    await expect(page.getByRole("heading", { name: "Administration" }).first()).toBeVisible();
    await expect(sheet(page)).toBeHidden();
  } finally {
    await context.close();
  }
});
