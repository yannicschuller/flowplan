// SSO groups → workspace membership and workspace groups (lib/sso-mappings.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
const dir = mkdtempSync(join(tmpdir(), "flowplan-sso-mappings-"));
process.env.FLOWPLAN_DATA_DIR = dir;
const { run, id, one, all } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command } = await import("../lib/api");
const { syncSsoMemberships, ssoSources } = await import("../lib/sso-mappings");

async function account(name: string, local = false) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, local ? `local:${uid}` : `https://idp|${uid}`, name, `${name}@example.test`);
  if (local)
    await run("INSERT INTO local_accounts(user_id,email,password_hash,created_at) VALUES(?,?,?,?)", uid, `${name}@example.test`, "x", Date.now());
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const role = async (wid: string, uid: string) => (await one<{ role: string }>("SELECT role FROM members WHERE workspace_id=? AND user_id=?", wid, uid))?.role ?? null;
const inGroup = async (gid: string, uid: string) => !!(await one("SELECT 1 FROM group_members WHERE group_id=? AND user_id=?", gid, uid));

// The owner here also administers the instance: only admins map SSO groups.
const owner = { ...(await account("owner")), isAdmin: true } as Identity;
const wid = await createWorkspace(owner.id, "Firma");
const marketing = ((await command(owner, { action: "group.create", workspaceId: wid, name: "Marketing" })) as { id: string }).id;
await command(owner, { action: "sso.mapping.add", workspaceId: wid, ssoGroup: "staff", role: "viewer" });
await command(owner, { action: "sso.mapping.add", workspaceId: wid, ssoGroup: "editors", role: "editor" });
await command(owner, { action: "sso.mapping.add", workspaceId: wid, ssoGroup: "mkt", groupId: marketing });
await command(owner, { action: "sso.mapping.add", workspaceId: wid, ssoGroup: "leads", role: "owner", groupId: marketing });

test("only owners who administer the instance map SSO groups, never in the demo", async () => {
  // Anyone may create a workspace: a mapping there would pull in people of
  // the whole instance and show their addresses.
  const mallory = await account("mallory");
  const own = await createWorkspace(mallory.id, "Eigener");
  await assert.rejects(async () => await command(mallory, { action: "sso.mapping.add", workspaceId: own, ssoGroup: "staff", role: "viewer" }), /Administrator/);
  assert.equal(await one("SELECT 1 FROM sso_mappings WHERE workspace_id=?", own), undefined);
  const demo = { ...mallory, demo: true, isAdmin: true } as unknown as Identity;
  await assert.rejects(async () => await command(demo, { action: "sso.mapping.add", workspaceId: own, ssoGroup: "staff", role: "viewer" }), /Demo/);
});

test("only owners map SSO groups; a mapping needs a role or a group", async () => {
  const ed = await account("ed");
  await run("INSERT INTO members VALUES(?,?,?)", wid, ed.id, "editor");
  await assert.rejects(async () => await command(ed, { action: "sso.mapping.add", workspaceId: wid, ssoGroup: "x", role: "viewer" }), /Berechtigung/);
  await assert.rejects(async () => await command(owner, { action: "sso.mapping.add", workspaceId: wid, ssoGroup: "x" }));
  await assert.rejects(async () => await command(owner, { action: "sso.mapping.add", workspaceId: wid, ssoGroup: "staff", role: "viewer" }), /gibt es schon/);
  await assert.rejects(async () => await command(ed, { action: "admin.ssoMapping.add", workspaceId: wid, ssoGroup: "x", role: "viewer" }), /Administrator/);
});

test("a matching SSO group adds the membership and the group membership", async () => {
  const ana = await account("ana");
  await syncSsoMemberships(ana.id, ["staff", "mkt", "unrelated"]);
  assert.equal(await role(wid, ana.id), "viewer");
  assert.ok(await inGroup(marketing, ana.id));
  assert.deepEqual(
    (await ssoSources(wid)).filter((s) => s.user_id === ana.id).map((s) => `${s.target || "member"}:${s.sso_group}`).sort(),
    [`${marketing}:mkt`, "member:staff"],
  );
  // The highest mapped role wins and changes with the groups.
  await syncSsoMemberships(ana.id, ["staff", "editors", "mkt"]);
  assert.equal(await role(wid, ana.id), "editor");
  await syncSsoMemberships(ana.id, ["staff"]);
  assert.equal(await role(wid, ana.id), "viewer");
  assert.equal(await inGroup(marketing, ana.id), false, "group membership goes with the SSO group");
  // Losing every mapped group removes the membership again.
  await syncSsoMemberships(ana.id, []);
  assert.equal(await role(wid, ana.id), null);
  assert.equal((await ssoSources(wid)).some((s) => s.user_id === ana.id), false);
});

