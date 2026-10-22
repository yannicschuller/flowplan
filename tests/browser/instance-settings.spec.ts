import { test, expect } from "@playwright/test";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

test("admins set the instance name and an announcement for everyone", async ({
  page,
  browser,
}, testInfo) => {
  test.skip(
    !process.env.FLOWPLAN_DATA_DIR,
    "Needs the test server data directory.",
  );
  test.skip(
    testInfo.project.name !== "desktop",
    "Instance settings are global.",
  );
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  const db = new DatabaseSync(
    join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"),
  );
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  const uid = randomUUID(),
    token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO users(id,subject,name,email,onboarded_at) VALUES(?,?,?,?,?)").run(
    uid,
    `instance-admin:${uid}`,
    "Instanz Admin",
    `${uid}@example.test`,
    Date.now(),
  );
  db.prepare(
    "INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)",
  ).run(
    createHash("sha256").update(token).digest("hex"),
    uid,
    JSON.stringify(["flowplan-admins"]),
    Date.now() + 300000,
  );
  db.close();
  const adminContext = await browser.newContext();
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
  const tag = Date.now();
  try {
    // Each setting saves on its own, in the section it belongs to.
    await admin.goto(`${origin}/#admin/general`);
    const general = admin.getByRole("region", { name: "Instanz", exact: true });
    await general.getByLabel("Name der Instanz").fill(`Muster ${tag}`);
    await general.getByRole("button", { name: "Speichern", exact: true }).click();
    await expect(general.getByRole("status").filter({ hasText: "Gespeichert" })).toBeVisible();
    await admin.goto(`${origin}/#admin/maintenance`);
    const notice = admin.getByRole("region", { name: "Hinweis für alle" });
    await notice.getByLabel("Hinweis für alle Personen").fill(`Wartung ${tag}`);
    await notice.getByRole("button", { name: "Speichern", exact: true }).click();
    await expect(notice.getByRole("status").filter({ hasText: "Gespeichert" })).toBeVisible();
    await admin.goto(`${origin}/#admin/limits`);
    const upload = admin.getByLabel("Größte Datei beim Hochladen", { exact: true });
    await upload.fill("20");
    await upload.press("Enter");
    await expect(admin.getByRole("status").filter({ hasText: "Gespeichert" })).toBeVisible();

    await page.request.post("/api/auth/demo", { headers: { origin } });
    await page.goto("/#home");
    await expect(page.locator(".instance-announcement")).toHaveText(
      `Wartung ${tag}`,
    );
    await expect(page.locator(".instance-name")).toHaveText(`Muster ${tag}`);
  } finally {
    // Back to the defaults for other tests.
    await admin.request.post(`${origin}/api/command`, {
      headers: { origin },
      data: {
        action: "admin.settings",
        settings: {
          name: "",
          announcement: "",
          defaultQuotaMb: null,
          retentionDays: null,
          maxUploadMb: 10,
          allowWorkspaceCreation: true,
        },
      },
    });
    await adminContext.close();
  }
});
