// "Send test notification" (lib/push-test.ts, POST /api/push { action:
// "test" }): only for oneself, rate limited, sent through the push worker's
// real channels with mocked senders, and the outcome per target – without a
// token, key or push address in the answer and without an inbox entry.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createECDH, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-push-test-"));
process.env.APP_URL = "https://app.example.test";

// A relay on localhost for the whole-request errors (http only for localhost).
let relayAnswer: { status: number; json?: unknown } = { status: 500 };
const relayServer: Server = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    res.writeHead(relayAnswer.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(relayAnswer.json ?? {}));
  });
});
await new Promise<void>((resolve) => relayServer.listen(0, "127.0.0.1", resolve));
const RELAY = `http://127.0.0.1:${(relayServer.address() as { port: number }).port}`;
process.env.PUSH_RELAY_URL = RELAY;
after(() => {
  relayServer.closeAllConnections();
  relayServer.close();
});

const { one, run, all, id } = await import("../lib/db");
const { flushPushQueue, subscribePush, PushGoneError, PUSH_TEST_URL } = await import("../lib/push");
const { sendTestPush } = await import("../lib/push-test");
const { registerMobileDevice } = await import("../lib/mobile-devices");
const { setDeviceFocus } = await import("../lib/mobile-focus");
const { sendToRelay } = await import("../lib/push-relay");
type RelayMessage = import("../lib/push-relay").RelayMessage;
type RelayResult = import("../lib/push-relay").RelayResult;
type ExpoMessage = import("../lib/push").ExpoMessage;

function account(name: string, { groups = [] as string[], agent = "", locale = "de" } = {}) {
  const uid = id(),
    token = id();
  run("INSERT INTO users(id,subject,name,email,locale) VALUES(?,?,?,?,?)", uid, uid, name, `${name}@example.test`, locale);
  run("INSERT INTO sessions(token,user_id,groups_json,expires,agent) VALUES(?,?,?,?,?)", token, uid, JSON.stringify(groups), Date.now() + 3600000, agent);
  const user = { id: uid, name, email: `${name}@example.test`, groups, isAdmin: false, disabled: 0, created_at: "" } as Identity;
  return { user, token };
}
function secondSession(user: Identity, agent: string) {
  const token = id();
  run("INSERT INTO sessions(token,user_id,groups_json,expires,agent) VALUES(?,?,?,?,?)", token, user.id, "[]", Date.now() + 3600000, agent);
  return token;
}
function webSubscription(host = "web.push.apple.com") {
  const curve = createECDH("prime256v1");
  curve.generateKeys();
  return {
    endpoint: `https://${host}/${id()}`,
    keys: { p256dh: curve.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") },
  };
}
const deviceKey = () => generateKeyPairSync("x25519").publicKey.export({ format: "jwk" }).x as string;
const relayToken = () => randomBytes(32).toString("base64url");
const expoToken = () => `ExponentPushToken[${randomUUID().replaceAll("-", "").slice(0, 22)}]`;
const CHROME_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const FIREFOX_WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0";

// Mocked senders, recording what went out.
type Sent = { web: { endpoint: string; payload: Record<string, unknown> }[]; expo: ExpoMessage[]; relay: RelayMessage[] };
function senders(
  answers: {
    web?: (endpoint: string) => unknown;
    expo?: (message: ExpoMessage) => unknown;
    relay?: (message: RelayMessage) => RelayResult;
  } = {},
) {
  const sent: Sent = { web: [], expo: [], relay: [] };
  const flush = () =>
    flushPushQueue(
      async (sub, payload) => {
        sent.web.push({ endpoint: sub.endpoint, payload: JSON.parse(String(payload)) });
        const error = answers.web?.(sub.endpoint);
        if (error) throw error;
      },
      async (message) => {
        sent.expo.push(message);
        const error = answers.expo?.(message);
        if (error) throw error;
      },
      async (messages) => {
        sent.relay.push(...messages);
        return messages.map((m) => answers.relay?.(m) ?? { status: "ok" });
      },
    );
  return { sent, flush };
}
async function quietly<T>(fn: () => Promise<T>) {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.warn = warn;
  }
}

