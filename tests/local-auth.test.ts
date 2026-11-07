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
const { adminGroup, acceptInviteToken } = await import("../lib/auth");

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
  assert.equal(await auth.firstAccount(), true);
  assert.equal(await auth.signupOpen(), true);
  await assert.rejects(auth.register({ name: "Ana", email: "ana@example.test", password: "kurz" }, "de"), /mindestens 10 Zeichen/);
  const { user, groups } = await auth.register({ name: "Ana", email: "Ana@Example.test", password: "ein-langes-passwort" }, "de");
  assert.deepEqual(groups, [adminGroup()]);
  assert.equal(user.email, "ana@example.test");
  assert.deepEqual(await auth.localGroups(user.id), [adminGroup()]);
  assert.equal(await auth.firstAccount(), false);
  // Sign-ups are now closed until the administration opens them.
  assert.equal(await auth.signupOpen(), false);
  await assert.rejects(auth.register({ name: "Ben", email: "ben@example.test", password: "ein-langes-passwort" }, "en"), /Only administrators/);
});

test("an invitation link offers creating the account while sign-ups are closed", async () => {
  const ana = (await one<{ user_id: string }>("SELECT user_id FROM local_accounts WHERE email='ana@example.test'"))!.user_id;
  const wid = id(),
    token = "einladung-eva-0123456789";
  await run("INSERT INTO workspaces(id,name,created_by) VALUES(?,?,?)", wid, "Eingeladen", ana);
  await run("INSERT INTO invites(id,workspace_id,email,role,created_by,guest,token) VALUES(?,?,?,?,?,0,?)", id(), wid, "eva@example.test", "editor", ana, token);
  // The sign-in page offers the account for the invited address.
  assert.equal(await auth.signupOpen(), false);
  assert.equal(await auth.signupOpen(undefined, token), true);
  assert.equal((await auth.loginOptions(undefined, token)).invitedEmail, "eva@example.test");
  // Unknown or malformed links change nothing.
  for (const other of ["einladung-unbekannt-0123", "kurz", "x".repeat(65)]) {
    assert.equal(await auth.signupOpen(undefined, other), false);
    assert.equal((await auth.loginOptions(undefined, other)).invitedEmail, "");
  }
  // Without password sign-in (SSO only) the link offers no account either.
  process.env.FLOWPLAN_LOCAL_LOGIN = "false";
  try {
    assert.equal(await auth.signupOpen(undefined, token), false);
    assert.equal((await auth.loginOptions(undefined, token)).invitedEmail, "");
  } finally {
    delete process.env.FLOWPLAN_LOCAL_LOGIN;
  }
  // The link creates an account only for the invited address (not one per
  // made-up address), and without e-mail the address alone is no proof.
  for (const email of ["mallory@example.test", "mallory2@example.test"])
    await assert.rejects(auth.register({ name: "Mallory", email, password: "ein-langes-passwort", invite: token }, "de"), /nur Admins/);
  await assert.rejects(auth.register({ name: "Eva?", email: "eva@example.test", password: "ein-langes-passwort" }, "de"), /nur Admins/);
  const { user } = await auth.register({ name: "Eva", email: "EVA@example.test", password: "ein-langes-passwort", invite: token }, "de");
  // Without e-mail the address is not confirmed: the link (app/page.tsx) takes the invitation over.
  assert.equal(await acceptInviteToken(user, token), wid);
  assert.ok(await one("SELECT 1 FROM members WHERE user_id=? AND workspace_id=?", user.id, wid));
  // A used link no longer opens sign-ups, and the server refuses it.
  assert.equal(await auth.signupOpen(undefined, token), false);
  assert.equal((await auth.loginOptions(undefined, token)).invitedEmail, "");
  await assert.rejects(
    auth.register({ name: "Fritz", email: "fritz@example.test", password: "ein-langes-passwort", invite: token }, "de"),
    /nur Admins/,
  );
});