test("SSO always wins over memberships added or changed by hand", async () => {
  const ben = await account("ben");
  await run("INSERT INTO members VALUES(?,?,?)", wid, ben.id, "owner");
  await run("INSERT INTO group_members VALUES(?,?)", marketing, ben.id);
  // No mapping matches: what was added by hand stays.
  await syncSsoMemberships(ben.id, ["unrelated"]);
  assert.equal(await role(wid, ben.id), "owner", "unmatched manual membership kept");
  assert.ok(await inGroup(marketing, ben.id), "unmatched manual group membership kept");
  // A matching mapping sets the role and takes both over.
  await syncSsoMemberships(ben.id, ["staff", "mkt"]);
  assert.equal(await role(wid, ben.id), "viewer", "the mapping sets the role");
  assert.ok(await inGroup(marketing, ben.id));
  await syncSsoMemberships(ben.id, []);
  assert.equal(await role(wid, ben.id), null, "now SSO-managed: goes with the SSO groups");
  assert.equal(await inGroup(marketing, ben.id), false);
});

test("a manual change lasts until the next SSO sign-in", async () => {
  const cem = await account("cem");
  await syncSsoMemberships(cem.id, ["staff", "mkt"]);
  await command(owner, { action: "member.role", workspaceId: wid, userId: cem.id, role: "editor" });
  await command(owner, { action: "group.member", workspaceId: wid, groupId: marketing, userId: cem.id, enabled: false });
  assert.equal(await role(wid, cem.id), "editor");
  assert.equal(await inGroup(marketing, cem.id), false);
  await syncSsoMemberships(cem.id, ["staff", "mkt"]);
  assert.equal(await role(wid, cem.id), "viewer", "the mapping sets the role again");
  assert.ok(await inGroup(marketing, cem.id), "the mapping adds the group again");
  await syncSsoMemberships(cem.id, []);
  assert.equal(await role(wid, cem.id), null);
});

test("the last owner granted through SSO is neither demoted nor removed", async () => {
  const dora = await account("dora");
  const other = await account("other");
  const ws = await createWorkspace(other.id, "Team");
  // Instance administrators map for any workspace.
  const admin = { ...owner, isAdmin: true };
  await command(admin, { action: "admin.ssoMapping.add", workspaceId: ws, ssoGroup: "leads", role: "owner" });
  await command(admin, { action: "admin.ssoMapping.add", workspaceId: ws, ssoGroup: "staff", role: "viewer" });
  await syncSsoMemberships(dora.id, ["leads"]);
  assert.equal(await role(ws, dora.id), "owner");
  // The manual founder leaves: dora is the only owner now.
  await run("DELETE FROM members WHERE workspace_id=? AND user_id=?", ws, other.id);
  await syncSsoMemberships(dora.id, ["staff"]);
  assert.equal(await role(ws, dora.id), "owner", "last owner not demoted");
  await syncSsoMemberships(dora.id, []);
  assert.equal(await role(ws, dora.id), "owner", "last owner not removed");
  // With another owner, the SSO membership goes.
  await run("INSERT INTO members VALUES(?,?,?)", ws, other.id, "owner");
  await syncSsoMemberships(dora.id, []);
  assert.equal(await role(ws, dora.id), null);
});

test("accounts with e-mail and password are not affected", async () => {
  const lea = await account("lea", true);
  await syncSsoMemberships(lea.id, ["staff", "mkt", "leads"]);
  assert.equal(await role(wid, lea.id), null);
  assert.equal(await inGroup(marketing, lea.id), false);
});

test("changing a mapping applies right away to people signed in through SSO", async () => {
  const eva = await account("eva");
  await run("INSERT INTO sessions(token,user_id,groups_json,expires,created_at,sso) VALUES(?,?,?,?,?,1)", id(), eva.id, JSON.stringify(["design"]), Date.now() + 3600_000, Date.now());
  const mapping = (await command(owner, { action: "sso.mapping.add", workspaceId: wid, ssoGroup: "design", role: "editor" })) as { id: string };
  assert.equal(await role(wid, eva.id), "editor");
  await command(owner, { action: "sso.mapping.delete", workspaceId: wid, id: mapping.id });
  assert.equal(await role(wid, eva.id), null);
  assert.equal((await all("SELECT 1 FROM sso_sources WHERE user_id=?", eva.id)).length, 0);
});
