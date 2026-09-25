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
  db.prepare("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)").run(
    uid,
    `instance-admin:${uid}`,
    "Instanz Admin",
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
    await admin.goto(`${origin}/#admin`);
    await admin.getByRole("button", { name: "Instanz", exact: true }).click();
    const form = admin.getByRole("form", { name: "Instanzeinstellungen" });
    await form.getByLabel("Name der Instanz").fill(`Muster ${tag}`);
    await form.getByLabel("Hinweis für alle Personen").fill(`Wartung ${tag}`);
    await form.getByLabel("Größte Datei beim Hochladen (MB)").fill("20");
    await form.getByRole("button", { name: "Einstellungen speichern" }).click();
    await expect(form.getByRole("status")).toHaveText("Gespeichert.");

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
