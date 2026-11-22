// Accounts with an unconfirmed e-mail address marked for deletion (#436,
// lib/unconfirmed-deletion.ts): who counts and who is exempt, marking with
// the warning e-mail, cancelling, confirming through the link (signing in
// does not), the reminder 3 days before, the deletion on the day, the
// automatic rule, nothing without e-mail, two rounds at once, and the
// activity log.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-unconfirmed-"));
process.env.APP_URL = "https://flowplan.example.test";
delete process.env.SMTP_HOST;
delete process.env.OIDC_ISSUER;
delete process.env.FLOWPLAN_LOCAL_LOGIN;
const { id, one, all, run } = await import("../lib/db");
const { command } = await import("../lib/api");
const { identityFromToken, HttpError } = await import("../lib/auth");
const local = await import("../lib/local-auth");
const u = await import("../lib/unconfirmed-deletion");
const { saveInstanceSettings } = await import("../lib/instance-settings");

const DAY = 86_400_000;
const withMail = () => {
  process.env.SMTP_HOST = "smtp.example.test";
  process.env.SMTP_FROM = "Flowplan <flowplan@example.test>";
};
const withoutMail = () => delete process.env.SMTP_HOST;

let n = 0;
async function account(name: string, options: { admin?: boolean; verified?: boolean; created?: number } = {}) {
  const uid = id();
  const email = `${name.toLowerCase()}-${++n}@example.test`;
  const verified = options.verified ? 1 : 0;
  await run("INSERT INTO users(id,subject,name,email,email_verified) VALUES(?,?,?,?,?)", uid, `local:${uid}`, name, email, verified);
  await run(
    "INSERT INTO local_accounts(user_id,email,password_hash,is_admin,email_verified,verify_required,created_at) VALUES(?,?,?,?,?,0,?)",
    uid,
    email,
    await local.hashPassword("a-long-password"),
    options.admin ? 1 : 0,
    verified,
    options.created ?? Date.now(),
  );
  const token = randomBytes(16).toString("hex");
  await run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", createHash("sha256").update(token).digest("hex"), uid, "[]", Date.now() + 3600_000);
  const identity = (await identityFromToken(token))!;
  return { ...identity, isAdmin: !!options.admin, email } as Identity & { email: string };
}
const status = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return 200;
  } catch (error) {
    if (error instanceof HttpError) return error.status;
    throw error;
  }
};
const mailsTo = async (email: string) => await all<{ subject: string; text: string }>("SELECT subject,text FROM mail_queue WHERE recipient=? ORDER BY seq", email);
const linkIn = (text: string) => /https:\/\/\S+\/api\/auth\/verify\?token=([\w-]+)/.exec(text)?.[1] || "";
const exists = async (userId: string) => !!(await one("SELECT 1 FROM users WHERE id=? AND subject NOT LIKE 'deleted:%'", userId));
const marked = async (userId: string) => (await one<{ due_at: number }>("SELECT due_at FROM unconfirmed_deletions WHERE user_id=? AND cancelled_at IS NULL", userId))?.due_at ?? null;
const auditOf = async (action: string, userId: string) => await all<{ actor_id: string | null; detail: string }>("SELECT actor_id,detail FROM audit WHERE action=? AND resource_id=?", action, userId);
const markCmd = (by: Identity, userIds: string[]) => command(by, { action: "admin.unconfirmedMark", userIds }) as Promise<{ marked: string[]; due: number }>;

const admin = await account("Admin", { admin: true, verified: true });
const member = await account("Member", { verified: true });

test("without e-mail the overview says unavailable and marking is refused", async () => {
  withoutMail();
  const spam = await account("Spam");
  const overview = await u.unconfirmedOverview(admin);
  assert.equal(overview.available, false);
  assert.ok(overview.ids.includes(spam.id), "still listed as unconfirmed");
  assert.equal(await status(() => markCmd(admin, [spam.id])), 409);
  assert.equal(await status(() => command(admin, { action: "admin.unconfirmedPlan", userIds: [spam.id] })), 409);
  assert.equal(await marked(spam.id), null);
  // The job does nothing either.
  assert.deepEqual(await u.runUnconfirmedDeletions(Date.now() + 100 * DAY), { marked: [], reminded: [], deleted: [], ended: [] });
});

test("only administrators mark – never members, never an API token", async () => {
  withMail();
  const spam = await account("Spam2");
  assert.equal(await status(() => markCmd(member, [spam.id])), 403);
  assert.equal(await status(() => markCmd({ ...admin, apiScope: "write" } as Identity, [spam.id])), 403);
  assert.equal(await status(() => command({ ...admin, apiScope: "write" } as Identity, { action: "admin.unconfirmedCancel", userId: spam.id })), 403);
  assert.equal(await marked(spam.id), null);
});

