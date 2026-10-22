import { test, expect, type Page } from "@playwright/test";
import { FIXED_TIME, STORAGE_FILE, openApp, settle, visualState } from "./shared";

// Key screens of the app against the baselines in __screenshots__. The
// content is seeded once (global-setup.ts), the clock stands still, and
// animations are off, so a difference means the screen changed.
//
// The order matters: the start page and the search list recently opened and
// edited pages, so those screens come first, before any page is opened
// (Playwright runs the tests of a file in order, one worker).
//
// Update the baselines after an intended change: npm run test:visual:update

test.use({ storageState: STORAGE_FILE });

const shot = (page: Page, name: string) => expect(page).toHaveScreenshot(`${name}.png`);

const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

test.describe("before any page is opened", () => {
  test("home", async ({ page }) => {
    await openApp(page, "#home");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await shot(page, "home");
  });

  test("home, dark", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await openApp(page, "#home");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await shot(page, "home-dark");
  });

  test("command palette", async ({ page }) => {
    await openApp(page, "#home");
    await page.keyboard.press("ControlOrMeta+k");
    const input = page.getByLabel("Suchen oder Befehl");
    await expect(input).toBeFocused();
    await input.fill("Pro");
    await expect(page.getByRole("dialog", { name: "Schnellsuche" })).toContainText("Projektbriefing");
    await settle(page);
    await shot(page, "command-palette");
  });

  test("settings: account", async ({ page }) => {
    await openApp(page, "#settings");
    await page.getByRole("button", { name: "Konto", exact: true }).first().click();
    await expect(page.getByRole("radiogroup", { name: "Erscheinungsbild" })).toBeVisible();
    await settle(page);
    await shot(page, "settings-account");
  });

  test("settings: workspace", async ({ page }) => {
    await openApp(page, "#settings");
    await page.getByRole("button", { name: "Arbeitsbereich", exact: true }).first().click();
    await settle(page);
    await shot(page, "settings-workspace");
  });

  test.describe("phone", () => {
    test.use(PHONE);

    test("home with the tab bar", async ({ page }) => {
      await openApp(page, "#home");
      await expect(page.locator(".mobile-tab-bar")).toBeVisible();
      await shot(page, "phone-home");
    });

    test("navigation drawer, dark", async ({ page }) => {
      await page.emulateMedia({ colorScheme: "dark" });
      await openApp(page, "#home");
      await page.locator(".mobile-tab-bar").getByRole("button", { name: "Navigation öffnen", exact: true }).click();
      await expect(page.locator("aside.sidebar")).toBeVisible();
      await settle(page);
      await shot(page, "phone-drawer-dark");
    });
  });

  test.describe("signed out", () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test("sign-in", async ({ page }) => {
      await page.clock.setFixedTime(FIXED_TIME);
      await page.goto(`${visualState().origin}/login`);
      await expect(page.getByRole("button", { name: "Anmelden", exact: true })).toBeVisible();
      await settle(page);
      await shot(page, "sign-in");
    });
  });
});

test.describe("pages", () => {
  test("document", async ({ page }) => {
    await openApp(page, `#page=${visualState().documentId}`);
    await expect(page.getByLabel("Dokumentinhalt", { exact: true })).toContainText("Ziele für das Quartal");
    await shot(page, "document");
  });

  test("database table", async ({ page }) => {
    await openApp(page, `#page=${visualState().databaseId}`);
    await expect(page.locator(".data-table")).toContainText("Release vorbereiten");
    await shot(page, "database-table");
  });

  test("database board", async ({ page }) => {
    await openApp(page, `#page=${visualState().databaseId}`);
    await page.getByRole("button", { name: "Board", exact: true }).click();
    await expect(page.locator(".board")).toContainText("Release vorbereiten");
    await settle(page);
    await shot(page, "database-board");
  });

  test("database board, dark", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await openApp(page, `#page=${visualState().databaseId}`);
    await page.getByRole("button", { name: "Board", exact: true }).click();
    await expect(page.locator(".board")).toContainText("Release vorbereiten");
    await settle(page);
    await shot(page, "database-board-dark");
  });

  test.describe("English", () => {
    test.use({ locale: "en-US", extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" } });
    test("document", async ({ page }) => {
      await openApp(page, `#page=${visualState().documentId}`);
      await expect(page.getByLabel("Document content", { exact: true })).toContainText("Ziele für das Quartal");
      await shot(page, "document-en");
    });
  });

  test.describe("French", () => {
    test.use({ locale: "fr-FR", extraHTTPHeaders: { "Accept-Language": "fr-FR,fr;q=0.9" } });
    test("database table", async ({ page }) => {
      await openApp(page, `#page=${visualState().databaseId}`);
      await expect(page.locator(".data-table")).toContainText("Release vorbereiten");
      await shot(page, "database-table-fr");
    });
  });

  test.describe("phone", () => {
    test.use(PHONE);
    test("document", async ({ page }) => {
      await openApp(page, `#page=${visualState().documentId}`);
      await expect(page.locator(".mobile-tab-bar")).toBeVisible();
      await expect(page.getByLabel("Dokumentinhalt", { exact: true })).toContainText("Ziele für das Quartal");
      await shot(page, "phone-document");
    });
  });
});
