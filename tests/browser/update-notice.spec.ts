import { test, expect } from "@playwright/test";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

// The administration announces a newer release with a link to the update
// guide. To see the notice, start the test server with a newer release, e.g.
//   FLOWPLAN_UPDATE_URL='data:application/json,{"tag_name":"v99.0.0","html_url":"https://github.com/yannicschuller/flowplan/releases/tag/v99.0.0"}'
// Without it (no newer release, or offline) there is no notice.
test("the administration announces a newer release", async ({ browser }, testInfo) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "FLOWPLAN_DATA_DIR of the test server is required.");
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  const uid = randomUUID(),
    token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)").run(uid, `update-admin:${uid}`, "Update Admin", `${uid}@example.test`);
  db.prepare("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)").run(
    createHash("sha256").update(token).digest("hex"),
    uid,
    JSON.stringify(["flowplan-admins"]),
    Date.now() + 300000,
  );
  const context = await browser.newContext(
    testInfo.project.name === "mobile" ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : {},
  );
  await context.addCookies([{ name: "flowplan_session", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
  const admin = await context.newPage();
  try {
    const { update, build } = await (await admin.request.get(`${origin}/api/admin`)).json();
    await admin.goto(`${origin}/#admin`);
    await expect(admin.getByRole("heading", { name: "Administration" })).toBeVisible();
    const notice = admin.locator(".admin-update");
    if (!update) {
      await expect(notice).toHaveCount(0);
      return;
    }
    expect(update.current).toBe(build.version);
    await expect(notice).toContainText(`Flowplan ${update.latest} ist verfügbar.`);
    await expect(notice).toContainText(`Diese Instanz läuft mit ${build.version}.`);
    await expect(notice.getByRole("link", { name: "So aktualisierst du" })).toHaveAttribute("href", "https://docs.flowplan.org/de/installation#aktualisieren");
    if (update.url) await expect(notice.getByRole("link", { name: "Was ist neu" })).toHaveAttribute("href", update.url);
    await admin.screenshot({ path: `test-results/admin-verification/${testInfo.project.name}-update.png` });
  } finally {
    await context.close();
    db.prepare("DELETE FROM sessions WHERE user_id=?").run(uid);
    db.prepare("UPDATE users SET disabled=1 WHERE id=?").run(uid);
    db.close();
  }
});
