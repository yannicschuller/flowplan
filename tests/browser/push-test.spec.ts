import { test, expect, type Page } from "@playwright/test";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

// Settings → Notifications → Push: "Send test notification" shows the
// outcome per device. The delivery is mocked (the answer of POST /api/push);
// the real endpoint is covered by tests/push-test.test.ts and, without any
// device, once below.
// A fresh person, signed in (onboarded: past the introduction).
async function signIn(page: Page) {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  db.exec("PRAGMA busy_timeout=5000;");
  const uid = randomUUID(),
    token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO users(id,subject,name,email,onboarded_at) VALUES(?,?,?,?,?)").run(uid, `push-test:${uid}`, "Push Test", `${uid}@example.test`, Date.now());
  db.prepare("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)").run(createHash("sha256").update(token).digest("hex"), uid, "[]", Date.now() + 600000);
  db.close();
  await page.context().addCookies([{ name: "flowplan_session", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
}

const report = {
  relay: { enabled: true, reason: null, instance: "https://flowplan.example.test" },
  targets: [
    { key: "a", kind: "browser", name: "Chrome · macOS", platform: null, service: "google", current: true, channel: "web", status: "delivered", detail: null, note: null, focus: false },
    { key: "b", kind: "app", name: "Annas iPhone", platform: "ios", service: null, current: false, channel: "relay", status: "delivered", detail: null, note: null, focus: true },
    { key: "c", kind: "app", name: "Pixel 8", platform: "android", service: null, current: false, channel: "relay", status: "relay-signature", detail: "HTTP 401", note: null, focus: false },
    { key: "d", kind: "app", name: "Altes Telefon", platform: "android", service: null, current: false, channel: "expo", status: "delivered", detail: null, note: "relay-registration", focus: false },
    { key: "e", kind: "app", name: "iPad", platform: "ios", service: null, current: false, channel: null, status: "push-disabled", detail: null, note: null, focus: false },
  ],
  diagnostics: { relayUrl: "https://push.flowplan.org", wellKnown: true, instance: "https://flowplan.example.test", mobilePush: true },
};

test("the test notification shows a result per device", async ({ page }, info) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "FLOWPLAN_DATA_DIR of the test server is required.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await signIn(page);
  let asked = 0;
  await page.route("**/api/push", async (route) => {
    const request = route.request();
    if (request.method() !== "POST" || request.postDataJSON()?.action !== "test") return route.fallback();
    asked++;
    // A moment in flight, so the busy state can be seen.
    await new Promise((resolve) => setTimeout(resolve, 400));
    await route.fulfill({ json: report });
  });
  await page.goto("/#settings/notifications/push-test");
  const button = page.getByRole("button", { name: "Testbenachrichtigung senden" });
  await expect(button).toBeVisible();
  await button.click();
  await expect(page.getByRole("button", { name: "Wird gesendet …" })).toHaveAttribute("aria-busy", "true");
  const results = page.locator(".push-test-results > li");
  await expect(results).toHaveCount(5);
  expect(asked).toBe(1);
  await expect(page.locator(".push-test-summary")).toHaveText("3 von 5 zugestellt");
  await expect(results.nth(0)).toContainText("Chrome · macOS (dieser Browser)");
  await expect(results.nth(0)).toContainText("Web Push");
  await expect(results.nth(0)).toContainText("An den Push-Dienst von Google zugestellt ✓");
  await expect(results.nth(1)).toContainText("Relay · Ende-zu-Ende-verschlüsselt");
  await expect(results.nth(1)).toContainText("An Apple (APNs) zugestellt ✓");
  await expect(results.nth(1)).toContainText("Fokus aktiv");
  await expect(results.nth(2)).toContainText("Das Relay konnte diese Instanz nicht verifizieren – ist https://flowplan.example.test/.well-known/flowplan-push erreichbar?");
  await expect(results.nth(3)).toContainText("Expo");
  await expect(results.nth(3)).toContainText("Öffne die App einmal");
  await expect(results.nth(4)).toContainText("Benachrichtigungen sind für dieses Gerät ausgeschaltet");
  await expect(page.locator(".push-test-diagnostics")).toContainText("https://push.flowplan.org");
  await expect(page.getByRole("button", { name: "Testbenachrichtigung senden" })).toBeEnabled();
  // Nothing wider than the screen on a phone.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const shots = process.env.PUSH_TEST_SCREENSHOTS;
  if (shots) {
    await page.locator(".setting-row#push-test").evaluate((el) => el.scrollIntoView({ block: "start" }));
    await page.screenshot({ path: `${shots}/test-push-${info.project.name}.png`, animations: "disabled" });
  }
  expect(errors).toEqual([]);
});

test("without devices the real endpoint says how to set one up", async ({ page }, info) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "FLOWPLAN_DATA_DIR of the test server is required.");
  test.skip(info.project.name !== "desktop", "Once is enough.");
  await signIn(page);
  await page.goto("/#settings/notifications/push-test");
  await page.getByRole("button", { name: "Testbenachrichtigung senden" }).click();
  await expect(page.locator(".push-test-summary")).toContainText("Keine Geräte für Push registriert");
});
