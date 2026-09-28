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
  for (const group of ["Einstieg", "Arbeiten mit Flowplan", "Verwaltung"])
    await expect(page.getByRole("heading", { name: group, level: 2 })).toBeVisible();
  // Running the instance is not public.
  await expect(page.getByRole("heading", { name: "Betrieb der Instanz", level: 2 })).toHaveCount(0);
  expect((await page.request.get("/docs/installation")).status()).toBe(404);

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
  await expect(page.getByRole("option")).toHaveCount(0);
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

test("administrators also find the pages about running the instance", async ({ page }) => {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  test.skip(!boot.user.isAdmin, "Needs an administrator.");
  await page.goto("/docs");
  await expect(page.getByRole("heading", { name: "Betrieb der Instanz", level: 2 })).toBeVisible();
  await page.goto("/docs/installation");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Installation mit Docker");
});
