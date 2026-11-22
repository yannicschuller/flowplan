import { test, expect } from "@playwright/test";

// Issue #370 (report in the iPhone app): a document made offline opened with
// "Not available offline" instead of the editor. The device's copy of the
// app's files was of an older release, and the editor had never loaded in
// the page that was open. While the copy does not hold the running build
// completely, the page now loads the code of the views a page made offline
// opens (editor, database, board, notebook) ahead, once it is up.
//
// Needs the production build (scripts/build-e2e.mjs): its real chunks.
test("offline: a new document opens in the editor although the copy of the app's files is incomplete (#370)", async ({ page, context }, info) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  test.skip(info.project.name !== "desktop", "One service-worker run covers the shared code path.");
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  const account = { name: "Offline Kopie", email: "offline-copy@example.test", password: "ein-langes-passwort" };
  if (!(await page.request.post("/api/auth/register", { headers: { origin }, data: account })).ok())
    await page.request.post("/api/auth/password", { headers: { origin }, data: account });
  const assets = await (await page.request.get("/api/offline/assets")).json();
  test.skip(!assets.files?.length, "Needs a production build (no client build files listed).");
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const space = boot.spaces[0];

  // Offline use on; nothing but the settings opened online.
  await page.goto("/#settings/devices");
  await page.getByRole("button", { name: "Auf diesem Gerät offline verfügbar machen" }).click();
  await expect(page.getByText(/offline verfügbar\./)).toBeVisible({ timeout: 180_000 });

  // The copy of the app's files as on the reporter's phone: not complete
  // for this build (and nothing of it on the device), refreshed just now so
  // no refresh stores it again during the test.
  await page.evaluate(async () => {
    const settings = await caches.open("flowplan-settings");
    const marker = await (await settings.match("/__flowplan-offline"))!.json();
    marker.app = { ...marker.app, complete: false, stored: 0 };
    marker.lastRefresh = Date.now();
    await settings.put("/__flowplan-offline", new Response(JSON.stringify(marker), { headers: { "Content-Type": "application/json" } }));
    for (const name of await caches.keys()) if (name.startsWith("flowplan-static-")) await caches.delete(name);
  });
  // A fresh start online, on the home screen: no document opened.
  await page.goto("/?v=1");
  await expect(page.locator("aside.sidebar")).toBeVisible({ timeout: 30_000 });
  // The views' code loads a few seconds after the start.
  await page.waitForTimeout(10_000);

  await context.setOffline(true);
  await context.route("**/*", (route) => route.abort("internetdisconnected"));
  await expect(page.locator(".topbar .offline-status-button")).toBeVisible({ timeout: 15_000 });
  const dialog = page.getByRole("dialog", { name: "Neue Seite" });
  await page.getByTitle(`Seite in ${space.name} hinzufügen`).first().click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox", { name: "Name" }).fill("Test offline");
  await dialog.getByRole("textbox", { name: "Name" }).press("Enter");
  await expect(page.locator("textarea.page-title")).toHaveValue("Test offline");
  await expect(page.locator(".topbar-note")).toContainText("Noch nicht synchronisiert");
  // The editor, not "Not available offline".
  const editor = page.locator(".page-content .ProseMirror").first();
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".view-unavailable")).toHaveCount(0);
  await editor.click();
  await page.keyboard.type("Ohne Verbindung geschrieben.");
  await expect(editor).toContainText("Ohne Verbindung geschrieben.");
  expect(errors).toEqual([]);
});
