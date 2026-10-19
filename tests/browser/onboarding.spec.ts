import { test, expect } from "@playwright/test";

// The introduction: settings, pages to start with, a tour of the features
// and notifications. New accounts see it once; Settings → General opens it
// again (used here, so any account of the test instance works).
test("the introduction walks through settings, starter pages and the tour", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  if (process.env.TEST_ADMIN_EMAIL)
    await page.request.post("/api/auth/password", { headers: { origin }, data: { email: process.env.TEST_ADMIN_EMAIL, password: process.env.TEST_ADMIN_PASSWORD } });
  else await page.request.post("/api/auth/demo", { headers: { origin } });
  // A new account would see the introduction first.
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  await page.goto("/#settings");
  await page.getByRole("button", { name: "Einführung starten" }).click();
  const dialog = page.getByRole("dialog", { name: "Willkommen bei Flowplan" });
  await expect(dialog.getByRole("heading", { name: /^Hallo / })).toBeVisible();
  await dialog.getByRole("radiogroup", { name: "Erscheinungsbild" }).getByText("Dunkel").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({ path: `test-results/onboarding-1-${info.project.name}.png` });
  await dialog.getByRole("button", { name: "Weiter" }).click();

  await expect(dialog.getByRole("heading", { name: "Womit möchtest du starten?" })).toBeVisible();
  await dialog.getByRole("button", { name: /^Aufgaben/ }).click();
  await expect(dialog.getByRole("button", { name: /^Aufgaben/ })).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({ path: `test-results/onboarding-2-${info.project.name}.png` });
  await dialog.getByRole("button", { name: "1 anlegen und weiter" }).click();

  await expect(dialog.getByRole("heading", { name: "Das kann Flowplan" })).toBeVisible();
  await dialog.getByRole("tab", { name: "Whiteboards" }).click();
  await expect(dialog.getByRole("tabpanel")).toContainText("Formen, Notizzettel");
  await dialog.getByRole("button", { name: "Nächste Funktion" }).click();
  await expect(dialog.getByRole("tab", { name: "Journal" })).toHaveAttribute("aria-selected", "true");
  await page.screenshot({ path: `test-results/onboarding-3-${info.project.name}.png` });
  await dialog.getByRole("button", { name: "Weiter" }).click();

  await expect(dialog.getByRole("heading", { name: "Wie möchtest du benachrichtigt werden?" })).toBeVisible();
  await dialog.getByRole("button", { name: "Weiter" }).click();
  await expect(dialog.getByRole("heading", { name: "Alles bereit!" })).toBeVisible();
  await expect(dialog).toContainText("Angelegt: Aufgaben");
  await page.screenshot({ path: `test-results/onboarding-4-${info.project.name}.png` });
  await dialog.getByRole("button", { name: "Los geht's" }).click();
  await expect(dialog).toBeHidden();
  // The task database is in the sidebar.
  await expect(page.locator(".sidebar").getByText("Aufgaben").first()).toBeVisible();
  expect(errors).toEqual([]);
});