test("exempt: admins, the acting admin, confirmed, SSO/LDAP/SCIM accounts and invited ones with a valid link", async () => {
  withMail();
  const otherAdmin = await account("Chef", { admin: true });
  const confirmed = await account("Fine", { verified: true });
  const sso = await account("Sso");
  await run("INSERT INTO user_identities(id,user_id,issuer,subject,email,created_at) VALUES(?,?,?,?,?,?)", id(), sso.id, "https://idp.example.test", `sub-${sso.id}`, sso.email, Date.now());
  const ldap = await account("Ldap");
  await run("INSERT INTO ldap_accounts(user_id,dn,username,created_at) VALUES(?,?,?,?)", ldap.id, `uid=${ldap.id}`, `l${n}`, Date.now());
  const invited = await account("Invited");
  await run("INSERT INTO auth_tokens(id,user_id,kind,expires) VALUES(?,?,?,?)", `w-${invited.id}`, invited.id, "welcome", Date.now() + 3 * DAY);
  const expiredInvite = await account("Expired");
  await run("INSERT INTO auth_tokens(id,user_id,kind,expires) VALUES(?,?,?,?)", `w-${expiredInvite.id}`, expiredInvite.id, "welcome", Date.now() - DAY);
  const unconfirmedAdmin = await account("SelfAdmin", { admin: true });
  const ids = [otherAdmin.id, confirmed.id, sso.id, ldap.id, invited.id, expiredInvite.id, unconfirmedAdmin.id];
  const overview = await u.unconfirmedOverview(unconfirmedAdmin);
  assert.ok(overview.ids.includes(otherAdmin.id) && overview.ids.includes(expiredInvite.id));
  for (const x of [confirmed, sso, ldap, invited]) assert.ok(!overview.ids.includes(x.id), "does not count as unconfirmed");
  assert.ok(overview.markable.includes(expiredInvite.id));
  assert.ok(!overview.markable.includes(otherAdmin.id) && !overview.markable.includes(unconfirmedAdmin.id));
  const plan = (await command(unconfirmedAdmin, { action: "admin.unconfirmedPlan", userIds: ids })) as { count: number; skipped: number };
  assert.deepEqual([plan.count, plan.skipped], [1, 6]);
  const result = await markCmd(unconfirmedAdmin, ids);
  assert.deepEqual(result.marked, [expiredInvite.id]);
  for (const x of ids.filter((x) => x !== expiredInvite.id)) assert.equal(await marked(x), null);
});

test("marking: the dialog's numbers, an e-mail with the day and a link, the list, the activity log", async () => {
  withMail();
  const now = Date.now();
  const lena = await account("Lena");
  const tom = await account("Tom");
  // Tom wrote in a workspace he shares with Member.
  const wid = id();
  await run("INSERT INTO workspaces(id,name) VALUES(?,?)", wid, "Gemeinsam");
  await run("INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,'editor'),(?,?,'owner')", wid, tom.id, wid, member.id);
  await run("INSERT INTO pages(id,workspace_id,title,created_by) VALUES(?,?,?,?)", id(), wid, "Notiz", tom.id);
  const plan = (await command(admin, { action: "admin.unconfirmedPlan", userIds: [lena.id, tom.id] })) as { count: number; shared: number; due: number };
  assert.equal(plan.count, 2);
  assert.equal(plan.shared, 1);
  assert.ok(Math.abs(plan.due - (now + 14 * DAY)) < 60_000);
  const result = await markCmd(admin, [lena.id, tom.id]);
  assert.deepEqual(new Set(result.marked), new Set([lena.id, tom.id]));
  const [warning] = await mailsTo(lena.email);
  assert.match(warning.subject, /Bestätige deine Adresse, sonst wird dein Konto am .* gelöscht/);
  assert.match(warning.text, /Nur anmelden reicht nicht/);
  assert.ok(linkIn(warning.text), "the confirm link");
  // Marked twice: nothing new.
  assert.deepEqual((await markCmd(admin, [lena.id])).marked, []);
  assert.equal((await mailsTo(lena.email)).length, 1);
  const overview = await u.unconfirmedOverview(admin);
  assert.equal(overview.marks[lena.id], await marked(lena.id));
  assert.ok(!overview.markable.includes(lena.id));
  const entry = await auditOf("admin.markUnconfirmed", lena.id);
  assert.equal(entry.length, 1);
  assert.equal(entry[0].actor_id, admin.id);
  assert.match(entry[0].detail, new RegExp(lena.email));
  // Marking is not in the generic log a second time.
  assert.equal((await all("SELECT 1 FROM audit WHERE action='admin.unconfirmedMark'")).length, 0);
});

