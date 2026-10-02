import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-local-auth-"));
process.env.APP_URL = "https://flowplan.example.test";
const { one, run, id } = await import("../lib/db");
const auth = await import("../lib/local-auth");
const mail = await import("../lib/mail");
const { saveInstanceSettings, instanceSettings } = await import("../lib/instance-settings");
const { adminGroup } = await import("../lib/auth");

const sent: { to: string; subject: string; text: string }[] = [];
mail.setMailSender(async (m) => void sent.push(m));
const linkIn = (text: string) => text.match(/https:\/\/\S+/)![0];

test("passwords are hashed with scrypt and checked in constant time", async () => {
  const stored = await auth.hashPassword("korrekt-pferd-batterie");
  assert.match(stored, /^scrypt\$32768\$8\$1\$/);
  assert.ok(!stored.includes("korrekt"));
  assert.equal(await auth.verifyPassword("korrekt-pferd-batterie", stored), true);
  assert.equal(await auth.verifyPassword("falsch-pferd-batterie", stored), false);
  assert.equal(await auth.verifyPassword("x", "kaputt"), false);
});

test("the first account sets the instance up and administers it", async () => {
  assert.equal(auth.firstAccount(), true);
  assert.equal(auth.signupOpen(), true);
  await assert.rejects(auth.register({ name: "Ana", email: "ana@example.test", password: "kurz" }, "de"), /mindestens 10 Zeichen/);
  const { user, groups } = await auth.register({ name: "Ana", email: "Ana@Example.test", password: "ein-langes-passwort" }, "de");
  assert.deepEqual(groups, [adminGroup()]);
  assert.equal(user.email, "ana@example.test");
  assert.deepEqual(auth.localGroups(user.id), [adminGroup()]);
  assert.equal(auth.firstAccount(), false);
  // Sign-ups are now closed until the administration opens them.
  assert.equal(auth.signupOpen(), false);
  await assert.rejects(auth.register({ name: "Ben", email: "ben@example.test", password: "ein-langes-passwort" }, "en"), /Only administrators/);
});

test("signing in with e-mail and password; failed attempts are limited", async () => {
  const ok = await auth.passwordLogin({ email: "ANA@example.test", password: "ein-langes-passwort" }, "10.0.0.1", "de");
  assert.deepEqual(ok.groups, [adminGroup()]);
  await assert.rejects(auth.passwordLogin({ email: "ana@example.test", password: "falsch" }, "10.0.0.1", "de"), /stimmt nicht/);
  // Unknown addresses get the same answer.
  await assert.rejects(auth.passwordLogin({ email: "niemand@example.test", password: "egal-egal-egal" }, "10.0.0.2", "en"), /is wrong/);
  for (let i = 0; i < 8; i++)
    await auth.passwordLogin({ email: "ziel@example.test", password: `versuch-${i}` }, `10.0.1.${i}`, "de").catch(() => {});
  await assert.rejects(auth.passwordLogin({ email: "ziel@example.test", password: "noch-einer" }, "10.0.2.1", "de"), /Zu viele Versuche/);
  // A disabled account cannot sign in.
  const uid = one<{ user_id: string }>("SELECT user_id FROM local_accounts WHERE email='ana@example.test'")!.user_id;
  run("UPDATE users SET disabled=1 WHERE id=?", uid);
  await assert.rejects(auth.passwordLogin({ email: "ana@example.test", password: "ein-langes-passwort" }, "10.0.3.1", "de"), /deaktiviert/);
  run("UPDATE users SET disabled=0 WHERE id=?", uid);
});

test("open sign-ups, confirmation by e-mail accepts invitations", async () => {
  process.env.SMTP_HOST = "smtp.example.test";
  process.env.SMTP_FROM = "Flowplan <flowplan@example.test>";
  // An invited address may create its account even with sign-ups closed.
  const ana = one<{ user_id: string }>("SELECT user_id FROM local_accounts WHERE email='ana@example.test'")!.user_id;
  const wid = id();
  run("INSERT INTO workspaces(id,name,created_by) VALUES(?,?,?)", wid, "Team", ana);
  run("INSERT INTO invites(id,workspace_id,email,role,created_by,guest) VALUES(?,?,?,?,?,0)", id(), wid, "cem@example.test", "editor", ana);
  const { user, groups } = await auth.register({ name: "Cem", email: "cem@example.test", password: "ein-langes-passwort" }, "de");
  assert.deepEqual(groups, []);
  // Not a member before the address is confirmed.
  assert.equal(one("SELECT 1 FROM members WHERE user_id=?", user.id), undefined);
  await mail.flushMailQueue();
  const confirm = sent.find((m) => m.to === "cem@example.test")!;
  assert.match(confirm.subject, /bestätigen/);
  const token = new URL(linkIn(confirm.text)).searchParams.get("token")!;
  assert.equal(auth.verifyEmail("falsch"), false);
  assert.equal(auth.verifyEmail(token), true);
  assert.equal(auth.verifyEmail(token), false, "used once");
  assert.ok(one("SELECT 1 FROM members WHERE user_id=? AND workspace_id=?", user.id, wid));
  // With sign-ups open, anyone may register; a second account per address not.
  saveInstanceSettings({ ...instanceSettings(), allowSignup: true });
  assert.equal(auth.signupOpen(), true);
  await auth.register({ name: "Dana", email: "dana@example.test", password: "ein-langes-passwort" }, "de");
  await assert.rejects(auth.register({ name: "Dana 2", email: "DANA@example.test", password: "ein-langes-passwort" }, "de"), /schon ein Konto/);
});

