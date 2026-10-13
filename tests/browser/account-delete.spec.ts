import { test, expect } from "@playwright/test";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

// Admins delete an account once it is disabled; the dialog says what happens.
test("an admin deletes a disabled account after seeing what happens", async ({ browser }, info) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "FLOWPLAN_DATA_DIR of the test server is required.");
  test.skip(info.project.name !== "desktop", "Once is enough.");
  test.setTimeout(120_000);
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  db.exec("PRAGMA busy_timeout=5000;");
  const make = (name: string, groups: string[]) => {
    const uid = randomUUID(),
      token = randomBytes(32).toString("hex");
    db.prepare("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)").run(uid, `del:${uid}`, name, `${uid}@example.test`);
    db.prepare("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)").run(createHash("sha256").update(token).digest("hex"), uid, JSON.stringify(groups), Date.now() + 600000);
    return { uid, token };
  };
  const name = `Gehend ${Date.now()}`;
  const leaving = make(name, []);
  const admin = make("Admin Löschen", ["flowplan-admins"]);
  const errors: string[] = [];
  const context = await browser.newContext({ locale: "de-DE" });
  await context.addCookies([{ name: "flowplan_session", value: admin.token, url: origin, httpOnly: true, sameSite: "Lax" }]);
  // The person's own workspace exists after a first visit.
  const visit = await browser.newContext({ locale: "de-DE" });
  await visit.addCookies([{ name: "flowplan_session", value: leaving.token, url: origin, httpOnly: true, sameSite: "Lax" }]);
  const visitPage = await visit.newPage();
  await visitPage.goto(`${origin}/#home`);
  await expect(visitPage.locator(".workspace-switch").first()).toBeAttached({ timeout: 20_000 });
  await visit.close();
  try {
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${origin}/#admin`);
    const row = page.locator(".user-row", { hasText: name });
    await row.getByRole("button", { name: "Verwalten" }).click();
    await expect(row.getByRole("button", { name: "Konto löschen …" })).toHaveCount(0);
    await expect(row).toContainText("sobald das Konto deaktiviert ist");
    await row.getByRole("button", { name: "Deaktivieren" }).click();
    await row.getByRole("button", { name: "Konto löschen …" }).click();
    const dialog = page.getByRole("dialog", { name: `${name} löschen?` });
    await expect(dialog).toContainText("nur diese Person als Mitglied");
    await page.screenshot({ path: `test-results/admin-verification/delete-dialog.png` });
    await dialog.getByRole("button", { name: "Endgültig löschen" }).click();
    await expect(page.locator(".user-row", { hasText: name })).toHaveCount(0);
    expect(db.prepare("SELECT count(*) n FROM members WHERE user_id=?").get(leaving.uid)).toEqual({ n: 0 });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    db.close();
  }
});
