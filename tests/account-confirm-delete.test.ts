import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-accounts-"));
process.env.APP_URL = "https://flowplan.test";
const { one, all, run } = await import("../lib/db");
const { register, passwordLogin, verifyEmail, resendVerification } = await import("../lib/local-auth");
const { saveInstanceSettings, instanceSettings } = await import("../lib/instance-settings");
const { command } = await import("../lib/api");
const { deletionPlan } = await import("../lib/account-deletion");

const mails = () => all<{ recipient: string; text: string }>("SELECT recipient,text FROM mail_queue ORDER BY rowid");
const linkIn = (text: string) => /verify\?token=([A-Za-z0-9_-]+)/.exec(text)?.[1] || "";
const identity = (id: string, isAdmin = false) => ({ id, name: "x", email: "x", groups: [], isAdmin }) as never as Parameters<typeof command>[0];

test("the first account and instances without e-mail start right away", async () => {
  delete process.env.SMTP_HOST;
  const first = await register({ name: "Admin", email: "admin@example.test", password: "a-long-password" }, "de");
  assert.equal(first.pending, false);
  saveInstanceSettings({ ...instanceSettings(), allowSignup: true });
  const noMail = await register({ name: "Ohne Mail", email: "nomail@example.test", password: "a-long-password" }, "de");
  assert.equal(noMail.pending, false);
  assert.ok(await passwordLogin({ email: "nomail@example.test", password: "a-long-password" }, "1.1.1.1", "de"));
});

test("with e-mail set up, a new account confirms its address before signing in", async () => {
  process.env.SMTP_HOST = "smtp.example.test";
  const result = await register({ name: "Lena", email: "lena@example.test", password: "a-long-password" }, "de");
  assert.equal(result.pending, true);
  const sent = mails().filter((m) => m.recipient === "lena@example.test");
  assert.equal(sent.length, 1);
  await assert.rejects(passwordLogin({ email: "lena@example.test", password: "a-long-password" }, "1.1.1.2", "de"), /bestätige zuerst/);
  // No second mail within five minutes, neither by signing in nor by asking again.
  resendVerification({ email: "lena@example.test" }, "de");
  assert.equal(mails().filter((m) => m.recipient === "lena@example.test").length, 1);
  assert.equal(verifyEmail("wrong-token"), null);
  assert.equal(verifyEmail(linkIn(sent[0].text)), result.user.id);
  assert.ok(await passwordLogin({ email: "lena@example.test", password: "a-long-password" }, "1.1.1.2", "de"));
  // Without e-mail nobody stays locked out.
  const other = await register({ name: "Tom", email: "tom@example.test", password: "a-long-password" }, "de");
  assert.equal(other.pending, true);
  delete process.env.SMTP_HOST;
  assert.ok(await passwordLogin({ email: "tom@example.test", password: "a-long-password" }, "1.1.1.3", "de"));
  // Admins can confirm by hand.
  process.env.SMTP_HOST = "smtp.example.test";
  const admin = one<{ id: string }>("SELECT user_id id FROM local_accounts WHERE email='admin@example.test'")!.id;
  command(identity(admin, true), { action: "admin.confirmEmail", userId: other.user.id });
  assert.ok(await passwordLogin({ email: "tom@example.test", password: "a-long-password" }, "1.1.1.3", "de"));
  delete process.env.SMTP_HOST;
});

test("deleting an account: only after deactivating; own workspaces go, shared ones stay with a new owner", async () => {
  const admin = one<{ id: string }>("SELECT user_id id FROM local_accounts WHERE email='admin@example.test'")!.id;
  const leaving = (await register({ name: "Weg", email: "weg@example.test", password: "a-long-password" }, "de")).user.id;
  const staying = (await register({ name: "Bleibt", email: "bleibt@example.test", password: "a-long-password" }, "de")).user.id;
  const own = (command(identity(leaving), { action: "workspace.create", name: "Nur meins" }) as { id: string }).id;
  const shared = (command(identity(leaving), { action: "workspace.create", name: "Gemeinsam" }) as { id: string }).id;
  run("INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,'editor')", shared, staying);
  const plan = deletionPlan(leaving);
  assert.deepEqual(plan.removed.map((w) => w.name).sort(), ["Nur meins"]);
  assert.deepEqual(plan.handedOver, [{ id: shared, name: "Gemeinsam", to: "Bleibt" }]);
  assert.throws(() => command(identity(admin, true), { action: "admin.deleteUser", userId: leaving }), /zuerst deaktivieren/);
  assert.throws(() => command(identity(leaving), { action: "admin.deleteUser", userId: leaving }));
  run("UPDATE users SET disabled=1 WHERE id=?", leaving);
  command(identity(admin, true), { action: "admin.deleteUser", userId: leaving });
  assert.equal(one("SELECT 1 FROM workspaces WHERE id=?", own), undefined);
  assert.equal(one<{ role: string }>("SELECT role FROM members WHERE workspace_id=? AND user_id=?", shared, staying)?.role, "owner");
  assert.equal(one("SELECT 1 FROM local_accounts WHERE user_id=?", leaving), undefined);
  const rest = one<{ name: string; email: string }>("SELECT name,email FROM users WHERE id=?", leaving);
  // Gone, or an empty shell where it is still named as author.
  assert.ok(!rest || (rest.name === "Gelöschtes Konto" && rest.email === ""));
  // Not oneself, and never the last admin.
  assert.throws(() => command(identity(admin, true), { action: "admin.deleteUser", userId: admin }), /eigene Konto/);
});
