import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
const dataDir = mkdtempSync(join(tmpdir(), "flowplan-two-factor-"));
process.env.FLOWPLAN_DATA_DIR = dataDir;
process.env.APP_URL = "https://flowplan.example.test";
delete process.env.FLOWPLAN_ENCRYPTION_KEY;
delete process.env.FLOWPLAN_SECRETS_KEY;
const { one, run, all } = await import("../lib/db");
const auth = await import("../lib/local-auth");
const { hash, identityFromToken, adminGroup } = await import("../lib/auth");
const totp = await import("../lib/totp");
const box = await import("../lib/secret-box");
const tf = await import("../lib/two-factor");
const policy = await import("../lib/two-factor-policy");
const { saveInstanceSettings } = await import("../lib/instance-settings");
const { command } = await import("../lib/api");

saveInstanceSettings({ allowSignup: true });
const T0 = Date.UTC(2026, 9, 19, 12, 0, 0);
const STEP = 30_000;
async function account(name: string) {
  const { user } = await auth.register({ name, email: `${name}@example.test`, password: `${name}-passwort-123` }, "de");
  return user;
}
const identity = (userId: string, isAdmin = false): Identity => {
  const u = one<{ name: string; email: string }>("SELECT name,email FROM users WHERE id=?", userId)!;
  return { id: userId, name: u.name, email: u.email, groups: isAdmin ? [adminGroup()] : [], isAdmin, disabled: 0, created_at: "" };
};
// Sets up the app for an account and returns its secret and recovery codes.
function enable(userId: string, now = T0) {
  const setup = tf.startTotpSetup({ id: userId }, "de");
  const { recoveryCodes } = tf.confirmTotpSetup(userId, { code: totp.totpCode(setup.secret, now) }, "de", now);
  return { secret: setup.secret, recoveryCodes, uri: setup.uri };
}
const signIn = async (name: string, address: string) => {
  const { userId } = await auth.passwordLogin({ email: `${name}@example.test`, password: `${name}-passwort-123` }, address, "de");
  return tf.afterPassword(userId, false, "de");
};

