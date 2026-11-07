import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-app-devices-"));
const { run, all, id } = await import("../lib/db");
const { provesApp, checkAppDevice, appDeviceKey, MAX_APP_DEVICES } = await import("../lib/app-devices");
const { sessionTerms } = await import("../lib/session-policy");
const { createDesktopCode, redeemDesktopCode } = await import("../lib/desktop-sign-in");
const native = await import("../lib/native-app");

// The app lifetime is bound to a sign-in the app proves (lib/app-devices.ts),
// not to the user agent, which any browser can send.
const ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36 FlowplanMobile/1.1.0";
const DESKTOP = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/130.0 Electron/33.0 Safari/537.36 FlowplanDesktop/1.4.0";
const BROWSER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36";
const DAY = 86_400_000;
const HOUR = 3_600_000;
const user = async () => {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, "Mara", `${uid}@example.test`);
  return uid;
};
const key = () => ({ id: randomBytes(16).toString("base64url"), secret: randomBytes(32).toString("base64url") });
// What a session of this sign-in would get (issueSession → sessionTerms).
const lifetime = async (app: boolean, now: number) => (await sessionTerms({ app }, now)).expires - now;
for (const name of ["SESSION_HOURS", "SESSION_REMEMBER", "SESSION_APP_REMEMBER", "SESSION_APP_DAYS", "SESSION_MAX_DAYS"]) delete process.env[name];

test("the hand-off is the app's: only the holder of the verifier redeems the code", async () => {
  const uid = await user();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const code = await createDesktopCode(uid, [], challenge);
  assert.equal(await redeemDesktopCode(code, "someone-else"), null, "a wrong verifier redeems nothing (and uses the code up)");
  const again = await createDesktopCode(uid, [], challenge);
  assert.deepEqual(await redeemDesktopCode(again, verifier), { userId: uid, groups: [], authenticatedAt: null });
  const now = Date.now();
  assert.equal(await provesApp({ via: "handoff" }), true);
  assert.equal(await lifetime(await provesApp({ via: "handoff" }), now), 90 * DAY, "90 days without use by default");
});

test("the user agent alone gives the browser lifetime", async () => {
  const uid = await user();
  const now = Date.now();
  for (const agent of [ANDROID, DESKTOP]) {
    const app = await provesApp({ via: "form", userId: uid, input: { email: "x", password: "y" }, agent }, now);
    assert.equal(app, false, agent);
    assert.equal(await lifetime(app, now), 8 * HOUR, "8 hours, like any browser without Stay signed in");
  }
  // "Stay signed in" still works for them where the instance offers it.
  process.env.SESSION_REMEMBER = "true";
  assert.equal((await sessionTerms({ app: false, remember: true }, now)).expires - now, 7 * DAY);
  delete process.env.SESSION_REMEMBER;
  assert.equal((await all("SELECT 1 FROM app_devices WHERE user_id=?", uid)).length, 0, "nothing registered without a key");
});

test("password in the app with its device key: registered on first use, then required", async () => {
  const uid = await user();
  const device = key();
  const now = Date.now();
  // First sign-in on this device: registered (trust on first use).
  assert.equal(await checkAppDevice(uid, device, now), "registered");
  const rows = await all<{ device_id: string; secret_hash: Buffer }>("SELECT device_id,secret_hash FROM app_devices WHERE user_id=?", uid);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].device_id, device.id);
  assert.ok(!Buffer.from(rows[0].secret_hash).toString("latin1").includes(device.secret), "only a hash is kept");
  // Later sign-ins with the same key: the app's.
  const app = await provesApp({ via: "form", userId: uid, input: { password: "…", device }, agent: ANDROID }, now + 1000);
  assert.equal(app, true);
  assert.equal(await lifetime(app, now), 90 * DAY);
  assert.equal(await provesApp({ via: "form", userId: uid, input: { device }, agent: DESKTOP }), true);
  // The same key for another account: a device of that account of its own.
  const other = await user();
  assert.equal(await checkAppDevice(other, device), "registered");
});

test("a wrong secret for a known device gives the browser lifetime", async () => {
  const uid = await user();
  const device = key();
  assert.equal(await provesApp({ via: "form", userId: uid, input: { device }, agent: ANDROID }), true, "first use registers");
  const wrong = { id: device.id, secret: key().secret };
  assert.equal(await checkAppDevice(uid, wrong), "mismatch");
  const app = await provesApp({ via: "form", userId: uid, input: { device: wrong }, agent: ANDROID });
  assert.equal(app, false);
  assert.equal(await lifetime(app, Date.now()), 8 * HOUR);
  // The registered key is not replaced by the wrong one.
  assert.equal(await checkAppDevice(uid, device), "known");
  // The key without the app's user agent (copied into a browser): no.
  assert.equal(await provesApp({ via: "form", userId: uid, input: { device }, agent: BROWSER }), false);
});

test("malformed keys are ignored; the list per account stays bounded", async () => {
  assert.equal(appDeviceKey({ device: { id: "short", secret: "x".repeat(43) } }), null);
  assert.equal(appDeviceKey({ device: { id: "a".repeat(22), secret: "not base64url!" } }), null);
  assert.equal(appDeviceKey({ device: "a.b" }), null);
  assert.equal(appDeviceKey(null), null);
  const uid = await user();
  assert.equal(await provesApp({ via: "form", userId: uid, input: { device: { id: "x", secret: "y" } }, agent: ANDROID }), false);
  const first = key();
  await checkAppDevice(uid, first, 1);
  for (let i = 0; i < MAX_APP_DEVICES; i++) await checkAppDevice(uid, key(), 100 + i);
  assert.equal((await all("SELECT 1 FROM app_devices WHERE user_id=?", uid)).length, MAX_APP_DEVICES);
  assert.equal(await checkAppDevice(uid, first), "registered", "the one unused longest made room");
});

test("the page finds the app's device key in the bridge (lib/native-app.ts)", () => {
  const device = key();
  assert.deepEqual(native.appDeviceKey({ deviceKey: device }), device);
  assert.equal(native.appDeviceKey({ deviceKey: { id: device.id } }), null);
  assert.equal(native.appDeviceKey({}), null, "an older app: none");
  assert.equal(native.appDeviceKey(undefined), null, "a browser: none");
});

test("the sign-in routes bind the app lifetime to the proof, not the user agent", () => {
  const route = readFileSync(join(import.meta.dirname, "../app/api/auth/[action]/route.ts"), "utf8");
  assert.match(route, /redeemDesktopCode[\s\S]{0,600}provesApp\(\{ via: "handoff" \}\)/);
  for (const action of ["register", "password", "totp-login", "passkey"]) {
    const start = route.indexOf(`if (action === "${action}")`, route.indexOf("handlePOST"));
    const block = route.slice(start, route.indexOf("return NextResponse.json({ ok: true });", start));
    assert.match(block, /provesApp\(\{ via: "form"/, action);
  }
  const auth = readFileSync(join(import.meta.dirname, "../lib/auth.ts"), "utf8");
  assert.doesNotMatch(auth, /sessionTerms\(\{ agent/, "issueSession no longer decides by the user agent");
});
