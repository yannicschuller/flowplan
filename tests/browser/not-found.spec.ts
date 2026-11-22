import { test, expect } from "@playwright/test";

// Unknown addresses and pages that are no longer public get Flowplan's own
// 404 page instead of the framework's.
test("own 404 page for unknown addresses and withdrawn public pages", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  for (const path of ["/gibt-es-nicht", "/share/00000000-0000-4000-8000-000000000000"]) {
    const response = await page.goto(path);
    expect(response?.status(), path).toBe(404);
    await expect(page.getByRole("heading", { name: "Diese Seite gibt es hier nicht." })).toBeVisible();
    await expect(page.getByText("Nicht mehr öffentlich.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Zur Startseite" })).toHaveAttribute("href", "/");
    await expect(page.getByText("This page could not be found")).toHaveCount(0);
  }
  // No horizontal scrolling on phones.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: `test-results/not-found-${info.project.name}.png`, fullPage: true });
  expect(errors).toEqual([]);
});

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
async function demo(page: import("@playwright/test").Page) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
}

test("signed out the 404 page offers signing in", async ({ page }) => {
  await page.goto("/gibt-es-nicht");
  await expect(page.getByRole("link", { name: "Anmelden" })).toHaveAttribute("href", "/login");
  await expect(page.getByRole("link", { name: "Suchen" })).toHaveCount(0);
});

test("signed in the 404 page offers going back and the search, not signing in", async ({ page }) => {
  await demo(page);
  await page.goto("/#home");
  await expect(page.locator(".home-grid")).toBeVisible({ timeout: 20_000 });
  const response = await page.goto("/gibt-es-nicht");
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("link", { name: "Anmelden" })).toHaveCount(0);
  await expect(page.getByText("Über die Suche findest du sie – sofern du sie sehen darfst.", { exact: false })).toBeVisible();
  await expect(page.getByRole("link", { name: "Zur Startseite" })).toHaveAttribute("href", "/");
  await expect(page.getByRole("link", { name: "Suchen" })).toHaveAttribute("href", "/#search");
  // "Zurück" is the browser's previous entry.
  await page.getByRole("link", { name: "Zurück" }).click();
  await expect(page).toHaveURL(/\/#home$/);
  // "Suchen" opens the app's search.
  await page.goto("/gibt-es-nicht");
  await page.getByRole("link", { name: "Suchen" }).click();
  await expect(page.getByRole("searchbox").first()).toBeVisible({ timeout: 20_000 });
});

// A link to a page that does not exist (any more) or is not shared: one
// empty state in the page area, no error toast with a retry.
test("an unknown page link shows an empty state without a retry", async ({ page }) => {
  await demo(page);
  await page.goto("/#page=00000000-0000-4000-8000-000000000000");
  const missing = page.locator(".page-missing");
  await expect(missing.getByRole("heading", { name: "Diese Seite gibt es nicht (mehr) – oder du hast keinen Zugriff" })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".breadcrumb")).toContainText("Seite nicht gefunden");
  await expect(page.getByText("Seite nicht verfügbar.")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Erneut versuchen" })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  // The trash, then back to the empty state, then "Zurück" ends on the start page.
  await missing.getByRole("link", { name: "Zum Papierkorb" }).click();
  await expect(page).toHaveURL(/#trash$/);
  await page.goBack();
  await expect(missing).toBeVisible({ timeout: 20_000 });
  await missing.getByRole("button", { name: "Zur Startseite" }).click();
  await expect(page).toHaveURL(/#home$/);
});