test("only for oneself: a live session of the person, never an API token; no devices → empty list", async () => {
  const { user, token } = account("self");
  await assert.rejects(sendTestPush({ ...user, apiScope: "write" }, token), (e: { status?: number }) => e.status === 403);
  const other = account("other");
  // Another person's session does not let anyone test their devices.
  await assert.rejects(sendTestPush(user, other.token), (e: { status?: number }) => e.status === 401);
  run("UPDATE sessions SET expires=0 WHERE token=?", other.token);
  await assert.rejects(sendTestPush(other.user, other.token), (e: { status?: number }) => e.status === 401);
  const { flush } = senders();
  const report = await sendTestPush(user, token, { flush });
  assert.deepEqual(report.targets, []);
  assert.equal(report.relay.enabled, true);
  // Somebody else's devices never show up.
  subscribePush(other.user, secondSession(other.user, CHROME_MAC), webSubscription());
  assert.deepEqual((await sendTestPush(user, token, { flush })).targets, []);
});

test("at most 5 tests per person in 10 minutes", async () => {
  const { user, token } = account("limited");
  const { flush } = senders();
  for (let i = 0; i < 5; i++) await sendTestPush(user, token, { flush });
  await assert.rejects(sendTestPush(user, token, { flush }), (e: { status?: number; message?: string }) => e.status === 429 && /5/.test(e.message || ""));
  // Another person is not affected.
  const other = account("not-limited");
  await sendTestPush(other.user, other.token, { flush });
});

