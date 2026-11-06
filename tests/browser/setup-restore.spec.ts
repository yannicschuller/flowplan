import { test, expect } from "@playwright/test";
import { createCipheriv, createHash, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// "Restore from a backup" on the setup screen of a new instance (#128): an
// encrypted scheduled backup is uploaded, the key is asked for, and the
// account of the backup signs in. Needs a fresh test server (no account
// yet): the restore replaces its database, so it skips on a used one.
test("a new instance restores an encrypted backup on the setup screen", async ({ browser }, info) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "Needs the test server data directory.");
  test.skip(info.project.name !== "desktop", "Restores are instance-wide.");
  const live = join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite");
  const check = new DatabaseSync(live, { readOnly: true });
  const used = check.prepare("SELECT 1 FROM users WHERE demo_until IS NULL AND subject<>'local-development' LIMIT 1").get();
  check.close();
  test.skip(!!used, "Needs a fresh instance without accounts.");

  // The backup: a copy of this instance's (empty) database with one account.
  const work = mkdtempSync(join(tmpdir(), "flowplan-setup-restore-e2e-"));
  const plain = join(work, "plain.sqlite");
  const source = new DatabaseSync(live);
  source.exec(`PRAGMA busy_timeout=5000; VACUUM INTO '${plain.replaceAll("'", "''")}'`);
  source.close();
  const uid = randomUUID(),
    email = `restored-${Date.now()}@example.test`,
    password = "aus-der-sicherung-1";
  const salt = randomBytes(16);
  const hash = `scrypt$32768$8$1$${salt.toString("base64url")}$${scryptSync(password, salt, 64, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString("base64url")}`;
  const db = new DatabaseSync(plain);
  db.prepare("INSERT INTO users(id,subject,name,email,onboarded_at) VALUES(?,?,?,?,?)").run(uid, `local:${uid}`, "Aus der Sicherung", email, Date.now());
  db.prepare("INSERT INTO local_accounts(user_id,email,password_hash,is_admin,email_verified,created_at) VALUES(?,?,?,1,1,?)").run(uid, email, hash, Date.now());
  db.close();
  // Encrypted like a scheduled backup with FLOWPLAN_ENCRYPTION_KEY (lib/encryption.ts, "FPE1").
  const secret = randomBytes(32);
  const keyId = createHash("sha256").update("flowplan-encryption-key-id\0").update(secret).digest().subarray(0, 8);
  const head = Buffer.concat([Buffer.from("FPE1"), keyId, randomBytes(12)]);
  const cipher = createCipheriv("aes-256-gcm", secret, head.subarray(12));
  cipher.setAAD(head.subarray(0, 12));
  const file = join(work, "flowplan-2026-11-06-03-00.sqlite.enc");
  writeFileSync(file, Buffer.concat([head, cipher.update(readFileSync(plain)), cipher.final(), cipher.getAuthTag()]));

  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.goto("/register");
    await page.getByRole("button", { name: "Aus Sicherung wiederherstellen" }).click();
    await expect(page.getByRole("heading", { name: /Aus einer Sicherung/ })).toBeVisible();
    // Without the key: the page asks for it.
    await page.getByLabel("Sicherung hochladen").setInputFiles(file);
    await expect(page.locator(".setup-restore [role=alert]")).toContainText("verschlüsselt");
    const key = page.getByLabel("Schlüssel der Sicherung");
    await expect(key).toBeFocused();
    await key.fill(secret.toString("base64"));
    await page.getByLabel("Sicherung hochladen").setInputFiles(file);
    await expect(page.getByText("Wiederhergestellt.")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".setup-restore[role=status]")).toContainText("1 Konten");
    // The key was entered, not configured: a hint to set it.
    await expect(page.getByText(/als FLOWPLAN_ENCRYPTION_KEY ein, damit neue Sicherungen/)).toBeVisible();
    await page.getByRole("link", { name: "Mit einem Konto der Sicherung anmelden" }).click();
    // The setup is closed now: the page signs in.
    await expect(page.getByRole("button", { name: "Aus Sicherung wiederherstellen" })).toHaveCount(0);
    await page.waitForLoadState("networkidle");
    await page.getByLabel("E-Mail-Adresse").fill(email);
    await page.locator("input[name=password]").fill(password);
    // The password of the restored account signs in (the app itself then
    // loads as after any sign-in).
    const signedIn = page.waitForResponse((r) => r.url().includes("/api/auth/password") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Anmelden", exact: true }).click();
    expect((await signedIn).status()).toBe(200);
    // And the endpoint refuses from now on.
    const refused = await page.request.get("/api/setup/restore");
    expect(refused.status()).toBe(403);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    rmSync(work, { recursive: true, force: true });
  }
});
