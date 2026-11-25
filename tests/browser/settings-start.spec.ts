import { test, expect, type Page } from "@playwright/test";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

// #532: one settings screen with one sidebar. The start page (#settings)
// shows the person's storage and AI as rings and "Dein Setup"; admins see
// "Instanz auf einen Blick" with live tiles that lead into the instance's
// sections (#settings/instance/<id>). The administration's old addresses
// (#admin/…) lead there without a history step of their own; for everyone
// else the instance's sections do not exist. On phones the start page
// stacks, the list of every section follows it and a section opens full
// screen with "← Einstellungen".
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

async function signIn(page: Page, admin: boolean) {
  const d = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  d.exec("PRAGMA busy_timeout=5000;");
  const uid = randomUUID(),
    token = randomBytes(32).toString("hex");
  d.prepare("INSERT INTO users(id,subject,name,email,onboarded_at) VALUES(?,?,?,?,?)").run(uid, `settings-start:${uid}`, admin ? "Ada Admin" : "Max Member", `${uid}@example.test`, Date.now());
  d.prepare("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)").run(createHash("sha256").update(token).digest("hex"), uid, JSON.stringify(admin ? ["flowplan-admins"] : []), Date.now() + 600_000);
  d.close();
  await page.context().addCookies([{ name: "flowplan_session", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
  await page.addInitScript(() => {
    try {
      localStorage.setItem("flowplan-app-promo", "1");
      localStorage.setItem("flowplan-offline-offer", "never");
    } catch {}
  });
}
// A fresh load of an address (a hash change alone would not reload).
async function open(page: Page, hash: string) {
  await page.goto("about:blank");
  await page.goto(`${origin}/${hash}`);
}
const nav = (page: Page) => page.getByRole("navigation", { name: "Bereiche der Einstellungen" });

test.beforeEach(() => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "FLOWPLAN_DATA_DIR of the test server is required.");
});

test("a member: the start page's tiles, no instance anywhere", async ({ page }) => {
  await signIn(page, false);
  await open(page, "#settings");
  await expect(page.getByRole("heading", { name: "Einstellungen", level: 1 })).toBeVisible({ timeout: 30_000 });
  // Storage as a ring with its words; the setup card leads into its sections.
  const usage = page.locator(".sv-start-usage");
  await expect(usage.getByRole("img", { name: /^Speicher: / })).toBeVisible();
  await expect(usage.getByRole("link", { name: /^Speicher/ })).toHaveAttribute("href", "#settings/usage/storage");
  const setup = page.locator(".sv-start-setup");
  await expect(setup.getByRole("link", { name: /^Erscheinungsbild/ })).toHaveAttribute("href", "#settings/appearance");
  await expect(setup.getByRole("link", { name: /^Benachrichtigungen/ })).toHaveAttribute("href", "#settings/notifications");
  await expect(setup.getByRole("link", { name: /^Dieses Gerät/ })).toHaveAttribute("href", "#settings/devices");
  await expect(page.getByRole("radiogroup", { name: "Einstellungsstufe" })).toBeVisible();
  // No instance: neither on the start page nor in the sidebar.
  await expect(page.getByRole("heading", { name: "Instanz auf einen Blick" })).toHaveCount(0);
  await expect(nav(page).locator("a[data-area='admin']")).toHaveCount(0);
  await expect(nav(page).getByRole("heading", { name: /Instanz/ })).toHaveCount(0);
  // The search does not find the instance's sections either.
  await page.getByRole("searchbox", { name: "Einstellung suchen" }).fill("Überwachung");
  await expect(page.locator(".settings-results .settings-tile[href^='#settings/instance']")).toHaveCount(0);
  // An instance address (new or old) shows the start page.
  for (const hash of ["#settings/instance/users", "#admin/users"]) {
    await open(page, hash);
    await expect(page.locator(".sv-start")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "Benutzer", level: 1 })).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => location.hash)).toBe("#settings");
  }
});

