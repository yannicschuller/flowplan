import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-sessions-"));
const { run, one, id } = await import("../lib/db");
const { hash, identityFromToken, rememberPolicy, carryOverSession } = await import("../lib/auth");
const { registerMobileDevice, identityFromDeviceToken } = await import("../lib/mobile-devices");
const { disableInactiveAccounts } = await import("../lib/inactive-accounts");
const { saveInstanceSettings } = await import("../lib/instance-settings");
const { mySessions, endMySessions, deviceName } = await import("../lib/my-sessions");

const uid = id();
run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, "Mara", "mara@example.test");
const HOUR = 3_600_000;
function session(token: string, values: { created: number; expires: number; remember?: boolean; sso?: boolean; agent?: string }) {
  run(
    "INSERT INTO sessions(token,user_id,groups_json,expires,created_at,remember,sso,last_seen,agent) VALUES(?,?,?,?,?,?,?,?,?)",
    hash(token),
    uid,
    "[]",
    values.expires,
    values.created,
    values.remember ? 1 : 0,
    values.sso ? 1 : 0,
    values.created,
    values.agent || "",
  );
}
const expires = (token: string) => one<{ expires: number }>("SELECT expires FROM sessions WHERE token=?", hash(token))!.expires;

test("without SESSION_REMEMBER nothing slides", () => {
  delete process.env.SESSION_REMEMBER;
  assert.equal(rememberPolicy(), null);
  const now = Date.now();
  session("plain", { created: now - HOUR, expires: now + HOUR, remember: true });
  assert.ok(identityFromToken("plain"));
  assert.equal(expires("plain"), now + HOUR);
});

test("a remembered session slides while used, up to its maximum", () => {
  process.env.SESSION_REMEMBER = "true";
  process.env.SESSION_IDLE_HOURS = "48";
  process.env.SESSION_MAX_DAYS = "30";
  process.env.SESSION_GROUPS_HOURS = "72";
  const now = Date.now();
  session("phone", { created: now - 24 * HOUR, expires: now + HOUR, remember: true });
  assert.ok(identityFromToken("phone"));
  assert.ok(Math.abs(expires("phone") - (now + 48 * HOUR)) < 5000, "extended by the idle time");
  // Near the absolute maximum it does not go beyond it.
  session("old", { created: now - (30 * 24 - 2) * HOUR, expires: now + HOUR, remember: true });
  identityFromToken("old");
  assert.ok(Math.abs(expires("old") - (now - (30 * 24 - 2) * HOUR + 30 * 24 * HOUR)) < 5000);
  // SSO: groups are checked again after SESSION_GROUPS_HOURS.
  session("sso", { created: now - 70 * HOUR, expires: now + HOUR, remember: true, sso: true });
  identityFromToken("sso");
  assert.ok(Math.abs(expires("sso") - (now + 2 * HOUR)) < 5000);
  // Expired: gone, and a disabled account ends every session at once.
  session("gone", { created: now - 100 * HOUR, expires: now - 1000, remember: true });
  assert.equal(identityFromToken("gone"), null);
  run("UPDATE users SET disabled=1 WHERE id=?", uid);
  assert.equal(identityFromToken("phone"), null);
  run("UPDATE users SET disabled=0 WHERE id=?", uid);
});

test("SSO sessions last as long as the others unless SESSION_GROUPS_HOURS is set", () => {
  process.env.SESSION_REMEMBER = "true";
  process.env.SESSION_IDLE_HOURS = "48";
  process.env.SESSION_MAX_DAYS = "30";
  delete process.env.SESSION_GROUPS_HOURS;
  assert.equal(rememberPolicy()!.groupsHours, null);
  const now = Date.now();
  // Signed in through SSO 8 days ago (beyond the old fixed 7 days): it slides
  // like a password session, up to SESSION_MAX_DAYS.
  session("sso-long", { created: now - 8 * 24 * HOUR, expires: now + HOUR, remember: true, sso: true });
  assert.ok(identityFromToken("sso-long"));
  assert.ok(Math.abs(expires("sso-long") - (now + 48 * HOUR)) < 5000);
  session("sso-max", { created: now - (30 * 24 - 2) * HOUR, expires: now + HOUR, remember: true, sso: true });
  identityFromToken("sso-max");
  assert.ok(Math.abs(expires("sso-max") - (now + 2 * HOUR)) < 5000, "never beyond SESSION_MAX_DAYS");
  // An instance that asks for it still ends SSO sessions earlier.
  process.env.SESSION_GROUPS_HOURS = "72";
  session("sso-capped", { created: now - 70 * HOUR, expires: now + HOUR, remember: true, sso: true });
  identityFromToken("sso-capped");
  assert.ok(Math.abs(expires("sso-capped") - (now + 2 * HOUR)) < 5000);
  delete process.env.SESSION_GROUPS_HOURS;
});

