import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-sessions-"));
const { run, one, id } = await import("../lib/db");
const { hash, identityFromToken, rememberPolicy } = await import("../lib/auth");
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
