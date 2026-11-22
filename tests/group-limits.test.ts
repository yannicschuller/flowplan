// Limits per group (lib/user-limits.ts): storage, own workspaces and the
// largest upload for the members of a workspace group or a directory group
// – the resolution order, the administration, and the way a hosted billing
// service uses it: an existing account with e-mail and password, found by
// its address over SCIM, put into the SCIM group "Plus" and out again,
// without the account being taken over, changed or deactivated.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-group-limits-"));
process.env.APP_URL = "https://flowplan.example.com";
const { run, one, id } = await import("../lib/db");
const { saveInstanceSettings, instanceSettings } = await import("../lib/instance-settings");
const { command, bootstrap } = await import("../lib/api");
const limits = await import("../lib/user-limits");
const { handleScim, createScimToken, claimProvisionedAccount } = await import("../lib/scim");
const { hashPassword, passwordLogin } = await import("../lib/local-auth");
import type { Identity } from "../lib/types";
import type { GroupLimitsView, UserLimits } from "../lib/user-limits";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const person = async (isAdmin = false, name = "Test") => {
  const uid = randomUUID();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, `test:${uid}`, name, `${uid}@example.test`);
  return { id: uid, name, email: `${uid}@example.test`, groups: [], isAdmin } as never as Identity;
};
const admin = await person(true, "Admin");
const settings = () => ({ defaultUserStorageMb: 500, defaultUserWorkspaces: 3, maxUploadMb: 10 });

test("resolution: own value, else the most generous group value (0 = unlimited), else the default", () => {
  const rules = [
    { target: "g-small", limits: { storageMb: 1000, uploadMb: 20 } },
    { target: "g-big", limits: { storageMb: 5000 } },
    { target: "g-free", limits: { storageMb: 0, workspaces: 10 } },
    { target: "dir:Plus", limits: { uploadMb: 100 } },
  ];
  const resolve = (own: UserLimits, groups: string[]) => limits.resolveUserLimits(own, rules, groups, settings());
  // No groups: the defaults.
  assert.deepEqual(resolve({}, []), {
    values: { storageMb: 500, workspaces: 3, uploadMb: 10 },
    sources: { storageMb: { from: "default", group: null }, workspaces: { from: "default", group: null }, uploadMb: { from: "default", group: null } },
  });
  // One group: its values; what it leaves open comes from the default.
  const small = resolve({}, ["g-small"]);
  assert.deepEqual(small.values, { storageMb: 1000, workspaces: 3, uploadMb: 20 });
  assert.deepEqual(small.sources.storageMb, { from: "group", group: "g-small" });
  assert.deepEqual(small.sources.workspaces, { from: "default", group: null });
  // Several groups: the most generous per limit; 0 = unlimited wins.
  assert.deepEqual(resolve({}, ["g-small", "g-big"]).values, { storageMb: 5000, workspaces: 3, uploadMb: 20 });
  const all = resolve({}, ["g-small", "g-big", "g-free", "dir:Plus"]);
  assert.deepEqual(all.values, { storageMb: 0, workspaces: 10, uploadMb: 100 });
  assert.deepEqual(all.sources.storageMb, { from: "group", group: "g-free" });
  assert.deepEqual(all.sources.uploadMb, { from: "group", group: "dir:Plus" });
  // A group smaller than the default still applies (it is the group's value).
  assert.equal(limits.resolveUserLimits({}, [{ target: "g", limits: { storageMb: 100 } }], ["g"], settings()).values.storageMb, 100);
  // The account's own value wins, even a smaller one, and 0.
  const own = resolve({ storageMb: 200, workspaces: 0 }, ["g-big", "g-free"]);
  assert.deepEqual(own.values, { storageMb: 200, workspaces: 0, uploadMb: 10 });
  assert.deepEqual(own.sources.storageMb, { from: "user", group: null });
  // Groups the person is not in do not count.
  assert.deepEqual(resolve({}, ["other"]).values, { storageMb: 500, workspaces: 3, uploadMb: 10 });
});

