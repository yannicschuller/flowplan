// The groups of the latest OIDC sign-in per account (#289,
// lib/sso-group-report.ts): stored bounded, replaced at the next sign-in,
// the claim and whether it was missing, and only administrators read them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-sso-groups-"));
process.env.APP_URL = "https://flowplan.example.test";
delete process.env.OIDC_GROUPS_CLAIM;
delete process.env.OIDC_ADMIN_GROUP;
const { id, one, run } = await import("../lib/db");
const { HttpError, extractGroups } = await import("../lib/auth");
const r = await import("../lib/sso-group-report");

async function user(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, `https://idp.example.test|${uid}`, name, `${name}@example.test`);
  return uid;
}
const identity = (uid: string, isAdmin: boolean): Identity => ({ id: uid, name: "A", email: "a@example.test", groups: [], isAdmin, disabled: 0, created_at: "" });
const reportOf = async (uid: string) => (await r.ssoGroupReports(identity(uid, true))).find((x) => x.userId === uid);

test("the claim: present, empty, missing, and as a dot path", () => {
  assert.equal(r.groupsClaimName(), "groups");
  assert.equal(r.groupsClaimMissing({ groups: ["a"] }), false);
  assert.equal(r.groupsClaimMissing({ groups: [] }), false);
  assert.equal(r.groupsClaimMissing({ sub: "x" }), true);
  process.env.OIDC_GROUPS_CLAIM = "realm_access.roles";
  try {
    assert.equal(r.groupsClaimName(), "realm_access.roles");
    assert.equal(r.groupsClaimMissing({ realm_access: { roles: ["x"] } }), false);
    assert.equal(r.groupsClaimMissing({ realm_access: {} }), true);
    assert.equal(r.groupsClaimMissing({ groups: ["x"] }), true);
  } finally {
    delete process.env.OIDC_GROUPS_CLAIM;
  }
});

test("a sign-in is stored with time, claim and the admin group; the next replaces it", async () => {
  const uid = await user("kc");
  await r.recordSsoGroups(uid, ["staff", "flowplan-admins"], { claim: "groups", missing: false }, 1_000);
  let got = await reportOf(uid);
  assert.deepEqual(got, { userId: uid, at: 1_000, claim: "groups", claimMissing: false, groups: ["staff", "flowplan-admins"], groupCount: 2, adminGroup: "flowplan-admins", hasAdminGroup: true });
  // Keycloak with "Full group path": a leading slash – compared exactly, not an admin.
  process.env.OIDC_ADMIN_GROUP = "AdminGroup";
  try {
    const claims = { groups: ["/AdminGroup"] };
    await r.recordSsoGroups(uid, extractGroups(claims), { claim: r.groupsClaimName(), missing: r.groupsClaimMissing(claims) }, 2_000);
    got = await reportOf(uid);
    assert.equal(got?.at, 2_000);
    assert.deepEqual(got?.groups, ["/AdminGroup"]);
    assert.equal(got?.adminGroup, "AdminGroup");
    assert.equal(got?.hasAdminGroup, false);
  } finally {
    delete process.env.OIDC_ADMIN_GROUP;
  }
  assert.equal(Number((await one<{ n: number }>("SELECT count(*) n FROM sso_group_reports WHERE user_id=?", uid))?.n), 1);
});

test("the claim missing from token and userinfo is noted; unknown without the profile's note", async () => {
  const uid = await user("nomapper");
  const claims = { sub: "x", email: "x@example.test" };
  await r.recordSsoGroups(uid, extractGroups(claims), { claim: r.groupsClaimName(), missing: r.groupsClaimMissing(claims) });
  let got = await reportOf(uid);
  assert.equal(got?.claimMissing, true);
  assert.deepEqual(got?.groups, []);
  assert.equal(got?.hasAdminGroup, false);
  // A sign-in that waited to be connected carries no note: unknown when empty…
  await r.recordSsoGroups(uid, []);
  got = await reportOf(uid);
  assert.equal(got?.claimMissing, null);
  assert.equal(got?.claim, "groups");
  // …present when groups came.
  await r.recordSsoGroups(uid, ["a"]);
  assert.equal((await reportOf(uid))?.claimMissing, false);
});

test("bounded: at most 100 groups of at most 200 characters; the admin group counts from all", async () => {
  const uid = await user("many");
  const groups = Array.from({ length: 150 }, (_, i) => `g${i}-${"x".repeat(300)}`);
  groups.push("flowplan-admins");
  await r.recordSsoGroups(uid, groups, { claim: "groups", missing: false });
  const got = (await reportOf(uid))!;
  assert.equal(got.groups.length, r.MAX_REPORTED_GROUPS);
  assert.ok(got.groups.every((g) => g.length <= r.MAX_GROUP_LENGTH));
  assert.equal(got.groupCount, 151);
  assert.equal(got.hasAdminGroup, true);
});

test("only administrators read the reports; they go with the account", async () => {
  const uid = await user("gone");
  await r.recordSsoGroups(uid, ["a"], { claim: "groups", missing: false });
  await assert.rejects(() => r.ssoGroupReports(identity(uid, false)), (e) => e instanceof HttpError && e.status === 403);
  const all = await r.ssoGroupReports(identity(uid, true));
  assert.ok(all.some((x) => x.userId === uid));
  // Newest first.
  assert.ok(all.every((x, i) => i === 0 || all[i - 1].at >= x.at));
  await run("DELETE FROM users WHERE id=?", uid);
  assert.equal(await one("SELECT 1 FROM sso_group_reports WHERE user_id=?", uid), undefined);
});
