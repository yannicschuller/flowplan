import { test, expect, type Browser, type TestInfo } from "@playwright/test";

// The workspace's live signal (#383, lib/workspace-live.ts,
// components/use-workspace-signals.ts): a change one person makes shows up
// in the other person's open tab within seconds – a new page in the
// sidebar, a changed record in the open database – not only with the timed
// refresh (every 60 s while the signal is connected, 10 s without).
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
async function person(browser: Browser, info: TestInfo) {
  const { viewport, isMobile, hasTouch } = info.project.use;
  const context = await browser.newContext({
    baseURL: origin,
    viewport,
    isMobile,
    hasTouch,
    locale: "de-DE",
    extraHTTPHeaders: { "Accept-Language": "de-DE,de;q=0.9" },
    storageState: { cookies: [], origins: [{ origin: new URL(origin).origin, localStorage: [{ name: "flowplan-offline-offer", value: "never" }] }] },
  });
  const page = await context.newPage();
  await page.request.post("/api/auth/demo", { headers: { origin } });
  return { context, page };
}

test("a change by one person shows up for another without waiting for the timed refresh", async ({ browser }, info) => {
  const a = await person(browser, info),
    b = await person(browser, info);
  const command = async (data: Record<string, unknown>) => {
    const response = await a.page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return await response.json();
  };
  const boot = await (await a.page.request.get("/api/bootstrap")).json();
  const db = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, kind: "database", title: `Live ${Date.now()}` });
  const row = await command({ action: "row.create", pageId: db.id, cells: { title: "Erster Eintrag" } });
  // Counts B's requests for the bootstrap: the signal, not a 10 s poll.
  const boots: number[] = [];
  let following = false;
  b.page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path === "/api/bootstrap") boots.push(Date.now());
    if (path === "/api/live") following = true;
  });
  await b.page.goto(`/#page=${db.id}`);
  const table = b.page.locator(".data-table, .record-card, .record-list").first();
  await expect(table).toContainText("Erster Eintrag");
  // B's tab follows the workspace (the stream is open).
  await expect.poll(() => following, { timeout: 10_000 }).toBe(true);
  await b.page.waitForTimeout(1000);

  // A new page appears in B's sidebar.
  const started = Date.now();
  const fresh = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, kind: "document", title: `Neu von A ${Date.now()}` });
  await expect(b.page.locator(`.page-nav[data-page-id="${fresh.id}"]`)).toBeAttached({ timeout: 5000 });
  expect(Date.now() - started, "within seconds, not with the timed refresh").toBeLessThan(5000);

  // A changed record shows in B's open database.
  const changed = Date.now();
  await command({ action: "row.update", pageId: db.id, rowId: row.id, version: row.version ?? 1, cells: { title: "Von A geändert" } });
  await expect(table).toContainText("Von A geändert", { timeout: 5000 });
  expect(Date.now() - changed).toBeLessThan(5000);
  // The bootstrap came with the signal, not with polls every 10 s.
  expect(boots.filter((t) => t >= started).length, "bootstrap requests since the change").toBeLessThanOrEqual(3);
  await a.context.close();
  await b.context.close();
});
