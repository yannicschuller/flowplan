// Directory groups by hand (#451, lib/directory-groups.ts): administrators
// add people to SCIM, LDAP and SSO groups and remove them – stored in
// scim_group_members (marked) for SCIM groups, apart for LDAP/SSO groups,
// a new name becomes a SCIM group; limits and AI rules apply at once;
// audited, administrators only, never with an API token.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-directory-groups-"));
process.env.APP_URL = "https://flowplan.example.com";
const { run, one, all, id } = await import("../lib/db");
const { command } = await import("../lib/api");
const { saveInstanceSettings, instanceSettings } = await import("../lib/instance-settings");
const limits = await import("../lib/user-limits");
const quota = await import("../lib/ai/quota");
const { chooseModel } = await import("../lib/ai/model-policy");
const { handleScim, createScimToken } = await import("../lib/scim");
const { personGroupKeys, groupChoices } = await import("../lib/person-groups");
const { directoryGroupName } = await import("../lib/directory-groups");
import type { Identity } from "../lib/types";
import type { DirectoryGroupInfo, DirectoryMembership } from "../lib/directory-groups";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const person = async (isAdmin = false, name = "Test") => {
  const uid = randomUUID();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, `test:${uid}`, name, `${uid}@example.test`);
  return { id: uid, name, email: `${uid}@example.test`, groups: [], isAdmin } as never as Identity;
};
const admin = await person(true, "Admin");
const { token } = await createScimToken(admin.id, "Billing");
async function scim(method: string, path: string, body?: unknown) {
  const [p, q = ""] = path.split("?");
  const result = await handleScim({ method, path: p.split("/").filter(Boolean), query: new URLSearchParams(q), authorization: `Bearer ${token}`, body: body === undefined ? "" : JSON.stringify(body) });
  return { status: result.status, body: result.body as Json };
}
const PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const LINK = "urn:ietf:params:scim:schemas:extension:flowplan:2.0:User";
const groupsOf = async (userId: string) => ((await command(admin, { action: "admin.directoryGroups", userId })) as { groups: DirectoryMembership[]; names: string[]; existing: string[] });
const add = (userId: string, name: string) => command(admin, { action: "admin.directoryGroupAdd", userId, name }) as Promise<Json>;
const remove = (userId: string, name: string) => command(admin, { action: "admin.directoryGroupRemove", userId, name }) as Promise<Json>;
const auditOf = async (action: string, resource: string) => await all<{ actor_id: string; detail: string }>("SELECT actor_id,detail FROM audit WHERE action=? AND resource_id=?", action, resource);

test("name rules: those of a SCIM displayName", () => {
  assert.equal(directoryGroupName("  Flowplan Plus "), "Flowplan Plus");
  assert.throws(() => directoryGroupName(""), /fehlt/);
  assert.throws(() => directoryGroupName("   "), /fehlt/);
  assert.throws(() => directoryGroupName(42), /fehlt/);
  assert.throws(() => directoryGroupName("x".repeat(201)), /200/);
  assert.equal(directoryGroupName("x".repeat(200)).length, 200);
  assert.throws(() => directoryGroupName("a\nb"), /Steuerzeichen/);
});

test("a SCIM group: the hand-made member is a member for SCIM (GET /Groups), marked, the version moves, and a client's PATCH keeps it", async () => {
  // The billing service links an existing account and creates "Plus".
  const kim = await person(false, "Kim");
  const linked = await scim("POST", "/Users", { userName: kim.email, emails: [{ value: kim.email, primary: true }], [LINK]: { linkExisting: true } });
  // linkExisting needs a confirmed address.
  assert.equal(linked.status, 404);
  await run("UPDATE users SET email_verified=1 WHERE id=?", kim.id);
  const kimScim = (await scim("POST", "/Users", { userName: kim.email, emails: [{ value: kim.email, primary: true }], [LINK]: { linkExisting: true } })).body.id as string;
  const group = await scim("POST", "/Groups", { displayName: "Plus", members: [] });
  assert.equal(group.status, 201);
  assert.equal(group.body.meta.version, 'W/"1"');

  const result = await add(kim.id, "plus");
  assert.deepEqual(result, { name: "Plus", stored: "scim", created: false, already: false }, "the SCIM group of that name, whatever the case");
  const got = await scim("GET", `/Groups/${group.body.id}`);
  assert.deepEqual(got.body.members.map((m: Json) => m.value), [kimScim]);
  assert.equal(got.body.meta.version, 'W/"2"', "SCIM clients see the change");
  assert.deepEqual(Object.keys(got.body).sort(), ["displayName", "id", "members", "meta", "schemas"], "the standard shape");
  assert.equal((await one<{ added_by: string }>("SELECT added_by FROM scim_group_members WHERE group_id=? AND user_id=?", group.body.id, kim.id))?.added_by, admin.id);
  const view = await groupsOf(kim.id);
  assert.deepEqual(view.groups, [{ name: "Plus", sources: ["scim"], byHand: true, removable: true, fixed: [] }]);
  assert.ok(view.names.includes("Plus"));
  assert.ok(view.existing.includes("Plus"));
  // Once more: nothing changes.
  assert.equal((await add(kim.id, "Plus")).already, true);
  assert.equal((await scim("GET", `/Groups/${group.body.id}`)).body.meta.version, 'W/"2"');
  // The client renames the group: the member stays.
  assert.equal((await scim("PATCH", `/Groups/${group.body.id}`, { schemas: [PATCH], Operations: [{ op: "replace", path: "displayName", value: "Plus" }] })).status, 200);
  assert.deepEqual((await scim("GET", `/Groups/${group.body.id}`)).body.members.map((m: Json) => m.value), [kimScim]);
  // Audited.
  const entries = await auditOf("admin.directoryGroup.add", kim.id);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].actor_id, admin.id);
  assert.deepEqual(JSON.parse(entries[0].detail), { group: "Plus", stored: "scim" });

  // Removed by hand: gone for SCIM too, version moves.
  const before = Number(/\d+/.exec((await scim("GET", `/Groups/${group.body.id}`)).body.meta.version)![0]);
  assert.deepEqual(await remove(kim.id, "Plus"), { name: "Plus", removed: ["scim"], remains: [] });
  const after = await scim("GET", `/Groups/${group.body.id}`);
  assert.deepEqual(after.body.members, []);
  assert.equal(after.body.meta.version, `W/"${before + 1}"`);
  assert.equal((await auditOf("admin.directoryGroup.remove", kim.id)).length, 1);
  await assert.rejects(remove(kim.id, "Plus"), /nicht in der Gruppe/);
});

