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

function account(name: string, local = false) {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, local ? `local:${uid}` : `https://idp|${uid}`, name, `${name}@example.test`);
  if (local)
    run("INSERT INTO local_accounts(user_id,email,password_hash,created_at) VALUES(?,?,?,?)", uid, `${name}@example.test`, "x", Date.now());
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const role = (wid: string, uid: string) => one<{ role: string }>("SELECT role FROM members WHERE workspace_id=? AND user_id=?", wid, uid)?.role ?? null;
const inGroup = (gid: string, uid: string) => !!one("SELECT 1 FROM group_members WHERE group_id=? AND user_id=?", gid, uid);

const owner = account("owner");
const wid = createWorkspace(owner.id, "Firma");
const marketing = (command(owner, { action: "group.create", workspaceId: wid, name: "Marketing" }) as { id: string }).id;
command(owner, { action: "sso.mapping.add", workspaceId: wid, ssoGroup: "staff", role: "viewer" });
command(owner, { action: "sso.mapping.add", workspaceId: wid, ssoGroup: "editors", role: "editor" });
command(owner, { action: "sso.mapping.add", workspaceId: wid, ssoGroup: "mkt", groupId: marketing });
command(owner, { action: "sso.mapping.add", workspaceId: wid, ssoGroup: "leads", role: "owner", groupId: marketing });

test("only owners map SSO groups; a mapping needs a role or a group", () => {
  const ed = account("ed");
  run("INSERT INTO members VALUES(?,?,?)", wid, ed.id, "editor");
  assert.throws(() => command(ed, { action: "sso.mapping.add", workspaceId: wid, ssoGroup: "x", role: "viewer" }), /Berechtigung/);
  assert.throws(() => command(owner, { action: "sso.mapping.add", workspaceId: wid, ssoGroup: "x" }));
  assert.throws(() => command(owner, { action: "sso.mapping.add", workspaceId: wid, ssoGroup: "staff", role: "viewer" }), /gibt es schon/);
  assert.throws(() => command(ed, { action: "admin.ssoMapping.add", workspaceId: wid, ssoGroup: "x", role: "viewer" }), /Administrator/);
});

test("a matching SSO group adds the membership and the group membership", () => {
  const ana = account("ana");
  syncSsoMemberships(ana.id, ["staff", "mkt", "unrelated"]);
  assert.equal(role(wid, ana.id), "viewer");
  assert.ok(inGroup(marketing, ana.id));
  assert.deepEqual(
    ssoSources(wid).filter((s) => s.user_id === ana.id).map((s) => `${s.target || "member"}:${s.sso_group}`).sort(),
    [`${marketing}:mkt`, "member:staff"],
  );
  // The highest mapped role wins and changes with the groups.
  syncSsoMemberships(ana.id, ["staff", "editors", "mkt"]);
  assert.equal(role(wid, ana.id), "editor");
  syncSsoMemberships(ana.id, ["staff"]);
  assert.equal(role(wid, ana.id), "viewer");
  assert.equal(inGroup(marketing, ana.id), false, "group membership goes with the SSO group");
  // Losing every mapped group removes the membership again.
  syncSsoMemberships(ana.id, []);
  assert.equal(role(wid, ana.id), null);
  assert.equal(ssoSources(wid).some((s) => s.user_id === ana.id), false);
});

test("memberships and group memberships added by hand are never changed or removed", () => {
  const ben = account("ben");
  run("INSERT INTO members VALUES(?,?,?)", wid, ben.id, "owner");
  run("INSERT INTO group_members VALUES(?,?)", marketing, ben.id);
  syncSsoMemberships(ben.id, ["staff", "mkt"]);
  assert.equal(role(wid, ben.id), "owner", "manual owner not demoted");
  syncSsoMemberships(ben.id, []);
  assert.equal(role(wid, ben.id), "owner", "manual membership kept");
  assert.ok(inGroup(marketing, ben.id), "manual group membership kept");
  run("DELETE FROM members WHERE workspace_id=? AND user_id=?", wid, ben.id);
  run("DELETE FROM group_members WHERE user_id=?", ben.id);
});

test("a manual role change takes the membership over from SSO", () => {
  const cem = account("cem");
  syncSsoMemberships(cem.id, ["staff"]);
  command(owner, { action: "member.role", workspaceId: wid, userId: cem.id, role: "editor" });
  syncSsoMemberships(cem.id, []);
  assert.equal(role(wid, cem.id), "editor");
});

test("the last owner granted through SSO is neither demoted nor removed", () => {
  const dora = account("dora");
  const other = account("other");
  const ws = createWorkspace(other.id, "Team");
  // Instance administrators map for any workspace.
  const admin = { ...owner, isAdmin: true };
  command(admin, { action: "admin.ssoMapping.add", workspaceId: ws, ssoGroup: "leads", role: "owner" });
  command(admin, { action: "admin.ssoMapping.add", workspaceId: ws, ssoGroup: "staff", role: "viewer" });
  syncSsoMemberships(dora.id, ["leads"]);
  assert.equal(role(ws, dora.id), "owner");
  // The manual founder leaves: dora is the only owner now.
  run("DELETE FROM members WHERE workspace_id=? AND user_id=?", ws, other.id);
  syncSsoMemberships(dora.id, ["staff"]);
  assert.equal(role(ws, dora.id), "owner", "last owner not demoted");
  syncSsoMemberships(dora.id, []);
  assert.equal(role(ws, dora.id), "owner", "last owner not removed");
  // With another owner, the SSO membership goes.
  run("INSERT INTO members VALUES(?,?,?)", ws, other.id, "owner");
  syncSsoMemberships(dora.id, []);
  assert.equal(role(ws, dora.id), null);
});

test("accounts with e-mail and password are not affected", () => {
  const lea = account("lea", true);
  syncSsoMemberships(lea.id, ["staff", "mkt", "leads"]);
  assert.equal(role(wid, lea.id), null);
  assert.equal(inGroup(marketing, lea.id), false);
});

test("changing a mapping applies right away to people signed in through SSO", () => {
  const eva = account("eva");
  run("INSERT INTO sessions(token,user_id,groups_json,expires,created_at,sso) VALUES(?,?,?,?,?,1)", id(), eva.id, JSON.stringify(["design"]), Date.now() + 3600_000, Date.now());
  const mapping = command(owner, { action: "sso.mapping.add", workspaceId: wid, ssoGroup: "design", role: "editor" }) as { id: string };
  assert.equal(role(wid, eva.id), "editor");
  command(owner, { action: "sso.mapping.delete", workspaceId: wid, id: mapping.id });
  assert.equal(role(wid, eva.id), null);
  assert.equal(all("SELECT 1 FROM sso_sources WHERE user_id=?", eva.id).length, 0);
});
