import { test, expect } from "@playwright/test";

test("the documentation is linked from the start page, navigable and searchable", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.locator("footer").getByRole("link", { name: "Dokumentation" }).click();
  await expect(page).toHaveURL(/\/docs$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Flowplan betreiben und benutzen.");
  for (const group of ["Einstieg", "Selbst hosten", "Arbeiten mit Flowplan", "Verwaltung"])
    await expect(page.getByRole("heading", { name: group, level: 2 })).toBeVisible();

  // Navigation: on phones the page list folds into a menu.
  const nav = page.getByRole("navigation", { name: "Dokumentation" });
  if (info.project.name === "mobile") await nav.getByRole("button").click();
  await nav.getByRole("link", { name: "Whiteboards" }).click();
  await expect(page).toHaveURL(/\/docs\/whiteboards$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Whiteboards");
  await expect(page.getByRole("link", { name: /Weiter\s*Journal/ })).toBeVisible();

  // The search finds words from the body and jumps to their section.
  const search = page.getByRole("searchbox", { name: "Dokumentation durchsuchen" });
  await search.fill("litestream restore");
  const hit = page.getByRole("option").first();
  await expect(hit).toContainText("Wiederherstellen");
  await search.press("Enter");
  await expect(page).toHaveURL(/\/docs\/speicher-und-sicherung#wiederherstellen$/);
  await expect(page.getByRole("heading", { name: "Wiederherstellen" })).toBeInViewport();

  const missing = await page.request.get("/docs/gibt-es-nicht");
  expect(missing.status()).toBe(404);
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(errors).toEqual([]);
});
