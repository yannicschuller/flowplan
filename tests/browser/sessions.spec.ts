import { test, expect } from "@playwright/test";

// Issue #30: "Stay signed in on this device" (only with SESSION_REMEMBER=true
// on the server) and the list of one's own signed-in devices.
test("signed-in devices are listed and signed out one by one", async ({ page, browser }, info) => {
  test.skip(info.project.name !== "desktop", "One run covers it.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  // A second device of the same person.
  const other = await browser.newContext({ locale: "de-DE", userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit Version/18.0 Mobile Safari/604.1" });
  await other.request.post(`${origin}/api/auth/demo`, { headers: { origin } });
  await page.request.post("/api/auth/demo", { headers: { origin } });

  await page.goto("/#settings/account");
  const devices = page.locator(".my-sessions");
  await expect(devices.locator("li").filter({ hasText: "dieses Gerät" })).toHaveCount(1);
  const phone = devices.locator("li").filter({ hasText: "Safari auf iPhone" }).first();
  await expect(phone).toBeVisible();
  await phone.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/my-sessions.png" });
  await phone.getByRole("button", { name: "Abmelden" }).click();
  // The phone is signed out, this device is not.
  await expect.poll(async () => (await other.request.get(`${origin}/api/bootstrap`)).status()).toBe(401);
  expect((await page.request.get("/api/bootstrap")).ok()).toBe(true);
  await other.close();

  // The sign-in page offers to stay signed in (SESSION_REMEMBER=true).
  const visitor = await browser.newContext({ locale: "de-DE" });
  const login = await visitor.newPage();
  await login.goto(`${origin}/login`);
  const switchToSignIn = login.getByRole("button", { name: "Anmelden", exact: true });
  if (await login.getByText("Schon ein Konto?").isVisible()) await switchToSignIn.click();
  const remember = login.getByRole("checkbox", { name: /Auf diesem Gerät angemeldet bleiben/ });
  if (await remember.count()) {
    await remember.check();
    await login.screenshot({ path: "test-results/login-remember.png" });
  }
  await visitor.close();
  expect(errors).toEqual([]);
});
