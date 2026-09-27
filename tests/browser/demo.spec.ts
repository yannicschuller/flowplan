import { test, expect } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

test("the demo button opens a throwaway workspace that is deleted on leaving", async ({
  browser,
}, testInfo) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "Needs the test server data directory.");
  test.skip(testInfo.project.name !== "desktop", "The demo setting is global.");
  const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  db.exec("PRAGMA busy_timeout=5000;");
  const setDemo = (on: boolean) =>
    db
      .prepare(
        "INSERT INTO instance_settings(key,value) VALUES('publicDemo',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(JSON.stringify(on));
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    setDemo(false);
    await page.goto("/");
    await expect(page.getByRole("link", { name: "Anmelden" }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /Demo/ })).toHaveCount(0);

    setDemo(true);
    await page.goto("/");
    await page.getByRole("button", { name: "Demo ausprobieren" }).first().click();
    await expect(page.locator(".demo-banner")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".sidebar")).toContainText("Produkt-Roadmap");
    const uid = (db.prepare("SELECT id FROM users WHERE demo_until IS NOT NULL ORDER BY rowid DESC LIMIT 1").get() as { id: string }).id;
    const ws = (db.prepare("SELECT workspace_id id FROM members WHERE user_id=?").get(uid) as { id: string }).id;

    // Sharing to the outside is not part of the demo.
    const blocked = await page.request.post("/api/command", {
      headers: { origin: new URL(page.url()).origin },
      data: { action: "workspace.create", name: "Mehr" },
    });
    expect(blocked.status()).toBe(403);

    // Link cards (server-side fetches of foreign pages) are off in the demo.
    const embed = await page.request.get("/api/embed?url=https%3A%2F%2Fexample.com%2F");
    expect(embed.status()).toBe(403);

    await page.getByRole("button", { name: "Demo beenden" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Auf eurem Server.");
    expect(db.prepare("SELECT 1 FROM users WHERE id=?").get(uid)).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM workspaces WHERE id=?").get(ws)).toBeUndefined();
    expect(errors).toEqual([]);
  } finally {
    setDemo(false);
    db.close();
    await context.close();
  }
});

test("the live channel of a document closes once the session ends", async ({ browser }, testInfo) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "Needs the test server data directory.");
  test.skip(testInfo.project.name !== "desktop", "One run is enough.");
  test.setTimeout(60_000);
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  const context = await browser.newContext({ baseURL: origin });
  const page = await context.newPage();
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const created = await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, kind: "document", title: `Live-Rechte ${Date.now()}` },
  });
  const { id } = await created.json();
  const { generation } = await (await page.request.get(`/api/pages/${id}`)).json();
  await page.goto("/docs");
  await page.evaluate(
    ({ id, generation }) => {
      const events: string[] = [];
      (window as unknown as { liveEvents: string[] }).liveEvents = events;
      const source = new EventSource(`/api/documents/live?page=${id}&generation=${generation}&client=${crypto.randomUUID()}`);
      source.onmessage = (e) => {
        events.push(JSON.parse(e.data).type);
        if (JSON.parse(e.data).type === "revoked") source.close();
      };
    },
    { id, generation },
  );
  await expect.poll(() => page.evaluate(() => (window as unknown as { liveEvents: string[] }).liveEvents)).toContain("ready");
  // The session ends (sign-out elsewhere, disabled account, expiry).
  await page.request.post("/api/auth/logout", { headers: { origin } });
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { liveEvents: string[] }).liveEvents), { timeout: 20_000 })
    .toContain("revoked");
  await context.close();
});
