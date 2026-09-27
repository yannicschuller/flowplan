import { test, expect } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

test("follow a page, see changes since the last visit and recently viewed pages", async ({ page }, info) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "Needs the test server data directory.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const title = `Aktivität ${info.project.name} ${Date.now()}`;
  const pageId = (
    await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind: "document" })
  ).id;
  const { htmlState } = await import("../../lib/document-server");
  const sync = async (html: string) => {
    const data = await (await page.request.get(`/api/pages/${pageId}`)).json();
    await command({
      action: "document.sync",
      workspaceId: boot.workspace.id,
      pageId,
      generation: data.generation,
      update: Buffer.from(htmlState(html)).toString("base64"),
    });
  };
  await sync("<p>Ursprünglicher Plan für das Quartal</p>");
  await page.goto(`/#page=${pageId}`);
  // The creator follows the page.
  const follow = page.getByRole("button", { name: "Nicht mehr folgen" });
  await expect(follow).toHaveAttribute("aria-pressed", "true");
  await follow.click();
  await expect(page.getByRole("button", { name: "Seite folgen" })).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "Seite folgen" }).click();
  await expect(page.getByRole("button", { name: "Nicht mehr folgen" })).toBeVisible();

  // Someone else changes the page while we are away.
  const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  db.exec("PRAGMA busy_timeout=5000;");
  const kim = randomUUID();
  db.prepare("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)").run(kim, kim, "Kim Weber", `${kim}@example.test`);
  await page.goto("/#home");
  await expect(page.locator(".visited-section")).toContainText(title);
  // Let background reloads of the page settle before going back in time.
  await page.waitForTimeout(1500);
  db.prepare("UPDATE page_visits SET seen_at=seen_at-3600000 WHERE page_id=?").run(pageId);
  db.prepare("UPDATE documents SET html=?,state=? WHERE page_id=?").run(
    "<p>Überarbeiteter Plan für das Quartal</p><p>Neue Ziele</p>",
    htmlState("<p>Überarbeiteter Plan für das Quartal</p><p>Neue Ziele</p>"),
    pageId,
  );
  db.prepare("INSERT INTO page_edits(page_id,user_id,at) VALUES(?,?,?)").run(pageId, kim, Date.now());
  await page.reload();
  await expect(page.locator(".visited-section")).toContainText(title);
  await page.locator(".visited-section button", { hasText: title }).click();
  const banner = page.locator(".since-visit");
  await expect(banner).toContainText("Kim Weber");
  await banner.getByRole("button", { name: "Änderungen zeigen" }).click();
  const dialog = page.getByRole("dialog", { name: "Seit deinem letzten Besuch" });
  await expect(dialog.locator("ins").first()).toBeVisible();
  await expect(dialog).toContainText("Neue Ziele");
  await dialog.getByRole("button", { name: "Schließen" }).click();
  await banner.getByRole("button", { name: "Hinweis schließen" }).click();
  await expect(banner).toHaveCount(0);
  // Readers: Kim has not opened it; only we did, so no reader button.
  await expect(page.locator(".readers-button")).toHaveCount(0);
  db.prepare("INSERT INTO page_visits(user_id,page_id,seen_at) VALUES(?,?,?)").run(kim, pageId, Date.now() + 1000);
  db.prepare("INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,?)").run(boot.workspace.id, kim, "viewer");
  await page.reload();
  await page.locator(".readers-button").click();
  await expect(page.locator(".readers-menu")).toContainText("Kim Weber");
  expect(errors).toEqual([]);
});
