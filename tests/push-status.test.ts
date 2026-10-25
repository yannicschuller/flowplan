// Administration → Push-Benachrichtigungen (lib/push-status.ts,
// app/api/admin/push): the relay's configuration with every reason it is
// off, the live checks against local servers (reachable, unreachable,
// timeout, redirect refused, too large, wrong document), the minute cache,
// the delivery counters (lib/metrics.ts, schema 64) and that no token, key
// or secret is ever part of the answer.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createECDH, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-push-status-"));
delete process.env.PUSH_RELAY;
delete process.env.MOBILE_PUSH;
delete process.env.MOBILE_PUSH_CONTENT;
delete process.env.WEB_PUSH_PUBLIC_KEY;
delete process.env.WEB_PUSH_PRIVATE_KEY;
delete process.env.WEB_PUSH_SUBJECT;
delete process.env.FLOWPLAN_METRICS;

// A local relay (http is allowed for localhost) whose /healthz answers as
// the test says, and a local "instance" serving /.well-known/flowplan-push.
type Handler = (req: IncomingMessage, res: ServerResponse) => void;
let relayHandler: Handler = (_req, res) => json(res, 200, { status: "ok" });
let instanceHandler: Handler = (_req, res) => json(res, 404, { error: "Not found" });
const hits = { relay: 0, instance: 0 };
function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}
async function listen(handler: () => Handler, kind: "relay" | "instance") {
  const server: Server = createServer((req, res) => {
    hits[kind]++;
    req.resume();
    handler()(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, origin: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}
const relay = await listen(() => relayHandler, "relay");
const instance = await listen(() => instanceHandler, "instance");
// A port nothing listens on.
const closed = await listen(() => relayHandler, "relay");
await new Promise<void>((resolve) => closed.server.close(() => resolve()));
after(() => {
  for (const s of [relay.server, instance.server]) {
    s.closeAllConnections();
    s.close();
  }
});

const RELAY = relay.origin;
const INSTANCE = instance.origin;
function configure(env: { PUSH_RELAY?: string; PUSH_RELAY_URL?: string; APP_URL?: string }) {
  for (const key of ["PUSH_RELAY", "PUSH_RELAY_URL", "APP_URL"] as const) {
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
}
configure({ PUSH_RELAY_URL: RELAY, APP_URL: INSTANCE });

const { one, run, id } = await import("../lib/db");
const status = await import("../lib/push-status");
const { pushStatus, pushStatusFor, pushSummary, resetPushProbes, checkRelayHealth, checkWellKnown, relaySetup, PROBE_MAX_AGE_MS } = status;
const { pushIdentityDocument, rotatePushIdentity } = await import("../lib/push-identity");
const { sendBatched, DEFAULT_PUSH_RELAY } = await import("../lib/push-relay");
const metrics = await import("../lib/metrics");
const { flushPushQueue, subscribePush } = await import("../lib/push");
const { registerMobileDevice } = await import("../lib/mobile-devices");

function account(name: string, groups: string[] = []) {
  const uid = id(),
    token = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", token, uid, JSON.stringify(groups), Date.now() + 3_600_000);
  const user = { id: uid, name, email: `${name}@example.test`, groups, isAdmin: false, disabled: 0, created_at: "" } as Identity;
  return { user, token };
}
const serveDocument: Handler = (req, res) => (req.url === "/.well-known/flowplan-push" ? json(res, 200, pushIdentityDocument()) : json(res, 404, {}));

beforeEach(() => {
  configure({ PUSH_RELAY_URL: RELAY, APP_URL: INSTANCE });
  relayHandler = (_req, res) => json(res, 200, { status: "ok" });
  instanceHandler = serveDocument;
  resetPushProbes();
});

test("relay off: every reason, with the address shown but no credentials, and no check made", async () => {
  const before = hits.relay;
  configure({ PUSH_RELAY: "off", PUSH_RELAY_URL: RELAY, APP_URL: INSTANCE });
  let s = await pushStatus();
  assert.equal(s.relay.enabled, false);
  assert.equal(s.relay.reason, "off");
  assert.equal(s.tone, "off");
  assert.equal(s.relay.wellKnown, false);
  assert.equal(s.relay.health, null);
  assert.equal(s.relay.self, null);
  assert.deepEqual(s.relay.keys, []);

  // An invalid PUSH_RELAY_URL: shown without user, password and query.
  configure({ PUSH_RELAY_URL: "https://admin:hunter2@relay.example.test/v1?token=abc", APP_URL: "https://app.example.test" });
  s = await pushStatus();
  assert.equal(s.relay.reason, "relay-url");
  assert.equal(s.tone, "error");
  assert.equal(s.relay.url, "https://relay.example.test/v1");
  assert.equal(s.relay.custom, true);
  assert.doesNotMatch(JSON.stringify(s), /hunter2|admin:|token=abc/);
  configure({ PUSH_RELAY_URL: "not a url", APP_URL: "https://app.example.test" });
  assert.equal((await pushStatus()).relay.url, null);

  // APP_URL without https: the relay could never fetch the key.
  configure({ APP_URL: "http://flowplan.example.test" });
  s = await pushStatus();
  assert.equal(s.relay.reason, "instance-url");
  assert.equal(s.tone, "warn");
  assert.equal(s.relay.instance, "http://flowplan.example.test");
  assert.equal(s.relay.url, DEFAULT_PUSH_RELAY);
  assert.equal(s.relay.official, true);
  assert.equal(s.relay.custom, false);
  assert.equal(hits.relay, before, "nothing is checked while the relay is off");
});

test("relay on: reachable with time and version, /.well-known fetched at APP_URL, keys listed", async () => {
  relayHandler = (req, res) => (req.url === "/healthz" ? json(res, 200, { status: "ok", version: "1.4.2" }) : json(res, 404, {}));
  const s = await pushStatus();
  assert.equal(s.relay.enabled, true);
  assert.equal(s.relay.url, RELAY);
  assert.equal(s.relay.official, false);
  assert.equal(s.relay.instance, INSTANCE);
  assert.equal(s.relay.wellKnownUrl, `${INSTANCE}/.well-known/flowplan-push`);
  assert.equal(s.relay.health?.ok, true);
  assert.equal(s.relay.health?.httpStatus, 200);
  assert.equal(s.relay.health?.version, "1.4.2");
  assert.ok(typeof s.relay.health?.ms === "number" && s.relay.health.ms >= 0);
  assert.equal(s.relay.self?.ok, true);
  assert.equal(s.tone, "ok");
  assert.equal(s.relay.keys.filter((k) => k.signing).length, 1);
  // Without a version, or with one that is not a plain version string.
  resetPushProbes();
  relayHandler = (_req, res) => json(res, 200, { status: "ok", version: "<script>" });
  assert.equal((await pushStatus()).relay.health?.version, null);
});

test("unreachable relay: refused, HTTP 503, wrong document, too large, timeout", async () => {
  configure({ PUSH_RELAY_URL: closed.origin, APP_URL: INSTANCE });
  let s = await pushStatus();
  assert.equal(s.relay.health?.ok, false);
  assert.equal(s.relay.health?.error, "refused");
  assert.equal(s.tone, "error");

  configure({ PUSH_RELAY_URL: RELAY, APP_URL: INSTANCE });
  resetPushProbes();
  relayHandler = (_req, res) => json(res, 503, { status: "unavailable" });
  s = await pushStatus();
  assert.deepEqual([s.relay.health?.ok, s.relay.health?.error, s.relay.health?.httpStatus], [false, "http", 503]);

  relayHandler = (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<html>a proxy</html>");
  };
  assert.equal((await checkRelayHealth(RELAY)).error, "response");
  relayHandler = (_req, res) => json(res, 200, { status: "ok", padding: "x".repeat(10_000) });
  assert.equal((await checkRelayHealth(RELAY)).error, "too-large");

  relayHandler = (_req, res) => {
    setTimeout(() => json(res, 200, { status: "ok" }), 1500);
  };
  const started = Date.now();
  const slow = await checkRelayHealth(RELAY, { timeoutMs: 200 });
  assert.equal(slow.ok, false);
  assert.equal(slow.error, "timeout");
  assert.equal(slow.ms, null);
  assert.ok(Date.now() - started < 1400, "the timeout ends the check");
});

test("a redirect is never followed", async () => {
  let followed = false;
  relayHandler = (req, res) => {
    if (req.url === "/elsewhere") {
      followed = true;
      return json(res, 200, { status: "ok" });
    }
    res.writeHead(302, { Location: `${RELAY}/elsewhere` });
    res.end();
  };
  const probe = await checkRelayHealth(RELAY);
  assert.deepEqual([probe.ok, probe.error, probe.httpStatus], [false, "redirect", 302]);
  assert.equal(followed, false);
  // Neither for the key document.
  instanceHandler = (_req, res) => {
    res.writeHead(301, { Location: "https://elsewhere.example.test/.well-known/flowplan-push" });
    res.end();
  };
  assert.equal((await checkWellKnown(INSTANCE, null)).error, "redirect");
});

test("only https (http for localhost) is checked; nothing is fetched otherwise", async () => {
  const before = hits.relay;
  assert.equal((await checkRelayHealth("http://relay.example.test")).error, "insecure");
  assert.equal((await checkRelayHealth("ftp://127.0.0.1")).error, "insecure");
  assert.equal(hits.relay, before);
});

test("own /.well-known: unreachable from here is a warning, a document without this key a mismatch", async () => {
  instanceHandler = (_req, res) => json(res, 404, { error: "Not found" });
  let s = await pushStatus();
  assert.equal(s.relay.health?.ok, true);
  assert.deepEqual([s.relay.self?.ok, s.relay.self?.error, s.relay.self?.httpStatus], [false, "http", 404]);
  assert.equal(s.tone, "warn");

  resetPushProbes();
  instanceHandler = (_req, res) => json(res, 200, { version: 1, keys: [{ id: "someone-else", alg: "Ed25519", publicKey: "x" }] });
  s = await pushStatus();
  assert.equal(s.relay.self?.error, "mismatch");

  // After a rotation the waiting key is listed, the signing one still signs.
  resetPushProbes();
  instanceHandler = serveDocument;
  rotatePushIdentity();
  s = await pushStatus();
  assert.equal(s.relay.self?.ok, true);
  const waiting = s.relay.keys.find((k) => !k.signing && k.activeFrom > s.at);
  assert.ok(waiting, "the new key waits to sign");
  assert.ok(s.relay.keys.some((k) => k.signing && k.retireAt), "the old key signs until it retires");
});

test("cache: one check a minute per address, concurrent asks share it, force checks again", async () => {
  relayHandler = (_req, res) => setTimeout(() => json(res, 200, { status: "ok" }), 50);
  const before = hits.relay;
  const [a, b] = await Promise.all([pushStatus(), pushStatus()]);
  assert.equal(hits.relay - before, 1);
  assert.equal(a.relay.health?.at, b.relay.health?.at);
  await pushStatus();
  assert.equal(hits.relay - before, 1, "cached");
  // Older than a minute: checked again.
  const later = await pushStatus({ now: Date.now() + PROBE_MAX_AGE_MS + 1 });
  assert.equal(hits.relay - before, 2);
  assert.ok(later.relay.health);
  await pushStatus({ force: true });
  assert.equal(hits.relay - before, 3);
  // The tiles only read what is known, without a request.
  const summary = pushSummary();
  assert.equal(hits.relay - before, 3);
  assert.equal(summary.health?.ok, true);
  assert.equal(summary.enabled, true);
  // Not checked yet: "info", and still no request.
  resetPushProbes();
  assert.equal(pushSummary().tone, "info");
  assert.equal(pushSummary().health, null);
  assert.equal(hits.relay - before, 3);
});

test("only administrators in the browser; rate limited", async () => {
  const admin = account("push-status-admin");
  admin.user.isAdmin = true;
  const member = account("push-status-member");
  await assert.rejects(pushStatusFor(member.user), /Administrator/);
  await assert.rejects(pushStatusFor({ ...admin.user, apiScope: "read" } as Identity), /API-Token/);
  const ok = await pushStatusFor(admin.user);
  assert.equal(ok.relay.enabled, true);
  // Checking again at once: six a minute.
  for (let i = 0; i < 6; i++) await pushStatusFor(admin.user, { force: true });
  await assert.rejects(pushStatusFor(admin.user, { force: true }), (e: Error & { status?: number }) => e.status === 429);
  // Reading still works.
  await pushStatusFor(admin.user);
});

test("no token, key or secret in the answer", async () => {
  const { user, token } = account("push-status-devices");
  const relayToken = randomBytes(32).toString("base64url");
  const publicKey = generateKeyPairSync("x25519").publicKey.export({ format: "jwk" }).x as string;
  registerMobileDevice(user, token, { installationId: randomUUID(), platform: "ios", relayToken, publicKey });
  const curve = createECDH("prime256v1");
  curve.generateKeys();
  const endpoint = `https://fcm.googleapis.com/fcm/send/${id()}`;
  const p256dh = curve.getPublicKey().toString("base64url");
  subscribePush(user, token, { endpoint, keys: { p256dh, auth: randomBytes(16).toString("base64url") } });
  process.env.WEB_PUSH_PUBLIC_KEY = "BPublicVapidKeyForTheTest";
  process.env.WEB_PUSH_PRIVATE_KEY = "private-vapid-secret-for-the-test";
  try {
    const s = await pushStatus({ force: true });
    assert.equal(s.devices.apps, 1);
    assert.equal(s.devices.relay, 1);
    assert.equal(s.devices.relayOnly, 1);
    assert.equal(s.devices.web, 1);
    assert.equal(s.web.vapid, "env");
    const text = JSON.stringify(s) + JSON.stringify(pushSummary());
    const keyRows = (await import("../lib/db")).all<{ public_key: string; private_key: string }>("SELECT public_key,private_key FROM push_identity_keys");
    const sealed = one<{ relay_token: string; public_key: string }>("SELECT relay_token,public_key FROM mobile_push_relay")!;
    for (const secret of [relayToken, sealed.relay_token, publicKey, endpoint, p256dh, "private-vapid-secret-for-the-test", "BPublicVapidKeyForTheTest", ...keyRows.flatMap((k) => [k.private_key, k.public_key])])
      assert.ok(!text.includes(secret), "nothing secret or device-specific");
    assert.doesNotMatch(text, /private/i);
  } finally {
    delete process.env.WEB_PUSH_PUBLIC_KEY;
    delete process.env.WEB_PUSH_PRIVATE_KEY;
  }
});

test("Expo fallback and Web Push rows: MOBILE_PUSH, MOBILE_PUSH_CONTENT, VAPID", async () => {
  let s = await pushStatus();
  assert.deepEqual(s.mobile, { enabled: true, content: "default" });
  process.env.MOBILE_PUSH = "off";
  process.env.MOBILE_PUSH_CONTENT = "on";
  process.env.WEB_PUSH_PUBLIC_KEY = "only-one";
  process.env.WEB_PUSH_SUBJECT = "mailto:admin@example.test";
  try {
    s = await pushStatus();
    assert.deepEqual(s.mobile, { enabled: false, content: "on" });
    assert.equal(s.web.vapid, "partial");
    assert.equal(s.web.subject, true);
    process.env.MOBILE_PUSH_CONTENT = "off";
    assert.equal((await pushStatus()).mobile.content, "off");
    assert.equal(pushSummary().mobile, false);
  } finally {
    delete process.env.MOBILE_PUSH;
    delete process.env.MOBILE_PUSH_CONTENT;
    delete process.env.WEB_PUSH_PUBLIC_KEY;
    delete process.env.WEB_PUSH_SUBJECT;
  }
});

test("delivery counters: per hour, channel and result, written to metrics_push; last success and failure", async () => {
  metrics.clearMetrics();
  const now = Date.now();
  // Relay results through sendBatched (also tests and Live Activities).
  const message = { to: "t".repeat(30), type: "alert" as const, payload: "x", category: null, collapseId: null, badge: null, priority: "high" as const, ttl: 60, liveActivity: null };
  await sendBatched([message, message, message, message], async () => [
    { status: "ok" },
    { status: "ok" },
    { status: "gone" },
    { status: "error", reason: "signature", httpStatus: 401 },
  ]);
  // A sender that throws counts as an error for every message.
  await sendBatched([message], async () => {
    throw new Error("boom");
  });
  let d = metrics.pushDeliveries();
  assert.equal(d.collecting, true);
  assert.equal(d.totals.relay.ok, 2);
  assert.equal(d.totals.relay.gone, 1);
  assert.equal(d.totals.relay.error, 2);
  assert.ok(d.lastOk.relay && d.lastOk.relay >= now);
  assert.deepEqual([d.lastError?.channel, d.lastError?.result, d.lastError?.code], ["relay", "error", "response"]);
  assert.equal(d.hourly.length, 24);
  assert.equal(d.hourly.at(-1)?.ok, 2);
  assert.equal(d.hourly.at(-1)?.failed, 2, "gone is no failure");
  const rows = (await import("../lib/db")).all<{ channel: string; result: string; count: number }>("SELECT channel,result,count FROM metrics_push ORDER BY result");
  assert.deepEqual(
    rows.map((r) => `${r.channel}:${r.result}:${r.count}`),
    ["relay:error:2", "relay:gone:1", "relay:ok:2"],
  );

  // Web Push through the push worker: delivered, and gone (410).
  const { user, token } = account("push-status-web");
  const sub = (host: string) => {
    const curve = createECDH("prime256v1");
    curve.generateKeys();
    const endpoint = `https://${host}/${id()}`;
    subscribePush(user, token, { endpoint, keys: { p256dh: curve.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } });
    return endpoint;
  };
  const good = sub("web.push.apple.com"),
    gone = sub("fcm.googleapis.com");
  const nid = id();
  run("INSERT INTO notifications(id,user_id,body) VALUES(?,?,?)", nid, user.id, "Counted");
  const subs = (await import("../lib/db")).all<{ id: string }>("SELECT id FROM push_subscriptions WHERE user_id=?", user.id);
  for (const s of subs) if (!one("SELECT 1 FROM push_deliveries WHERE notification_id=? AND subscription_id=?", nid, s.id)) run("INSERT INTO push_deliveries(notification_id,subscription_id) VALUES(?,?)", nid, s.id);
  await flushPushQueue(async (s) => {
    if (s.endpoint === gone) throw Object.assign(new Error("gone"), { statusCode: 410 });
    assert.equal(s.endpoint, good);
  });
  d = metrics.pushDeliveries();
  assert.equal(d.totals.web.ok, 1);
  assert.equal(d.totals.web.gone, 1);
  assert.ok(d.lastOk.web);

  // Written by the metrics worker; the last success survives a restart.
  metrics.flushMetrics(Date.now());
  const stored = one<{ value: string }>("SELECT value FROM instance_settings WHERE key='push-delivery'");
  assert.ok(stored && JSON.parse(stored.value).ok.relay >= now);
  assert.doesNotMatch(stored!.value, /t{30}/);

  // A failure code is kept only when it is a plain code.
  metrics.notePushResult("expo", "error", "https://exp.host/secret?token=abc");
  assert.equal(metrics.pushDeliveries().lastError?.code, null);
  metrics.notePushResult("expo", "error", "MessageRateExceeded");
  assert.equal(metrics.pushDeliveries().lastError?.code, "MessageRateExceeded");
  // Statistics off: nothing counted, the last outcome still known.
  metrics.saveMetricsSetting(false);
  try {
    const before = metrics.pushDeliveries().totals.relay.ok;
    metrics.notePushResult("relay", "ok");
    const off = metrics.pushDeliveries();
    assert.equal(off.collecting, false);
    assert.equal(off.totals.relay.ok, before);
    assert.ok(off.lastOk.relay);
  } finally {
    metrics.saveMetricsSetting(true);
  }
  // Clearing the statistics removes the counts.
  metrics.clearMetrics();
  assert.equal(one<{ n: number }>("SELECT COUNT(*) n FROM metrics_push")!.n, 0);
});

test("a relay failing since its last success turns the tile amber; the relay setup is the test notification's", async () => {
  metrics.clearMetrics();
  metrics.notePushResult("relay", "ok", null, Date.now() - 60_000);
  metrics.notePushResult("relay", "error", "unreachable");
  const s = await pushStatus();
  assert.equal(s.relay.health?.ok, true);
  assert.equal(s.tone, "warn");
  metrics.notePushResult("relay", "ok");
  assert.equal((await pushStatus()).tone, "ok");
  const setup = relaySetup();
  assert.deepEqual([setup.url, setup.instance, setup.wellKnown], [RELAY, INSTANCE, true]);
});
