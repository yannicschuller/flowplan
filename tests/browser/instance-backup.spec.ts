import { test, expect } from "@playwright/test";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

test("admins download an instance backup and stage or cancel a restore", async ({
  browser,
}, testInfo) => {
  test.skip(
    !process.env.FLOWPLAN_DATA_DIR,
    "Needs the test server data directory.",
  );
  test.skip(testInfo.project.name !== "desktop", "Restores are instance-wide.");
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  const db = new DatabaseSync(
    join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"),
  );
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  const uid = randomUUID(),
    token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)").run(
    uid,
    `backup-admin:${uid}`,
    "Backup Admin",
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
  const context = await browser.newContext({ acceptDownloads: true });
  await context.addCookies([
    {
      name: "flowplan_session",
      value: token,
      url: origin,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const admin = await context.newPage();
  try {
    await admin.goto(`${origin}/#admin`);
    await admin.getByRole("button", { name: "Instanz", exact: true }).click();
    const section = admin.getByRole("region", { name: "Instanzsicherung" });
    const downloading = admin.waitForEvent("download");
    await section
      .getByRole("link", { name: "Sicherung herunterladen" })
      .click();
    const download = await downloading;
    expect(download.suggestedFilename()).toMatch(/^flowplan-instanz-.*\.zip$/);
    const file = (await download.path())!;
    await section.getByLabel("Instanzsicherung hochladen").setInputFiles(file);
    await expect(section.getByRole("status")).toContainText(
      "Bereit zur Übernahme beim Neustart",
    );
    await section
      .getByRole("button", { name: "Wiederherstellung abbrechen" })
      .click();
    await expect(section.getByText("Sicherung auswählen")).toBeVisible();
  } finally {
    await context.close();
  }
});
