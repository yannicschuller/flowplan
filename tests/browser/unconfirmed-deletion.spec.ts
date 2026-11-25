import { test, expect, type BrowserContext } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID, randomBytes, createHash, scryptSync } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

// Accounts with an unconfirmed address marked for deletion (#436): the
// administrator filters "E-Mail unbestätigt", marks one account from its
// menu and the rest of the filter in one go; the first person, signed in,
// sees the notice, opens the link from the e-mail and keeps the account; the
// other one is deleted once its day has come.
//
// The specs' servers send no e-mail, and the feature is only offered with
// e-mail. This spec starts one more server of the same build with SMTP_HOST
// pointing at a closed local port: the e-mails stay in its queue, where the
// spec reads the link. FLOWPLAN_UNCONFIRMED_CHECK_MS runs the job every
// two seconds; "the clock moves on" by setting the day of deletion into
// the past in the database.
const base = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const port = Number(new URL(base).port || 80) + 60;
const origin = `http://127.0.0.1:${port}`;
const dataDir = `${process.env.FLOWPLAN_DATA_DIR}mail`;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const PASSWORD = "ein-langes-passwort";
function passwordHash(password: string) {
  const salt = randomBytes(16);
  const key = scryptSync(password.normalize("NFKC"), salt, 64, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$32768$8$1$${salt.toString("base64url")}$${key.toString("base64url")}`;
}
const database = () => {
  const db = new DatabaseSync(join(dataDir, "flowplan.sqlite"));
  db.exec("PRAGMA busy_timeout=5000;");
  return db;
};
function withDb<T>(fn: (db: DatabaseSync) => T): T {
  const db = database();
  try {
    return fn(db);
  } finally {
    db.close();
  }
}
// An account with e-mail and password and a session; `confirmed` false: the
// address was never confirmed.
function account(name: string, confirmed: boolean, groups: string[] = []) {
  const uid = randomUUID(),
    token = randomBytes(32).toString("hex"),
    email = `${name.toLowerCase().replace(/\W/g, "")}-${uid.slice(0, 6)}@example.test`;
  withDb((db) => {
    db.prepare("INSERT INTO users(id,subject,name,email,email_verified,onboarded_at) VALUES(?,?,?,?,?,?)").run(uid, `local:${uid}`, name, email, confirmed ? 1 : 0, Date.now());
    db.prepare("INSERT INTO local_accounts(user_id,email,password_hash,is_admin,email_verified,verify_required,created_at) VALUES(?,?,?,0,?,0,?)").run(
      uid,
      email,
      passwordHash(PASSWORD),
      confirmed ? 1 : 0,
      Date.now() - 30 * 86_400_000,
    );
    db.prepare("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)").run(sha(token), uid, JSON.stringify(groups), Date.now() + 600000);
  });
  return { uid, email, name, token };
}
async function signIn(context: BrowserContext, token: string) {
  await context.addCookies([{ name: "flowplan_session", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
}
const linkFor = (email: string) =>
  withDb((db) => {
    const mails = db.prepare("SELECT text FROM mail_queue WHERE recipient=? ORDER BY seq").all(email) as { text: string }[];
    return /https?:\/\/\S+\/api\/auth\/verify\?token=[\w-]+/.exec(mails.at(-1)?.text || "")?.[0] || "";
  });

let server: ChildProcess | null = null;
test.beforeAll(async ({}, info) => {
  if (!process.env.FLOWPLAN_DATA_DIR || info.project.name !== "desktop") return;
  test.setTimeout(120_000);
  server = spawn(process.execPath, ["scripts/e2e-server.mjs"], {
    env: {
      ...process.env,
      PORT: String(port),
      FLOWPLAN_DATA_DIR: dataDir,
      APP_URL: origin,
      SMTP_HOST: "127.0.0.1",
      SMTP_PORT: "9",
      SMTP_FROM: "Flowplan <flowplan@example.test>",
      FLOWPLAN_UNCONFIRMED_CHECK_MS: "2000",
    },
    stdio: "ignore",
  });
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${origin}/api/health`)).ok) return;
    } catch {}
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error("The server with e-mail did not start.");
});
test.afterAll(async () => {
  if (!server) return;
  const stopped = new Promise((done) => server!.once("exit", done));
  server.kill("SIGTERM");
  await stopped;
});