test("TOTP codes follow RFC 6238, accept one step either side and never count twice", () => {
  // The RFC's test secret ("12345678901234567890"), last six digits.
  const secret = totp.base32Encode(Buffer.from("12345678901234567890"));
  assert.equal(secret, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  assert.equal(totp.totpCode(secret, 59_000), "287082");
  assert.equal(totp.totpCode(secret, 1111111109_000), "081804");
  assert.equal(totp.totpCode(secret, 1234567890_000), "005924");
  assert.deepEqual(totp.base32Decode(secret), Buffer.from("12345678901234567890"));
  const step = totp.timeStep(T0);
  assert.equal(totp.matchTotp(secret, totp.totpCode(secret, T0), T0), step);
  assert.equal(totp.matchTotp(secret, totp.totpCode(secret, T0 - STEP), T0), step - 1);
  assert.equal(totp.matchTotp(secret, totp.totpCode(secret, T0 + STEP), T0), step + 1);
  assert.equal(totp.matchTotp(secret, totp.totpCode(secret, T0 - 2 * STEP), T0), null, "two steps back is too old");
  assert.equal(totp.matchTotp(secret, totp.totpCode(secret, T0 + 2 * STEP), T0), null);
  // A step that was used already does not count again.
  assert.equal(totp.matchTotp(secret, totp.totpCode(secret, T0), T0, step), null);
  assert.equal(totp.matchTotp(secret, "12345", T0), null);
  assert.equal(totp.matchTotp(secret, "abcdef", T0), null);
  assert.match(totp.otpauthUri(secret, "ana@example.test", "Flowplan"), /^otpauth:\/\/totp\/Flowplan:ana%40example\.test\?secret=GEZ/);
});

test("secrets are sealed with a key file of their own and bound to their place", () => {
  const sealed = box.sealSecret("JBSWY3DPEHPK3PXP", "totp:a");
  assert.ok(!sealed.includes("JBSWY3DPEHPK3PXP"));
  assert.equal(box.openSecret(sealed, "totp:a"), "JBSWY3DPEHPK3PXP");
  assert.throws(() => box.openSecret(sealed, "totp:b"), "another account's row does not open it");
  assert.equal(statSync(join(dataDir, "secrets.key")).mode & 0o777, 0o600);
  // With FLOWPLAN_SECRETS_KEY set, older values stay readable through the key file.
  process.env.FLOWPLAN_SECRETS_KEY = Buffer.alloc(32, 7).toString("base64");
  let newer = "";
  try {
    assert.equal(box.openSecret(sealed, "totp:a"), "JBSWY3DPEHPK3PXP");
    newer = box.sealSecret("x", "y");
    assert.equal(box.openSecret(newer, "y"), "x");
  } finally {
    delete process.env.FLOWPLAN_SECRETS_KEY;
  }
  // The newer value was sealed with FLOWPLAN_SECRETS_KEY, not the key file.
  assert.throws(() => box.openSecret(newer, "y"));
  const signature = box.signValue("test", "data");
  assert.equal(box.validSignature("test", "data", signature), true);
  assert.equal(box.validSignature("test", "datA", signature), false);
  assert.equal(box.validSignature("other", "data", signature), false);
});

test("setting up: QR code, confirmation with a code, recovery codes shown once and stored hashed", async () => {
  const ana = await account("ana");
  assert.equal(policy.totpEnabled(ana.id), false);
  const setup = tf.startTotpSetup({ id: ana.id }, "de");
  assert.match(setup.uri, /^otpauth:\/\/totp\/Flowplan:ana%40example\.test\?secret=/);
  assert.ok(setup.qr.size >= 21 && setup.qr.path.startsWith("M"));
  const stored = one<{ secret: string; enabled: number }>("SELECT secret,enabled FROM user_totp WHERE user_id=?", ana.id)!;
  assert.equal(stored.enabled, 0);
  assert.ok(!stored.secret.includes(setup.secret), "the secret is encrypted at rest");
  assert.throws(() => tf.confirmTotpSetup(ana.id, { code: "000000" }, "de", T0), /stimmt nicht/);
  const { recoveryCodes } = tf.confirmTotpSetup(ana.id, { code: totp.totpCode(setup.secret, T0) }, "de", T0);
  assert.equal(recoveryCodes.length, 10);
  assert.equal(new Set(recoveryCodes).size, 10);
  assert.ok(recoveryCodes.every((c) => /^[a-z2-9]{5}-[a-z2-9]{5}$/.test(c)));
  const hashes = all<{ code_hash: string }>("SELECT code_hash FROM recovery_codes WHERE user_id=?", ana.id);
  assert.equal(hashes.length, 10);
  assert.ok(hashes.every((h) => !recoveryCodes.includes(h.code_hash)));
  assert.equal(policy.totpEnabled(ana.id), true);
  assert.deepEqual(tf.twoFactorStatus(ana.id), { enabled: true, recoveryLeft: 10, passkey: false, required: false });
  assert.throws(() => tf.startTotpSetup({ id: ana.id }, "de"), /schon eingerichtet/);
});

test("signing in needs the second step; codes and recovery codes count once", async () => {
  const ben = await account("ben");
  const { secret, recoveryCodes } = enable(ben.id);
  const first = await signIn("ben", "10.1.0.1");
  assert.ok("pending" in first, "the password alone is not a session");
  const pending = (first as { pending: string }).pending;
  assert.throws(() => tf.completeSignIn(pending, { code: "000000" }, "10.1.0.1", "de", T0 + STEP), /stimmt nicht/);
  const later = T0 + 2 * STEP;
  const done = tf.completeSignIn(pending, { code: totp.totpCode(secret, later) }, "10.1.0.1", "de", later);
  assert.equal(done.userId, ben.id);
  assert.equal(done.remember, false);
  // The same code (same window) does not work twice, not even with a new token.
  assert.throws(() => tf.completeSignIn(tf.pendingToken(ben.id, false, later), { code: totp.totpCode(secret, later) }, "10.1.0.1", "de", later), /schon benutzt/);
  // An older code inside the window is refused once a newer one was used.
  assert.throws(() => tf.completeSignIn(tf.pendingToken(ben.id, false, later), { code: totp.totpCode(secret, later - STEP) }, "10.1.0.1", "de", later), /schon benutzt/);
  const next = later + STEP;
  assert.equal(tf.completeSignIn(tf.pendingToken(ben.id, true, next), { code: totp.totpCode(secret, next) }, "10.1.0.1", "de", next).remember, true);
  // Recovery codes: each works once, with or without the dash and in any case.
  const code = recoveryCodes[3];
  tf.completeSignIn(tf.pendingToken(ben.id, false, next), { code: code.toUpperCase().replace("-", " ") }, "10.1.0.1", "de", next);
  assert.throws(() => tf.completeSignIn(tf.pendingToken(ben.id, false, next), { code }, "10.1.0.1", "de", next), /schon benutzt/);
  assert.equal(tf.twoFactorStatus(ben.id).recoveryLeft, 9);
  // Tampered, expired or foreign tokens are refused.
  const token = tf.pendingToken(ben.id, false, next);
  const parts = token.split(".");
  assert.throws(() => tf.completeSignIn([parts[0], parts[1], "1", parts[3], parts[4]].join("."), { code: recoveryCodes[0] }, "10.1.0.1", "de", next), /abgelaufen/);
  assert.throws(() => tf.completeSignIn(token, { code: recoveryCodes[0] }, "10.1.0.1", "de", next + 6 * 60_000), /abgelaufen/);
  assert.throws(() => tf.completeSignIn(undefined, { code: recoveryCodes[0] }, "10.1.0.1", "de", next), /abgelaufen/);
  // A new password ends tokens issued before it.
  await auth.changePassword(ben.id, { current: "ben-passwort-123", next: "ben-passwort-456" }, "de");
  assert.throws(() => tf.completeSignIn(token, { code: recoveryCodes[0] }, "10.1.0.1", "de", next), /abgelaufen/);
  await auth.changePassword(ben.id, { current: "ben-passwort-456", next: "ben-passwort-123" }, "de");
});

test("wrong codes are limited per account", async () => {
  const cleo = await account("cleo");
  const { secret } = enable(cleo.id);
  const now = T0 + 10 * STEP;
  for (let i = 0; i < 8; i++)
    assert.throws(() => tf.completeSignIn(tf.pendingToken(cleo.id, false, now), { code: String(100000 + i) }, `10.2.0.${i}`, "de", now), /stimmt nicht/);
  assert.throws(
    () => tf.completeSignIn(tf.pendingToken(cleo.id, false, now), { code: totp.totpCode(secret, now) }, "10.2.1.1", "de", now),
    /Zu viele Versuche/,
    "even the right code waits once the limit is reached",
  );
  run("DELETE FROM login_failures WHERE key=?", `totp:${cleo.id}`);
  assert.equal(tf.completeSignIn(tf.pendingToken(cleo.id, false, now), { code: totp.totpCode(secret, now) }, "10.2.1.1", "de", now).userId, cleo.id);
});

test("a password reset by e-mail link does not skip the second step", async () => {
  const dora = await account("dora");
  enable(dora.id);
  const link = new URL(auth.adminResetLink(dora.id));
  await auth.resetPassword({ token: link.searchParams.get("token")!, password: "dora-neues-passwort" }, "de");
  const { userId } = await auth.passwordLogin({ email: "dora@example.test", password: "dora-neues-passwort" }, "10.3.0.1", "de");
  const next = tf.afterPassword(userId, false, "de");
  assert.ok("pending" in next);
  assert.equal(policy.totpEnabled(dora.id), true, "the reset keeps the authenticator app");
});

test("turning it off and new recovery codes need the password or a code", async () => {
  const emil = await account("emil");
  // Set up a few minutes ago, so a code from now is a new one.
  const { secret } = enable(emil.id, Date.now() - 10 * STEP);
  await assert.rejects(tf.regenerateRecoveryCodes(emil.id, { password: "falsch" }, "10.4.0.1", "de"), /aktuelle Passwort/);
  const { recoveryCodes } = await tf.regenerateRecoveryCodes(emil.id, { password: "emil-passwort-123" }, "10.4.0.1", "de");
  assert.equal(recoveryCodes.length, 10);
  await assert.rejects(tf.disableTotp(emil.id, {}, "10.4.0.1", "de"), /aktuelle Passwort/);
  const now = Date.now();
  assert.equal(totp.matchTotp(secret, totp.totpCode(secret, now), now) !== null, true);
  const status = await tf.disableTotp(emil.id, { code: totp.totpCode(secret, now) }, "10.4.0.1", "de");
  assert.equal(status.enabled, false);
  assert.equal(one("SELECT 1 FROM recovery_codes WHERE user_id=?", emil.id), undefined);
  assert.ok("userId" in tf.afterPassword(emil.id, false, "de"));
});

test("required by the administration: setup right after signing in, passkeys count, admins may be the only ones", async () => {
  const fritz = await account("fritz");
  const admin = one<{ user_id: string }>("SELECT user_id FROM local_accounts WHERE is_admin=1")!.user_id;
  const session = (userId: string) => {
    const token = `session-${userId}-${Math.random()}`;
    run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", hash(token), userId, "[]", Date.now() + 60_000);
    return token;
  };
  const fritzSession = session(fritz.id);
  assert.equal(identityFromToken(fritzSession)?.twoFactorSetup, undefined);
  saveInstanceSettings({ twoFactor: "admins" });
  assert.equal(policy.needsTwoFactorSetup(fritz.id), false);
  assert.equal(policy.needsTwoFactorSetup(admin), !policy.totpEnabled(admin));
  saveInstanceSettings({ twoFactor: "all" });
  // Signed in with the password only: the session works for the setup alone.
  assert.ok("userId" in tf.afterPassword(fritz.id, false, "de"));
  assert.equal(identityFromToken(fritzSession)?.twoFactorSetup, true);
  const { secret } = enable(fritz.id);
  assert.equal(identityFromToken(fritzSession)?.twoFactorSetup, undefined);
  // Required and on: turning it off needs a passkey first.
  await assert.rejects(tf.disableTotp(fritz.id, { code: totp.totpCode(secret, Date.now()) }, "10.5.0.1", "de"), /vorgeschrieben/);
  // An account with a passkey (and no app) signs in with the passkey.
  const gina = await account("gina");
  run("INSERT INTO passkeys(id,user_id,public_key,created_at) VALUES(?,?,?,?)", `pk-${gina.id}`, gina.id, Buffer.from([1]), Date.now());
  assert.equal(policy.needsTwoFactorSetup(gina.id), false);
  assert.throws(() => tf.afterPassword(gina.id, false, "de"), /Passkey/);
  // SSO accounts and demos are not affected.
  run("INSERT INTO users(id,subject,name,email) VALUES('sso-user','https://idp|1','SSO','sso@example.test')");
  assert.equal(policy.needsTwoFactorSetup("sso-user"), false);
  saveInstanceSettings({ twoFactor: "off" });
  assert.equal(policy.needsTwoFactorSetup(gina.id), false);
});

test("administrators reset the app of an account (lost phone), noted and told by e-mail", async () => {
  const hanna = await account("hanna");
  enable(hanna.id);
  process.env.SMTP_HOST = "smtp.example.test";
  try {
    const admin = one<{ user_id: string }>("SELECT user_id FROM local_accounts WHERE is_admin=1")!.user_id;
    assert.equal(auth.localAccountInfo()[hanna.id].totp, true);
    assert.throws(() => command(identity(hanna.id), { action: "admin.twoFactorReset", userId: hanna.id }), (e: { status?: number }) => e.status === 403);
    command(identity(admin, true), { action: "admin.twoFactorReset", userId: hanna.id });
    assert.equal(policy.totpEnabled(hanna.id), false);
    assert.equal(one("SELECT 1 FROM recovery_codes WHERE user_id=?", hanna.id), undefined);
    assert.equal(auth.localAccountInfo()[hanna.id].totp, false);
    assert.ok(one("SELECT 1 FROM audit WHERE action='admin.twoFactorReset' AND actor_id=? AND resource_id=?", admin, hanna.id));
    assert.ok(one("SELECT 1 FROM mail_queue WHERE recipient='hanna@example.test' AND subject LIKE '%Zwei-Faktor%'"));
    // Signing in now goes without a code; the app can be set up again.
    assert.ok("userId" in (await signIn("hanna", "10.6.0.1")));
    enable(hanna.id, T0 + 100 * STEP);
    assert.equal(policy.totpEnabled(hanna.id), true);
  } finally {
    delete process.env.SMTP_HOST;
  }
});
