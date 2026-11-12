import { test, expect } from "@playwright/test";

// #243: every hit of the quick search shows its path and last change; with
// nothing typed, the recently visited pages and records, grouped by day.
test("⌘K: hits with path and date, recently visited pages and records by day", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const spaceId = boot.spaces[0].id;
  const stamp = `Kolibri${info.project.name}${Date.now()}`;
  const create = (title: string, extra: Record<string, unknown> = {}) =>
    command({ action: "page.create", workspaceId: boot.workspace.id, spaceId, title, kind: "document", ...extra });
  const parent = await create(`Wurzel ${stamp}`);
  const alpha = await create(`${stamp} Alpha`, { parentId: parent.id });
  const beta = await create(`${stamp} Beta`);
  const db = await create(`Termine ${stamp}`, { kind: "database", parentId: parent.id });
  const row = await command({ action: "row.create", pageId: db.id, cells: {} });

  // Visits: the record (as the record view opens it), then two pages.
  expect((await page.request.get(`/api/pages/${db.id}/rows/${row.id}`, { headers: { "X-Flowplan-Visit": "1" } })).ok()).toBe(true);
  await page.goto(`/#page=${alpha.id}`);
  await expect(page.getByLabel("Dokumentinhalt", { exact: true })).toBeVisible({ timeout: 20_000 });
  await page.goto(`/#page=${beta.id}`);
  await expect(page.getByLabel("Dokumentinhalt", { exact: true })).toBeVisible({ timeout: 20_000 });

  // Nothing typed: today's visits, newest first, each with its path.
  await page.keyboard.press("ControlOrMeta+k");
  const recent = page.locator(".palette-group").filter({ has: page.locator("#palette-recent-title") });
  await expect(page.locator("#palette-recent-title")).toHaveText("Zuletzt angesehen · Heute");
  const recentRows = recent.locator(".palette-option").filter({ hasText: stamp });
  await expect(recentRows).toHaveCount(3, { timeout: 15_000 });
  await expect(recentRows.nth(0)).toContainText(`${stamp} Beta`);
  await expect(recentRows.nth(1)).toContainText(`${stamp} Alpha`);
  await expect(recentRows.nth(1).locator(".palette-path")).toContainText(`Wurzel ${stamp}`);
  // The record: its database and the database's parent in the path.
  await expect(recentRows.nth(2).locator(".palette-path")).toContainText(`Wurzel ${stamp} / Termine ${stamp}`);
  if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/recent-${info.project.name}-light.png` });

  // Hits: path and "Bearbeitet …" in every row, the count and the order above.
  const input = page.getByLabel("Suchen oder Befehl");
  await input.fill(stamp);
  const hits = page.locator(".palette-group[aria-label='Treffer'] .palette-option");
  await expect(hits.filter({ hasText: `${stamp} Alpha` })).toHaveCount(1, { timeout: 15_000 });
  const alphaHit = hits.filter({ hasText: `${stamp} Alpha` });
  await expect(alphaHit.locator(".palette-path")).toContainText(`Wurzel ${stamp}`);
  for (const option of await hits.all()) {
    const date = info.project.name === "mobile" ? option.locator(".palette-date-inline") : option.locator(".palette-date");
    await expect(date).toContainText("Bearbeitet");
  }
  await expect(page.locator(".palette-results-head")).toContainText("Treffer");
  await expect(page.getByLabel("Sortierung")).toBeVisible();
  if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/hits-${info.project.name}-light.png` });

  if (process.env.SHOTS_DIR) {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({ path: `${process.env.SHOTS_DIR}/hits-${info.project.name}-dark.png` });
    await input.fill("");
    await expect(page.locator("#palette-recent-title")).toBeVisible();
    await page.screenshot({ path: `${process.env.SHOTS_DIR}/recent-${info.project.name}-dark.png` });
    await page.emulateMedia({ colorScheme: "light" });
  }
  await page.keyboard.press("Escape");
  for (const p of [beta, parent]) await command({ action: "page.delete", pageId: p.id });
  expect(errors).toEqual([]);
});