test("signing in does not cancel; the notice shows the day; the link confirms and keeps the account", async () => {
  withMail();
  const now = Date.now();
  const mia = await account("Mia", { created: now - 30 * DAY });
  await markCmd(admin, [mia.id]);
  // Mia signs in and uses the app: still marked, the notice shows the day.
  await run("UPDATE users SET last_login_at=?,last_active_at=? WHERE id=?", now + DAY, now + DAY, mia.id);
  await u.runUnconfirmedDeletions(now + 2 * DAY);
  assert.ok(await marked(mia.id));
  assert.deepEqual(await u.pendingDeletionOf(mia.id), { due: (await marked(mia.id))! });
  // "Bestätigungslink erneut senden": once every five minutes.
  await command(mia, { action: "account.keepLink" });
  assert.equal((await mailsTo(mia.email)).length, 2);
  assert.equal(await status(() => command(mia, { action: "account.keepLink" })), 429);
  assert.equal(await status(() => command(member, { action: "account.keepLink" })), 409);
  // The first link (from the e-mail), opened in the browser Mia is signed in to.
  const token = linkIn((await mailsTo(mia.email))[0].text);
  const confirmed = await local.verifyEmail(token, null, mia.id);
  assert.deepEqual(confirmed, { userId: mia.id, signedIn: true });
  assert.equal(await marked(mia.id), null);
  assert.equal(await u.pendingDeletionOf(mia.id), null);
  assert.equal((await one<{ email_verified: number }>("SELECT email_verified FROM local_accounts WHERE user_id=?", mia.id))!.email_verified, 1);
  assert.ok((await one("SELECT password_hash FROM local_accounts WHERE user_id=? AND password_hash<>''", mia.id)), "the password stays");
  assert.equal((await auditOf("user.unconfirmedConfirmed", mia.id)).length, 1);
  // Single use: the other link no longer works either.
  assert.equal(await local.verifyEmail(token, null, mia.id), null);
  assert.equal(await local.verifyEmail(linkIn((await mailsTo(mia.email))[1].text)), null);
  // Long past the day: still there.
  await u.runUnconfirmedDeletions(now + 30 * DAY);
  assert.ok(await exists(mia.id));
});

test("opened in another browser the link confirms too, and the owner sets the password anew", async () => {
  withMail();
  const ben = await account("Ben");
  await markCmd(admin, [ben.id]);
  const confirmed = await local.verifyEmail(linkIn((await mailsTo(ben.email))[0].text), null, null);
  assert.equal(confirmed?.userId, ben.id);
  assert.ok(confirmed?.setPassword);
  assert.equal(await marked(ben.id), null);
});

test("an administrator's confirmation and cancelling end the marking; cancelled stays cancelled", async () => {
  withMail();
  const now = Date.now();
  const ida = await account("Ida", { created: now - 60 * DAY });
  const jan = await account("Jan", { created: now - 60 * DAY });
  await markCmd(admin, [ida.id, jan.id]);
  await command(admin, { action: "admin.confirmEmail", userId: ida.id });
  assert.equal(await marked(ida.id), null);
  await command(admin, { action: "admin.unconfirmedCancel", userId: jan.id });
  assert.equal(await marked(jan.id), null);
  assert.equal((await auditOf("admin.cancelUnconfirmedDeletion", jan.id))[0].actor_id, admin.id);
  assert.equal(await status(() => command(admin, { action: "admin.unconfirmedCancel", userId: jan.id })), 409);
  // The link of a cancelled marking no longer works.
  assert.equal(await local.verifyEmail(linkIn((await mailsTo(jan.email))[0].text)), null);
  // The automatic rule leaves Jan alone…
  await saveInstanceSettings({ unconfirmedAutoDays: 7 });
  const r = await u.runUnconfirmedDeletions(now);
  assert.ok(!r.marked.includes(jan.id));
  // …marking by hand still works.
  assert.deepEqual((await markCmd(admin, [jan.id])).marked, [jan.id]);
  await command(admin, { action: "admin.unconfirmedCancel", userId: jan.id });
  await saveInstanceSettings({ unconfirmedAutoDays: null });
});

