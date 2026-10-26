import { test, expect, type Page } from "@playwright/test";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

// Administration → Arbeitsbereiche: each workspace names its owners, the
// search finds a workspace by its owner, and the list comes in pages of 25.
const db = () => {
  const d = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  d.exec("PRAGMA busy_timeout=5000;");
  return d;
};

async function signInAdmin(page: Page) {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  const d = db();
  const uid = randomUUID(),
    token = randomBytes(32).toString("hex");
  d.prepare("INSERT INTO users(id,subject,name,email,onboarded_at) VALUES(?,?,?,?,?)").run(uid, `ws-admin:${uid}`, "Workspace Admin", `${uid}@example.test`, Date.now());
  d.prepare("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)").run(createHash("sha256").update(token).digest("hex"), uid, JSON.stringify(["flowplan-admins"]), Date.now() + 600000);
  d.close();
  await page.context().addCookies([{ name: "flowplan_session", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
}

test("workspaces show their owners and come in pages", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "The table layout: the desktop run.");
  const run = randomBytes(3).toString("hex");
  const d = db();
  const owner = randomUUID();
  d.prepare("INSERT INTO users(id,subject,name,email,onboarded_at) VALUES(?,?,?,?,?)").run(owner, `ws-owner:${owner}`, `Olga Owner ${run}`, `olga-${run}@example.test`, Date.now());
  for (let i = 0; i < 30; i++) {
    const ws = randomUUID();
    d.prepare("INSERT INTO workspaces(id,name) VALUES(?,?)").run(ws, `Bereich ${run} ${String(i).padStart(2, "0")}`);
    d.prepare("INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,?)").run(ws, owner, "owner");
  }
  d.close();
  await signInAdmin(page);
  await page.goto("/#admin/workspaces");
  const section = page.locator("section[aria-labelledby='admin-workspaces-title']");
  await expect(section).toBeVisible({ timeout: 30_000 });
  const pager = section.getByRole("navigation", { name: "Seiten der Arbeitsbereiche" });
  await expect(pager).toBeVisible();
  await expect(section.locator("tbody tr")).toHaveCount(25);

  // By the owner's address: only the 30 workspaces of this run, on two pages.
  await section.getByRole("searchbox", { name: "Arbeitsbereiche suchen" }).fill(`olga-${run}`);
  await expect(pager).toContainText("1–25 von 30");
  const first = section.locator("tbody tr").first();
  await expect(first).toContainText(`Bereich ${run} 00`);
  await expect(first).toContainText(`Olga Owner ${run}`);
  await expect(first).toContainText(`olga-${run}@example.test`);
  await pager.getByRole("button", { name: "Nächste Seite" }).click();
  await expect(pager).toContainText("26–30 von 30");
  await expect(section.locator("tbody tr")).toHaveCount(5);
  await expect(pager.getByRole("button", { name: "Nächste Seite" })).toBeDisabled();
  await pager.getByRole("button", { name: "Vorherige Seite" }).click();
  await expect(pager).toContainText("1–25 von 30");
});