test("an account the SCIM client never provisioned: a member in Flowplan, not listed by SCIM, and kept by the client's PUT and DELETE /Users", async () => {
  const friend = await person(false, "Friend");
  const group = await scim("POST", "/Groups", { displayName: "Friends", members: [] });
  await add(friend.id, "Friends");
  assert.ok((await personGroupKeys(friend.id)).includes("dir:Friends"));
  assert.deepEqual((await scim("GET", `/Groups/${group.body.id}`)).body.members, [], "no SCIM user to name");
  // Okta-style full replace without them: they stay.
  assert.equal((await scim("PUT", `/Groups/${group.body.id}`, { displayName: "Friends", members: [] })).status, 200);
  assert.equal((await scim("PATCH", `/Groups/${group.body.id}`, { schemas: [PATCH], Operations: [{ op: "replace", path: "members", value: [] }] })).status, 200);
  assert.ok((await personGroupKeys(friend.id)).includes("dir:Friends"));
  // A provisioned account added by hand, then DELETE /Users: the hand-made membership stays, SCIM ones go.
  const pat = await person(false, "Pat");
  await run("UPDATE users SET email_verified=1 WHERE id=?", pat.id);
  const patScim = (await scim("POST", "/Users", { userName: pat.email, emails: [{ value: pat.email }], [LINK]: { linkExisting: true } })).body.id as string;
  const other = await scim("POST", "/Groups", { displayName: "From SCIM", members: [{ value: patScim }] });
  await add(pat.id, "Friends");
  assert.equal((await scim("DELETE", `/Users/${patScim}`)).status, 204);
  const keys = await personGroupKeys(pat.id);
  assert.ok(keys.includes("dir:Friends"));
  assert.ok(!keys.includes("dir:From SCIM"));
  assert.deepEqual((await scim("GET", `/Groups/${other.body.id}`)).body.members, []);
});

test("a new name becomes a SCIM group that SCIM clients see", async () => {
  const sam = await person(false, "Sam");
  const result = await add(sam.id, "  Beta Testers ");
  assert.deepEqual(result, { name: "Beta Testers", stored: "scim", created: true, already: false });
  const list = await scim("GET", `/Groups?filter=${encodeURIComponent('displayName eq "Beta Testers"')}`);
  assert.equal(list.body.totalResults, 1);
  assert.equal(list.body.Resources[0].displayName, "Beta Testers");
  assert.equal(list.body.Resources[0].meta.version, 'W/"1"');
  assert.equal((await auditOf("admin.directoryGroup.create", list.body.Resources[0].id)).length, 1);
  assert.ok((await groupChoices()).some((g) => g.directory && g.name === "Beta Testers" && g.members === 1));
  // Invalid names are refused before anything is stored.
  await assert.rejects(add(sam.id, "x".repeat(201)), /200/);
  await assert.rejects(add(sam.id, " "), /fehlt/);
  await assert.rejects(add(randomUUID(), "Beta Testers"), /gibt es nicht/);
});