test("the reminder 3 days before, then the deletion on the day; content in shared workspaces stays", async () => {
  withMail();
  const now = Date.now();
  const leo = await account("Leo");
  const wid = id();
  await run("INSERT INTO workspaces(id,name) VALUES(?,?)", wid, "Team");
  await run("INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,'editor'),(?,?,'owner')", wid, leo.id, wid, member.id);
  const page = id();
  await run("INSERT INTO pages(id,workspace_id,title,created_by) VALUES(?,?,?,?)", page, wid, "Leos Seite", leo.id);
  const { due } = await u.markUnconfirmed(admin, { userIds: [leo.id] }, "de", now);
  assert.equal(due, now + 14 * DAY);
  let r = await u.runUnconfirmedDeletions(due - 4 * DAY);
  assert.ok(!r.reminded.includes(leo.id));
  r = await u.runUnconfirmedDeletions(due - 3 * DAY);
  assert.deepEqual(r.reminded.filter((x) => x === leo.id), [leo.id]);
  const mails = await mailsTo(leo.email);
  assert.equal(mails.length, 2);
  assert.match(mails[1].subject, /^Erinnerung: /);
  // Once.
  r = await u.runUnconfirmedDeletions(due - 2 * DAY);
  assert.ok(!r.reminded.includes(leo.id));
  assert.equal((await mailsTo(leo.email)).length, 2);
  r = await u.runUnconfirmedDeletions(due);
  assert.ok(r.deleted.includes(leo.id));
  assert.ok(!(await exists(leo.id)));
  assert.ok(await one("SELECT 1 FROM pages WHERE id=?", page), "the shared page stays");
  const entry = await auditOf("user.unconfirmedDeleted", leo.id);
  assert.equal(entry.length, 1);
  assert.equal(entry[0].actor_id, null);
  assert.equal(await one("SELECT 1 FROM unconfirmed_deletions WHERE user_id=?", leo.id), undefined);
});

test("two rounds at once send each mail once and delete once", async () => {
  withMail();
  const now = Date.now();
  const a = await account("Ann");
  const b = await account("Bo");
  const { due } = await u.markUnconfirmed(admin, { userIds: [a.id, b.id] }, "de", now);
  const reminders = await Promise.all([u.runUnconfirmedDeletions(due - DAY), u.runUnconfirmedDeletions(due - DAY)]);
  assert.equal(reminders.flatMap((r) => r.reminded).filter((x) => x === a.id || x === b.id).length, 2);
  assert.equal((await mailsTo(a.email)).length, 2);
  const deletions = await Promise.all([u.runUnconfirmedDeletions(due + 1), u.runUnconfirmedDeletions(due + 1)]);
  assert.equal(deletions.flatMap((r) => r.deleted).filter((x) => x === a.id || x === b.id).length, 2);
  assert.equal((await auditOf("user.unconfirmedDeleted", a.id)).length, 1);
  assert.equal((await auditOf("user.unconfirmedDeleted", b.id)).length, 1);
});

test("without e-mail later, marked accounts wait: no reminder, no deletion", async () => {
  withMail();
  const now = Date.now();
  const kim = await account("Kim");
  const { due } = await u.markUnconfirmed(admin, { userIds: [kim.id] }, "de", now);
  withoutMail();
  await u.runUnconfirmedDeletions(due + DAY);
  assert.ok(await exists(kim.id));
  withMail();
  await u.runUnconfirmedDeletions(due + DAY);
  assert.ok(!(await exists(kim.id)));
});

test("the automatic rule marks accounts unconfirmed for X days since creation, not younger ones, not admins", async () => {
  withMail();
  const now = Date.now();
  await assert.rejects(saveInstanceSettings({ unconfirmedAutoDays: 6 }));
  await saveInstanceSettings({ unconfirmedAutoDays: 10 });
  const old = await account("Alt", { created: now - 11 * DAY });
  const young = await account("Jung", { created: now - 9 * DAY });
  const oldAdmin = await account("AltAdmin", { admin: true, created: now - 30 * DAY });
  const r = await u.runUnconfirmedDeletions(now);
  assert.ok(r.marked.includes(old.id));
  assert.ok(!r.marked.includes(young.id) && !r.marked.includes(oldAdmin.id));
  assert.equal(await marked(old.id), now + 14 * DAY);
  assert.equal((await auditOf("user.unconfirmedMarked", old.id))[0].actor_id, null);
  assert.equal((await mailsTo(old.email)).length, 1);
  // The next round marks nothing new.
  assert.ok(!(await u.runUnconfirmedDeletions(now + DAY)).marked.includes(old.id));
  assert.equal((await mailsTo(old.email)).length, 1);
  await saveInstanceSettings({ unconfirmedAutoDays: null });
});

test("a marked account that becomes admin is no longer deleted", async () => {
  withMail();
  const now = Date.now();
  const max = await account("Max");
  const { due } = await u.markUnconfirmed(admin, { userIds: [max.id] }, "de", now);
  await run("UPDATE local_accounts SET is_admin=1 WHERE user_id=?", max.id);
  await u.runUnconfirmedDeletions(due + DAY);
  assert.ok(await exists(max.id));
  assert.equal(await marked(max.id), null);
});
