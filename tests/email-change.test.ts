import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-email-change-"));
process.env.APP_URL = "https://flowplan.example.test";
const { one, all, run, id } = await import("../lib/db");
const auth = await import("../lib/local-auth");
const mail = await import("../lib/mail");
const change = await import("../lib/email-change");
const events = await import("../lib/security-events");
const { mySecurity } = await import("../lib/my-security");

// Changing the e-mail address of an account with e-mail and password (#405).
const sent: { to: string; subject: string; text: string }[] = [];
mail.setMailSender(async (m) => void sent.push(m));
const withMail = () => {
  process.env.SMTP_HOST = "smtp.example.test";
  process.env.SMTP_FROM = "Flowplan <flowplan@example.test>";
};
const withoutMail = () => delete process.env.SMTP_HOST;
const linkIn = (text: string) => text.match(/https:\/\/\S+/)![0];
const tokenIn = (m: { text: string }) => new URL(linkIn(m.text)).searchParams.get("token")!;
const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 20));
  await events.securityWritesSettled();
};
let addresses = 0;
// A fresh client address per request: the per-address limit is its own test.
const address = () => `10.9.0.${++addresses}`;

const account = async (name: string, email: string) => {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email,email_verified) VALUES(?,?,?,?,1)", uid, `local:${uid}`, name, email);
  await run(
    "INSERT INTO local_accounts(user_id,email,password_hash,is_admin,email_verified,verify_required,created_at) VALUES(?,?,?,0,1,0,?)",
    uid,
    email,
    await auth.hashPassword("ein-langes-passwort"),
    Date.now(),
  );
  return uid;
};
const emailOf = async (uid: string) => ({
  user: (await one<{ email: string }>("SELECT email FROM users WHERE id=?", uid))!.email,
  local: (await one<{ email: string }>("SELECT email FROM local_accounts WHERE user_id=?", uid))!.email,
});

// The first account sets the instance up (it is not one of the people below).
await account("Admin", "admin@example.test");

test("the change waits for the link to the new address; the old one can cancel it", async () => {
  withMail();
  sent.length = 0;
  const ada = await account("Ada", "ada@example.test");
  const wid = id();
  await run("INSERT INTO workspaces(id,name,created_by) VALUES(?,?,?)", wid, "Team", ada);
  await run("INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,?)", wid, ada, "owner");
  await run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", "s-ada", ada, "[]", Date.now() + 600_000);
  const pending = await change.requestEmailChange(ada, { email: " Ada.New@Example.test " }, "de", address());
  assert.equal(pending.email, "ada.new@example.test");
  assert.deepEqual(await change.pendingEmailChange(ada), pending);
  // Nothing changes before the link is opened.
  assert.deepEqual(await emailOf(ada), { user: "ada@example.test", local: "ada@example.test" });
  await mail.flushMailQueue();
  const link = sent.find((m) => m.to === "ada.new@example.test")!;
  const notice = sent.find((m) => m.to === "ada@example.test")!;
  assert.match(link.subject, /Neue E-Mail-Adresse bestätigen/);
  assert.match(linkIn(link.text), /^https:\/\/flowplan\.example\.test\/email-change\?token=/);
  assert.match(notice.subject, /wird geändert/);
  assert.match(notice.text, /ada\.new@example\.test/);
  assert.match(linkIn(notice.text), /&cancel=1$/);
  // The cancel link of the old address ends the pending change: its link no longer works.
  assert.equal(await change.cancelEmailChangeByLink(tokenIn(notice)), true);
  assert.equal(await change.pendingEmailChange(ada), null);
  await assert.rejects(change.confirmEmailChange(tokenIn(link), "de"), /abgelaufen oder wurde schon benutzt/);
  assert.equal(await change.cancelEmailChangeByLink(tokenIn(notice)), false, "nothing left to cancel");
  assert.deepEqual(await emailOf(ada), { user: "ada@example.test", local: "ada@example.test" });
  await settle();
  const kinds = (await all<{ kind: string }>("SELECT kind FROM security_events WHERE actor_id=? ORDER BY id", ada)).map((e) => e.kind);
  assert.deepEqual(kinds, ["account.email_change_requested", "account.email_change_cancelled"]);
});