test("an SSO group: stored apart, survives the next sign-in, the SSO membership itself cannot be removed by hand", async () => {
  const sso = await person(false, "Sso");
  const session = id();
  await run("INSERT INTO sessions(token,user_id,groups_json,expires,created_at,sso) VALUES(?,?,?,?,?,1)", session, sso.id, JSON.stringify(["Staff", "Ops"]), Date.now() + 3600_000, Date.now());
  const ann = await person(false, "Ann");
  assert.deepEqual(await add(ann.id, "Staff"), { name: "Staff", stored: "manual", created: false, already: false });
  assert.equal(await one("SELECT 1 FROM scim_groups WHERE display_name='Staff'"), undefined, "no SCIM group for an SSO group");
  assert.ok((await personGroupKeys(ann.id)).includes("dir:Staff"));
  // The SSO person: Staff from SSO – read-only; given Staff by hand as well, then removed: SSO remains.
  assert.deepEqual((await groupsOf(sso.id)).groups.find((g) => g.name === "Staff"), { name: "Staff", sources: ["sso"], byHand: false, removable: false, fixed: ["sso"] });
  await assert.rejects(remove(sso.id, "Staff"), /kommt aus SSO – dort ändern/);
  await add(sso.id, "Staff");
  assert.deepEqual((await groupsOf(sso.id)).groups.find((g) => g.name === "Staff"), { name: "Staff", sources: ["sso"], byHand: true, removable: true, fixed: ["sso"] });
  // A new sign-in without Staff: the hand-made membership survives.
  await run("INSERT INTO sessions(token,user_id,groups_json,expires,created_at,sso) VALUES(?,?,?,?,?,1)", id(), sso.id, JSON.stringify(["Ops"]), Date.now() + 3600_000, Date.now() + 1);
  assert.ok((await personGroupKeys(sso.id)).includes("dir:Staff"));
  assert.deepEqual(await remove(sso.id, "Staff"), { name: "Staff", removed: ["manual"], remains: [] });
  assert.ok(!(await personGroupKeys(sso.id)).includes("dir:Staff"));
  // The members dialog: everyone with where it comes from.
  const members = (await command(admin, { action: "admin.directoryGroupMembers", name: "Ops" })) as DirectoryGroupInfo;
  assert.equal(members.scim, false);
  assert.deepEqual(members.members.map((m) => [m.userName, m.sources, m.byHand, m.removable]), [["Sso", ["sso"], false, false]]);
  const staff = (await command(admin, { action: "admin.directoryGroupMembers", name: "Staff" })) as DirectoryGroupInfo;
  assert.deepEqual(staff.members.map((m) => [m.userName, m.byHand, m.removable]), [["Ann", true, true]]);
});

test("limits and AI rules of the group apply right after adding", async () => {
  await saveInstanceSettings({ ...(await instanceSettings()), defaultUserStorageMb: 500, defaultUserWorkspaces: 3, maxUploadMb: 10 });
  const lee = await person(false, "Lee");
  await command(admin, { action: "admin.groupLimits", target: "dir:Gold", limits: { storageMb: 9000 } });
  assert.equal((await limits.effectiveUserLimits(lee.id)).storageMb, 500);
  await add(lee.id, "Gold");
  const details = await limits.userLimitDetails(lee.id);
  assert.equal(details.values.storageMb, 9000);
  assert.deepEqual(details.sources.storageMb, { from: "group", group: "dir:Gold" });
  // AI: the group's quota and model rule.
  const who = await quota.quotaPerson(lee);
  assert.ok(who.groups.includes("dir:Gold"));
  const personal = quota.personalLimits([{ scope: "group", target: "dir:Gold", exempt: false, limits: { month: 77 } }], who);
  assert.deepEqual(personal.limits, { month: 77 });
  assert.equal(chooseModel([{ scope: "group", target: "dir:Gold", model: "big", kind: "ollama" }], who, { kind: "ollama", model: "small" }, []).model, "big");
  await remove(lee.id, "Gold");
  assert.equal((await limits.effectiveUserLimits(lee.id)).storageMb, 500);
  assert.ok(!(await quota.quotaPerson(lee)).groups.includes("dir:Gold"));
  await command(admin, { action: "admin.groupLimits", target: "dir:Gold", limits: null });
});

test("administrators only, never with an API token", async () => {
  const someone = await person(false, "Someone");
  for (const body of [
    { action: "admin.directoryGroups", userId: someone.id },
    { action: "admin.directoryGroupMembers", name: "Plus" },
    { action: "admin.directoryGroupAdd", userId: someone.id, name: "Plus" },
    { action: "admin.directoryGroupRemove", userId: someone.id, name: "Plus" },
  ]) {
    await assert.rejects(command(someone, body), /Administrator/);
    await assert.rejects(command({ ...admin, apiScope: "write" } as Identity, body), /API-Token/);
  }
  assert.ok(!(await personGroupKeys(someone.id)).includes("dir:Plus"));
});

test("a deleted account's hand-made memberships go with it", async () => {
  const gone = await person(false, "Gone");
  await run("INSERT INTO sessions(token,user_id,groups_json,expires,created_at,sso) VALUES(?,?,?,?,?,1)", id(), (await person(false, "X")).id, JSON.stringify(["Leaving"]), Date.now() + 3600_000, Date.now());
  await add(gone.id, "Leaving");
  await run("DELETE FROM users WHERE id=?", gone.id);
  assert.equal(await one("SELECT 1 FROM directory_group_members WHERE user_id=?", gone.id), undefined);
});