test("every target through its real channel, the outcome per target, no inbox entry and no secrets", async () => {
  const { user, token } = account("many", { agent: CHROME_MAC, locale: "en" });
  // Push switched off for every kind and a Focus on: a test still goes.
  for (const kind of ["mention", "share", "comment", "reminder", "guest", "change", "automation", "security", "incident"])
    run("INSERT INTO notification_prefs(user_id,kind,inbox,push) VALUES(?,?,0,0)", user.id, kind);
  const here = webSubscription("fcm.googleapis.com");
  subscribePush(user, token, here);
  const firefox = webSubscription("updates.push.services.mozilla.com");
  subscribePush(user, secondSession(user, FIREFOX_WIN), firefox);
  const iphone = { relay: relayToken(), key: deviceKey() };
  const { deviceToken } = registerMobileDevice(user, token, { installationId: randomUUID(), platform: "ios", name: "Anna's iPhone", relayToken: iphone.relay, publicKey: iphone.key });
  const pixel = { relay: relayToken(), key: deviceKey(), expo: expoToken() };
  registerMobileDevice(user, token, { installationId: randomUUID(), platform: "android", name: "Pixel", relayToken: pixel.relay, publicKey: pixel.key, pushToken: pixel.expo });
  const ipad = { relay: relayToken(), key: deviceKey() };
  registerMobileDevice(user, token, { installationId: randomUUID(), platform: "ios", name: "iPad", relayToken: ipad.relay, publicKey: ipad.key });
  const old = expoToken();
  registerMobileDevice(user, token, { installationId: randomUUID(), platform: "android", name: "Old phone", pushToken: old });
  const gone = expoToken();
  registerMobileDevice(user, token, { installationId: randomUUID(), platform: "ios", name: "Uninstalled", pushToken: gone });
  registerMobileDevice(user, token, { installationId: randomUUID(), platform: "ios", name: "No permission" });
  // The iPhone has a Focus with a Flowplan filter on (another profile: all quiet).
  setDeviceFocus(user, `Bearer ${deviceToken}`, { hide: true, workspaceId: null });

  const inboxBefore = Number(one<{ n: number }>("SELECT COUNT(*) n FROM notifications WHERE user_id=?", user.id)!.n);
  const { sent, flush } = senders({
    web: (endpoint) => (endpoint === firefox.endpoint ? { statusCode: 410 } : null),
    expo: (message) => (message.to === gone ? new PushGoneError("DeviceNotRegistered") : message.to === old ? new Error("MessageRateExceeded") : null),
    relay: (message) => (message.to === pixel.relay ? { status: "forbidden" } : message.to === ipad.relay ? { status: "gone" } : { status: "ok" }),
  });
  const report = await quietly(() => sendTestPush(user, token, { flush }));
  const by = (name: string) => report.targets.find((t) => t.name === name)!;

  assert.equal(report.targets.length, 8);
  const chrome = report.targets.find((t) => t.current)!;
  assert.deepEqual({ name: chrome.name, kind: chrome.kind, channel: chrome.channel, status: chrome.status, service: chrome.service }, { name: "Chrome · macOS", kind: "browser", channel: "web", status: "delivered", service: "google" });
  const ff = report.targets.find((t) => t.name === "Firefox · Windows")!;
  assert.deepEqual([ff.status, ff.detail, ff.current], ["web-gone", "HTTP 410", false]);
  // As for every notification: the expired subscription went.
  assert.equal(one("SELECT 1 FROM push_subscriptions WHERE endpoint=?", firefox.endpoint), undefined);

  assert.deepEqual([by("Anna's iPhone").channel, by("Anna's iPhone").status, by("Anna's iPhone").focus], ["relay", "delivered", true]);
  // Refused by the relay: the Expo token takes over right away.
  assert.deepEqual([by("Pixel").channel, by("Pixel").status, by("Pixel").note], ["expo", "delivered", "relay-registration"]);
  assert.deepEqual([by("iPad").channel, by("iPad").status, by("iPad").detail], ["relay", "relay-registration", "gone"]);
  assert.deepEqual([by("Old phone").channel, by("Old phone").status, by("Old phone").detail], ["expo", "expo-error", "MessageRateExceeded"]);
  assert.deepEqual([by("Uninstalled").channel, by("Uninstalled").status], ["expo", "expo-gone"]);
  assert.deepEqual([by("No permission").channel, by("No permission").status], [null, "push-disabled"]);

  // What went out: the test text in the person's language, to the settings.
  const web = sent.web.find((w) => w.endpoint === here.endpoint)!;
  assert.equal(web.payload.body, "Test notification – everything works.");
  assert.equal(web.payload.url, PUSH_TEST_URL);
  assert.equal(PUSH_TEST_URL, "/#settings/notifications/push");
  const pixelExpo = sent.expo.find((m) => m.to === pixel.expo)!;
  assert.equal(pixelExpo.body, "Test notification – everything works.");
  assert.deepEqual(pixelExpo.data, { url: PUSH_TEST_URL });
  assert.equal(pixelExpo.categoryId, undefined);
  const iphoneMessage = sent.relay.find((m) => m.to === iphone.relay)!;
  assert.equal(iphoneMessage.category, "default");
  assert.equal(iphoneMessage.type, "alert");
  // End-to-end encrypted: the text is not in the relay message.
  assert.ok(!JSON.stringify(iphoneMessage).includes("everything works"));

  // No inbox entry, no queued delivery, no rows left behind.
  assert.equal(Number(one<{ n: number }>("SELECT COUNT(*) n FROM notifications WHERE user_id=?", user.id)!.n), inboxBefore);
  assert.equal(one("SELECT 1 FROM push_deliveries d JOIN push_subscriptions s ON s.id=d.subscription_id WHERE s.user_id=?", user.id), undefined);
  assert.deepEqual(all("SELECT * FROM push_tests"), []);

  // Never a token, key, push address or internal id in the answer.
  const text = JSON.stringify(report);
  const devices = all<{ id: string; push_subscription_id: string | null }>("SELECT id,push_subscription_id FROM mobile_devices WHERE user_id=?", user.id);
  for (const secret of [
    here.endpoint,
    here.keys.p256dh,
    here.keys.auth,
    firefox.endpoint,
    "fcm.googleapis.com",
    iphone.relay,
    iphone.key,
    pixel.relay,
    pixel.key,
    pixel.expo,
    old,
    gone,
    "ExponentPushToken",
    token,
    ...devices.flatMap((d) => [d.id, d.push_subscription_id ?? ""]).filter(Boolean),
  ])
    assert.ok(!text.includes(secret), `leaked ${secret.slice(0, 12)}…`);
  // Diagnostics only for administrators.
  assert.equal(report.diagnostics, undefined);
});