test("workspace groups count in every workspace; admins stay unlimited; uploads per group", async () => {
  await saveInstanceSettings({ ...(await instanceSettings()), ...settings() });
  const owner = await person();
  const member = await person();
  const ws = ((await command(owner, { action: "workspace.create", name: "Fremd" })) as { id: string }).id;
  await run("INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,'editor')", ws, member.id);
  const group = id();
  await run("INSERT INTO groups(id,workspace_id,name) VALUES(?,?,?)", group, ws, "Viel Platz");
  await run("INSERT INTO group_members(group_id,user_id) VALUES(?,?)", group, member.id);
  assert.equal((await limits.effectiveUserLimits(member.id)).storageMb, 500);
  await command(admin, { action: "admin.groupLimits", target: group, limits: { storageMb: 2000, uploadMb: 50 } });
  assert.deepEqual(await limits.effectiveUserLimits(member.id), { storageMb: 2000, workspaces: 3, uploadMb: 50 });
  assert.equal(await limits.maxUploadMbFor(member), 50);
  assert.equal(await limits.maxUploadMbFor(owner), 10);
  // The person's own "Deine Grenzen" names the group.
  const boot = (await bootstrap(member)) as unknown as { myLimits: Json };
  assert.equal(boot.myLimits.storageMb, 2000);
  assert.deepEqual(boot.myLimits.sources.storageMb, { from: "group", group });
  assert.equal(boot.myLimits.groupNames[group], "Viel Platz");
  assert.equal(boot.myLimits.moreUrl, null);
  // The administration's list too.
  const row = (await limits.usersUsage()).find((u) => u.id === member.id)!;
  assert.equal(row.effective.storageMb, 2000);
  assert.deepEqual(row.sources.uploadMb, { from: "group", group });
  // Admins are not limited, whatever their groups say.
  const boss = await person(true);
  await run("INSERT INTO group_members(group_id,user_id) VALUES(?,?)", group, boss.id);
  await command(admin, { action: "admin.groupLimits", target: group, limits: { storageMb: 1, uploadMb: 1 } });
  await assert.doesNotReject(async () => await limits.enforceUserStorage(boss, 50 * 1024 * 1024));
  assert.equal(await limits.maxUploadMbFor(boss), 10);
  // Removed: back to the defaults.
  await command(admin, { action: "admin.groupLimits", target: group, limits: null });
  assert.deepEqual(await limits.effectiveUserLimits(member.id), { storageMb: 500, workspaces: 3, uploadMb: 10 });
});

test("only administrators set group limits; the group must exist or be a directory group by name", async () => {
  const someone = await person();
  await assert.rejects(command(someone, { action: "admin.groupLimits", target: "dir:Plus", limits: { storageMb: 1 } }), /Administrator|403|Nur/);
  await assert.rejects(command(admin, { action: "admin.groupLimits", target: randomUUID(), limits: { storageMb: 1 } }), /Gruppe nicht gefunden/);
  await assert.rejects(command(admin, { action: "admin.groupLimits", target: "dir: ", limits: { storageMb: 1 } }), /Gruppe nicht gefunden/);
  await assert.rejects(command(admin, { action: "admin.groupLimits", target: "dir:Plus", limits: { uploadMb: 0 } }));
  const view = (await command(admin, { action: "admin.groupLimits", target: "dir:Plus", limits: {} })) as GroupLimitsView;
  assert.deepEqual(view.rules.find((r) => r.target === "dir:Plus"), { target: "dir:Plus", limits: {} });
  // A directory group nobody pushed yet is offered by name.
  assert.ok(view.groups.some((g) => g.id === "dir:Plus" && g.directory));
  await command(admin, { action: "admin.groupLimits", target: "dir:Plus", limits: null });
  // The link for more: http(s) only.
  await assert.rejects(saveInstanceSettings({ moreLimitsUrl: "javascript:alert(1)" }));
  await saveInstanceSettings({ moreLimitsUrl: "https://billing.example.com/" });
  await command(someone, { action: "workspace.create", name: "Meins" });
  assert.equal(((await bootstrap(someone)) as unknown as { myLimits: Json }).myLimits.moreUrl, "https://billing.example.com/");
  await saveInstanceSettings({ moreLimitsUrl: "" });
});

/* ---------- The billing service's calls over SCIM ---------- */

const { token } = await createScimToken(admin.id, "Billing");
async function scim(method: string, path: string, body?: unknown) {
  const [p, q = ""] = path.split("?");
  const result = await handleScim({ method, path: p.split("/").filter(Boolean), query: new URLSearchParams(q), authorization: `Bearer ${token}`, body: body === undefined ? "" : JSON.stringify(body) });
  return { status: result.status, body: result.body as Json };
}
const LINK = "urn:ietf:params:scim:schemas:extension:flowplan:2.0:User";
const PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

