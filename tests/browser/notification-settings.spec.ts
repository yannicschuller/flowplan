import { test, expect } from "@playwright/test";

test("notification kinds are switched per channel in the settings", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const prefs = async () =>
    (await (await page.request.get("/api/bootstrap")).json()).notificationPrefs;
  await page.goto("/#settings/notifications");
  const inbox = page.getByLabel("Datums-Erinnerungen im Posteingang");
  const push = page.getByLabel("Datums-Erinnerungen als Push");
  await inbox.check();
  await push.check();
  await push.uncheck();
  await expect
    .poll(async () => (await prefs()).reminder)
    .toEqual({ inbox: true, push: false, email: true });
  await inbox.uncheck();
  await expect(push).toBeDisabled();
  await expect
    .poll(async () => (await prefs()).reminder)
    .toEqual({ inbox: false, push: false, email: false });
  // A reload keeps the section (#settings/notifications).
  await page.reload();
  await expect(
    page.getByLabel("Datums-Erinnerungen im Posteingang"),
  ).not.toBeChecked();
  // Restore the defaults for other tests.
  await page.getByLabel("Datums-Erinnerungen im Posteingang").check();
  await page.getByLabel("Datums-Erinnerungen als Push").check();
  await page.getByLabel("Datums-Erinnerungen per E-Mail").check();
  await expect
    .poll(async () => (await prefs()).reminder)
    .toEqual({ inbox: true, push: true, email: true });
  expect(errors).toEqual([]);
});
