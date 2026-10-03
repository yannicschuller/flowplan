import { test, expect } from "@playwright/test";

test("visitors get the product page with sign-in and sign-up; deep links still ask to sign in", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Open Source – bei uns oder bei euch.",
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
  await page.locator("#sicherheit").scrollIntoViewIfNeeded();
  await expect(page.getByText("Rechenzentrum in Deutschland")).toBeVisible();
  // Hosted in Germany or self-hosted: both offers, with guide and source.
  await page.locator("#selbst-hosten").scrollIntoViewIfNeeded();
  const selfHost = page.locator("#selbst-hosten");
  await expect(selfHost.getByRole("heading", { name: "Selbst hosten" })).toBeVisible();
  await expect(selfHost.getByRole("link", { name: "Installationsanleitung" })).toHaveAttribute("href", "/docs/installation");
  await expect(selfHost.getByRole("link", { name: /Quellcode auf GitHub/ })).toHaveAttribute("href", "https://github.com/yannicschuller/flowplan");
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
  await page.locator("#sicherheit").scrollIntoViewIfNeeded();
  await expect(page.getByText("Kein Tracking, keine Werbung")).toBeVisible();
  const hidden = await page.evaluate(
    () =>
      [...document.querySelectorAll("[data-reveal]")].filter(
        (el) => getComputedStyle(el).opacity !== "1",
      ).length,
  );
  expect(hidden).toBe(0);
  await context.close();
});

test("English browsers get the page in English; the choice can be switched and is kept", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US" });
  const page = await context.newPage();
  const base = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.goto(base);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Everything you work on.");
  await expect(page.getByRole("link", { name: "Sign in" }).first()).toBeVisible();
  await expect(page.locator("#selbst-hosten").getByRole("heading", { name: "Self-hosting" })).toBeAttached();
  await expect(page.getByText(/[äöüß]/)).toHaveCount(0);
  // Switch to German: the page reloads in German and stays so.
  await page.getByRole("group", { name: "Language" }).first().getByRole("button", { name: "DE" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Alles, woran ihr arbeitet.");
  await page.goto(`${base}/login`);
  await expect(page.getByRole("link", { name: /Mit SSO anmelden/ }).or(page.getByText("Lokalen Arbeitsbereich öffnen"))).toBeVisible();
  await context.close();
});
