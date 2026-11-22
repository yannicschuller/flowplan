import { test, expect, type Page } from "@playwright/test";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

// Administration → Benutzer → "Konto anlegen" (#433) on an instance without
// e-mail (the browser specs' server sends none): the administrator creates
// the account with a workspace, copies the link, and the person opens it in
// a browser of their own, sets the password and lands in that workspace.
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const database = () => {
  const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  db.exec("PRAGMA busy_timeout=5000;");
  return db;
};
// A signed-in administrator (the SSO admin group) in `page`'s context.
async function signedInAdmin(page: Page) {
  const db = database();
  const uid = randomUUID(),
    token = randomBytes(32).toString("hex");
  try {
    db.prepare("INSERT INTO users(id,subject,name,email,email_verified,onboarded_at) VALUES(?,?,?,?,1,?)").run(uid, `local:${uid}`, "Admin Anlegen", `${uid.slice(0, 8)}@example.test`, Date.now());
    db.prepare("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)").run(sha(token), uid, JSON.stringify(["flowplan-admins"]), Date.now() + 600000);
  } finally {
    db.close();
  }
  await page.context().addCookies([{ name: "flowplan_session", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
}

test("an administrator creates an account, hands over the link, and the person sets a password and lands in the workspace", async ({ browser }, info) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "FLOWPLAN_DATA_DIR of the test server is required.");
  test.skip(info.project.name !== "desktop", "Once is enough.");
  test.setTimeout(120_000);
  const admin = await browser.newContext({ locale: "de-DE", permissions: ["clipboard-read", "clipboard-write"] });
  const person = await browser.newContext({ locale: "de-DE" });
  const errors: string[] = [];
  try {
    const page = await admin.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await signedInAdmin(page);
    const stamp = Date.now().toString(36);
    const name = `Rosa Neu ${stamp}`;
    const email = `rosa-${stamp}@example.test`;
    await page.goto(`${origin}/#admin/users`);
    await page.getByRole("button", { name: "Konto anlegen" }).click();
    const dialog = page.getByRole("dialog", { name: "Konto anlegen" });
    await expect(dialog).toContainText("Diese Instanz versendet keine E-Mails");
    await dialog.getByLabel("Name", { exact: true }).fill(name);
    await dialog.getByLabel("E-Mail-Adresse").fill(email);
    await expect(dialog.getByLabel("Rolle")).toHaveValue("member");
    await expect(dialog.getByLabel("Auch einen Arbeitsbereich für die Person anlegen")).toBeChecked();
    // Prefilled from the first name.
    const workspace = dialog.getByLabel("Name des Arbeitsbereichs");
    await expect(workspace).toHaveValue("Rosas Arbeitsbereich");
    await workspace.fill(`Rosas Ecke ${stamp}`);
    await dialog.getByRole("button", { name: "Konto anlegen" }).click();
    const field = dialog.getByLabel("Link zum Festlegen des Passworts");
    await expect(field).toHaveValue(/\/welcome\?token=/);
    await expect(dialog).toContainText("7 Tage");
    await dialog.getByRole("button", { name: "Link kopieren" }).click();
    const link = await page.evaluate(() => navigator.clipboard.readText());
    expect(link).toBe(await field.inputValue());
    await dialog.getByRole("button", { name: "Fertig" }).click();
    await expect(dialog).toBeHidden();
    // In the list right away, as invited.
    await page.getByRole("searchbox", { name: "Benutzer suchen" }).fill(name);
    const row = page.locator(".user-row", { hasText: name });
    await expect(row).toContainText("Eingeladen");
    // The same address once more is refused.
    await page.getByRole("button", { name: "Konto anlegen" }).click();
    await dialog.getByLabel("Name", { exact: true }).fill("Doppelt");
    await dialog.getByLabel("E-Mail-Adresse").fill(email.toUpperCase());
    await dialog.getByRole("button", { name: "Konto anlegen" }).click();
    await expect(dialog.getByRole("alert")).toContainText("gibt es schon ein Konto");
    await dialog.getByRole("button", { name: "Abbrechen" }).click();

    // The person, in a browser of their own.
    const own = await person.newPage();
    own.on("pageerror", (e) => errors.push(e.message));
    await own.goto(link.replace(/^https?:\/\/[^/]+/, origin));
    await expect(own.getByRole("heading", { name: "Willkommen – Passwort festlegen" })).toBeVisible();
    await expect(own.locator(".login-card")).toContainText(email);
    await own.locator("input[name=password]").fill("rosas-langes-passwort");
    await own.locator("input[name=repeat]").fill("rosas-langes-passwort");
    await own.getByRole("button", { name: "Passwort festlegen und anmelden" }).click();
    await expect(own.locator(".workspace-switch").first()).toContainText(`Rosas Ecke ${stamp}`, { timeout: 30_000 });
    // The link worked once.
    await own.goto(link.replace(/^https?:\/\/[^/]+/, origin));
    await expect(own.getByRole("heading", { name: "Link abgelaufen" })).toBeVisible();

    // Signed in now: no longer invited.
    await page.reload();
    await page.getByRole("searchbox", { name: "Benutzer suchen" }).fill(name);
    await expect(page.locator(".user-row", { hasText: name })).toBeVisible();
    await expect(page.locator(".user-row", { hasText: name })).not.toContainText("Eingeladen");
    expect(errors).toEqual([]);
  } finally {
    await admin.close();
    await person.close();
  }
});
