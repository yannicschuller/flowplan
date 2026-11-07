// The administration's account commands through command() (lib/api.ts):
// only admins, never on the own account where that would lock them out,
// and each takes effect on sign-in – deactivating, ending sessions, the
// reset link, the admin right, and the previews before deleting or merging.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-admin-accounts-"));
process.env.APP_URL = "https://flowplan.example.test";
delete process.env.SMTP_HOST;
delete process.env.OIDC_ISSUER;
const { id, one, run } = await import("../lib/db");
const { command } = await import("../lib/api");
const { identityFromToken, HttpError } = await import("../lib/auth");
const { createWorkspace } = await import("../lib/seed");
const { hashPassword, passwordLogin, resetPassword } = await import("../lib/local-auth");

// An account with e-mail and password and one signed-in session.
async function account(name: string, admin = false) {
  const uid = id();
  const email = `${name.toLowerCase()}@example.test`;
  await run("INSERT INTO users(id,subject,name,email,email_verified) VALUES(?,?,?,?,1)", uid, `local:${uid}`, name, email);
  await run(
    "INSERT INTO local_accounts(user_id,email,password_hash,is_admin,email_verified,verify_required,created_at) VALUES(?,?,?,?,1,0,?)",
    uid,
    email,
    await hashPassword("a-long-password"),
    admin ? 1 : 0,
    Date.now(),
  );
  const token = await signIn(uid);
  const identity = (await identityFromToken(token))!;
  return { identity: { ...identity, isAdmin: admin } as Identity, token, email };
}
async function signIn(uid: string) {
  const token = randomBytes(16).toString("hex");
  await run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", createHash("sha256").update(token).digest("hex"), uid, "[]", Date.now() + 3600_000);
  return token;
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

const admin = await account("Admin", true);
const member = await account("Member");

test("account commands are for administrators only", async () => {
  const target = await account("Target");
  for (const action of ["admin.user", "admin.revoke", "admin.resetLink", "admin.localAdmin", "admin.deletePlan", "admin.confirmEmail"])
    assert.equal(await status(() => command(member.identity, { action, userId: target.identity.id, disabled: true, admin: true })), 403, action);
  assert.equal(await status(() => command(member.identity, { action: "admin.mergePlan", sourceId: target.identity.id, targetId: member.identity.id })), 403);
  // Nothing happened to the account.
  assert.ok(await identityFromToken(target.token));
  assert.equal((await one<{ is_admin: number }>("SELECT is_admin FROM local_accounts WHERE user_id=?", target.identity.id))!.is_admin, 0);
});

test("deactivating ends the sessions and refuses sign-in; enabling lets the person in again", async () => {
  const target = await account("Leaving");
  assert.equal(await status(() => command(admin.identity, { action: "admin.user", userId: admin.identity.id, disabled: true })), 400);
  await command(admin.identity, { action: "admin.user", userId: target.identity.id, disabled: true });
  assert.equal(await identityFromToken(target.token), null);
  await assert.rejects(passwordLogin({ email: target.email, password: "a-long-password" }, "", "de"), /deaktiviert/);
  await command(admin.identity, { action: "admin.user", userId: target.identity.id, disabled: false });
  const login = await passwordLogin({ email: target.email, password: "a-long-password" }, "", "de");
  assert.equal(login.userId, target.identity.id);
});

test("ending all sessions signs the person out everywhere, nobody else", async () => {
  const target = await account("Traveller");
  const second = await signIn(target.identity.id);
  await command(admin.identity, { action: "admin.revoke", userId: target.identity.id });
  assert.equal(await identityFromToken(target.token), null);
  assert.equal(await identityFromToken(second), null);
  assert.ok(await identityFromToken(member.token));
  assert.ok(await identityFromToken(admin.token));
});

test("the reset link sets a new password once, confirms the address and ends the old sessions", async () => {
  const target = await account("Forgetful");
  await run("UPDATE local_accounts SET email_verified=0 WHERE user_id=?", target.identity.id);
  await run("UPDATE users SET email_verified=0 WHERE id=?", target.identity.id);
  const { url } = (await command(admin.identity, { action: "admin.resetLink", userId: target.identity.id })) as { url: string };
  assert.match(url, /^https:\/\/flowplan\.example\.test\/reset\?token=/);
  const token = new URL(url).searchParams.get("token")!;
  await resetPassword({ token, password: "another-long-password" }, "de");
  assert.equal(await identityFromToken(target.token), null);
  assert.equal((await one<{ email_verified: number }>("SELECT email_verified FROM users WHERE id=?", target.identity.id))!.email_verified, 1);
  await assert.rejects(passwordLogin({ email: target.email, password: "a-long-password" }, "", "de"));
  assert.ok(await passwordLogin({ email: target.email, password: "another-long-password" }, "", "de"));
  // The link works once.
  await assert.rejects(resetPassword({ token, password: "a-third-long-password" }, "de"), /abgelaufen/);
  // Accounts without a password (single sign-on) get no link.
  const sso = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", sso, `oidc:${sso}`, "Sso", "sso@example.test");
  assert.equal(await status(() => command(admin.identity, { action: "admin.resetLink", userId: sso })), 400);
});

test("the admin right: given and taken by another admin, never the own, sessions start over", async () => {
  const target = await account("Promoted");
  await command(admin.identity, { action: "admin.localAdmin", userId: target.identity.id, admin: true });
  assert.equal((await one<{ is_admin: number }>("SELECT is_admin FROM local_accounts WHERE user_id=?", target.identity.id))!.is_admin, 1);
  // The right lives in the session: the person signs in again.
  assert.equal(await identityFromToken(target.token), null);
  assert.equal(await status(() => command(admin.identity, { action: "admin.localAdmin", userId: admin.identity.id, admin: false })), 400);
  await command(admin.identity, { action: "admin.localAdmin", userId: target.identity.id, admin: false });
  assert.equal((await one<{ is_admin: number }>("SELECT is_admin FROM local_accounts WHERE user_id=?", target.identity.id))!.is_admin, 0);
});

test("previews before deleting or merging an account change nothing", async () => {
  const target = await account("Owner");
  const alone = await createWorkspace(target.identity.id, "Allein");
  const shared = await createWorkspace(target.identity.id, "Geteilt");
  await run("INSERT INTO members VALUES(?,?,?)", shared, member.identity.id, "editor");
  const plan = (await command(admin.identity, { action: "admin.deletePlan", userId: target.identity.id })) as {
    name: string;
    removed: { id: string }[];
    handedOver: { id: string; to: string }[];
  };
  assert.equal(plan.name, "Owner");
  assert.deepEqual(plan.removed.map((w) => w.id), [alone]);
  assert.deepEqual(plan.handedOver.map((w) => [w.id, w.to]), [[shared, "Member"]]);
  const merge = (await command(admin.identity, { action: "admin.mergePlan", sourceId: target.identity.id, targetId: member.identity.id })) as {
    source: { id: string };
    target: { id: string };
    summary: { workspaces: number };
  };
  assert.equal(merge.source.id, target.identity.id);
  assert.equal(merge.target.id, member.identity.id);
  assert.equal(merge.summary.workspaces, 2);
  assert.ok(await one("SELECT 1 FROM workspaces WHERE id=?", alone));
  assert.ok(await identityFromToken(target.token));
  assert.equal(await status(() => command(admin.identity, { action: "admin.deletePlan", userId: id() })), 404);
});