test("signing in with e-mail and password; failed attempts are limited", async () => {
  const ok = await auth.passwordLogin({ email: "ANA@example.test", password: "ein-langes-passwort" }, "10.0.0.1", "de");
  assert.deepEqual(ok.groups, [adminGroup()]);
  await assert.rejects(auth.passwordLogin({ email: "ana@example.test", password: "falsch" }, "10.0.0.1", "de"), /stimmt nicht/);
  // Unknown addresses get the same answer.
  await assert.rejects(auth.passwordLogin({ email: "niemand@example.test", password: "egal-egal-egal" }, "10.0.0.2", "en"), /is wrong/);
  // 8 wrong passwords for one account from one address: that address waits,
  // the account's owner elsewhere does not (no lockout by a stranger).
  for (let i = 0; i < 8; i++)
    await auth.passwordLogin({ email: "ana@example.test", password: `versuch-${i}` }, "10.0.1.1", "de").catch(() => {});
  await assert.rejects(auth.passwordLogin({ email: "ana@example.test", password: "ein-langes-passwort" }, "10.0.1.1", "de"), /Zu viele Versuche/);
  assert.ok(await auth.passwordLogin({ email: "ana@example.test", password: "ein-langes-passwort" }, "10.0.2.1", "de"));
  // The success cleared the account's failures, also those of the other address.
  assert.ok(await auth.passwordLogin({ email: "ana@example.test", password: "ein-langes-passwort" }, "10.0.1.1", "de"));
  // Spread over many addresses, the account's ceiling still applies.
  const now = Date.now();
  for (let i = 0; i < auth.LIMITS.name; i++) await run("INSERT INTO login_failures(key,at) VALUES(?,?)", "email:ziel@example.test", now);
  await assert.rejects(auth.passwordLogin({ email: "ziel@example.test", password: "noch-einer" }, "10.0.2.9", "de"), /Zu viele Versuche/);
  await run("DELETE FROM login_failures WHERE key LIKE 'email:ziel@%'");
  // Without a proxy address (""), failures count per account only: 30 wrong
  // passwords for one address do not lock everyone else out.
  for (let i = 0; i < 31; i++)
    await auth.passwordLogin({ email: `fremd${i}@example.test`, password: "falsch-falsch" }, "", "de").catch(() => {});
  assert.ok(await auth.passwordLogin({ email: "ana@example.test", password: "ein-langes-passwort" }, "", "de"));
  assert.equal(await one("SELECT 1 FROM login_failures WHERE key='ip:'"), undefined, "no bucket for the unknown address");
  // A disabled account cannot sign in.
  const uid = (await one<{ user_id: string }>("SELECT user_id FROM local_accounts WHERE email='ana@example.test'"))!.user_id;
  await run("UPDATE users SET disabled=1 WHERE id=?", uid);
  await assert.rejects(auth.passwordLogin({ email: "ana@example.test", password: "ein-langes-passwort" }, "10.0.3.1", "de"), /deaktiviert/);
  await run("UPDATE users SET disabled=0 WHERE id=?", uid);
});

test("open sign-ups, confirmation by e-mail accepts invitations", async () => {
  process.env.SMTP_HOST = "smtp.example.test";
  process.env.SMTP_FROM = "Flowplan <flowplan@example.test>";
  // An invited address may create its account even with sign-ups closed.
  const ana = (await one<{ user_id: string }>("SELECT user_id FROM local_accounts WHERE email='ana@example.test'"))!.user_id;
  const wid = id();
  await run("INSERT INTO workspaces(id,name,created_by) VALUES(?,?,?)", wid, "Team", ana);
  await run("INSERT INTO invites(id,workspace_id,email,role,created_by,guest) VALUES(?,?,?,?,?,0)", id(), wid, "cem@example.test", "editor", ana);
  const { user, groups, pending } = await auth.register({ name: "Cem", email: "cem@example.test", password: "ein-langes-passwort" }, "de");
  assert.deepEqual(groups, []);
  // The instance sends e-mail: the account waits for the confirmation.
  assert.equal(pending, true);
  await assert.rejects(auth.passwordLogin({ email: "cem@example.test", password: "ein-langes-passwort" }, "10.0.3.9", "de"), /bestätige zuerst/);
  // Not a member before the address is confirmed.
  assert.equal(await one("SELECT 1 FROM members WHERE user_id=?", user.id), undefined);
  await mail.flushMailQueue();
  const confirm = sent.find((m) => m.to === "cem@example.test")!;
  assert.match(confirm.subject, /bestätigen/);
  const token = new URL(linkIn(confirm.text)).searchParams.get("token")!;
  assert.equal(await auth.verifyEmail("falsch"), null);
  assert.equal(await auth.verifyEmail(token), user.id);
  assert.equal(await auth.verifyEmail(token), null, "used once");
  assert.ok(await auth.passwordLogin({ email: "cem@example.test", password: "ein-langes-passwort" }, "10.0.3.9", "de"));
  assert.ok(await one("SELECT 1 FROM members WHERE user_id=? AND workspace_id=?", user.id, wid));
  // With sign-ups open, anyone may register; a second account per address not.
  await saveInstanceSettings({ ...(await instanceSettings()), allowSignup: true });
  assert.equal(await auth.signupOpen(), true);
  await auth.register({ name: "Dana", email: "dana@example.test", password: "ein-langes-passwort" }, "de");
  await assert.rejects(auth.register({ name: "Dana 2", email: "DANA@example.test", password: "ein-langes-passwort" }, "de"), /schon ein Konto/);
});

