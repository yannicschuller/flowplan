import { test, expect } from "@playwright/test";

// Issue #32: Administration shows whether encryption is on, which key, what
// in the bucket is still plain, and that Litestream copies stay unencrypted.
test("the encryption status is shown in the administration", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "One run covers it.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  // An administrator of the test instance, or the demo account.
  if (process.env.TEST_ADMIN_EMAIL)
    await page.request.post("/api/auth/password", { headers: { origin }, data: { email: process.env.TEST_ADMIN_EMAIL, password: process.env.TEST_ADMIN_PASSWORD } });
  else await page.request.post("/api/auth/demo", { headers: { origin } });
  const admin = await (await page.request.get("/api/admin")).json();
  await page.goto("/#admin");
  await page.getByRole("tab", { name: "Instanz" }).or(page.getByRole("button", { name: "Instanz" })).first().click();
  const section = page.locator(".encryption-settings");
  if (admin.encryption.enabled) {
    await expect(section).toContainText(`Verschlüsselung an · Schlüssel-ID ${admin.encryption.keyId}`);
    if (admin.encryption.litestream && !admin.encryption.litestreamSseC) await expect(section.locator(".callout.warning")).toContainText("unverschlüsselt");
    await expect(page.locator(".settings-section").filter({ has: page.getByRole("heading", { name: "Geplante Sicherung", exact: true }) })).toContainText("verschlüsselt");
  } else await expect(section).toContainText("Aus. Mit FLOWPLAN_ENCRYPTION_KEY");
  await expect(page.getByRole("switch", { name: "Stündlich statt täglich" })).toBeVisible();
  await section.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/encryption-admin.png" });
  expect(errors).toEqual([]);
});
