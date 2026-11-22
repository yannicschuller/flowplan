// Administration → Benutzer → "Konto anlegen" (#433, lib/account-create.ts):
// only administrators, the checks of sign-up, a link to set the password
// (by e-mail or to hand over), once and for seven days, the workspace
// option and the activity log.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-account-create-"));
process.env.APP_URL = "https://flowplan.example.test";
delete process.env.SMTP_HOST;
delete process.env.OIDC_ISSUER;
delete process.env.FLOWPLAN_LOCAL_LOGIN;
const { id, one, all, run } = await import("../lib/db");
const { command } = await import("../lib/api");
const { identityFromToken, HttpError } = await import("../lib/auth");
const mail = await import("../lib/mail");
const local = await import("../lib/local-auth");
const create = await import("../lib/account-create");
const { instanceSettings } = await import("../lib/instance-settings");

const sent: { to: string; subject: string; text: string }[] = [];
mail.setMailSender(async (m) => void sent.push(m));
const withMail = () => {
  process.env.SMTP_HOST = "smtp.example.test";
  process.env.SMTP_FROM = "Flowplan <flowplan@example.test>";
};
const withoutMail = () => delete process.env.SMTP_HOST;
const tokenOf = (url: string) => new URL(url).searchParams.get("token")!;

async function account(name: string, admin = false) {
  const uid = id();
  const email = `${name.toLowerCase()}@example.test`;
  await run("INSERT INTO users(id,subject,name,email,email_verified) VALUES(?,?,?,?,1)", uid, `local:${uid}`, name, email);
  await run(
    "INSERT INTO local_accounts(user_id,email,password_hash,is_admin,email_verified,verify_required,created_at) VALUES(?,?,?,?,1,0,?)",
    uid,
    email,
    await local.hashPassword("a-long-password"),
    admin ? 1 : 0,
    Date.now(),
  );
  const token = randomBytes(16).toString("hex");
  await run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", createHash("sha256").update(token).digest("hex"), uid, "[]", Date.now() + 3600_000);
  const identity = (await identityFromToken(token))!;
  return { ...identity, isAdmin: admin } as Identity;
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
type Created = { userId: string; email: string; mailed: boolean; url?: string; workspaceId?: string };
const createAccount = (by: Identity, body: Record<string, unknown>) => command(by, { action: "admin.createAccount", ...body }) as Promise<Created>;

const admin = await account("Admin", true);
const member = await account("Member");

test("sign-ups stay closed: creating an account does not depend on them", async () => {
  assert.equal((await instanceSettings()).allowSignup, false);
});

test("only administrators create accounts – never through an API token", async () => {
  const body = { name: "Nope", email: "nope@example.test" };
  assert.equal(await status(() => createAccount(member, body)), 403);
  assert.equal(await status(() => createAccount({ ...admin, apiScope: "write" } as Identity, body)), 403);
  assert.equal(await status(() => command(member, { action: "admin.accountLink", userId: admin.id })), 403);
  assert.equal(await one("SELECT 1 FROM users WHERE email='nope@example.test'"), undefined);
});

test("without e-mail the link comes back; it sets the password once, signs in and leaves the address unconfirmed", async () => {
  withoutMail();
  const created = await createAccount(admin, { name: "Grace Hopper", email: " Grace@Example.TEST ", role: "member" });
  assert.equal(created.email, "grace@example.test");
  assert.equal(created.mailed, false);
  assert.match(created.url!, /^https:\/\/flowplan\.example\.test\/welcome\?token=/);
  const row = (await one<{ password_hash: string; is_admin: number; email_verified: number; verify_required: number }>("SELECT * FROM local_accounts WHERE user_id=?", created.userId))!;
  assert.deepEqual([row.password_hash, row.is_admin, row.email_verified, row.verify_required], ["", 0, 0, 0]);
  // Listed as invited until the password is set.
  assert.equal((await local.localAccountInfo())[created.userId].invited, true);
  // No password: no sign-in with any.
  await assert.rejects(local.passwordLogin({ email: "grace@example.test", password: "" }, "", "en"));
  const token = tokenOf(created.url!);
  assert.deepEqual(await create.welcomeAccount(token), { name: "Grace Hopper", email: "grace@example.test" });
  // Too short: the link stays usable.
  await assert.rejects(create.acceptWelcome({ token, password: "short" }, "en"), /at least 10/);
  const accepted = await create.acceptWelcome({ token, password: "graces-own-password" }, "en");
  assert.equal(accepted.userId, created.userId);
  assert.deepEqual(accepted.groups, []);
  const login = await local.passwordLogin({ email: "grace@example.test", password: "graces-own-password" }, "", "en");
  assert.equal(login.userId, created.userId);
  // Once only.
  await assert.rejects(create.acceptWelcome({ token, password: "another-password" }, "en"), /expired or was used/);
  assert.equal(await create.welcomeAccount(token), null);
  // Handed over: the address is not proven.
  assert.equal((await one<{ email_verified: number }>("SELECT email_verified FROM local_accounts WHERE user_id=?", created.userId))!.email_verified, 0);
  assert.equal((await local.localAccountInfo())[created.userId].invited, false);
});

test("the route signs the person in right after the password (source guard)", () => {
  const route = readFileSync(join(import.meta.dirname, "../app/api/auth/[action]/handler.ts"), "utf8");
  const at = route.indexOf('if (action === "welcome") {');
  assert.ok(at > 0);
  assert.match(route.slice(at, at + 700), /acceptWelcome\(input, locale\)[\s\S]*refuseSsoOnly[\s\S]*afterPassword[\s\S]*signIn\(userId, groups/);
});

test("the link is valid for seven days; a new one replaces the previous one", async () => {
  withoutMail();
  const created = await createAccount(admin, { name: "Late", email: "late@example.test" });
  const first = tokenOf(created.url!);
  const again = (await command(admin, { action: "admin.accountLink", userId: created.userId })) as { mailed: boolean; url: string };
  assert.equal(again.mailed, false);
  const second = tokenOf(again.url);
  await assert.rejects(create.acceptWelcome({ token: first, password: "a-long-password" }, "en"), /expired or was used/);
  // Eight days later the new one has expired too.
  const later = Date.now() + 8 * 86_400_000;
  await assert.rejects(create.acceptWelcome({ token: second, password: "a-long-password" }, "en", later), /expired or was used/);
  assert.equal(await create.welcomeAccount(second, later), null);
  // Six days on it still works.
  await create.acceptWelcome({ token: second, password: "a-long-password" }, "en", Date.now() + 6 * 86_400_000);
  // Signed up now: no more account links, the reset link is for that.
  assert.equal(await status(() => command(admin, { action: "admin.accountLink", userId: created.userId })), 409);
});

test("an address that has an account is refused, in any case and any way of signing in", async () => {
  withoutMail();
  assert.equal(await status(() => createAccount(admin, { name: "Again", email: "MEMBER@example.test" })), 409);
  const sso = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", sso, `https://idp|${sso}`, "Sso", "sso.person@example.test");
  assert.equal(await status(() => createAccount(admin, { name: "Sso", email: "Sso.Person@example.test" })), 409);
  // The checks of sign-up.
  assert.equal(await status(() => createAccount(admin, { name: "", email: "x@example.test" })), 400);
  assert.equal(await status(() => createAccount(admin, { name: "X", email: "not-an-address" })), 400);
  assert.equal(await status(() => createAccount(admin, { name: "X", email: "x@example.test", role: "owner" })), 400);
});

test("with e-mail the link goes out, and opening it confirms the address", async () => {
  withMail();
  sent.length = 0;
  // An invitation waiting for the address follows once it is confirmed.
  const team = id();
  await run("INSERT INTO workspaces(id,name,created_by) VALUES(?,?,?)", team, "Team", admin.id);
  await run("INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,?)", team, admin.id, "owner");
  await run("INSERT INTO invites(id,workspace_id,email,role,created_by,guest,created_at,token) VALUES(?,?,?,?,?,0,?,?)", id(), team, "ada@example.test", "editor", admin.id, new Date().toISOString(), randomBytes(16).toString("hex"));
  const created = await createAccount(admin, { name: "Ada", email: "ada@example.test", role: "admin" });
  assert.equal(created.mailed, true);
  assert.equal(created.url, undefined);
  await mail.flushMailQueue();
  const message = sent.find((m) => m.to === "ada@example.test")!;
  assert.ok(message, "an e-mail went out");
  assert.match(message.subject, /account was created|Konto wurde angelegt/);
  assert.match(message.text, /7/);
  const link = message.text.match(/https:\/\/\S+/)![0];
  assert.match(link, /\/welcome\?token=/);
  const accepted = await create.acceptWelcome({ token: tokenOf(link), password: "adas-own-password" }, "en");
  // Created as an administrator.
  assert.equal(accepted.groups.length, 1);
  assert.equal((await one<{ email_verified: number }>("SELECT email_verified FROM local_accounts WHERE user_id=?", created.userId))!.email_verified, 1);
  assert.equal((await one<{ email_verified: number }>("SELECT email_verified FROM users WHERE id=?", created.userId))!.email_verified, 1);
  assert.ok(await one("SELECT 1 FROM members WHERE workspace_id=? AND user_id=?", team, created.userId), "the invitation was taken");
  // Resending for an account waiting with e-mail sends a new one.
  const other = await createAccount(admin, { name: "Bob", email: "bob@example.test" });
  await mail.flushMailQueue();
  const firstLink = sent.find((m) => m.to === "bob@example.test")!.text.match(/https:\/\/\S+/)![0];
  sent.length = 0;
  const again = (await command(admin, { action: "admin.accountLink", userId: other.userId })) as { mailed: boolean; url?: string };
  assert.deepEqual([again.mailed, again.url], [true, undefined]);
  await mail.flushMailQueue();
  assert.equal(sent.filter((m) => m.to === "bob@example.test").length, 1);
  // The first e-mail's link stopped working.
  await assert.rejects(create.acceptWelcome({ token: tokenOf(firstLink), password: "a-long-password" }, "en"), /expired or was used/);
  withoutMail();
});

test("the workspace option creates the person's own workspace with the starter pages", async () => {
  withoutMail();
  const created = await createAccount(admin, { name: "Lin", email: "lin@example.test", workspace: "Lins Arbeitsbereich" });
  assert.ok(created.workspaceId);
  const ws = (await one<{ name: string; created_by: string }>("SELECT name,created_by FROM workspaces WHERE id=?", created.workspaceId))!;
  assert.deepEqual(ws, { name: "Lins Arbeitsbereich", created_by: created.userId });
  assert.equal((await one<{ role: string }>("SELECT role FROM members WHERE workspace_id=? AND user_id=?", created.workspaceId, created.userId))!.role, "owner");
  assert.ok((await all("SELECT 1 FROM pages WHERE workspace_id=?", created.workspaceId)).length > 0, "starter pages");
  // Without the option: no workspace yet (the first sign-in gives one).
  const bare = await createAccount(admin, { name: "Bare", email: "bare@example.test", workspace: null });
  assert.equal(bare.workspaceId, undefined);
  assert.equal(await one("SELECT 1 FROM members WHERE user_id=?", bare.userId), undefined);
});

test("the activity log records the new account with its address", async () => {
  withoutMail();
  const created = await createAccount(admin, { name: "Logged", email: "logged@example.test" });
  const entries = await all<{ actor_id: string; resource_id: string; detail: string }>("SELECT actor_id,resource_id,detail FROM audit WHERE action='admin.createAccount' AND resource_id=?", created.userId);
  assert.deepEqual(entries, [{ actor_id: admin.id, resource_id: created.userId, detail: "logged@example.test" }]);
});

test("not offered while password sign-in is off (SSO only)", async () => {
  process.env.FLOWPLAN_LOCAL_LOGIN = "false";
  try {
    assert.equal(await status(() => createAccount(admin, { name: "Off", email: "off@example.test" })), 409);
    assert.equal(await one("SELECT 1 FROM users WHERE email='off@example.test'"), undefined);
  } finally {
    delete process.env.FLOWPLAN_LOCAL_LOGIN;
  }
});

test("a blocked account's link no longer works", async () => {
  withoutMail();
  const created = await createAccount(admin, { name: "Blocked", email: "blocked@example.test" });
  await run("UPDATE users SET disabled=1 WHERE id=?", created.userId);
  assert.equal(await create.welcomeAccount(tokenOf(created.url!)), null);
  await assert.rejects(create.acceptWelcome({ token: tokenOf(created.url!), password: "a-long-password" }, "en"), /expired or was used/);
});
