import { test, expect } from "@playwright/test";

test("the documentation is linked from the start page, navigable and searchable", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.locator("footer").getByRole("link", { name: "Dokumentation" }).click();
  await expect(page).toHaveURL(/\/docs$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Flowplan Schritt für Schritt.");
  for (const group of ["Einstieg", "Arbeiten mit Flowplan", "Verwaltung", "Selbst hosten"])
    await expect(page.getByRole("heading", { name: group, level: 2 })).toBeVisible();
  // Self-hosting is documented publicly.
  expect((await page.request.get("/docs/installation")).status()).toBe(200);

  // Navigation: on phones the page list folds into a menu.
  const nav = page.getByRole("navigation", { name: "Dokumentation" });
  if (info.project.name === "mobile") await nav.getByRole("button").click();
  await nav.getByRole("link", { name: "Whiteboards" }).click();
  await expect(page).toHaveURL(/\/docs\/whiteboards$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Whiteboards");
  await expect(page.getByRole("link", { name: /Weiter\s*Journal/ })).toBeVisible();

  // The search finds words from the body and jumps to their section.
  const search = page.getByRole("searchbox", { name: "Dokumentation durchsuchen" });
  await search.fill("litestream");
  await expect(page.getByRole("option").first()).toBeVisible();
  await search.fill("Tagesvorlage");
  const hit = page.getByRole("option").first();
  await expect(hit).toContainText("Tagesvorlage");
  await search.press("Enter");
  await expect(page).toHaveURL(/\/docs\/journal#tagesvorlage$/);
  await expect(page.getByRole("heading", { name: "Tagesvorlage" })).toBeInViewport();

  const missing = await page.request.get("/docs/gibt-es-nicht");
  expect(missing.status()).toBe(404);
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(errors).toEqual([]);
});

test("English browsers read the documentation in English and can switch", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US" });
  const page = await context.newPage();
  const base = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.goto(`${base}/docs`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Flowplan, step by step.");
  for (const group of ["Getting started", "Working with Flowplan", "Administration", "Self-hosting"])
    await expect(page.getByRole("heading", { name: group, level: 2 })).toBeVisible();
  await page.goto(`${base}/docs/sign-in`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sign-in: password, passkeys and OIDC");
  await expect(page.getByRole("navigation", { name: "Continue reading" })).toContainText("Next");
  const search = page.getByRole("searchbox", { name: "Search the documentation" });
  await search.fill("passkey");
  await expect(page.getByRole("option").first()).toContainText(/passkey/i);
  // Switching to German keeps the page.
  await page.getByRole("group", { name: "Language" }).getByRole("button", { name: "DE" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Anmeldung: Passwort, Passkeys und OIDC");
  await context.close();
});
