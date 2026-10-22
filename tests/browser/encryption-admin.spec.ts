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
  // A new account would see the introduction first.
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  const admin = await (await page.request.get("/api/admin")).json();
  await page.goto("/#admin/security");
  const section = page.locator(".encryption-settings");
  if (admin.encryption.enabled) {
    await expect(section).toContainText("Verschlüsselung an");
    await expect(section).toContainText(admin.encryption.keyId);
    if (admin.encryption.litestream && !admin.encryption.litestreamSseC) await expect(section.locator(".callout.warning")).toContainText("unverschlüsselt");
  } else await expect(section).toContainText("Aus. Mit FLOWPLAN_ENCRYPTION_KEY");
  await section.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/encryption-admin.png" });
  // The scheduled backup says whether it is encrypted (Speicher & Sicherung);
  // hourly backups are an instance setting (Instanz).
  if (admin.encryption.enabled) {
    await page.goto("/#admin/storage");
    await expect(page.getByRole("region", { name: "Sicherungen" })).toContainText("verschlüsselt");
  }
  // The backup settings have one home: Speicher & Sicherung.
  await page.goto("/#admin/storage");
  await expect(page.getByRole("switch", { name: "Stündlich statt täglich" })).toBeVisible();
  expect(errors).toEqual([]);
});
