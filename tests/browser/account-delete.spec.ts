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

// People delete their own account from Settings → General → Your profile:
// the plan first, a successor for a shared workspace, the e-mail address to
// confirm (SSO) – then they land on the sign-in page.
test("an SSO account deletes itself after choosing a successor", async ({ browser }, info) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "FLOWPLAN_DATA_DIR of the test server is required.");
  test.skip(info.project.name !== "desktop", "Once is enough.");
  test.setTimeout(120_000);
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  db.exec("PRAGMA busy_timeout=5000;");
  const stamp = Date.now();
  const person = (name: string) => {
    const uid = randomUUID();
    db.prepare("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)").run(uid, `self:${uid}`, name, `${uid}@example.test`);
    return uid;
  };
  const me = person(`Selbst ${stamp}`),
    editor = person(`Redaktion ${stamp}`),
    viewer = person(`Lesend ${stamp}`);
  const token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)").run(createHash("sha256").update(token).digest("hex"), me, "[]", Date.now() + 600000);
  const team = randomUUID();
  db.prepare("INSERT INTO workspaces(id,name,created_by) VALUES(?,?,?)").run(team, `Team ${stamp}`, me);
  db.prepare("INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,'owner'),(?,?,'editor'),(?,?,'viewer')").run(team, me, team, editor, team, viewer);
  const context = await browser.newContext({ locale: "de-DE" });
  await context.addCookies([{ name: "flowplan_session", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
  const errors: string[] = [];
  try {
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${origin}/#settings`);
    await page.getByRole("button", { name: /Allgemein/ }).first().click().catch(() => {});
    await page.getByRole("button", { name: "Konto löschen …" }).click();
    const dialog = page.getByRole("dialog", { name: "Dein Konto löschen?" });
    await expect(dialog).toContainText("nur dich als Mitglied");
    const successor = dialog.getByLabel(`Neuer Eigentümer von „Team ${stamp}“:`);
    await expect(successor).toHaveValue(editor);
    await successor.selectOption(viewer);
    const confirm = dialog.getByLabel(`Zur Bestätigung „${me}@example.test“ eingeben:`);
    await confirm.fill("falsch@example.test");
    await dialog.getByRole("button", { name: "Konto endgültig löschen" }).click();
    await expect(dialog.getByRole("alert")).toContainText("Bestätigung stimmt nicht");
    await confirm.fill(`${me}@example.test`);
    await page.screenshot({ path: "test-results/account-self-delete/dialog.png" });
    await dialog.getByRole("button", { name: "Konto endgültig löschen" }).click();
    // Signed out: the sign-in page.
    await expect(page.locator(".login-form, .login-card, .login").first()).toBeVisible({ timeout: 20_000 });
    expect(db.prepare("SELECT count(*) n FROM sessions WHERE user_id=?").get(me)).toEqual({ n: 0 });
    expect(db.prepare("SELECT role FROM members WHERE workspace_id=? AND user_id=?").get(team, viewer)).toEqual({ role: "owner" });
    expect(db.prepare("SELECT count(*) n FROM members WHERE user_id=?").get(me)).toEqual({ n: 0 });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    db.close();
  }
});

test("an account with a password confirms with it; the last admin is refused", async ({ browser }, info) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "FLOWPLAN_DATA_DIR of the test server is required.");
  test.skip(info.project.name !== "desktop", "Once is enough.");
  test.setTimeout(120_000);
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  db.exec("PRAGMA busy_timeout=5000;");
  db.prepare("INSERT INTO instance_settings(key,value) VALUES('allowSignup','true') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
  db.prepare("INSERT OR IGNORE INTO users(id,subject,name,email) VALUES(?,?,?,?)").run("00000000-0000-4000-8000-0000000000aa", "seed:existing", "Bestehend", "existing@example.test");
  const email = `selbst-${Date.now()}@example.test`;
  const context = await browser.newContext({ locale: "de-DE" });
  const errors: string[] = [];
  try {
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${origin}/register`);
    await page.getByLabel("Name").fill("Selbst Löschend");
    await page.getByLabel("E-Mail-Adresse").fill(email);
    await page.locator("input[name=password]").fill("ein-langes-passwort");
    await page.getByRole("button", { name: "Konto erstellen" }).click();
    await expect(page.getByLabel("Dokumentinhalt", { exact: true }).or(page.locator(".sidebar"))).toBeVisible({ timeout: 20_000 });
    const uid = (db.prepare("SELECT user_id FROM local_accounts WHERE email=?").get(email) as { user_id: string }).user_id;
    const open = async () => {
      await page.goto(`${origin}/#settings`);
      await page.getByRole("button", { name: /Allgemein/ }).first().click().catch(() => {});
      await page.getByRole("button", { name: "Konto löschen …" }).click();
      return page.getByRole("dialog", { name: "Dein Konto löschen?" });
    };
    // As the only admin: refused with a reason, nothing to confirm.
    const others = db.prepare("SELECT user_id FROM local_accounts WHERE is_admin=1 AND user_id<>?").all(uid) as { user_id: string }[];
    db.prepare("UPDATE local_accounts SET is_admin=CASE WHEN user_id=? THEN 1 ELSE 0 END").run(uid);
    let dialog = await open();
    await expect(dialog.getByRole("alert")).toContainText("letzte Admin-Konto");
    await expect(dialog.getByRole("button", { name: "Konto endgültig löschen" })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Schließen" }).click();
    db.prepare("UPDATE local_accounts SET is_admin=0 WHERE user_id=?").run(uid);
    for (const o of others) db.prepare("UPDATE local_accounts SET is_admin=1 WHERE user_id=?").run(o.user_id);

    dialog = await open();
    const password = dialog.getByLabel("Zur Bestätigung dein Passwort:");
    await password.fill("falsches-passwort");
    await dialog.getByRole("button", { name: "Konto endgültig löschen" }).click();
    await expect(dialog.getByRole("alert")).toContainText("Passwort stimmt nicht");
    await password.fill("ein-langes-passwort");
    await dialog.getByRole("button", { name: "Konto endgültig löschen" }).click();
    await expect(page.getByRole("button", { name: "Anmelden", exact: true })).toBeVisible({ timeout: 20_000 });
    expect(db.prepare("SELECT count(*) n FROM local_accounts WHERE user_id=?").get(uid)).toEqual({ n: 0 });
    // The old password no longer signs in.
    await page.getByLabel("E-Mail-Adresse").fill(email);
    await page.locator("input[name=password]").fill("ein-langes-passwort");
    await page.getByRole("button", { name: "Anmelden", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Passwort stimmt nicht");
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    db.close();
  }
});
