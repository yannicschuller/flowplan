import { test, expect } from "@playwright/test";

// The sign-in methods in the account settings loaded themselves in a loop:
// their effect listed `t`, and useT() returned a new function on every
// render, so every answer re-rendered and asked again (about 200,000
// requests a day on an instance with the settings open). Now it asks once.
test("the account settings ask for the sign-in methods once, not in a loop", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "One run covers it.");
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  let calls = 0;
  page.on("request", (r) => {
    if (r.url().includes("/api/auth/sign-in-methods")) calls++;
  });
  await page.goto("/#settings/account");
  const skip = page.getByRole("button", { name: "Überspringen" });
  await skip.waitFor({ state: "visible", timeout: 15_000 }).then(
    () => skip.click(),
    () => {},
  );
  await expect(page.locator("#sign-in-methods")).toBeVisible();
  await page.waitForTimeout(3000);
  expect(calls).toBeGreaterThan(0);
  expect(calls).toBeLessThanOrEqual(2);
});
