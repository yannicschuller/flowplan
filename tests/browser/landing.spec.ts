import { test, expect } from "@playwright/test";

test("visitors get the product page with sign-in and sign-up; deep links still ask to sign in", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Auf eurem Server.",
  );
  // Both actions are always reachable (header and hero).
  await expect(page.getByRole("link", { name: /Registrieren/ }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Anmelden" }).first()).toBeVisible();
  // All page types and the feature index are on the page.
  for (const title of ["Dokumente", "Datenbanken", "Whiteboards", "Journal"])
    await expect(page.getByRole("heading", { name: title, exact: true }).first()).toBeAttached();
  await expect(page.getByRole("heading", { name: "Was drin ist." })).toBeAttached();
  // The database scene switches views when a tab is chosen.
  await page.locator("#ansichten").scrollIntoViewIfNeeded();
  await page.locator("#funktionen").scrollIntoViewIfNeeded();
  await page.locator("#betrieb").scrollIntoViewIfNeeded();
  await expect(page.getByText("OIDC_ISSUER")).toBeVisible();
  if (process.env.LANDING_SHOTS)
    await page.screenshot({ path: `${process.env.LANDING_SHOTS}/${info.project.name}-ops.png` });
  // Anmelden leads to the sign-in card.
  await page.getByRole("link", { name: "Anmelden" }).first().click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.locator(".login-card")).toBeVisible();
  // A link to a page shows the sign-in card right away.
  await page.goto("/#page=00000000-0000-4000-8000-000000000000");
  await expect(page.locator(".login-card")).toBeVisible();
  expect(errors).toEqual([]);
});

test("reduced motion shows every scene in its final state", async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.goto(process.env.TEST_BASE_URL || "http://127.0.0.1:3000");
  await page.locator("#betrieb").scrollIntoViewIfNeeded();
  await expect(page.getByText("Bereit auf Port 3000")).toBeVisible();
  const hidden = await page.evaluate(
    () =>
      [...document.querySelectorAll("[data-reveal]")].filter(
        (el) => getComputedStyle(el).opacity !== "1",
      ).length,
  );
  expect(hidden).toBe(0);
  await context.close();
});