test("an administrator marks unconfirmed accounts; confirming keeps one, the other is deleted on its day", async ({ browser }, info) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "FLOWPLAN_DATA_DIR of the test server is required.");
  test.skip(info.project.name !== "desktop", "Once is enough.");
  test.setTimeout(180_000);
  const storageState = { cookies: [], origins: [{ origin, localStorage: [{ name: "flowplan-offline-offer", value: "never" }] }] };
  const adminContext = await browser.newContext({ locale: "de-DE", storageState });
  const personContext = await browser.newContext({ locale: "de-DE", storageState });
  const errors: string[] = [];
  try {
    const admin = account("Admin Vormerken", true, ["flowplan-admins"]);
    const stamp = Date.now().toString(36);
    const rita = account(`Rita Echt ${stamp}`, false);
    const sam = account(`Sam Spam ${stamp}`, false);
    const fine = account(`Fritz Fein ${stamp}`, true);
    await signIn(adminContext, admin.token);
    await signIn(personContext, rita.token);

    const page = await adminContext.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${origin}/#settings/instance/users`);
    await page.getByRole("button", { name: /^E-Mail unbestätigt/ }).click();
    await page.getByRole("searchbox", { name: "Benutzer suchen" }).fill(stamp);
    await expect(page.locator(".user-row", { hasText: rita.name })).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".user-row", { hasText: sam.name })).toBeVisible();
    await expect(page.locator(".user-row", { hasText: fine.name })).toHaveCount(0);

    // One account from its menu.
    await page.getByRole("button", { name: `Aktionen für ${rita.name}` }).click();
    await page.getByRole("menuitem", { name: "Zur Löschung vormerken …" }).click();
    let dialog = page.getByRole("dialog", { name: `${rita.name} zur Löschung vormerken` });
    await expect(dialog).toContainText("1 Konto mit unbestätigter Adresse wird am");
    await expect(dialog).toContainText("Anmelden allein verhindert die Löschung nicht");
    await dialog.getByRole("button", { name: "Zur Löschung vormerken" }).click();
    await expect(dialog).toBeHidden();
    const ritaRow = page.locator(".user-row", { hasText: rita.name });
    await expect(ritaRow).toContainText("Löschung am");
    expect(linkFor(rita.email)).toMatch(/\/api\/auth\/verify\?token=/);

    // The rest of the filter at once: only Sam is left to mark.
    await page.getByRole("button", { name: "Alle gefilterten zur Löschung vormerken …" }).click();
    dialog = page.getByRole("dialog", { name: `${sam.name} zur Löschung vormerken` });
    await expect(dialog).toContainText("1 Konto mit unbestätigter Adresse");
    await dialog.getByRole("button", { name: "Zur Löschung vormerken" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator(".user-row", { hasText: sam.name })).toContainText("Löschung am");

    // Rita, signed in: the notice; signing in does not keep the account.
    const own = await personContext.newPage();
    own.on("pageerror", (e) => errors.push(e.message));
    await own.goto(origin);
    const notice = own.locator(".unconfirmed-deletion-banner");
    await expect(notice).toContainText("Dein Konto wird am", { timeout: 30_000 });
    await expect(notice).toContainText("bestätige jetzt deine Adresse");
    await notice.getByRole("button", { name: "Bestätigungslink erneut senden" }).click();
    await expect(notice).toContainText(`Ein neuer Link ist an ${rita.email} unterwegs`);
    // The link from the e-mail, in this browser: confirmed, still signed in.
    await own.goto(linkFor(rita.email).replace(/^https?:\/\/[^/]+/, origin));
    await expect(own.locator(".workspace-switch").first()).toBeVisible({ timeout: 30_000 });
    await expect(own.locator(".unconfirmed-deletion-banner")).toHaveCount(0);
    expect(withDb((db) => db.prepare("SELECT email_verified FROM local_accounts WHERE user_id=?").get(rita.uid) as { email_verified: number }).email_verified).toBe(1);

    // The clock moves on: Sam's day has come, the job deletes the account.
    withDb((db) => db.prepare("UPDATE unconfirmed_deletions SET due_at=? WHERE user_id=?").run(Date.now() - 1000, sam.uid));
    await expect
      .poll(() => withDb((db) => (db.prepare("SELECT subject FROM users WHERE id=?").get(sam.uid) as { subject?: string } | undefined)?.subject ?? "gone"), { timeout: 30_000 })
      .toMatch(/^(deleted:|gone)/);
    // Rita stays and is no longer marked.
    await page.reload();
    await page.getByRole("searchbox", { name: "Benutzer suchen" }).fill(stamp);
    await expect(page.locator(".user-row", { hasText: rita.name })).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".user-row", { hasText: rita.name })).not.toContainText("Löschung am");
    await expect(page.locator(".user-row", { hasText: sam.name })).toHaveCount(0);
    // Every step in the activity log.
    const actions = withDb((db) => (db.prepare("SELECT action FROM audit WHERE resource_id IN (?,?)").all(rita.uid, sam.uid) as { action: string }[]).map((a) => a.action));
    expect(actions).toEqual(expect.arrayContaining(["admin.markUnconfirmed", "user.unconfirmedConfirmed", "user.unconfirmedDeleted"]));
    expect(errors).toEqual([]);
  } finally {
    await adminContext.close();
    await personContext.close();
  }
});
