import { test, expect, type Page } from "@playwright/test";

// Issue #47: offline use stores the whole app, not only the parts opened
// online. After opting in with nothing but the start page loaded, a record,
// a calendar view and a dashboard open offline; a part that is missing
// anyway shows "Not available offline" with "Try again" instead of a stuck
// interface, and loads once the connection is back.
//
// Loading while offline needs the production build (the development server
// hydrates only with its live-reload connection) and its real chunks: run it
// against the standalone server of `npm run build` (TEST_BASE_URL, with
// APP_URL set to the same address).
test("the offline copy holds every part of the app (#47)", async ({ page, context }, testInfo) => {
  test.setTimeout(300_000);
  test.skip(testInfo.project.name !== "desktop", "One service-worker run covers the shared code path.");
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  // A fresh instance takes the account; later runs sign in again.
  const account = { name: "Offline App", email: "offline-app@example.test", password: "ein-langes-passwort" };
  if (!(await page.request.post("/api/auth/register", { headers: { origin }, data: account })).ok())
    await page.request.post("/api/auth/password", { headers: { origin }, data: account });
  const assets = await (await page.request.get("/api/offline/assets")).json();
  test.skip(!assets.files?.length, "Needs a production build (no client build files listed).");
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await command({ action: "profile.onboarded" });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const where = { workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id };
  const db = await command({ ...where, action: "page.create", title: `Termine ${Date.now()}`, kind: "database" });
  const version = (await (await page.request.get(`/api/pages/${db.id}`)).json()).database.version;
  await command({
    action: "database.update",
    pageId: db.id,
    version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "date", name: "Datum", type: "date" },
      { id: "hours", name: "Stunden", type: "number" },
    ],
    views: [
      { id: "cal", name: "Kalender", type: "calendar", filters: [], sorts: [], dateField: "date", calendar: { mode: "month", timeZone: "UTC" } },
      { id: "table", name: "Tabelle", type: "table", filters: [], sorts: [] },
    ],
  });
  const today = new Date().toISOString().slice(0, 10);
  const row = await command({ action: "row.create", pageId: db.id, cells: { title: "Zahnarzt", date: today, hours: 2 } });
  const dashboard = await command({ ...where, action: "page.create", title: `Übersicht ${Date.now()}`, kind: "dashboard" });
  await command({
    action: "dashboard.save",
    pageId: dashboard.id,
    tiles: [
      { id: "note", type: "text", size: "full", text: "**Wochenplan**" },
      { id: "chart", type: "chart", source: db.id, kind: "donut", xField: "title", aggregate: "sum", yField: "hours" },
    ],
  });
  const board = await command({ ...where, action: "page.create", title: `Tafel ${Date.now()}`, kind: "whiteboard" });
  const doc = await command({ ...where, action: "page.create", title: `Notiz ${Date.now()}` });

  // Only the start page and the settings were ever loaded online.
  await page.goto("/#settings/devices");
  await page.getByRole("button", { name: "Auf diesem Gerät offline verfügbar machen" }).click();
  await expect(page.getByText(/offline verfügbar\./)).toBeVisible({ timeout: 180_000 });
  await expect(page.getByTestId("offline-app")).toContainText(
    `Die App ist für die Offline-Nutzung gespeichert (Version ${assets.version}`,
  );
  // Every listed file is in the cache of this build, nothing in older ones.
  const stored = await page.evaluate(async (build) => {
    const names = (await caches.keys()).filter((n) => n.startsWith("flowplan-static-"));
    const cache = await caches.open(`flowplan-static-${build}`);
    let bytes = 0;
    const keys = await cache.keys();
    for (const key of keys) bytes += (await (await cache.match(key))!.blob()).size;
    return { names, files: keys.length, bytes };
  }, assets.build);
  expect(stored.names).toEqual([`flowplan-static-${assets.build}`]);
  expect(stored.files).toBe(assets.files.length);
  console.log(`offline app copy: ${stored.files} files, ${(stored.bytes / 1024 / 1024).toFixed(1)} MB (listed ${(assets.bytes / 1024 / 1024).toFixed(1)} MB)`);

  // setOffline alone leaves the service worker's own requests online in
  // Chromium; aborting every request cuts those as well.
  await context.setOffline(true);
  await context.route("**/*", (route) => route.abort("internetdisconnected"));
  let visit = 0;
  const open = (hash: string) => page.goto(`/?v=${++visit}#${hash}`);
  const stuck = async (p: Page) => expect(p.locator(".view-unavailable")).toHaveCount(0);
  // A calendar view, loaded from the device's copy.
  await open(`page=${db.id}`);
  await expect(page.locator(".offline-banner")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".calendar-grid")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".calendar-grid").getByText("Zahnarzt")).toBeVisible();
  await stuck(page);
  // A record: its cells and – not stored, never opened – a clear message
  // instead of "Loading document …".
  await open(`page=${db.id}&row=${row.id}`);
  await expect(page.getByText("Dieser Eintrag ist offline nicht verfügbar.")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Dokument wird geladen …")).toHaveCount(0);
  // A dashboard with a chart.
  await open(`page=${dashboard.id}`);
  await expect(page.locator(".dashboard-text")).toContainText("Wochenplan", { timeout: 15_000 });
  await expect(page.locator(".dashboard-tile.type-chart svg").first()).toBeVisible();
  await stuck(page);
  // A document with the editor.
  await open(`page=${doc.id}`);
  await expect(page.getByLabel("Dokumentinhalt", { exact: true })).toBeVisible({ timeout: 15_000 });

  // A part missing from the copy anyway (here: the copy of the app's files
  // removed after the start): a message with "Try again", the rest works.
  await page.evaluate(async () => {
    for (const name of await caches.keys()) if (name.startsWith("flowplan-static-")) await caches.delete(name);
  });
  await page.goto(`/?v=${visit}#page=${board.id}`);
  const missing = page.locator(".view-unavailable");
  await expect(missing).toContainText("Nicht offline verfügbar – versuche es wieder, wenn du online bist.", { timeout: 15_000 });
  await missing.getByRole("button", { name: "Erneut versuchen" }).click();
  await expect(missing).toBeVisible();
  // The sidebar still answers.
  await expect(page.locator(".offline-banner")).toBeVisible();
  // Back online: the whiteboard loads by itself.
  await context.unrouteAll();
  await context.setOffline(false);
  await expect(page.locator(".wb-canvas").first()).toBeVisible({ timeout: 20_000 });
  await expect(missing).toHaveCount(0);
});
