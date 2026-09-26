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
