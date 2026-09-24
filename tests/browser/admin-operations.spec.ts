import { test, expect } from "@playwright/test";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

// Creates an admin session directly in the test server's database. Refuses to
// run without an explicit data directory so real data is never touched.
test("admins see operations metrics and quotas block uploads beyond the limit", async ({
  page,
  browser,
}, testInfo) => {
  test.skip(
    !process.env.FLOWPLAN_DATA_DIR,
    "FLOWPLAN_DATA_DIR of the test server is required.",
  );
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const db = new DatabaseSync(
    join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"),
  );
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  const uid = randomUUID(),
    token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)").run(
    uid,
    `ops-admin:${uid}`,
    "Ops Admin",
    `${uid}@example.test`,
  );
  db.prepare(
    "INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)",
  ).run(
    createHash("sha256").update(token).digest("hex"),
    uid,
    JSON.stringify(["flowplan-admins"]),
    Date.now() + 300000,
  );
  const adminContext = await browser.newContext(
    testInfo.project.name === "mobile"
      ? {
          viewport: { width: 390, height: 844 },
          isMobile: true,
          hasTouch: true,
        }
      : {},
  );
  await adminContext.addCookies([
    {
      name: "flowplan_session",
      value: token,
      url: origin,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const admin = await adminContext.newPage();
  try {
    await admin.goto(`${origin}/#admin`);
    await expect(
      admin.getByRole("heading", { name: "Administration" }),
    ).toBeVisible();
    await admin.getByRole("button", { name: "Betrieb", exact: true }).click();
    const metrics = admin.getByLabel("Betriebsmetriken");
    await expect(metrics).toContainText("Datenbank");
    await expect(metrics).toContainText("Suchindex");
    await admin.screenshot({
      path: `test-results/admin-verification/${testInfo.project.name}-metrics.png`,
    });
    await admin
      .getByRole("button", { name: "Arbeitsbereiche", exact: true })
      .click();
    const quota = admin.getByLabel(`Kontingent ${boot.workspace.name}`).first();
    await quota.fill("1");
    await quota.blur();
    await expect
      .poll(
        () =>
          (
            db
              .prepare("SELECT quota_mb FROM workspaces WHERE id=?")
              .get(boot.workspace.id) as { quota_mb: number | null }
          ).quota_mb,
      )
      .toBe(1);
    // The demo user's upload beyond the remaining quota is rejected.
    const p = await (
      await page.request.post("/api/command", {
        headers: { origin },
        data: {
          action: "page.create",
          workspaceId: boot.workspace.id,
          spaceId: boot.spaces[0].id,
          title: `Quote ${testInfo.project.name}`,
        },
      })
    ).json();
    const upload = await page.request.post("/api/upload", {
      headers: { origin },
      multipart: {
        pageId: p.id,
        file: {
          name: "big.bin",
          mimeType: "application/octet-stream",
          buffer: Buffer.alloc(2 * 1024 * 1024),
        },
      },
    });
    expect(upload.status()).toBe(413);
    expect(await upload.text()).toContain("Speicherkontingent");
    await quota.fill("");
    await quota.blur();
    await expect
      .poll(
        () =>
          (
            db
              .prepare("SELECT quota_mb FROM workspaces WHERE id=?")
              .get(boot.workspace.id) as { quota_mb: number | null }
          ).quota_mb,
      )
      .toBeNull();
    await page.request.post("/api/command", {
      headers: { origin },
      data: { action: "page.delete", pageId: p.id },
    });
  } finally {
    await adminContext.close();
    // The admin received a personal workspace on first visit; deactivate instead of deleting.
    db.prepare("DELETE FROM sessions WHERE user_id=?").run(uid);
    db.prepare("UPDATE users SET disabled=1 WHERE id=?").run(uid);
    db.close();
  }
});