test("SCIM: a local account found by its address joins the group “Plus”, gets its storage, and keeps its password and state", async () => {
  await saveInstanceSettings({ ...(await instanceSettings()), ...settings() });
  // An account with e-mail and password, made by sign-up – not by SCIM.
  const uid = randomUUID();
  const email = "kim@example.com";
  await run("INSERT INTO users(id,subject,name,email,email_verified) VALUES(?,?,?,?,1)", uid, `local:${uid}`, "Kim Kunde", email);
  await run("INSERT INTO local_accounts(user_id,email,password_hash,is_admin,email_verified,created_at) VALUES(?,?,?,0,1,?)", uid, email, await hashPassword("ein gutes Passwort 123"), Date.now());
  const before = await one<Json>("SELECT u.subject,u.name,u.email,u.disabled,a.password_hash FROM users u JOIN local_accounts a ON a.user_id=u.id WHERE u.id=?", uid);
  await command(admin, { action: "admin.groupLimits", target: "dir:Plus", limits: { storageMb: 2000, uploadMb: 100 } });
  assert.equal((await limits.effectiveUserLimits(uid)).storageMb, 500);

  // 1. Not provisioned yet: the filter finds nothing.
  const none = await scim("GET", `/Users?filter=${encodeURIComponent(`emails[value eq "${email}"]`)}`);
  assert.equal(none.status, 200);
  assert.equal(none.body.totalResults, 0);
  // 2. Link only: an unknown address creates no account.
  const unknown = await scim("POST", "/Users", { schemas: ["urn:ietf:params:scim:schemas:core:2.0:User", LINK], userName: "nobody@example.com", emails: [{ value: "nobody@example.com", primary: true }], [LINK]: { linkExisting: true } });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.scimType, "noTarget");
  assert.equal(await one("SELECT 1 FROM users WHERE email='nobody@example.com'"), undefined);
  // 3. Link the existing account (no name, no "active" in the request).
  const linked = await scim("POST", "/Users", { schemas: ["urn:ietf:params:scim:schemas:core:2.0:User", LINK], userName: email, emails: [{ value: email, primary: true }], [LINK]: { linkExisting: true } });
  assert.equal(linked.status, 201);
  assert.equal(linked.body.active, true);
  assert.equal(linked.body.displayName, "Kim Kunde");
  const scimId = linked.body.id as string;
  assert.equal((await one<{ user_id: string }>("SELECT user_id FROM scim_users WHERE id=?", scimId))!.user_id, uid);
  // Now the filter finds it (by address or userName).
  assert.equal((await scim("GET", `/Users?filter=${encodeURIComponent(`emails[value eq "${email}"]`)}`)).body.Resources[0].id, scimId);
  assert.equal((await scim("GET", `/Users?filter=${encodeURIComponent(`userName eq "${email}"`)}`)).body.Resources[0].id, scimId);
  // 4. The group "Plus" (created once) and the member added.
  const group = await scim("POST", "/Groups", { schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"], displayName: "Plus", members: [] });
  assert.equal(group.status, 201);
  const added = await scim("PATCH", `/Groups/${group.body.id}`, { schemas: [PATCH], Operations: [{ op: "add", path: "members", value: [{ value: scimId }] }] });
  assert.equal(added.status, 200);
  assert.deepEqual(added.body.members.map((m: Json) => m.value), [scimId]);
  const plus = await limits.userLimitDetails(uid);
  assert.deepEqual(plus.values, { storageMb: 2000, workspaces: 3, uploadMb: 100 });
  assert.deepEqual(plus.sources.storageMb, { from: "group", group: "dir:Plus" });
  // 5. Removed: back to the default.
  const removed = await scim("PATCH", `/Groups/${group.body.id}`, { schemas: [PATCH], Operations: [{ op: "remove", path: `members[value eq "${scimId}"]` }] });
  assert.equal(removed.status, 200);
  assert.deepEqual(await limits.effectiveUserLimits(uid), { storageMb: 500, workspaces: 3, uploadMb: 10 });
  // Nothing about the account changed: subject, name, address, password, state.
  assert.deepEqual(await one<Json>("SELECT u.subject,u.name,u.email,u.disabled,a.password_hash FROM users u JOIN local_accounts a ON a.user_id=u.id WHERE u.id=?", uid), before);
  // An OIDC sign-in with the same address does not take it over.
  await claimProvisionedAccount(`https://idp.example.com|sub-kim`, "sub-kim", email, true);
  assert.equal((await one<{ subject: string }>("SELECT subject FROM users WHERE id=?", uid))!.subject, `local:${uid}`);
  // The password sign-in keeps working.
  const login = await passwordLogin({ email, password: "ein gutes Passwort 123" }, "", "de");
  assert.equal(login.userId, uid);
  // Once more into the group and out by replacing the members (Entra/Okta style): still enabled.
  await scim("PATCH", `/Groups/${group.body.id}`, { schemas: [PATCH], Operations: [{ op: "replace", path: "members", value: [{ value: scimId }] }] });
  assert.equal((await limits.effectiveUserLimits(uid)).storageMb, 2000);
  await scim("PATCH", `/Groups/${group.body.id}`, { schemas: [PATCH], Operations: [{ op: "replace", path: "members", value: [] }] });
  assert.equal((await limits.effectiveUserLimits(uid)).storageMb, 500);
  assert.equal((await one<{ disabled: number }>("SELECT disabled FROM users WHERE id=?", uid))!.disabled, 0);
  // Linking a second time is refused, not a second account.
  assert.equal((await scim("POST", "/Users", { userName: "kim2", emails: [{ value: email }], [LINK]: { linkExisting: true } })).status, 404);
});

test("SCIM: linking an account an administrator disabled does not enable it", async () => {
  const uid = randomUUID();
  const email = "off@example.com";
  await run("INSERT INTO users(id,subject,name,email,email_verified,disabled) VALUES(?,?,?,?,1,1)", uid, `local:${uid}`, "Off", email);
  await run("INSERT INTO local_accounts(user_id,email,password_hash,is_admin,email_verified,created_at) VALUES(?,?,?,0,1,?)", uid, email, "x", Date.now());
  const linked = await scim("POST", "/Users", { userName: email, emails: [{ value: email }], [LINK]: { linkExisting: true } });
  assert.equal(linked.status, 201);
  assert.equal(linked.body.active, false);
  assert.equal((await one<{ disabled: number }>("SELECT disabled FROM users WHERE id=?", uid))!.disabled, 1);
});