test("relay failures of the whole request become actionable codes", async () => {
  const { user, token } = account("relay-errors", { groups: ["flowplan-admins"] });
  const device = { relay: relayToken(), key: deviceKey() };
  registerMobileDevice(user, token, { installationId: randomUUID(), platform: "ios", name: "Phone", relayToken: device.relay, publicKey: device.key });
  // The real relay client against a local relay.
  const flush = () => flushPushQueue(async () => assert.fail("no Web Push"), async () => assert.fail("no Expo"), sendToRelay);
  const statusFor = async (answer: typeof relayAnswer) => {
    relayAnswer = answer;
    const report = await quietly(() => sendTestPush(user, token, { flush }));
    return report;
  };
  let report = await statusFor({ status: 401 });
  assert.equal(report.targets[0].status, "relay-signature");
  assert.equal(report.relay.instance, "https://app.example.test");
  // Administrators see where the relay is and what this instance calls itself.
  assert.deepEqual(report.diagnostics, { relayUrl: RELAY, wellKnown: true, instance: "https://app.example.test", mobilePush: true });
  assert.equal((await statusFor({ status: 403 })).targets[0].status, "relay-blocked");
  assert.equal((await statusFor({ status: 502 })).targets[0].status, "relay-upstream");
  report = await statusFor({ status: 400 });
  assert.deepEqual([report.targets[0].status, report.targets[0].detail], ["relay-rejected", "HTTP 400"]);
  // Apple or Google refused this one message.
  assert.equal((await statusFor({ status: 200, json: { results: [{ status: "error" }] } })).targets[0].status, "relay-upstream");
  // The registration survived all of these (whole-request errors drop nothing).
  assert.ok(one("SELECT 1 FROM mobile_push_relay r JOIN mobile_devices d ON d.id=r.device_id WHERE d.user_id=?", user.id));

  // Unreachable: nothing listens there.
  const { user: u2, token: t2 } = account("relay-down");
  registerMobileDevice(u2, t2, { installationId: randomUUID(), platform: "ios", name: "Phone", relayToken: relayToken(), publicKey: deviceKey() });
  process.env.PUSH_RELAY_URL = "http://127.0.0.1:9";
  try {
    const down = await quietly(() => sendTestPush(u2, t2, { flush }));
    assert.equal(down.targets[0].status, "relay-unreachable");
  } finally {
    process.env.PUSH_RELAY_URL = RELAY;
  }
});

test("relay not configured: relay-only devices say why, Expo devices fall back", async () => {
  const { user, token } = account("relay-off");
  registerMobileDevice(user, token, { installationId: randomUUID(), platform: "ios", name: "Relay only", relayToken: relayToken(), publicKey: deviceKey() });
  const expo = expoToken();
  registerMobileDevice(user, token, { installationId: randomUUID(), platform: "android", name: "Both", relayToken: relayToken(), publicKey: deviceKey(), pushToken: expo });
  for (const [env, value, reason] of [
    ["PUSH_RELAY", "off", "off"],
    ["APP_URL", "http://flowplan.example.test", "instance-url"],
  ] as const) {
    const saved = process.env[env];
    process.env[env] = value;
    try {
      const { sent, flush } = senders({ relay: () => assert.fail("relay is off") });
      const report = await quietly(() => sendTestPush(user, token, { flush }));
      assert.deepEqual(report.relay, { enabled: false, reason, instance: null });
      const only = report.targets.find((t) => t.name === "Relay only")!;
      assert.deepEqual([only.status, only.channel], ["relay-off", "relay"]);
      const both = report.targets.find((t) => t.name === "Both")!;
      assert.deepEqual([both.status, both.channel, both.note], ["delivered", "expo", "relay-off"]);
      assert.equal(sent.expo.length, 1);
    } finally {
      process.env[env] = saved;
    }
  }
  // The relay-only registration is kept for when the relay is back.
  assert.ok(one("SELECT 1 FROM mobile_devices WHERE name='Relay only' AND push_subscription_id IS NOT NULL"));
});

test("no answer within the time: pending, and nothing stays queued", async () => {
  const { user, token } = account("slow");
  subscribePush(user, token, webSubscription());
  const report = await sendTestPush(user, token, { flush: () => new Promise(() => {}), timeoutMs: 200 });
  assert.equal(report.targets[0].status, "pending");
  assert.deepEqual(all("SELECT * FROM push_tests"), []);
});

test("MOBILE_PUSH=off: apps are listed with the reason", async () => {
  const { user, token } = account("mobile-off");
  process.env.MOBILE_PUSH = "off";
  try {
    registerMobileDevice(user, token, { installationId: randomUUID(), platform: "android", name: "Phone", pushToken: expoToken() });
    const report = await sendTestPush(user, token, { flush: senders().flush });
    assert.deepEqual(report.targets.map((t) => t.status), ["app-push-off"]);
  } finally {
    delete process.env.MOBILE_PUSH;
  }
});