test("the app's device token keeps its remembered session alive", () => {
  process.env.SESSION_REMEMBER = "true";
  process.env.SESSION_IDLE_HOURS = "48";
  const now = Date.now();
  session("app", { created: now - 10 * 24 * HOUR, expires: now + HOUR, remember: true, sso: true });
  const me = { id: uid, name: "Mara", email: "", groups: [], isAdmin: false, disabled: 0, created_at: "" } as never;
  const { deviceToken } = registerMobileDevice(me, hash("app"), { installationId: "4b8a8f3e-1d5e-4c41-9a43-0d1f3b3c2a11", platform: "ios" });
  run("UPDATE sessions SET last_seen=? WHERE token=?", now - HOUR, hash("app"));
  assert.ok(identityFromDeviceToken(`Bearer ${deviceToken}`));
  assert.ok(Math.abs(expires("app") - (now + 48 * HOUR)) < 5000, "slid by the widget");
  assert.ok(one<{ last_seen: number }>("SELECT last_seen FROM sessions WHERE token=?", hash("app"))!.last_seen >= now);
  // Without SESSION_REMEMBER nothing slides, and an expired session ends the token.
  delete process.env.SESSION_REMEMBER;
  run("UPDATE sessions SET expires=? WHERE token=?", now - 1000, hash("app"));
  assert.equal(identityFromDeviceToken(`Bearer ${deviceToken}`), null);
});

test("signing in again moves the app installation to the new session; signing out removes it", () => {
  const now = Date.now();
  const me = { id: uid, name: "Mara", email: "", groups: [], isAdmin: false, disabled: 0, created_at: "" } as never;
  session("before", { created: now - 40 * 24 * HOUR, expires: now - HOUR, remember: true, sso: true });
  const installationId = "8f0e3a52-6c1b-4f7e-8d29-5a4b3c2d1e0f";
  run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", hash("live-for-register"), uid, "[]", now + HOUR);
  const { deviceToken } = registerMobileDevice(me, hash("live-for-register"), { installationId, platform: "android" });
  run("UPDATE mobile_devices SET session_token=? WHERE installation_id=?", hash("before"), installationId);
  // The old session ran out: the token stops working …
  assert.equal(identityFromDeviceToken(`Bearer ${deviceToken}`), null);
  // … until the same person signs in again on the device.
  session("after", { created: now, expires: now + HOUR, remember: true, sso: true });
  assert.equal(carryOverSession(hash("before"), hash("after"), uid), 1);
  assert.equal(identityFromDeviceToken(`Bearer ${deviceToken}`)?.id, uid, "the same device token works again");
  assert.equal(one("SELECT 1 FROM sessions WHERE token=?", hash("before")), undefined, "the old session ended");
  // Someone else signing in on that device takes nothing over.
  const other = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", other, other, "Nils", "nils@example.test");
  run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", hash("nils"), other, "[]", now + HOUR);
  assert.equal(carryOverSession(hash("after"), hash("nils"), other), 0);
  assert.equal(identityFromDeviceToken(`Bearer ${deviceToken}`)?.id, uid);
  // Signing out (the session row goes) removes the installation.
  run("DELETE FROM sessions WHERE token=?", hash("after"));
  assert.equal(identityFromDeviceToken(`Bearer ${deviceToken}`), null);
  assert.equal(one("SELECT 1 FROM mobile_devices WHERE installation_id=?", installationId), undefined);
});

test("using a long session counts as activity for the inactive-account check", () => {
  const now = Date.now();
  const DAY = 24 * HOUR;
  const active = id(),
    idle = id();
  for (const [user, name] of [[active, "Aktiv"], [idle, "Weg"]])
    run("INSERT INTO users(id,subject,name,email,last_login_at) VALUES(?,?,?,?,?)", user, user, name, `${user}@example.test`, now - 60 * DAY);
  run("INSERT INTO sessions(token,user_id,groups_json,expires,created_at,remember,last_seen) VALUES(?,?,?,?,?,?,?)", hash(`s-${active}`), active, "[]", now + DAY, now - 60 * DAY, 1, now - DAY);
  run("INSERT INTO sessions(token,user_id,groups_json,expires,created_at,remember,last_seen) VALUES(?,?,?,?,?,?,?)", hash(`s-${idle}`), idle, "[]", now - 20 * DAY, now - 60 * DAY, 1, now - 50 * DAY);
  saveInstanceSettings({ inactiveDays: 30 });
  const disabled = disableInactiveAccounts(now);
  saveInstanceSettings({ inactiveDays: null });
  assert.ok(disabled.includes(idle));
  assert.ok(!disabled.includes(active), "signed in 60 days ago, but used the session yesterday");
});

test("own sessions are listed and signed out per device", () => {
  const now = Date.now();
  session("laptop", { created: now, expires: now + HOUR, agent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit Version/18 Safari/605" });
  const me = { id: uid, name: "Mara", email: "", groups: [], isAdmin: false, disabled: 0, created_at: "" } as never;
  const list = mySessions(me, "laptop");
  const laptop = list.find((s) => s.current)!;
  assert.deepEqual([laptop.browser, laptop.system], ["Safari", "macOS"]);
  assert.ok(list.every((s) => !("token" in s)), "no tokens or hashes leave the server");
  assert.deepEqual(deviceName("Mozilla/5.0 (iPhone) FlowplanMobile/1.0"), { app: "Flowplan app", browser: "", system: "iPhone" });
  const phone = list.find((s) => !s.current)!;
  assert.deepEqual(endMySessions(me, "laptop", { id: phone.id }), { ended: 1, current: false });
  assert.throws(() => endMySessions(me, "laptop", { id: phone.id }), /gibt es nicht mehr/);
  const result = endMySessions(me, "laptop", { others: true });
  assert.equal(result.current, false);
  assert.deepEqual(mySessions(me, "laptop").map((s) => s.current), [true]);
});