test("the link works once within 24 hours and moves what is keyed by the address", async () => {
  withMail();
  sent.length = 0;
  const ben = await account("Ben", "ben@example.test");
  const owner = await account("Owner", "owner@example.test");
  // A workspace Ben is in, with an e-mail inbox that lets his old address in.
  const team = id();
  await run("INSERT INTO workspaces(id,name,created_by) VALUES(?,?,?)", team, "Ben's team", owner);
  await run("INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,?)", team, ben, "editor");
  const page = id();
  await run("INSERT INTO pages(id,workspace_id,title,kind,created_by) VALUES(?,?,?,?,?)", page, team, "Eingang", "document", owner);
  const inbox = id();
  await run(
    "INSERT INTO inbound_addresses(id,workspace_id,page_id,label,token,secret,senders,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
    inbox,
    team,
    page,
    "",
    `tok-${inbox}`,
    "",
    JSON.stringify(["ben@example.test", "example.org"]),
    owner,
    Date.now(),
  );
  // An invitation to the new address waits in another workspace.
  const other = id();
  await run("INSERT INTO workspaces(id,name,created_by) VALUES(?,?,?)", other, "Neu", owner);
  await run("INSERT INTO invites(id,workspace_id,email,role,created_by,guest) VALUES(?,?,?,?,?,0)", id(), other, "ben.neu@example.test", "editor", owner);
  await run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", "s-ben", ben, "[]", Date.now() + 600_000);
  // A password reset link sent to the old address before.
  await auth.requestPasswordReset({ email: "ben@example.test" }, "de");
  const now = Date.now();
  await change.requestEmailChange(ben, { email: "ben.neu@example.test" }, "de", address(), now);
  await mail.flushMailQueue();
  const token = tokenIn(sent.find((m) => m.to === "ben.neu@example.test")!);
  const expires = (await one<{ expires: number }>("SELECT expires FROM auth_tokens WHERE user_id=? AND kind='email-change'", ben))!.expires;
  assert.equal(Number(expires), now + 24 * 3600_000, "valid for 24 hours");
  // Past its time the link changes nothing.
  await assert.rejects(change.confirmEmailChange(token, "en", now + 24 * 3600_000 + 1), /expired or was used/);
  assert.equal((await emailOf(ben)).local, "ben@example.test");
  const done = await change.confirmEmailChange(token, "de", now + 3600_000);
  assert.deepEqual(done, { userId: ben, email: "ben.neu@example.test" });
  await assert.rejects(change.confirmEmailChange(token, "de"), /schon benutzt/, "works once");
  assert.deepEqual(await emailOf(ben), { user: "ben.neu@example.test", local: "ben.neu@example.test" });
  assert.equal((await one<{ v: number }>("SELECT email_verified v FROM users WHERE id=?", ben))!.v, 1);
  // Sessions stay; the new address signs in, the old one no longer.
  assert.ok(await one("SELECT 1 FROM sessions WHERE token='s-ben'"));
  assert.equal((await auth.passwordLogin({ email: "ben.neu@example.test", password: "ein-langes-passwort" }, "10.9.1.1", "de")).userId, ben);
  await assert.rejects(auth.passwordLogin({ email: "ben@example.test", password: "ein-langes-passwort" }, "10.9.1.2", "de"));
  // The reset link of the old address stopped working.
  assert.equal(await one("SELECT 1 FROM auth_tokens WHERE user_id=? AND kind='reset'", ben), undefined);
  // The invitation to the new address was taken over.
  assert.ok(await one("SELECT 1 FROM members WHERE workspace_id=? AND user_id=? AND role='editor'", other, ben));
  assert.equal(await one("SELECT 1 FROM invites WHERE workspace_id=?", other), undefined);
  // The inbox lets the new address in instead of the old one.
  assert.deepEqual(JSON.parse((await one<{ senders: string }>("SELECT senders FROM inbound_addresses WHERE id=?", inbox))!.senders), ["ben.neu@example.test", "example.org"]);
  // In the activity log with both addresses, and in the person's security check.
  const entry = await one<{ actor_id: string; action: string; resource_id: string; detail: string }>("SELECT actor_id,action,resource_id,detail FROM audit WHERE action='account.email'");
  assert.deepEqual({ ...entry }, { actor_id: ben, action: "account.email", resource_id: ben, detail: "ben@example.test → ben.neu@example.test" });
  await settle();
  const security = await mySecurity({ id: ben, email: "ben.neu@example.test", name: "Ben" } as never, undefined);
  const kinds = security.activity.map((e: { kind: string }) => e.kind);
  assert.ok(kinds.includes("account.email_changed"));
  assert.ok(kinds.includes("account.email_change_requested"));
});

