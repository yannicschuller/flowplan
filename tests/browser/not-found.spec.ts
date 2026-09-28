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
