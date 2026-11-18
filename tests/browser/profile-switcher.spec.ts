import { test, expect, type Page } from "@playwright/test";

// "Instanz wechseln …" (lib/native-app.ts profileSwitcherWay): inside the
// iPhone, iPad and Android app the workspace menu and a long press on the
// own account row open the app's own profile sheet (openProfileSwitcher),
// older apps' profile screen (openProfiles) where the sheet is missing, and
// nothing in a browser. The app's bridge is a stand-in that counts its calls
// (flowplan-app, src/bridge-script.ts).

const IOS_APP_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 FlowplanMobile/1.4.0";
const shots = process.env.PROFILE_SWITCHER_SCREENSHOTS || "";

type Bridge = "switcher" | "profiles" | "none";
type Calls = { switcher: unknown[][]; profiles: unknown[][] };

async function setUp(page: Page, bridge: Bridge) {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  await page.addInitScript((bridge: Bridge) => {
    try {
      localStorage.setItem("flowplan-app-promo", "1");
    } catch {}
    const calls: Calls = { switcher: [], profiles: [] };
    (window as unknown as { __calls: Calls }).__calls = calls;
    if (bridge === "none") return;
    (window as unknown as { ReactNativeWebView: unknown }).ReactNativeWebView = { postMessage: () => {} };
    (window as unknown as { FlowplanApp: unknown }).FlowplanApp = {
      platform: "ios",
      version: "1.4.0",
      refresh: () => {},
      haptic: () => {},
      backState: () => {},
      openSettings: () => {},
      openProfiles: (...args: unknown[]) => void calls.profiles.push(args),
      ...(bridge === "switcher" ? { openProfileSwitcher: (...args: unknown[]) => void calls.switcher.push(args) } : {}),
    };
  }, bridge);
}
const calls = (page: Page) => page.evaluate(() => (window as unknown as { __calls: Calls }).__calls);

// The sidebar: on phones the drawer behind "Navigation" in the bar.
async function showSidebar(page: Page, phone: boolean) {
  if (!phone) return;
  const tab = page.getByRole("navigation", { name: "Schnellnavigation" }).getByRole("button", { name: /^Navigation (öffnen|schließen)$/ });
  // The first tap may come before the page has hydrated: again until it opens.
  await expect(async () => {
    if ((await tab.getAttribute("aria-expanded")) !== "true") await tab.click();
    await expect(tab).toHaveAttribute("aria-expanded", "true", { timeout: 1500 });
  }).toPass({ timeout: 15_000 });
}
async function openWorkspaceMenu(page: Page) {
  await page.locator(".sidebar .workspace-switch").click();
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem").first()).toBeVisible();
  return menu;
}
// Pressed and held on the own avatar for `ms`.
async function press(page: Page, ms: number) {
  const box = await page.locator(".sidebar .profile .avatar").first().boundingBox();
  if (!box) throw new Error("no avatar");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.up();
}

test.use({ userAgent: IOS_APP_UA });

for (const phone of [false, true]) {
  test.describe(phone ? "phone" : "wide window", () => {
    test.beforeEach(async ({}, info) => {
      test.skip(info.project.name !== (phone ? "mobile" : "desktop"), "one layout per project");
    });

    test("with the app's switcher: the menu entry and the long press call openProfileSwitcher, with nothing", async ({ page }) => {
      await setUp(page, "switcher");
      await page.goto("/#home");
      await showSidebar(page, phone);
      const menu = await openWorkspaceMenu(page);
      const entry = menu.getByRole("menuitem", { name: "Instanz wechseln …" });
      await expect(entry).toBeVisible();
      // Below the workspaces: the last entry of the menu.
      await expect(menu.getByRole("menuitem").last()).toHaveText("Instanz wechseln …");
      await entry.click();
      await expect(menu).toBeHidden();
      expect(await calls(page)).toEqual({ switcher: [[]], profiles: [] });

      // A tap on the account row is no long press; holding it is.
      await showSidebar(page, phone && !(await page.locator(".app-shell.nav-open").count()));
      await press(page, 100);
      await page.waitForTimeout(700);
      expect((await calls(page)).switcher).toHaveLength(1);
      await press(page, 800);
      await expect.poll(async () => (await calls(page)).switcher.length).toBe(2);
      expect((await calls(page)).profiles).toHaveLength(0);
      // The row's own "⋯" keeps its menu (wider windows).
      if (!phone) {
        await page.locator(".profile-account-menu").click();
        await expect(page.getByRole("menuitem", { name: "Abmelden" })).toBeVisible();
        await page.keyboard.press("Escape");
      }
    });

    test("older apps with openProfiles only: the entry opens their profiles", async ({ page }) => {
      await setUp(page, "profiles");
      await page.goto("/#home");
      await showSidebar(page, phone);
      const menu = await openWorkspaceMenu(page);
      await menu.getByRole("menuitem", { name: "Instanz wechseln …" }).click();
      expect(await calls(page)).toEqual({ switcher: [], profiles: [[]] });
      await showSidebar(page, phone && !(await page.locator(".app-shell.nav-open").count()));
      await press(page, 800);
      await expect.poll(async () => (await calls(page)).profiles.length).toBe(2);
    });

    test("without the bridge: no entry and no long press", async ({ page }) => {
      await setUp(page, "none");
      await page.goto("/#home");
      await showSidebar(page, phone);
      const menu = await openWorkspaceMenu(page);
      await expect(menu.getByRole("menuitem", { name: "Arbeitsbereich erstellen" })).toBeVisible();
      await expect(menu.getByRole("menuitem", { name: "Instanz wechseln …" })).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(page.locator(".sidebar .profile")).not.toHaveAttribute("data-profile-switcher");
      await press(page, 800);
      expect(await calls(page)).toEqual({ switcher: [], profiles: [] });
    });
  });
}

// The entry at 390 px, light and dark (PROFILE_SWITCHER_SCREENSHOTS=<prefix>).
for (const scheme of ["light", "dark"] as const)
  test(`screenshot of the menu entry, ${scheme}`, async ({ page }, info) => {
    test.skip(!shots || info.project.name !== "mobile", "screenshots on request, phone layout");
    await page.emulateMedia({ colorScheme: scheme });
    await setUp(page, "switcher");
    await page.goto("/#home");
    await showSidebar(page, true);
    const menu = await openWorkspaceMenu(page);
    await expect(menu.getByRole("menuitem", { name: "Instanz wechseln …" })).toBeVisible();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${shots}-${scheme}.png` });
  });