test("an admin: instance at a glance, its tiles lead into the sections, #admin redirects", async ({ page }, info) => {
  await signIn(page, true);
  await open(page, "#settings");
  const instance = page.getByRole("region", { name: "Instanz auf einen Blick" });
  await expect(instance).toBeVisible({ timeout: 30_000 });
  // The live strip moved here from the administration's landing page.
  await expect(instance.getByRole("region", { name: "Zustand der Instanz" })).toBeVisible();
  const tiles = instance.locator(".sv-start-tile");
  await expect(tiles).toHaveCount(6, { timeout: 30_000 });
  const hrefs = {
    accounts: "#settings/instance/users",
    storage: "#settings/instance/storage",
    monitoring: "#settings/instance/monitoring",
    signins: "#settings/instance/threats/addresses",
    features: "#settings/instance/general/modules-off",
    version: "#settings/instance/general/version",
  };
  for (const [id, href] of Object.entries(hrefs)) await expect(instance.locator(`.sv-start-tile[data-tile="${id}"]`)).toHaveAttribute("href", href);
  // Live numbers with their words: the stacked bar names both parts.
  await expect(instance.locator('[data-tile="storage"]').getByRole("img", { name: /^Datenbank .+, Dateien .+/ })).toBeVisible();
  await expect(instance.locator('[data-tile="features"]')).toContainText(/\d+ von \d+ an/);
  await expect(instance.locator('[data-tile="version"]')).toContainText(/v\d+\.\d+\.\d+/);
  // The sidebar: "Instanz" with its groups, only here.
  await expect(nav(page).getByRole("heading", { name: /^Instanz/ })).toBeVisible();
  for (const group of ["Personen", "Daten", "Dienste", "Sicherheit", "Betrieb"]) await expect(nav(page).getByRole("heading", { name: group, exact: true })).toBeAttached();
  // A tile opens its section; the sidebar marks it (desktop).
  await instance.locator('[data-tile="monitoring"]').click();
  await expect(page.getByRole("heading", { name: "Überwachung", level: 1 })).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL(/#settings\/instance\/monitoring$/);
  if (info.project.name === "desktop") await expect(nav(page).locator("a[aria-current='page']")).toHaveAttribute("data-section", "monitoring");

  // The same id in both areas stays apart (KI).
  await open(page, "#settings/instance/ai");
  await expect(page.getByRole("heading", { name: "KI", level: 1 })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".settings-breadcrumb")).toContainText("Instanz › Dienste");

  // Old addresses: replaced in place, no step of their own.
  await open(page, "#home");
  await expect(page.locator(".home-grid, .home-screen").first()).toBeVisible({ timeout: 30_000 });
  // (A hash changed while the page still hydrates is undone by Next.js.)
  await page.waitForTimeout(2_000);
  const steps = await page.evaluate(() => history.length);
  await page.evaluate(() => (location.hash = "admin/users"));
  await expect(page.getByRole("heading", { name: "Benutzer", level: 1 })).toBeVisible({ timeout: 30_000 });
  // One step (the link itself), replaced – none for the redirect.
  expect(await page.evaluate(() => history.length)).toBe(steps + 1);
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#settings/instance/users");
  // Back leads to the place before (phones: no tabs keeping their own
  // places in the way).
  if (info.project.name === "mobile") {
    await page.goBack();
    await expect.poll(() => page.evaluate(() => location.hash)).toBe("#home");
  }
  await open(page, "#admin");
  await expect(instance).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#settings/instance");
  await open(page, "#admin/operations");
  await expect(page.getByRole("heading", { name: "Überwachung", level: 1 })).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#settings/instance/monitoring");

  // The command palette's entry for the instance.
  if (info.project.name === "desktop") {
    await open(page, "#home");
    await expect(page.locator(".home-grid, .home-screen").first()).toBeVisible({ timeout: 30_000 });
    const input = page.getByLabel("Suchen oder Befehl");
    await expect(async () => {
      if (!(await input.isVisible())) await page.keyboard.press("ControlOrMeta+k");
      await expect(input).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 30_000 });
    await input.fill("> Einstellungen: Instanz");
    await expect(page.locator(".command-actions")).toContainText("Einstellungen: Instanz");
    await input.press("Enter");
    await expect(instance).toBeVisible({ timeout: 30_000 });
    // No Administration entry in the sidebar any more.
    await expect(page.locator(".sidebar").getByRole("button", { name: "Administration" })).toHaveCount(0);
  }
});

test("phones: the start page stacks, the list follows, a section opens full screen", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "The phone layout.");
  await signIn(page, true);
  await open(page, "#settings");
  const rings = page.locator(".sv-start-usage");
  const instance = page.getByRole("region", { name: "Instanz auf einen Blick" });
  await expect(instance.locator(".sv-start-tile").first()).toBeVisible({ timeout: 30_000 });
  // Rings first, then the instance, then the list of every section.
  const y = async (l: ReturnType<Page["locator"]>) => (await l.boundingBox())!.y;
  expect(await y(rings)).toBeLessThan(await y(instance));
  const list = nav(page);
  expect(await y(instance)).toBeLessThan(await y(list));
  // Two tiles a row, nothing wider than the screen.
  const [a, b] = [await instance.locator(".sv-start-tile").nth(0).boundingBox(), await instance.locator(".sv-start-tile").nth(1).boundingBox()];
  expect(Math.abs(a!.y - b!.y)).toBeLessThan(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  // "Alle Bereiche" leads to the list: grouped, with one line of facts.
  await page.getByRole("button", { name: "Alle Bereiche" }).tap();
  await expect(list.getByRole("heading", { name: "Persönlich" })).toBeInViewport();
  const appearance = list.locator("a[data-section='appearance']");
  await expect(appearance.locator("small")).toBeVisible();
  await expect(appearance.locator("small")).not.toHaveText("");
  // A section full screen, back to the start page.
  await appearance.tap();
  await expect(page.getByRole("heading", { name: "Darstellung & Sprache", level: 1 })).toBeVisible({ timeout: 30_000 });
  await expect(list).toBeHidden();
  const back = page.getByRole("button", { name: "Einstellungen" });
  await expect(back).toBeVisible();
  expect((await back.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await back.tap();
  await expect(page.locator(".sv-start")).toBeVisible();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#settings");
});
