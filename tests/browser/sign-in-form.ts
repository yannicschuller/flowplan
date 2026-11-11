import { expect, type Page } from "@playwright/test";

// The sign-in page shows the fastest way first (lib/sign-in-ways.ts): e-mail
// and password open with "Mit E-Mail und Passwort" – unless they are the
// way last used in this browser, then the form is there already.
export async function openPasswordForm(page: Page) {
  await page.locator(".login-ways:not([data-pending])").waitFor();
  const link = page.getByRole("button", { name: "Mit E-Mail und Passwort" });
  if (await link.isVisible()) await link.click();
  await expect(page.locator("input[name=email]")).toBeVisible();
}