test("password reset by e-mail and by an administrator's link", async () => {
  sent.length = 0;
  await auth.requestPasswordReset({ email: "dana@example.test" }, "de");
  await auth.requestPasswordReset({ email: "unbekannt@example.test" }, "de");
  await mail.flushMailQueue();
  const resets = sent.filter((m) => /zurücksetzen/.test(m.subject));
  assert.deepEqual(resets.map((m) => m.to), ["dana@example.test"], "only existing accounts get a mail");
  const link = linkIn(resets[0].text);
  assert.match(link, /^https:\/\/flowplan\.example\.test\/reset\?token=/);
  const token = new URL(link).searchParams.get("token")!;
  const dana = (await one<{ user_id: string }>("SELECT user_id FROM local_accounts WHERE email='dana@example.test'"))!.user_id;
  await run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", "s-dana", dana, "[]", Date.now() + 60_000);
  await assert.rejects(auth.resetPassword({ token, password: "kurz" }, "de"), /mindestens/);
  await auth.resetPassword({ token, password: "ganz-neues-passwort" }, "de");
  assert.equal(await one("SELECT 1 FROM sessions WHERE user_id=?", dana), undefined, "signed out everywhere");
  await assert.rejects(auth.resetPassword({ token, password: "noch-ein-passwort" }, "de"), /abgelaufen/);
  await auth.passwordLogin({ email: "dana@example.test", password: "ganz-neues-passwort" }, "10.0.4.1", "de");
  const adminLink = new URL(await auth.adminResetLink(dana));
  await auth.resetPassword({ token: adminLink.searchParams.get("token")!, password: "drittes-passwort-1" }, "de");
  await auth.changePassword(dana, { current: "drittes-passwort-1", next: "viertes-passwort-1" }, "de");
  await assert.rejects(auth.changePassword(dana, { current: "falsch", next: "fuenftes-passwort" }, "de"), /stimmt nicht/);
});

test("administrators give and take the admin right; one always remains", async () => {
  const ana = (await one<{ user_id: string }>("SELECT user_id FROM local_accounts WHERE email='ana@example.test'"))!.user_id;
  const cem = (await one<{ user_id: string }>("SELECT user_id FROM local_accounts WHERE email='cem@example.test'"))!.user_id;
  await assert.rejects(async () => await auth.setLocalAdmin(ana, false), /mindestens eine Person/);
  await auth.setLocalAdmin(cem, true);
  assert.deepEqual(await auth.localGroups(cem), [adminGroup()]);
  await auth.setLocalAdmin(ana, false);
  assert.deepEqual(await auth.localGroups(ana), []);
  assert.equal((await auth.localAccountInfo())[cem].admin, true);
});

test("passkeys: options for local accounts, unknown passkeys are refused", async () => {
  const cem = (await one<{ user_id: string; email: string }>("SELECT user_id,email FROM local_accounts WHERE email='cem@example.test'"))!;
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
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", sso, "https://id.example|1", "Sso", "sso@example.test");
  await assert.rejects(auth.passkeyRegistrationOptions({ id: sso, name: "Sso", email: "sso@example.test", disabled: 0, created_at: "" }, "de"), /SSO/);
  assert.deepEqual(await auth.listPasskeys(cem.user_id), []);
});

test("FLOWPLAN_LOCAL_LOGIN=false leaves only single sign-on", async () => {
  process.env.FLOWPLAN_LOCAL_LOGIN = "false";
  assert.equal((await auth.loginOptions()).localLogin, false);
  assert.equal(await auth.signupOpen(), false);
  await assert.rejects(auth.passwordLogin({ email: "ana@example.test", password: "ein-langes-passwort" }, "10.0.6.1", "de"), /ausgeschaltet/);
  delete process.env.FLOWPLAN_LOCAL_LOGIN;
});

test("failed sign-ins: per account and address, a ceiling per account, a growing delay", async () => {
  await run("DELETE FROM login_failures");
  const keys = (address: string) => [...(address ? [`ip:${address}`] : []), "email:opfer@example.test"];
  for (let i = 0; i < auth.LIMITS.nameAddress; i++) await auth.failed(keys("10.9.0.1"));
  assert.equal(await auth.limited(keys("10.9.0.1")), true, "the attacking address waits");
  assert.equal(await auth.limited(keys("10.9.0.2")), false, "the owner elsewhere does not");
  // An unknown address (no proxy header) counts the account alone, strictly.
  assert.equal(await auth.limited(keys("")), true);
  // The delay grows with the account's failures from every address.
  assert.equal(await auth.failureDelay(keys("10.9.0.2")), 0);
  for (let i = 0; i < 6; i++) await auth.failed(keys(`10.9.1.${i}`));
  assert.equal(await auth.failureDelay(keys("10.9.0.2")), (14 - auth.LIMITS.slowFrom) * auth.LIMITS.slowStepMs);
  const now = Date.now();
  for (let i = 0; i < 200; i++) await run("INSERT INTO login_failures(key,at) VALUES(?,?)", "email:opfer@example.test", now);
  assert.equal(await auth.failureDelay(keys("10.9.0.2")), auth.LIMITS.slowMaxMs);
  assert.equal(await auth.limited(keys("10.9.0.2")), true, "the ceiling per account");
  // A success clears the account's failures from every address.
  await auth.clearFailures("email:opfer@example.test");
  assert.equal(await one("SELECT 1 FROM login_failures WHERE key LIKE 'email:opfer@%'"), undefined);
  assert.equal(await auth.limited(keys("10.9.0.1")), false);
  // Codes stay strict per account, whatever the address.
  for (let i = 0; i < auth.LIMITS.other; i++) await auth.failed([`ip:10.9.2.${i}`, "totp:someone"]);
  assert.equal(await auth.limited(["ip:10.9.3.1", "totp:someone"]), true);
  await run("DELETE FROM login_failures");
});
