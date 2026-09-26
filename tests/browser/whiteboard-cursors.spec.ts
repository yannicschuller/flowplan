import { test, expect } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { join } from "node:path";

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

test("whiteboard cursors are live, leave with the person and point the way when off screen", async ({
  page,
  browser,
}, info) => {
  test.skip(info.project.name === "mobile", "Mouse cursors");
  // A second person is created directly in the test database only.
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "Needs the isolated test data directory");
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const board = await (
    await page.request.post("/api/command", {
      headers: { origin },
      data: {
        action: "page.create",
        workspaceId: boot.workspace.id,
        spaceId: boot.spaces[0].id,
        title: `Cursor-Board ${Date.now()}`,
        kind: "whiteboard",
      },
    })
  ).json();
  const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  const uid = randomUUID(),
    token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)").run(uid, uid, "Mira Moderation", `${uid}@test.invalid`);
  db.prepare("INSERT INTO members VALUES(?,?,?)").run(boot.workspace.id, uid, "editor");
  db.prepare("INSERT INTO sessions VALUES(?,?,?,?)").run(
    createHash("sha256").update(token).digest("hex"),
    uid,
    "[]",
    Date.now() + 3600000,
  );
  db.close();
  const context = await browser.newContext({ viewport: page.viewportSize() });
  await context.addCookies([{ name: "flowplan_session", value: token, url: origin }]);
  const other = await context.newPage();

  await page.goto(`/#page=${board.id}`);
  await other.goto(`${origin}/#page=${board.id}`);
  const canvas = (p: typeof page) => p.locator("svg.wb-canvas");
  await expect(canvas(page)).toBeVisible();
  await expect(canvas(other)).toBeVisible();

  // Mira moves: her cursor shows up on the first screen quickly.
  const area = (await canvas(other).boundingBox())!;
  await other.mouse.move(area.x + 200, area.y + 200);
  await other.mouse.move(area.x + 260, area.y + 240, { steps: 4 });
  const cursor = page.locator(".wb-cursor", { hasText: "Mira Moderation" });
  await expect(cursor).toBeVisible({ timeout: 2500 });
  const first = await cursor.evaluate((el) => (el as HTMLElement).style.transform);
  const started = Date.now();
  await other.mouse.move(area.x + 500, area.y + 380, { steps: 4 });
  await expect
    .poll(() => cursor.evaluate((el) => (el as HTMLElement).style.transform), { timeout: 2000 })
    .not.toBe(first);
  expect(Date.now() - started).toBeLessThan(1000);

  // Far away on the board: a marker at the edge; clicking jumps there.
  // (Mira's last throttled move is sent first.)
  await other.waitForTimeout(300);
  await other.request.post(`${origin}/api/whiteboards/${board.id}/cursor`, {
    headers: { origin },
    data: { x: 40000, y: 30000 },
  });
  const edge = page.getByRole("button", { name: "Zu Mira Moderation springen" });
  await expect(edge).toBeVisible();
  await edge.click();
  await expect(cursor).toBeVisible();

  // Leaving the board removes the cursor for everyone.
  await other.close();
  await expect(page.locator(".wb-cursor, .wb-cursor-edge")).toHaveCount(0, { timeout: 5000 });
  await context.close();
  await page.request.post("/api/command", { headers: { origin }, data: { action: "page.delete", pageId: board.id } });
});