test("password reset by e-mail and by an administrator's link", async () => {
  sent.length = 0;
  auth.requestPasswordReset({ email: "dana@example.test" }, "de");
  auth.requestPasswordReset({ email: "unbekannt@example.test" }, "de");
  await mail.flushMailQueue();
  const resets = sent.filter((m) => /zurücksetzen/.test(m.subject));
  assert.deepEqual(resets.map((m) => m.to), ["dana@example.test"], "only existing accounts get a mail");
  const link = linkIn(resets[0].text);
  assert.match(link, /^https:\/\/flowplan\.example\.test\/reset\?token=/);
  const token = new URL(link).searchParams.get("token")!;
  const dana = one<{ user_id: string }>("SELECT user_id FROM local_accounts WHERE email='dana@example.test'")!.user_id;
  run("INSERT INTO sessions VALUES(?,?,?,?)", "s-dana", dana, "[]", Date.now() + 60_000);
  await assert.rejects(auth.resetPassword({ token, password: "kurz" }, "de"), /mindestens/);
  await auth.resetPassword({ token, password: "ganz-neues-passwort" }, "de");
  assert.equal(one("SELECT 1 FROM sessions WHERE user_id=?", dana), undefined, "signed out everywhere");
  await assert.rejects(auth.resetPassword({ token, password: "noch-ein-passwort" }, "de"), /abgelaufen/);
  await auth.passwordLogin({ email: "dana@example.test", password: "ganz-neues-passwort" }, "10.0.4.1", "de");
  const adminLink = new URL(auth.adminResetLink(dana));
  await auth.resetPassword({ token: adminLink.searchParams.get("token")!, password: "drittes-passwort-1" }, "de");
  await auth.changePassword(dana, { current: "drittes-passwort-1", next: "viertes-passwort-1" }, "de");
  await assert.rejects(auth.changePassword(dana, { current: "falsch", next: "fuenftes-passwort" }, "de"), /stimmt nicht/);
});

test("administrators give and take the admin right; one always remains", () => {
  const ana = one<{ user_id: string }>("SELECT user_id FROM local_accounts WHERE email='ana@example.test'")!.user_id;
  const cem = one<{ user_id: string }>("SELECT user_id FROM local_accounts WHERE email='cem@example.test'")!.user_id;
  assert.throws(() => auth.setLocalAdmin(ana, false), /mindestens eine Person/);
  auth.setLocalAdmin(cem, true);
  assert.deepEqual(auth.localGroups(cem), [adminGroup()]);
  auth.setLocalAdmin(ana, false);
  assert.deepEqual(auth.localGroups(ana), []);
  assert.equal(auth.localAccountInfo()[cem].admin, true);
});

test("passkeys: options for local accounts, unknown passkeys are refused", async () => {
  const cem = one<{ user_id: string; email: string }>("SELECT user_id,email FROM local_accounts WHERE email='cem@example.test'")!;
  const user = { id: cem.user_id, name: "Cem", email: cem.email, disabled: 0, created_at: "" };
  const { options, token } = await auth.passkeyRegistrationOptions(user, "de");
  assert.equal(options.rp.id, "flowplan.example.test");
  assert.equal(options.authenticatorSelection?.residentKey, "required");
  assert.ok(token.length > 20);
  // A forged registration is not stored.
  await assert.rejects(auth.finishPasskeyRegistration(user, token, { response: { id: "x", rawId: "x", type: "public-key", response: {} } }, "de"), /nicht geprüft/);
  await assert.rejects(auth.finishPasskeyRegistration(user, token, { response: {} }, "de"), /abgelaufen/, "challenge used once");
  const login = await auth.passkeyLoginOptions();
  await assert.rejects(auth.passkeyLogin(login.token, { id: "unbekannt", rawId: "unbekannt", type: "public-key", response: {} }, "10.0.5.1", "en"), /not known/);
  // SSO accounts manage their sign-in with their provider.
  const sso = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", sso, "https://id.example|1", "Sso", "sso@example.test");
  await assert.rejects(auth.passkeyRegistrationOptions({ id: sso, name: "Sso", email: "sso@example.test", disabled: 0, created_at: "" }, "de"), /SSO/);
  assert.deepEqual(auth.listPasskeys(cem.user_id), []);
});

test("FLOWPLAN_LOCAL_LOGIN=false leaves only single sign-on", async () => {
  process.env.FLOWPLAN_LOCAL_LOGIN = "false";
  assert.equal(auth.loginOptions().localLogin, false);
  assert.equal(auth.signupOpen(), false);
  await assert.rejects(auth.passwordLogin({ email: "ana@example.test", password: "ein-langes-passwort" }, "10.0.6.1", "de"), /ausgeschaltet/);
  delete process.env.FLOWPLAN_LOCAL_LOGIN;
});
