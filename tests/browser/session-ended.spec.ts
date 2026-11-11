import { test, expect } from "@playwright/test";

// When the session ends, the app keeps the open page and shows a banner (so
// unsaved changes are not lost by a reload); its link leads to the sign-in
// page, keeping the page address, never to "Bitte melde dich an.".
test("an ended session leads to the sign-in page", async ({ page, context }) => {
  test.setTimeout(90_000);
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  // A new account would see the introduction first.
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const created = await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Sitzung ${Date.now()}`, kind: "document" },
  });
  const pageId = (await created.json()).id;
  await page.goto(`/#page=${pageId}`);
  await expect(page.getByLabel("Dokumentinhalt", { exact: true })).toBeVisible();
  await context.clearCookies();
  // Any request now fails with 401: e.g. adding a favourite.
  // The next request of the app fails with 401 – a background request may
  // already have shown the banner.
  await page.evaluate(() => fetch("/api/bootstrap").catch(() => {})).catch(() => {});
  const banner = page.getByRole("alert").filter({ hasText: "Du wurdest abgemeldet" });
  await expect(banner).toBeVisible({ timeout: 15_000 });
  await banner.getByRole("link", { name: "Anmelden" }).click();
  // The sign-in page: its ways to sign in (the password form may wait
  // behind "Mit E-Mail und Passwort", tests/browser/sign-in-form.ts).
  await expect(page.locator(".login-ways:not([data-pending])")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Bitte melde dich an.")).toHaveCount(0);
  expect(page.url()).toContain(`#page=${pageId}`);
});
