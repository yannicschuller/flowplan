import { test, expect, type Page, type Route } from "@playwright/test";
import { randomUUID, randomBytes, createHash, scryptSync } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

// Changing the e-mail address of an account with e-mail and password (#405):
// the dialog in Settings → Konto & Sicherheit → Profil, the page behind the
// link to the new address, and the administrators' way on an instance
// without e-mail. The browser specs' server sends no e-mail, so the dialog's
// request for the link is answered here once the password was checked by
// the real server.
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const PASSWORD = "ein-langes-passwort";
function passwordHash(password: string) {
  const salt = randomBytes(16);
  const key = scryptSync(password.normalize("NFKC"), salt, 64, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$32768$8$1$${salt.toString("base64url")}$${key.toString("base64url")}`;
}
const database = () => {
  const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  db.exec("PRAGMA busy_timeout=5000;");
  return db;
};
// An account with e-mail and password, signed in in `page`'s context.
async function localAccount(page: Page, name: string, groups: string[] = []) {
  const db = database();
  const uid = randomUUID(),
    token = randomBytes(32).toString("hex"),
    email = `${uid.slice(0, 8)}@example.test`;
  try {
    // onboarded_at: past the introduction new accounts see first.
    db.prepare("INSERT INTO users(id,subject,name,email,email_verified,onboarded_at) VALUES(?,?,?,?,1,?)").run(uid, `local:${uid}`, name, email, Date.now());
    db.prepare("INSERT INTO local_accounts(user_id,email,password_hash,is_admin,email_verified,verify_required,created_at) VALUES(?,?,?,0,1,0,?)").run(
      uid,
      email,
      passwordHash(PASSWORD),
      Date.now(),
    );
    db.prepare("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)").run(sha(token), uid, JSON.stringify(groups), Date.now() + 600000);
  } finally {
    db.close();
  }
  await page.context().addCookies([{ name: "flowplan_session", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
  return { uid, email };
}
async function openProfile(page: Page) {
  await page.goto(`${origin}/#settings/account`);
  await expect(page.locator("#profile")).toBeVisible({ timeout: 20_000 });
}
// The real answer, as if the instance sent e-mail.
async function withMail(route: Route) {
  const response = await route.fetch();
  const body = await response.json();
  await route.fulfill({ response, json: { ...body, mail: true } });
}

test("the dialog asks for the new address and the password, then shows the change as pending", async ({ page }, info) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "FLOWPLAN_DATA_DIR of the test server is required.");
  test.skip(info.project.name !== "desktop", "Once is enough.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { uid, email } = await localAccount(page, "Ada Adresse");
  const next = `neu-${uid.slice(0, 8)}@example.test`;
  await page.route("**/api/auth/email-change-status", withMail);
  await page.route("**/api/auth/email-change-cancel", withMail);
  let asked = 0;
  await page.route("**/api/auth/email-change", async (route) => {
    const body = route.request().postDataJSON() as { email?: string; confirm?: { password?: string } };
    expect(body.email).toBe(next);
    // A wrong password goes to the server, which refuses it.
    if (body.confirm?.password !== PASSWORD) return route.fallback();
    asked++;
    await route.fulfill({ json: { ok: true, available: true, mail: true, pending: { email: next, expires: Date.now() + 24 * 3600_000 } } });
  });
  await openProfile(page);
  const row = page.locator("#profile .setting-row", { hasText: "E-Mail-Adresse" });
  await expect(row).toContainText("Eine neue Adresse bestätigst du mit einem Link");
  await row.getByRole("button", { name: "E-Mail ändern …" }).click();
  const dialog = page.getByRole("dialog", { name: "E-Mail-Adresse ändern" });
  await expect(dialog).toContainText("innerhalb von 24 Stunden");
  const field = dialog.getByLabel("Neue E-Mail-Adresse");
  await expect(field).toBeFocused();
  // Both fields are required.
  await dialog.getByRole("button", { name: "Link senden" }).click();
  await expect(field).toHaveJSProperty("validity.valid", false);
  await field.fill(next);
  await dialog.getByLabel("Aktuelles Passwort").fill("falsches-passwort");
  await dialog.getByRole("button", { name: "Link senden" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Das Passwort stimmt nicht");
  await page.screenshot({ path: "test-results/email-change/dialog.png" });
  await dialog.getByLabel("Aktuelles Passwort").fill(PASSWORD);
  await dialog.getByRole("button", { name: "Link senden" }).click();
  await expect(dialog).toBeHidden();
  expect(asked).toBe(1);
  await expect(row.getByRole("status")).toContainText(`Link an ${next} gesendet`);
  await expect(row).toContainText(`Wartet auf Bestätigung: ${next}`);
  // Nothing changed yet; cancelling in the profile ends the pending change.
  const db = database();
  try {
    expect(db.prepare("SELECT email FROM local_accounts WHERE user_id=?").get(uid)).toEqual({ email });
  } finally {
    db.close();
  }
  await row.getByRole("button", { name: "Änderung abbrechen" }).click();
  await expect(row.getByRole("status")).toContainText("Änderung abgebrochen");
  await expect(row).not.toContainText("Wartet auf Bestätigung");
  await expect(row.getByRole("button", { name: "E-Mail ändern …" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("the link to the new address changes nothing until its button is pressed", async ({ browser }, info) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "FLOWPLAN_DATA_DIR of the test server is required.");
  test.skip(info.project.name !== "desktop", "Once is enough.");
  const context = await browser.newContext({ locale: "de-DE" });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    const { uid } = await localAccount(page, "Ben Bestätigt");
    const next = `bestaetigt-${uid.slice(0, 8)}@example.test`;
    const token = randomBytes(32).toString("base64url");
    const db = database();
    try {
      db.prepare("INSERT INTO auth_tokens(id,user_id,kind,expires,email) VALUES(?,?,'email-change',?,?)").run(sha(token), uid, Date.now() + 3600_000, next);
    } finally {
      db.close();
    }
    // Opened signed out, as from another device.
    await context.clearCookies();
    await page.goto(`${origin}/email-change?token=${token}`);
    await expect(page.getByRole("heading", { name: "Neue E-Mail-Adresse bestätigen" })).toBeVisible();
    const check = database();
    try {
      expect(check.prepare("SELECT 1 n FROM auth_tokens WHERE id=?").get(sha(token))).toEqual({ n: 1 });
    } finally {
      check.close();
    }
    await page.getByRole("button", { name: "Adresse bestätigen" }).click();
    await expect(page.getByRole("heading", { name: "Neue Adresse bestätigt" })).toBeVisible();
    await expect(page.locator(".login-card")).toContainText(`Du meldest dich ab jetzt mit ${next} an.`);
    const after = database();
    try {
      expect(after.prepare("SELECT email FROM users WHERE id=?").get(uid)).toEqual({ email: next });
      expect(after.prepare("SELECT email FROM local_accounts WHERE user_id=?").get(uid)).toEqual({ email: next });
    } finally {
      after.close();
    }
    // Used once: a second time it says so.
    await page.goto(`${origin}/email-change?token=${token}`);
    await page.getByRole("button", { name: "Adresse bestätigen" }).click();
    await expect(page.locator(".error[role=alert]")).toContainText("abgelaufen oder wurde schon benutzt");
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test("without e-mail an administrator changes the address in the account's panel", async ({ browser }, info) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "FLOWPLAN_DATA_DIR of the test server is required.");
  test.skip(info.project.name !== "desktop", "Once is enough.");
  test.setTimeout(90_000);
  const person = await browser.newContext({ locale: "de-DE" });
  const admin = await browser.newContext({ locale: "de-DE" });
  const errors: string[] = [];
  try {
    const personPage = await person.newPage();
    personPage.on("pageerror", (e) => errors.push(e.message));
    const name = `Cem Wechsel ${Date.now()}`;
    const { uid } = await localAccount(personPage, name);
    // The person's profile says who changes the address here.
    await openProfile(personPage);
    const row = personPage.locator("#profile .setting-row", { hasText: "E-Mail-Adresse" });
    await expect(row).toContainText("ändert die Administration für dich");
    await expect(row.getByRole("button", { name: "E-Mail ändern …" })).toHaveCount(0);

    const page = await admin.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await localAccount(page, "Admin Adressen", ["flowplan-admins"]);
    await page.goto(`${origin}/#admin/users`);
    await page.getByRole("searchbox", { name: "Benutzer suchen" }).fill(name);
    await page.locator(".user-row", { hasText: name }).locator("td.state").click();
    const sheet = page.getByRole("dialog", { name, exact: true });
    await sheet.getByRole("button", { name: "E-Mail ändern …" }).click();
    const field = sheet.getByLabel(`Neue E-Mail-Adresse für ${name}`);
    // An address of another account is refused.
    const taken = database();
    try {
      taken.prepare("INSERT OR IGNORE INTO users(id,subject,name,email) VALUES(?,?,?,?)").run(randomUUID(), `taken:${uid}`, "Vergeben", `vergeben-${uid.slice(0, 8)}@example.test`);
    } finally {
      taken.close();
    }
    await field.fill(`vergeben-${uid.slice(0, 8)}@example.test`);
    await sheet.getByRole("button", { name: "Ändern", exact: true }).click();
    await expect(sheet.getByRole("alert")).toContainText("gehört schon zu einem anderen Konto");
    const next = `gewechselt-${uid.slice(0, 8)}@example.test`;
    await field.fill(next);
    // Enter changes the address (and does not save the panel's limits).
    await field.press("Enter");
    await expect(sheet.getByRole("status")).toContainText(`E-Mail-Adresse geändert: ${next}`);
    await expect(sheet.locator(".ux-drawer-who small")).toHaveText(next);
    const db = database();
    try {
      expect(db.prepare("SELECT email FROM local_accounts WHERE user_id=?").get(uid)).toEqual({ email: next });
      expect(db.prepare("SELECT detail FROM audit WHERE action='admin.changeEmail' AND resource_id=?").get(uid)).toEqual({ detail: expect.stringContaining(`→ ${next}`) });
    } finally {
      db.close();
    }
    // The person stays signed in and sees the new address.
    await openProfile(personPage);
    await expect(personPage.locator(".account-identity-text small")).toHaveText(next);
    expect(errors).toEqual([]);
  } finally {
    await person.close();
    await admin.close();
  }
});