test("an address of another account is never taken over, and the answer does not tell", async () => {
  withMail();
  sent.length = 0;
  const cem = await account("Cem", "cem@example.test");
  await account("Dora", "dora@example.test");
  // An SSO account with the address counts as well.
  await run("INSERT INTO users(id,subject,name,email,email_verified) VALUES(?,?,?,?,1)", id(), "oidc:eva", "Eva", "eva@example.test");
  for (const taken of ["DORA@example.test", "eva@example.test"]) {
    sent.length = 0;
    const answer = await change.requestEmailChange(cem, { email: taken }, "de", address(), Date.now() + addresses * 10 * 60_000);
    assert.equal(answer.email, taken.toLowerCase(), "the same answer as for a free address");
    await mail.flushMailQueue();
    const note = sent.find((m) => m.to === taken.toLowerCase())!;
    assert.match(note.subject, /hat schon ein Konto/);
    assert.ok(!note.text.includes("/email-change"), "no confirmation link");
  }
  // Even with the token in hand the change is refused.
  const token = "versuch-0123456789";
  await run("INSERT INTO auth_tokens(id,user_id,kind,expires,email) VALUES(?,?,'email-change',?,?)", (await import("../lib/auth")).hash(token), cem, Date.now() + 60_000, "dora@example.test");
  await assert.rejects(change.confirmEmailChange(token, "de"), /anderen Konto/);
  assert.equal((await emailOf(cem)).local, "cem@example.test");
  // An address another account waits to change to is not free either.
  const fynn = await account("Fynn", "fynn@example.test");
  await change.requestEmailChange(fynn, { email: "frei@example.test" }, "de", address());
  assert.equal(await change.addressTaken("frei@example.test", cem), true);
  assert.equal(await change.addressTaken("frei@example.test", fynn), false);
  // Its own address, or none, is refused right away.
  await assert.rejects(change.requestEmailChange(cem, { email: "Cem@example.test" }, "de", address()), /schon die Adresse/);
  await assert.rejects(change.requestEmailChange(cem, { email: "kein-at" }, "en", address()), /valid e-mail address/);
});

test("requests are limited like a password reset, and a new one replaces the old", async () => {
  withMail();
  sent.length = 0;
  const gil = await account("Gil", "gil@example.test");
  const now = Date.now() + 3 * 3600_000;
  await change.requestEmailChange(gil, { email: "gil.1@example.test" }, "de", address(), now);
  await assert.rejects(change.requestEmailChange(gil, { email: "gil.2@example.test" }, "de", address(), now + 60_000), /schon ein Link unterwegs/);
  await change.requestEmailChange(gil, { email: "gil.2@example.test" }, "de", address(), now + 6 * 60_000);
  assert.equal((await change.pendingEmailChange(gil))!.email, "gil.2@example.test");
  assert.equal(Number((await one<{ n: number }>("SELECT COUNT(*) n FROM auth_tokens WHERE user_id=? AND kind='email-change'", gil))!.n), 1);
  await mail.flushMailQueue();
  const first = sent.find((m) => m.to === "gil.1@example.test")!;
  await assert.rejects(change.confirmEmailChange(tokenIn(first), "de", now + 7 * 60_000), /abgelaufen/, "the earlier link stopped working");
  // Per client address: 20 an hour.
  const from = "10.9.9.9";
  for (let i = 0; i < 20; i++) {
    const uid = await account(`Viele ${i}`, `viele.${i}@example.test`);
    await change.requestEmailChange(uid, { email: `viele.${i}.neu@example.test` }, "de", from, now);
  }
  const last = await account("Zu viele", "zu.viele@example.test");
  await assert.rejects(change.requestEmailChange(last, { email: "zu.viele.neu@example.test" }, "de", from, now), /Zu viele Versuche/);
  // Cancelled in the profile.
  assert.equal(await change.cancelEmailChange(gil), true);
  assert.equal(await change.pendingEmailChange(gil), null);
});

