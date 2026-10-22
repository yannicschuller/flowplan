import { test, expect, type Page } from "@playwright/test";

// The page as the mobile app shows it: the app puts window.FlowplanApp into
// its web view (flowplan-app, src/bridge-script.ts). Here a stand-in records
// what the page asks of it.
async function asApp(page: Page) {
  await page.addInitScript(() => {
    const calls: { refresh: number; saved: { name: string; size: number; type: string }[]; settings: number } = {
      refresh: 0,
      saved: [],
      settings: 0,
    };
    (window as unknown as { __app: typeof calls }).__app = calls;
    (window as unknown as { FlowplanApp: unknown }).FlowplanApp = {
      platform: "ios",
      version: "1.0.0",
      refresh: () => calls.refresh++,
      saveFile: (name: string, base64: string, type: string) => calls.saved.push({ name, size: atob(base64).length, type }),
      haptic: () => {},
      openSettings: () => calls.settings++,
    };
  });
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  return origin;
}
const app = (page: Page) => page.evaluate(() => (window as unknown as { __app: { refresh: number; saved: { name: string; size: number; type: string }[]; settings: number } }).__app);

test("quick actions open search and a new page; changes tell the app to refresh", async ({ page }) => {
  await asApp(page);
  await page.goto("/#search");
  await expect(page.getByRole("dialog", { name: "Schnellsuche" })).toBeVisible();
  // The address goes back to the screen behind the dialog.
  await expect(page).not.toHaveURL(/#search$/);
  await page.keyboard.press("Escape");

  await page.goto("/#new");
  const dialog = page.getByRole("dialog", { name: "Neue Seite" });
  await expect(dialog).toBeVisible();
  const before = (await app(page)).refresh;
  await dialog.getByPlaceholder("Wie heißt deine Seite?").fill(`From the app ${Date.now()}`);
  await dialog.getByPlaceholder("Wie heißt deine Seite?").press("Enter");
  await expect.poll(async () => (await app(page)).refresh).toBeGreaterThan(before);
});

test("the app registers for the session, reads its summary and leaves again", async ({ page }) => {
  const origin = await asApp(page);
  await page.goto("/");
  const installationId = crypto.randomUUID();
  const registered = await page.evaluate(async (id) => {
    const response = await fetch("/api/mobile/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ installationId: id, platform: "ios", name: "iPhone", appVersion: "1.0.0", pushToken: null }),
    });
    return { status: response.status, body: await response.json() };
  }, installationId);
  expect(registered.status).toBe(200);
  expect(registered.body.deviceToken).toMatch(/^fpd_/);
  const headers = { authorization: `Bearer ${registered.body.deviceToken}` };
  const summary = await page.request.get("/api/mobile/summary?today=2026-10-16", { headers });
  expect(summary.ok()).toBe(true);
  const data = await summary.json();
  expect(typeof data.unread).toBe("number");
  expect(Array.isArray(data.tasks.items)).toBe(true);
  // Without the page's origin and cookie nobody registers.
  const foreign = await page.request.post("/api/mobile/register", {
    headers: { origin: "https://evil.example" },
    data: { installationId, platform: "ios" },
  });
  expect(foreign.status()).toBe(403);
  // Leaving with the device token alone.
  expect((await page.request.post("/api/mobile/unregister", { headers })).ok()).toBe(true);
  expect((await page.request.get("/api/mobile/summary", { headers })).status()).toBe(401);
  void origin;
});

test("in the app, push settings point to the app settings", async ({ page }) => {
  await asApp(page);
  await page.goto("/#settings/notifications");
  await expect(page.getByText("Die Flowplan-App erhält keine Benachrichtigungen")).toBeVisible();
  await page.getByRole("button", { name: "App-Einstellungen öffnen" }).click();
  expect((await app(page)).settings).toBe(1);

});

test("in the app, exports go to the share sheet instead of a download", async ({ page }) => {
  const origin = await asApp(page);
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const created = await (
    await page.request.post("/api/command", {
      headers: { origin },
      data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: "Exported in the app", kind: "document" },
    })
  ).json();
  await page.goto(`/#page=${created.id}`);
  await expect(page.getByLabel("Dokumentinhalt", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Seitenaktionen", exact: true }).click();
  await page.getByRole("menuitem", { name: "Exportieren", exact: true }).click();
  await page.getByRole("dialog", { name: "Seite exportieren" }).getByRole("button", { name: "Herunterladen", exact: true }).click();
  await expect.poll(async () => (await app(page)).saved.map((file) => file.name)).toContain("Exported in the app.md");
});
