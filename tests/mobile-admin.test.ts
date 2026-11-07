// The administrators' widgets of the apps (lib/mobile-admin.ts,
// GET /api/mobile/admin-summary): only for devices of instance
// administrators, re-checked on every call, numbers and codes only, and
// without live numbers when the statistics are off.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-mobile-admin-"));
delete process.env.SMTP_HOST;
delete process.env.OIDC_ADMIN_GROUP;
const { id, run } = await import("../lib/db");
const { registerMobileDevice, identityFromDeviceToken, mobileSummary } = await import("../lib/mobile-devices");
const { isInstanceAdmin, mobileAdminSummary } = await import("../lib/mobile-admin");
const { saveMetricsSetting } = await import("../lib/metrics");

async function account(name: string, groups: string[]) {
  const uid = id(),
    token = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  await run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", token, uid, JSON.stringify(groups), Date.now() + 3600000);
  const user = { id: uid, name, email: `${name}@example.test`, groups, isAdmin: groups.includes("flowplan-admins"), disabled: 0, created_at: "" } as Identity;
  const { deviceToken } = await registerMobileDevice(user, token, { installationId: randomUUID(), platform: "ios" });
  return { user, token, header: `Bearer ${deviceToken}` };
}

test("only devices of instance administrators, checked against the session every time", async () => {
  const admin = await account("widget-admin", ["flowplan-admins"]);
  const member = await account("widget-member", ["staff"]);
  const adminIdentity = (await identityFromDeviceToken(admin.header))!;
  const memberIdentity = (await identityFromDeviceToken(member.header))!;
  // The device token never carries the administration itself.
  assert.equal(adminIdentity.isAdmin, false);
  assert.equal(isInstanceAdmin(adminIdentity), true);
  assert.equal(isInstanceAdmin(memberIdentity), false);
  assert.equal((await mobileSummary(adminIdentity)).admin, true);
  assert.equal((await mobileSummary(memberIdentity)).admin, false);
  // Leaving the admin group (a new sign-in with other groups) ends it.
  await run("UPDATE sessions SET groups_json=? WHERE token=?", JSON.stringify(["staff"]), admin.token);
  assert.equal(isInstanceAdmin((await identityFromDeviceToken(admin.header))!), false);
  await run("UPDATE sessions SET groups_json=? WHERE token=?", JSON.stringify(["flowplan-admins"]), admin.token);
  // A demo is never an administrator.
  assert.equal(isInstanceAdmin({ ...adminIdentity, demo: true }), false);
  // A removed device or an ended session: no identity at all (401).
  await run("DELETE FROM mobile_devices WHERE user_id=?", admin.user.id);
  assert.equal(await identityFromDeviceToken(admin.header), null);
});

test("the route refuses everyone but administrators' devices", () => {
  const route = readFileSync(join(import.meta.dirname, "../app/api/mobile/[action]/route.ts"), "utf8");
  assert.match(route, /identityFromDeviceToken[\s\S]*if \(action === "admin-summary"\) \{\s*\/\/[^\n]*\n\s*if \(!isInstanceAdmin\(user\)\) throw new HttpError\(403/);
});

test("state, live numbers and storage as numbers and codes", async () => {
  await account("widget-admin-2", ["flowplan-admins"]);
  await saveMetricsSetting(true);
  const s = await mobileAdminSummary(Date.now(), { latest: "99.0.0" } as never);
  assert.ok(["ok", "notice", "problem"].includes(s.health.state));
  // No mail server in a fresh instance: a notice.
  assert.ok(s.health.notices.includes("mailOff"));
  assert.equal(s.health.state, s.health.problems.length ? "problem" : "notice");
  assert.equal(s.update, "99.0.0");
  assert.equal(typeof s.version, "string");
  assert.ok(s.live);
  assert.equal(typeof s.live.activeNow, "number");
  assert.equal(typeof s.live.signinsToday, "number");
  assert.equal(s.live.requests24h.length, 24);
  assert.equal(typeof s.storage.bytes, "number");
  // No names or addresses anywhere.
  const text = JSON.stringify(s);
  assert.doesNotMatch(text, /widget-admin|example\.test/);
});

test("with the statistics off the live numbers are left out", async () => {
  await saveMetricsSetting(false);
  assert.equal((await mobileAdminSummary()).live, null);
  await saveMetricsSetting(true);
  process.env.FLOWPLAN_METRICS = "off";
  try {
    assert.equal((await mobileAdminSummary()).live, null);
  } finally {
    delete process.env.FLOWPLAN_METRICS;
  }
});
