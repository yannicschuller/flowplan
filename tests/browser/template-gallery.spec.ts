import { test, expect } from "@playwright/test";

test("the template gallery offers several templates per category and creates pages from them", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Same flow on mobile.");
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await page.goto("/#home");
  await page.locator(".sidebar-tools").getByRole("button", { name: "Vorlagen" }).click();
  const dialog = page.getByRole("dialog", { name: "Vorlagen" });
  // Every category has at least three templates.
  for (const category of ["Projekte", "Meetings", "Wissen & Dokumentation", "Planung & Ziele", "Persönlich", "Sonstiges"]) {
    await dialog.getByRole("button", { name: category, exact: true }).click();
    expect(await dialog.locator(".template-grid > button").count(), category).toBeGreaterThanOrEqual(3);
  }
  // A database template with its example entries and views.
  await dialog.getByRole("button", { name: "Planung & Ziele", exact: true }).click();
  await dialog.locator(".template-grid > button", { hasText: "Budgetplanung" }).click();
  const title = `Budget ${Date.now()}`;
  await page.getByPlaceholder("Wie heißt deine Seite?").fill(title);
  await page.getByRole("button", { name: "Seite erstellen" }).click();
  await expect(page.locator(".data-table")).toContainText("Kampagne Herbst");
  await expect(page.locator(".data-table")).toContainText("-1.800,00 €");
  await expect(page.locator(".database-tabs")).toContainText("Plan und Ist");

  // Public gallery: the built-in template leads into the workspace.
  await page.goto("/templates?category=meetings");
  await expect(page.locator(".template-card", { hasText: "Retrospektive" })).toBeVisible();
  await page.locator(".template-card", { hasText: "Retrospektive" }).click();
  await expect(page.getByRole("heading", { name: /Retrospektive/ })).toBeVisible();
  await page.getByRole("link", { name: "In meinem Arbeitsbereich verwenden" }).click();
  await expect(page.getByLabel("Dokumentinhalt", { exact: true })).toContainText("Was lief gut?");
});

// #112: the "New page" dialog offers templates as well.
test("the New page dialog opens the template gallery and comes back to it", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Same flow on mobile.");
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await page.goto("/#home");
  await page.getByRole("button", { name: /Neue Seite/ }).first().click();
  const create = page.getByRole("dialog", { name: "Neue Seite" });
  await create.getByRole("button", { name: /Aus Vorlage/ }).click();
  const gallery = page.getByRole("dialog", { name: "Vorlagen" });
  await expect(gallery).toBeVisible();
  await expect(create).toBeHidden();
  // Closing the gallery goes back to the dialog.
  await page.keyboard.press("Escape");
  await expect(create).toBeVisible();
  // A template from the gallery: the dialog says so and creates the page from it.
  await create.getByRole("button", { name: /Aus Vorlage/ }).click();
  await gallery.getByRole("button", { name: "Meetings", exact: true }).click();
  await gallery.locator(".template-grid > button", { hasText: "Retrospektive" }).click();
  await expect(create.getByRole("button", { name: /Vorlage gewählt/ })).toBeVisible();
  const title = `Retro ${Date.now()}`;
  await create.getByPlaceholder("Wie heißt deine Seite?").fill(title);
  await create.getByRole("button", { name: "Seite erstellen" }).click();
  await expect(page.getByLabel("Dokumentinhalt", { exact: true })).toContainText("Was lief gut?");
});