test("without e-mail only an administrator changes the address, recorded in the activity log", async () => {
  withoutMail();
  const admin = (await one<{ user_id: string }>("SELECT user_id FROM local_accounts WHERE email='admin@example.test'"))!.user_id;
  const hana = await account("Hana", "hana@example.test");
  await run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", "s-hana", hana, "[]", Date.now() + 600_000);
  await assert.rejects(change.requestEmailChange(hana, { email: "hana.neu@example.test" }, "de", address()), /versendet keine E-Mails/);
  assert.deepEqual(await change.emailChangeStatus(hana), { available: true, mail: false, pending: null });
  await assert.rejects(change.adminChangeEmail({ id: admin }, hana, { email: "dora@example.test" }, "de"), /anderen Konto/);
  const wid = id();
  await run("INSERT INTO workspaces(id,name,created_by) VALUES(?,?,?)", wid, "Hanas Einladung", admin);
  await run("INSERT INTO invites(id,workspace_id,email,role,created_by,guest) VALUES(?,?,?,?,?,0)", id(), wid, "hana.neu@example.test", "viewer", admin);
  assert.deepEqual(await change.adminChangeEmail({ id: admin }, hana, { email: "Hana.Neu@example.test" }, "de"), { email: "hana.neu@example.test" });
  assert.deepEqual(await emailOf(hana), { user: "hana.neu@example.test", local: "hana.neu@example.test" });
  assert.ok(await one("SELECT 1 FROM sessions WHERE token='s-hana'"), "sessions stay");
  assert.ok(await one("SELECT 1 FROM members WHERE workspace_id=? AND user_id=?", wid, hana), "the invitation was taken over");
  const entry = await one<{ actor_id: string; resource_id: string; detail: string }>("SELECT actor_id,resource_id,detail FROM audit WHERE action='admin.changeEmail'");
  assert.deepEqual({ ...entry }, { actor_id: admin, resource_id: hana, detail: "hana@example.test → hana.neu@example.test" });
  await settle();
  assert.ok(await one("SELECT 1 FROM security_events WHERE kind='admin.user' AND actor_id=? AND detail=?", admin, `e-mail changed ${hana}`));
  assert.ok(await one("SELECT 1 FROM security_events WHERE kind='account.email_changed' AND actor_id=? AND detail='by an administrator'", hana));
  // With e-mail the person does it themselves.
  withMail();
  await assert.rejects(change.adminChangeEmail({ id: admin }, hana, { email: "hana.3@example.test" }, "de"), /ändert ihre Adresse selbst/);
});

test("accounts from SSO, LDAP or SCIM keep the address of their provider", async () => {
  withMail();
  const sso = id();
  await run("INSERT INTO users(id,subject,name,email,email_verified) VALUES(?,?,?,?,1)", sso, "oidc:ivo", "Ivo", "ivo@example.test");
  assert.equal((await change.emailChangeStatus(sso)).available, false);
  await assert.rejects(change.requestEmailChange(sso, { email: "ivo.neu@example.test" }, "de", address()), /Anmeldeanbieter/);
  withoutMail();
  await assert.rejects(change.adminChangeEmail({ id: sso }, sso, { email: "ivo.neu@example.test" }, "de"), /Anmeldeanbieter/);
  // A local account provisioned by SCIM.
  withMail();
  const scim = await account("Jo", "jo@example.test");
  await run("INSERT INTO scim_users(id,user_id,user_name,created_at,updated_at) VALUES(?,?,?,?,?)", id(), scim, "jo", Date.now(), Date.now());
  assert.equal((await change.emailChangeStatus(scim)).available, false);
  await assert.rejects(change.requestEmailChange(scim, { email: "jo.neu@example.test" }, "de", address()), /SCIM/);
});
