// The push relay, instance side (lib/push-relay.ts, lib/push-identity.ts,
// lib/live-activity-push.ts; PROTOCOL.md of flowplan-push): end-to-end
// encryption, request signatures, the key document, device registration,
// sending through a mocked relay and what its answers do.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  randomUUID,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-push-relay-"));
process.env.APP_URL = "https://app.example.test";
const INSTANCE = "https://app.example.test";

const { id, one, all, run } = await import("../lib/db");
const { command, bootstrap, database } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { flushPushQueue } = await import("../lib/push");
const relayLib = await import("../lib/push-relay");
const identity = await import("../lib/push-identity");
const devices = await import("../lib/mobile-devices");
const { flushLiveActivities, focusProps, timerProps, contentState, liveActivityMessage } = await import("../lib/live-activity-push");
const { widgetAction } = await import("../lib/mobile-widget-actions");
const wellKnown = await import("../app/.well-known/flowplan-push/route");

const { encryptForDevice, plaintextJson, relayConfig, sendBatched, strictOrigin, validDeviceKey, MAX_PAYLOAD_BYTES } = relayLib;
const { registerMobileDevice, unregisterMobileDevice, identityFromDeviceToken, setLiveActivityToken } = devices;

// ---- An independent decryptor (§4), written from the protocol text ----

// v1.1 (§6.9): HKDF info and AES-GCM aad are "flowplan-push-v1\n" + instance.
const contextFor = (instance: string) => Buffer.from(`flowplan-push-v1\n${instance}`, "utf8");
const rawX = (key: KeyObject) => Buffer.from(key.export({ format: "jwk" }).x as string, "base64url");
function decrypt(devicePrivate: KeyObject, payload: string, instance = INSTANCE, info = contextFor(instance), aad = info) {
  const bytes = Buffer.from(payload, "base64url");
  assert.equal(bytes[0], 0x01, "version byte");
  const ePublic = bytes.subarray(1, 33),
    nonce = bytes.subarray(33, 45),
    ct = bytes.subarray(45, bytes.length - 16),
    tag = bytes.subarray(bytes.length - 16);
  const shared = diffieHellman({
    privateKey: devicePrivate,
    publicKey: createPublicKey({ key: { kty: "OKP", crv: "X25519", x: ePublic.toString("base64url") }, format: "jwk" }),
  });
  const devicePublic = rawX(createPublicKey(devicePrivate));
  const key = Buffer.from(hkdfSync("sha256", shared, Buffer.concat([ePublic, devicePublic]), info, 32));
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
const x25519FromRaw = (hex: string) =>
  createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b656e04220420", "hex"), Buffer.from(hex, "hex")]), format: "der", type: "pkcs8" });
const ed25519FromRaw = (hex: string) =>
  createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(hex, "hex")]), format: "der", type: "pkcs8" });

function deviceKeys() {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  return { privateKey, publicKey: rawX(publicKey).toString("base64url") };
}
const relayToken = () => randomBytes(32).toString("base64url");
const expoToken = () => `ExponentPushToken[${randomUUID().replaceAll("-", "").slice(0, 22)}]`;

function account(name: string) {
  const uid = id(),
    token = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", token, uid, "[]", Date.now() + 3600000);
  const user = { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
  return { user, token };
}

// ---- A relay on localhost (http is allowed for localhost only) ----

type Captured = { method: string; path: string; headers: IncomingMessage["headers"]; body: Buffer };
type Handler = (request: Captured) => { status: number; headers?: Record<string, string>; json?: unknown };
let handler: Handler = () => ({ status: 500 });
const requests: Captured[] = [];
const server: Server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const captured = { method: req.method || "", path: req.url || "", headers: req.headers, body: Buffer.concat(chunks) };
    requests.push(captured);
    const answer = handler(captured);
    res.writeHead(answer.status, { "Content-Type": "application/json", ...(answer.headers || {}) });
    res.end(answer.json === undefined ? "" : JSON.stringify(answer.json));
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
process.env.PUSH_RELAY_URL = `http://localhost:${port}`;
after(() => server.close());

const messagesOf = (request: Captured) => (JSON.parse(request.body.toString("utf8")) as { messages: Record<string, any>[] }).messages;
const okAll: Handler = (r) => ({ status: 200, json: { results: messagesOf(r).map(() => ({ status: "ok" })) } });
const noWebPush = async () => assert.fail("no Web Push");
const noExpo = async () => assert.fail("no Expo");

// Collects everything written to the console while `fn` runs.
async function quietly<T>(fn: () => Promise<T>) {
  const lines: string[] = [];
  const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const name of ["log", "warn", "error", "info"] as const) console[name] = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    return { value: await fn(), lines };
  } finally {
    Object.assign(console, saved);
  }
}

// ---- §4 Encryption ----

test("encryption: the exact byte layout, a fixed vector (RFC 7748 keys) and the independent decryptor", () => {
  // Ephemeral = RFC 7748 Alice, device = Bob; fixed nonce.
  const alice = x25519FromRaw("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a");
  const bob = x25519FromRaw("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb");
  const bobPublic = Buffer.from("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f", "hex").toString("base64url");
  assert.equal(rawX(createPublicKey(bob)).toString("base64url"), bobPublic);
  assert.equal(
    diffieHellman({ privateKey: alice, publicKey: createPublicKey(bob) }).toString("hex"),
    "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742",
  );
  const plaintext = JSON.stringify({ title: "Flowplan", body: "Anna commented: Hello", url: "https://app.example.test/#page=1", id: "n1", category: "flowplan.comment", data: null, sentAt: 1767225600 });
  const payload = encryptForDevice(bobPublic, INSTANCE, plaintext, { privateKey: alice, publicKey: createPublicKey(alice) }, Buffer.from("000102030405060708090a0b", "hex"));
  // Golden value (computed once from the spec, v1.1 context; guards against regressions).
  assert.equal(
    payload,
    "AYUg8AmJMKdUdIt93LQ-91oNvzoNJjga9OukqY6qm05qAAECAwQFBgcICQoLpsBuOc9IKWQyN982gXgnEuhyuKdXVm8KYRILZXpFSEQDrgE3QrZAQcbLoIY-vOHfAwQOqK8GyFuLx0I92Z6o-_VGpX3J-ZT_ENhebh0Y_AusUSxS-DiwwiZ3aeGmNRW5kgtdqukAZrggdv_ylOKwbWIVolHKFT6d_oOMf0gKN0DUAx5bWqh2j6XfDUI99gGBUw4Pd0UYhdBEZ9U7EXjHl-VqLsOSofXOVEOUN1FPUz9xgbN8",
  );
  const bytes = Buffer.from(payload, "base64url");
  assert.equal(bytes.length, 1 + 32 + 12 + Buffer.byteLength(plaintext) + 16);
  assert.equal(bytes.subarray(1, 33).toString("hex"), "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a");
  assert.equal(bytes.subarray(33, 45).toString("hex"), "000102030405060708090a0b");
  assert.equal(decrypt(bob, payload), plaintext);
  // Changed in transit or meant for another device: it does not open.
  const tampered = Buffer.from(bytes);
  tampered[50] ^= 1;
  assert.throws(() => decrypt(bob, tampered.toString("base64url")));
  assert.throws(() => decrypt(deviceKeysPrivate(), payload));
  // Bound to the instance (v1.1): it does not open as another instance's, nor with the v1.0 context.
  assert.throws(() => decrypt(bob, payload, "https://other.example.test"));
  assert.throws(() => decrypt(bob, payload, INSTANCE, Buffer.from("flowplan-push-v1")));
  assert.throws(() => encryptForDevice(bobPublic, `${INSTANCE}/`, plaintext));
});
const deviceKeysPrivate = () => generateKeyPairSync("x25519").privateKey;

test("encryption: random round trip, fresh ephemeral key and nonce every time, bad device keys refused", () => {
  const device = deviceKeys();
  const a = encryptForDevice(device.publicKey, INSTANCE, "{\"x\":1}"),
    b = encryptForDevice(device.publicKey, INSTANCE, "{\"x\":1}");
  assert.notEqual(a, b);
  assert.notDeepEqual(Buffer.from(a, "base64url").subarray(1, 45), Buffer.from(b, "base64url").subarray(1, 45));
  assert.equal(decrypt(device.privateKey, a), "{\"x\":1}");
  assert.equal(validDeviceKey(device.publicKey), true);
  // All zeros (low-order point), wrong length, padding, non-canonical encoding.
  assert.equal(validDeviceKey("A".repeat(43)), false);
  assert.throws(() => encryptForDevice("A".repeat(43), INSTANCE, "x"));
  assert.equal(validDeviceKey(Buffer.alloc(31, 7).toString("base64url")), false);
  assert.equal(validDeviceKey(`${device.publicKey}=`), false);
  const last = device.publicKey.at(-1)!;
  const sibling = "AEIMQUYcgkosw4".includes(last) ? String.fromCharCode(last.charCodeAt(0) + 1) : null;
  if (sibling) assert.equal(validDeviceKey(device.publicKey.slice(0, -1) + sibling), false);
});

test("plaintext: shortened to fit the relay's 2800 bytes (v1.1), the fields the app needs stay", () => {
  const text = plaintextJson({ title: "Flowplan", body: "ü😀".repeat(3000), url: `${INSTANCE}/#page=1`, id: "n", category: null, data: null, sentAt: 1 });
  const parsed = JSON.parse(text);
  assert.equal(MAX_PAYLOAD_BYTES, 2800);
  assert.ok(Buffer.byteLength(text) + 61 <= MAX_PAYLOAD_BYTES);
  assert.ok(parsed.body.endsWith("…"));
  assert.equal(parsed.url, `${INSTANCE}/#page=1`);
  assert.equal(parsed.id, "n");
  const device = deviceKeys();
  assert.ok(Buffer.from(encryptForDevice(device.publicKey, INSTANCE, text), "base64url").length <= MAX_PAYLOAD_BYTES);
});

// ---- §1 Identity, §3 signatures ----

test("signature: the base string, a fixed RFC 8032 vector and the header format", () => {
  const body = Buffer.from('{"messages":[]}');
  const base = identity.signatureBase(INSTANCE, 1767225600, body);
  assert.equal(base.toString("utf8"), `flowplan-push-v1\n${INSTANCE}\n1767225600\n${createHash("sha256").update(body).digest("hex")}`);
  const key = ed25519FromRaw("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");
  assert.equal(createPublicKey(key).export({ format: "jwk" }).x, "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo");
  assert.equal(sign(null, base, key).toString("base64url"), "v5neH5h4qvqFSqvOvOzkWTTp6eFHf758Gv829JwCpgPgyTp7idfiabX-kbgZFjAwROusHtD9d68JiimcW3USCQ");

  const now = Date.now();
  const signed = identity.signRelayRequest(INSTANCE, body, now);
  const match = signed.header.match(/^kid=([A-Za-z0-9_-]{16}), ts=(\d+), sig=([A-Za-z0-9_-]{86})$/);
  assert.ok(match, signed.header);
  assert.equal(Number(match[2]), Math.floor(now / 1000));
  const published = identity.pushIdentityDocument(now).keys.find((k) => k.id === match[1])!;
  const publicKey = identity.publicKeyObject(published.publicKey);
  assert.equal(verify(null, identity.signatureBase(INSTANCE, Number(match[2]), body), publicKey, Buffer.from(match[3], "base64url")), true);
  // Another body (one byte) or another instance: the signature does not fit.
  assert.equal(verify(null, identity.signatureBase(INSTANCE, Number(match[2]), Buffer.from('{"messages":[ ]}')), publicKey, Buffer.from(match[3], "base64url")), false);
  assert.equal(verify(null, identity.signatureBase("https://evil.test", Number(match[2]), body), publicKey, Buffer.from(match[3], "base64url")), false);
});

test("/.well-known/flowplan-push: public keys only, cacheable for an hour; the private key only sealed", async () => {
  const response = wellKnown.GET();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "public, max-age=3600");
  const doc = (await response.json()) as { version: number; keys: Record<string, string>[] };
  assert.deepEqual(Object.keys(doc).sort(), ["keys", "version"]);
  assert.equal(doc.version, 1);
  assert.ok(doc.keys.length >= 1);
  for (const k of doc.keys) {
    assert.deepEqual(Object.keys(k).sort(), ["alg", "id", "publicKey"]);
    assert.equal(k.alg, "Ed25519");
    assert.equal(Buffer.from(k.publicKey, "base64url").length, 32);
  }
  for (const row of all<{ private_key: string }>("SELECT private_key FROM push_identity_keys")) {
    assert.match(row.private_key, /^fps1:/);
    assert.doesNotMatch(row.private_key, /PRIVATE|MC4CAQ/);
  }
  process.env.PUSH_RELAY = "off";
  try {
    assert.equal(wellKnown.GET().status, 404);
  } finally {
    delete process.env.PUSH_RELAY;
  }
});

test("key rotation: the new key is listed first and signs after the publish delay; the old one stays for the grace period", () => {
  const now = Date.now() + 1000;
  const before = identity.signRelayRequest(INSTANCE, Buffer.from("x"), now).kid;
  const rotated = identity.rotatePushIdentity({ graceMs: 2 * 86_400_000 }, now);
  assert.equal(rotated.retired, before);
  const listed = identity.pushIdentityDocument(now).keys.map((k) => k.id);
  assert.ok(listed.includes(before) && listed.includes(rotated.kid));
  assert.equal(identity.signRelayRequest(INSTANCE, Buffer.from("x"), now).kid, before);
  const later = rotated.activeFrom + 1;
  assert.equal(identity.signRelayRequest(INSTANCE, Buffer.from("x"), later).kid, rotated.kid);
  assert.ok(identity.pushIdentityDocument(later).keys.some((k) => k.id === before));
  const afterGrace = rotated.retiredAt! + 1;
  assert.deepEqual(identity.pushIdentityDocument(afterGrace).keys.map((k) => k.id), [rotated.kid]);
  assert.equal(one("SELECT kid FROM push_identity_keys WHERE kid=?", before), undefined);
  // Many rotations never list more than a handful of keys.
  for (let i = 0; i < 12; i++) identity.rotatePushIdentity({}, afterGrace + i);
  assert.ok(identity.pushIdentityDocument(afterGrace + 20).keys.length <= 5);
  // Emergency: the new key signs at once, nothing older is listed.
  const urgent = identity.rotatePushIdentity({ immediate: true }, afterGrace + 30);
  assert.deepEqual(identity.pushIdentityDocument(afterGrace + 31).keys.map((k) => k.id), [urgent.kid]);
  assert.equal(identity.signRelayRequest(INSTANCE, Buffer.from("x"), afterGrace + 31).kid, urgent.kid);
  // Back to the present for the other tests.
  identity.rotatePushIdentity({ immediate: true });
});

// ---- Configuration ----

test("relay URL: https origins only (http for localhost), nothing else; PUSH_RELAY=off", () => {
  assert.equal(strictOrigin("https://push.flowplan.org"), "https://push.flowplan.org");
  assert.equal(strictOrigin("https://push.flowplan.org/"), "https://push.flowplan.org");
  assert.equal(strictOrigin("http://localhost:8080"), "http://localhost:8080");
  for (const bad of ["http://push.flowplan.org", "https://user:pw@push.flowplan.org", "https://push.flowplan.org/v1", "https://push.flowplan.org?x=1", "ftp://x", "file:///etc/passwd", "javascript:alert(1)", "not a url", "http://10.0.0.1"])
    assert.equal(strictOrigin(bad), null, bad);
  const saved = process.env.PUSH_RELAY_URL;
  try {
    delete process.env.PUSH_RELAY_URL;
    assert.deepEqual(relayConfig(), { enabled: true, relay: "https://push.flowplan.org", instance: INSTANCE });
    process.env.PUSH_RELAY_URL = "http://relay.example.test";
    assert.equal(relayConfig().enabled, false);
    process.env.PUSH_RELAY_URL = saved;
    process.env.PUSH_RELAY = "off";
    assert.deepEqual(relayConfig(), { enabled: false, reason: "off" });
  } finally {
    process.env.PUSH_RELAY_URL = saved;
    delete process.env.PUSH_RELAY;
  }
});

// ---- Registration (instance API of the app) ----

test("registration: older apps (Expo only) unchanged; relay token and key validated strictly and stored sealed", () => {
  const { user, token } = account("relay-register");
  // Version 1: as before.
  const old = registerMobileDevice(user, token, { installationId: randomUUID(), platform: "ios", pushToken: expoToken() });
  assert.equal(old.push, true);
  assert.equal(old.relay, false);
  assert.deepEqual(old.liveActivities, []);

  const keys = deviceKeys(),
    relay = relayToken();
  const installationId = randomUUID();
  const fresh = registerMobileDevice(user, token, { installationId, platform: "android", relayToken: relay, publicKey: keys.publicKey, relayUrl: `${process.env.PUSH_RELAY_URL}/` });
  assert.equal(fresh.push, true);
  assert.equal(fresh.relay, true);
  assert.doesNotMatch(JSON.stringify(fresh), new RegExp(relay));
  const stored = one<{ relay_token: string; public_key: string; device_id: string }>(
    "SELECT r.* FROM mobile_push_relay r JOIN mobile_devices d ON d.id=r.device_id WHERE d.installation_id=?",
    installationId,
  )!;
  assert.match(stored.relay_token, /^fps1:/);
  assert.ok(!stored.relay_token.includes(relay));
  assert.equal(stored.public_key, keys.publicKey);
  assert.equal(one<{ endpoint: string }>("SELECT s.endpoint FROM push_subscriptions s JOIN mobile_devices d ON d.push_subscription_id=s.id WHERE d.installation_id=?", installationId)!.endpoint, `relay:${stored.device_id}`);
  // Nothing in the database holds the token in plain text.
  assert.equal(one("SELECT 1 FROM push_subscriptions WHERE endpoint LIKE ?", `%${relay}%`), undefined);
  // The device list says relay, never the token.
  const listed = devices.listMobileDevices(user);
  assert.equal(listed.find((d) => d.installation_id === installationId)?.relay, 1);
  assert.doesNotMatch(JSON.stringify(listed), new RegExp(relay));

  const base = { installationId: randomUUID(), platform: "ios" };
  assert.throws(() => registerMobileDevice(user, token, { ...base, relayToken: relayToken() }), /publicKey/);
  assert.throws(() => registerMobileDevice(user, token, { ...base, publicKey: keys.publicKey }), /publicKey/);
  assert.throws(() => registerMobileDevice(user, token, { ...base, relayToken: "short", publicKey: keys.publicKey }));
  assert.throws(() => registerMobileDevice(user, token, { ...base, relayToken: relayToken(), publicKey: keys.publicKey.slice(1) }));
  assert.throws(() => registerMobileDevice(user, token, { ...base, relayToken: `${relayToken()}!`, publicKey: keys.publicKey }));
  assert.throws(() => registerMobileDevice(user, token, { ...base, relayToken: relayToken(), publicKey: "A".repeat(43) }), /Push-Schlüssel/);
  assert.throws(() => registerMobileDevice(user, token, { ...base, liveActivityRelayTokens: { focus: relayToken(), meeting: relayToken() } }));
  assert.throws(() => registerMobileDevice(user, token, { ...base, relayUrl: "x".repeat(400), relayToken: relayToken(), publicKey: keys.publicKey }));

  // Another relay than the instance's: registered, but without the relay part.
  const other = registerMobileDevice(user, token, { ...base, relayToken: relayToken(), publicKey: keys.publicKey, relayUrl: "https://evil.example.test" });
  assert.equal(other.relay, false);
  assert.equal(other.push, false);
  assert.deepEqual(devices.pushRelayInfo(), { version: 1, url: process.env.PUSH_RELAY_URL, instance: INSTANCE });

  // Unregistering removes the relay part with the installation.
  unregisterMobileDevice(user, installationId);
  assert.equal(one("SELECT 1 FROM mobile_push_relay WHERE device_id=?", stored.device_id), undefined);
});

test("registration: relay off or mobile push off store no relay token; still at most 20 apps", () => {
  const { user, token } = account("relay-limits");
  const keys = deviceKeys();
  for (const [name, value] of [["PUSH_RELAY", "off"], ["MOBILE_PUSH", "off"]] as const) {
    process.env[name] = value;
    try {
      const result = registerMobileDevice(user, token, { installationId: randomUUID(), platform: "ios", relayToken: relayToken(), publicKey: keys.publicKey, liveActivityRelayTokens: { timer: relayToken() } });
      assert.equal(result.relay, false);
      assert.deepEqual(result.liveActivities, []);
      assert.equal(devices.pushRelayInfo(), null);
    } finally {
      delete process.env[name];
    }
  }
  assert.equal(one<{ n: number }>("SELECT COUNT(*) n FROM mobile_push_relay r JOIN mobile_devices d ON d.id=r.device_id WHERE d.user_id=?", user.id)!.n, 0);
  for (let i = 2; i < 20; i++) registerMobileDevice(user, token, { installationId: randomUUID(), platform: "ios", relayToken: relayToken(), publicKey: keys.publicKey });
  assert.throws(() => registerMobileDevice(user, token, { installationId: randomUUID(), platform: "ios", relayToken: relayToken(), publicKey: keys.publicKey }), /20/);
});

test("registration: a relay token moves with the phone to the account that registered it last", () => {
  const anna = account("relay-anna"),
    ben = account("relay-ben");
  const shared = relayToken(),
    keys = deviceKeys(),
    installationId = randomUUID();
  registerMobileDevice(anna.user, anna.token, { installationId, platform: "ios", relayToken: shared, publicKey: keys.publicKey });
  registerMobileDevice(ben.user, ben.token, { installationId, platform: "ios", relayToken: shared, publicKey: keys.publicKey });
  const owners = all<{ user_id: string }>("SELECT d.user_id FROM mobile_push_relay r JOIN mobile_devices d ON d.id=r.device_id WHERE r.token_hash=?", createHash("sha256").update(shared).digest("hex"));
  assert.deepEqual(owners.map((o) => o.user_id), [ben.user.id]);
});

// ---- Sending through the relay ----

test("a notification goes to the relay signed and end-to-end encrypted: no plaintext leaves the instance", async () => {
  const { user, token } = account("relay-sender");
  const keys = deviceKeys(),
    relay = relayToken();
  registerMobileDevice(user, token, { installationId: randomUUID(), platform: "ios", relayToken: relay, publicKey: keys.publicKey, pushToken: expoToken() });
  const notificationId = id();
  run("INSERT INTO notifications(id,user_id,body) VALUES(?,?,?)", notificationId, user.id, "Quarterly numbers are confidential");
  requests.length = 0;
  handler = okAll;
  const { lines } = await quietly(() => flushPushQueue(noWebPush, noExpo));
  assert.equal(requests.length, 1);
  const [request] = requests;
  assert.equal(request.method, "POST");
  assert.equal(request.path, "/v1/send");
  assert.equal(request.headers["content-type"], "application/json");
  assert.equal(request.headers["flowplan-instance"], INSTANCE);
  // The signature covers exactly the bytes that arrived.
  const match = String(request.headers["flowplan-signature"]).match(/^kid=([^,]+), ts=(\d+), sig=([A-Za-z0-9_-]+)$/)!;
  const doc = (await wellKnown.GET().json()) as { keys: { id: string; publicKey: string }[] };
  const key = identity.publicKeyObject(doc.keys.find((k) => k.id === match[1])!.publicKey);
  const base = Buffer.from(`flowplan-push-v1\n${INSTANCE}\n${match[2]}\n${createHash("sha256").update(request.body).digest("hex")}`);
  assert.equal(verify(null, base, key, Buffer.from(match[3], "base64url")), true);
  assert.ok(Math.abs(Number(match[2]) - Date.now() / 1000) < 10);

  const text = request.body.toString("utf8");
  // A random requestId (v1.1, replay protection): 16 bytes, base64url.
  const sent = JSON.parse(text) as { requestId: string };
  assert.deepEqual(Object.keys(sent).sort(), ["messages", "requestId"]);
  assert.match(sent.requestId, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(Buffer.from(sent.requestId, "base64url").length, 16);
  for (const secret of ["Quarterly", "confidential", "Flowplan", "relay-sender", notificationId, keys.publicKey, "/#"]) assert.ok(!text.includes(secret), secret);
  const [message] = messagesOf(request);
  assert.deepEqual(Object.keys(message).sort(), ["badge", "category", "collapseId", "liveActivity", "payload", "priority", "to", "ttl", "type"]);
  assert.equal(message.to, relay);
  assert.equal(message.type, "alert");
  assert.equal(message.category, "default");
  assert.equal(message.badge, 1);
  assert.equal(message.priority, "high");
  assert.equal(message.liveActivity, null);
  const plain = JSON.parse(decrypt(keys.privateKey, message.payload));
  assert.deepEqual(Object.keys(plain).sort(), ["body", "category", "data", "id", "sentAt", "title", "url"]);
  // MOBILE_PUSH_CONTENT unset: the text comes along, only the app reads it.
  assert.match(plain.body, /Quarterly numbers are confidential/);
  assert.equal(plain.title, "Flowplan");
  assert.equal(plain.id, notificationId);
  assert.equal(new URL(plain.url).origin, INSTANCE);
  assert.equal(plain.category, "flowplan.read");
  assert.ok(Math.abs(plain.sentAt - Date.now() / 1000) < 10);
  assert.ok(one("SELECT 1 FROM push_deliveries WHERE notification_id=? AND delivered_at IS NOT NULL", notificationId));
  // Nothing of it in the logs.
  assert.doesNotMatch(lines.join("\n"), new RegExp(`${relay}|Quarterly|${keys.publicKey}`));

  // MOBILE_PUSH_CONTENT=off: even the relay gets only the general text.
  process.env.MOBILE_PUSH_CONTENT = "off";
  try {
    run("INSERT INTO notifications(id,user_id,body) VALUES(?,?,?)", id(), user.id, "Second secret");
    requests.length = 0;
    await flushPushQueue(noWebPush, noExpo);
    const second = JSON.parse(decrypt(keys.privateKey, messagesOf(requests[0])[0].payload));
    assert.notEqual(JSON.parse(requests[0].body.toString()).requestId, sent.requestId);
    assert.doesNotMatch(second.body, /Second secret/);
  } finally {
    delete process.env.MOBILE_PUSH_CONTENT;
  }
});

test("relay answers: ok, gone, rate_limited, forbidden (Expo takes over), invalid, error", async () => {
  const { user, token } = account("relay-outcomes");
  const keys = deviceKeys();
  const install = (status: string, withExpo: boolean) => {
    const relay = relayToken(),
      installationId = randomUUID();
    registerMobileDevice(user, token, { installationId, platform: "ios", relayToken: relay, publicKey: keys.publicKey, ...(withExpo ? { pushToken: expoToken() } : {}) });
    const device = one<{ id: string; push_subscription_id: string }>("SELECT id,push_subscription_id FROM mobile_devices WHERE installation_id=?", installationId)!;
    return { status, relay, device };
  };
  const set = [install("ok", false), install("gone", false), install("rate_limited", true), install("forbidden", true), install("invalid", false), install("error", false)];
  const byToken = new Map(set.map((s) => [s.relay, s.status]));
  const notificationId = id();
  run("INSERT INTO notifications(id,user_id,body) VALUES(?,?,?)", notificationId, user.id, "Outcome check");
  requests.length = 0;
  handler = (r) => ({
    status: 200,
    json: { results: messagesOf(r).map((m) => (byToken.get(m.to) === "rate_limited" ? { status: "rate_limited", retryAfter: 30 } : { status: byToken.get(m.to) })) },
  });
  const expo: string[] = [];
  const started = Date.now();
  const { lines } = await quietly(() =>
    flushPushQueue(noWebPush, async (m) => {
      expo.push(m.to);
    }),
  );
  assert.equal(requests.length, 1);
  assert.equal(messagesOf(requests[0]).length, 6);
  assert.equal(expo.length, 0);
  const delivery = (s: (typeof set)[number]) =>
    one<{ delivered_at: number | null; attempts: number; available_at: number; last_error: string | null }>(
      "SELECT delivered_at,attempts,available_at,last_error FROM push_deliveries WHERE notification_id=? AND subscription_id=?",
      notificationId,
      s.device.push_subscription_id,
    );
  const [ok, gone, limited, forbidden, invalid, error] = set;
  assert.ok(delivery(ok)?.delivered_at);
  // gone: the installation is removed.
  assert.equal(one("SELECT 1 FROM mobile_devices WHERE id=?", gone.device.id), undefined);
  assert.equal(one("SELECT 1 FROM push_subscriptions WHERE id=?", gone.device.push_subscription_id), undefined);
  // rate_limited: later, without counting as an attempt.
  assert.equal(delivery(limited)!.attempts, 0);
  assert.ok(delivery(limited)!.available_at >= started + 29_000);
  assert.ok(one("SELECT 1 FROM mobile_push_relay WHERE device_id=?", limited.device.id));
  // forbidden: the relay part goes, the Expo token takes over at once.
  assert.equal(one("SELECT 1 FROM mobile_push_relay WHERE device_id=?", forbidden.device.id), undefined);
  assert.ok(one("SELECT 1 FROM mobile_devices WHERE id=?", forbidden.device.id));
  assert.equal(delivery(forbidden)!.delivered_at, null);
  // invalid without Expo: nothing can reach it any more.
  assert.equal(one("SELECT 1 FROM mobile_push_relay WHERE device_id=?", invalid.device.id), undefined);
  assert.equal(one("SELECT 1 FROM push_subscriptions WHERE id=?", invalid.device.push_subscription_id), undefined);
  // error: the usual backoff.
  assert.equal(delivery(error)!.attempts, 1);
  assert.equal(delivery(error)!.last_error, "Relay: error");
  assert.ok(delivery(error)!.available_at > Date.now() + 20_000);
  // Logged without tokens.
  assert.ok(lines.some((l) => /forbidden/.test(l)));
  assert.doesNotMatch(lines.join("\n"), new RegExp(set.map((s) => s.relay).join("|")));

  // The next round: the forbidden device gets its notification through Expo.
  requests.length = 0;
  await flushPushQueue(noWebPush, async (m) => {
    expo.push(m.to);
  });
  assert.equal(expo.length, 1);
  assert.equal(requests.length, 0);
  assert.ok(delivery(forbidden)!.delivered_at);
});

test("relay failures: HTTP errors and 429 are retried, redirects are never followed", async () => {
  const { user, token } = account("relay-failures");
  const keys = deviceKeys();
  registerMobileDevice(user, token, { installationId: randomUUID(), platform: "ios", relayToken: relayToken(), publicKey: keys.publicKey });
  const pending = () => one<{ attempts: number; available_at: number; delivered_at: number | null }>("SELECT d.attempts,d.available_at,d.delivered_at FROM push_deliveries d JOIN push_subscriptions s ON s.id=d.subscription_id WHERE s.user_id=?", user.id)!;
  const ready = () => run("UPDATE push_deliveries SET available_at=0 WHERE subscription_id IN (SELECT id FROM push_subscriptions WHERE user_id=?)", user.id);
  run("INSERT INTO notifications(id,user_id,body) VALUES(?,?,?)", id(), user.id, "Failure check");

  handler = () => ({ status: 500, json: { error: "boom" } });
  await quietly(() => flushPushQueue(noWebPush, noExpo));
  assert.equal(pending().attempts, 1);
  assert.equal(pending().delivered_at, null);

  ready();
  handler = () => ({ status: 429, headers: { "Retry-After": "120" } });
  const before = Date.now();
  await quietly(() => flushPushQueue(noWebPush, noExpo));
  assert.equal(pending().attempts, 1);
  assert.ok(pending().available_at >= before + 119_000);

  // A redirect (e.g. to an internal address) is an error, not followed.
  ready();
  let followed = false;
  const elsewhere = createServer((_req, res) => {
    followed = true;
    res.end("{}");
  });
  await new Promise<void>((resolve) => elsewhere.listen(0, "127.0.0.1", resolve));
  handler = () => ({ status: 307, headers: { Location: `http://127.0.0.1:${(elsewhere.address() as { port: number }).port}/v1/send` } });
  await quietly(() => flushPushQueue(noWebPush, noExpo));
  elsewhere.close();
  assert.equal(followed, false);
  assert.equal(pending().attempts, 2);

  // Whole-request errors (v1.1 §6.6) never drop the registration.
  for (const status of [400, 401, 403, 409, 413, 415, 502]) {
    ready();
    handler = () => ({ status, json: { error: "x" } });
    await quietly(() => flushPushQueue(noWebPush, noExpo));
    assert.ok(one("SELECT 1 FROM mobile_push_relay r JOIN mobile_devices d ON d.id=r.device_id WHERE d.user_id=?", user.id), String(status));
  }
  run("UPDATE push_deliveries SET attempts=2 WHERE subscription_id IN (SELECT id FROM push_subscriptions WHERE user_id=?)", user.id);

  // A malformed answer (wrong number of results) is an error too.
  ready();
  handler = () => ({ status: 200, json: { results: [] } });
  await quietly(() => flushPushQueue(noWebPush, noExpo));
  assert.equal(pending().attempts, 3);
  assert.equal(pending().delivered_at, null);
});

test("batches of at most 100 messages per request", async () => {
  const sizes: number[] = [];
  const messages = Array.from({ length: 230 }, () => ({ to: relayToken(), type: "alert" as const, payload: "AQ", category: null, collapseId: null, badge: null, priority: "high" as const, ttl: 60, liveActivity: null }));
  const results = await sendBatched(messages, async (chunk) => {
    sizes.push(chunk.length);
    return chunk.map(() => ({ status: "ok" as const }));
  });
  assert.deepEqual(sizes, [100, 100, 30]);
  assert.equal(results.length, 230);
  // A sender that throws or answers short: the rest counts as error.
  const short = await sendBatched(messages.slice(0, 3), async () => [{ status: "ok" }]);
  assert.deepEqual(short.map((r) => r.status), ["ok", "error", "error"]);
});

test("PUSH_RELAY=off: a device with an Expo token gets Expo, a relay-only device nothing", async () => {
  const { user, token } = account("relay-off");
  const keys = deviceKeys();
  const expo = expoToken();
  registerMobileDevice(user, token, { installationId: randomUUID(), platform: "ios", relayToken: relayToken(), publicKey: keys.publicKey, pushToken: expo });
  registerMobileDevice(user, token, { installationId: randomUUID(), platform: "ios", relayToken: relayToken(), publicKey: keys.publicKey });
  run("INSERT INTO notifications(id,user_id,body) VALUES(?,?,?)", id(), user.id, "Relay off");
  process.env.PUSH_RELAY = "off";
  requests.length = 0;
  const sent: { to: string; body: string }[] = [];
  try {
    await flushPushQueue(noWebPush, async (m) => {
      sent.push(m);
    });
  } finally {
    delete process.env.PUSH_RELAY;
  }
  assert.equal(requests.length, 0);
  assert.deepEqual(sent.map((m) => m.to), [expo]);
  // Expo keeps its default: no content.
  assert.doesNotMatch(sent[0].body, /Relay off/);
});

// ---- Live Activities ----

// The app's texts for its views (flowplan-app src/activities.ts →
// liveActivityLabels), as it sends them.
const LABELS = {
  locale: "en",
  timeZone: "Europe/Berlin",
  focus: { focus: "Focus", break: "Break", until: "until {time}", stop: "End" },
  timer: { label: "Time tracking" },
};
// expo-widgets' content state: { name, props: JSON }.
const viewProps = (state: { name: string; props: string }) => {
  assert.deepEqual(Object.keys(state).sort(), ["name", "props"]);
  assert.equal(typeof state.props, "string");
  return { name: state.name, props: JSON.parse(state.props) as Record<string, any> };
};
const TIMER_KEYS = ["database", "label", "start", "title", "url"];
const FOCUS_KEYS = ["endsAt", "label", "phase", "startedAt", "stopLabel", "title", "untilLabel", "url"];

test("Live Activities: timer changes are pushed as liveactivity messages without titles", async () => {
  const { user, token } = account("relay-live");
  const wid = createWorkspace(user.id, "Live"),
    boot = bootstrap(user, wid);
  const dbId = (command(user, { action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, kind: "database", title: "Billable work" }) as { id: string }).id;
  command(user, {
    action: "database.update",
    pageId: dbId,
    version: database(dbId).version,
    fields: [
      { id: "title", name: "Title", type: "text" },
      { id: "spent", name: "Time", type: "time" },
    ],
    views: database(dbId).views,
  });
  const rowId = (command(user, { action: "row.create", pageId: dbId, cells: { title: "Secret client project" } }) as { id: string }).id;
  const timerToken = relayToken(),
    focusToken = relayToken();
  const registered = registerMobileDevice(user, token, { installationId: randomUUID(), platform: "ios", liveActivityRelayTokens: { timer: timerToken }, liveActivityLabels: LABELS });
  assert.deepEqual(registered.liveActivities, ["timer"]);
  // Labels that do not check out are left out, never the registration.
  {
    const other = account("relay-live-labels");
    const kept = registerMobileDevice(other.user, other.token, { installationId: randomUUID(), platform: "ios", liveActivityRelayTokens: { timer: relayToken() }, liveActivityLabels: { ...LABELS, timeZone: "Mars/Olympus" } });
    assert.deepEqual(kept.liveActivities, ["timer"]);
    assert.equal(one<{ labels: string | null }>("SELECT l.labels FROM mobile_live_activities l JOIN mobile_devices d ON d.id=l.device_id WHERE d.user_id=?", other.user.id)!.labels, null);
  }
  // Without a notification permission there is no push subscription, but the Live Activity works.
  assert.equal(registered.push, false);
  assert.throws(() => setLiveActivityToken("Bearer fpd_notarealtokenatall00000", { kind: "focus", relayToken: focusToken }), /melde dich an/);
  assert.throws(() => setLiveActivityToken(`Bearer ${registered.deviceToken}`, { kind: "meeting", relayToken: focusToken }));
  assert.deepEqual(setLiveActivityToken(`Bearer ${registered.deviceToken}`, { kind: "focus", relayToken: focusToken, labels: LABELS }).liveActivities, ["focus", "timer"]);

  command(user, { action: "time.start", pageId: dbId, rowId, fieldId: "spent" });
  assert.equal(one<{ n: number }>("SELECT COUNT(*) n FROM push_live_queue WHERE kind='timer'")!.n, 1);
  requests.length = 0;
  handler = okAll;
  await flushPushQueue(noWebPush, noExpo);
  assert.equal(requests.length, 1);
  const [update] = messagesOf(requests[0]);
  assert.equal(update.to, timerToken);
  assert.equal(update.type, "liveactivity");
  assert.ok(!("payload" in update));
  assert.equal(update.liveActivity.event, "update");
  // Every prop the app's FlowplanTimer view reads, the title only as the label.
  const shown = viewProps(update.liveActivity.contentState);
  assert.equal(shown.name, "FlowplanTimer");
  assert.deepEqual(Object.keys(shown.props).sort(), TIMER_KEYS);
  assert.ok(Math.abs(shown.props.start - Date.now()) < 10_000);
  assert.deepEqual({ ...shown.props, start: 0 }, { title: "Time tracking", database: "", start: 0, label: "Time tracking", url: "flowplan://open?path=%2F" });
  assert.doesNotMatch(requests[0].body.toString(), /Secret client project|Billable work/);

  command(user, { action: "time.stop", pageId: dbId, rowId, fieldId: "spent" });
  requests.length = 0;
  await flushPushQueue(noWebPush, noExpo);
  const [end] = messagesOf(requests[0]);
  assert.equal(end.liveActivity.event, "end");
  assert.equal(viewProps(end.liveActivity.contentState).name, "FlowplanTimer");
  assert.deepEqual(Object.keys(viewProps(end.liveActivity.contentState).props).sort(), TIMER_KEYS);
  assert.ok(end.liveActivity.dismissalDate);
  // An ended activity takes no more pushes.
  assert.equal(one("SELECT 1 FROM mobile_live_activities l JOIN mobile_devices d ON d.id=l.device_id WHERE l.kind='timer' AND d.user_id=?", user.id), undefined);

  // With MOBILE_PUSH_CONTENT=on the title comes along (plain text, by choice).
  process.env.MOBILE_PUSH_CONTENT = "on";
  try {
    setLiveActivityToken(`Bearer ${registered.deviceToken}`, { kind: "timer", relayToken: timerToken, labels: LABELS });
    command(user, { action: "time.start", pageId: dbId, rowId, fieldId: "spent" });
    requests.length = 0;
    await flushPushQueue(noWebPush, noExpo);
    const withContent = viewProps(messagesOf(requests[0])[0].liveActivity.contentState).props;
    assert.equal(withContent.title, "Secret client project");
    assert.equal(withContent.database, "Billable work");
    assert.match(withContent.url, /^flowplan:\/\/open\?path=%2F%23/);
    command(user, { action: "time.stop", pageId: dbId, rowId, fieldId: "spent" });
    await flushPushQueue(noWebPush, noExpo);
  } finally {
    delete process.env.MOBILE_PUSH_CONTENT;
  }
});

test("Live Activities: a focus session pushes its start, the break and its end; gone forgets the token", async () => {
  const { user, token } = account("relay-focus");
  const focusToken = relayToken();
  const registered = registerMobileDevice(user, token, { installationId: randomUUID(), platform: "ios", liveActivityRelayTokens: { focus: focusToken }, liveActivityLabels: LABELS });
  const device = identityFromDeviceToken(`Bearer ${registered.deviceToken}`)!;
  const started = Date.now();
  await widgetAction(device, { action: "focus.start", minutes: 25, breakMinutes: 5 });
  assert.equal(one<{ n: number }>("SELECT COUNT(*) n FROM push_live_queue q JOIN mobile_devices d ON d.id=q.device_id WHERE d.user_id=?", user.id)!.n, 3);
  const sent: Record<string, any>[] = [];
  const sender = async (messages: Record<string, any>[]) => {
    sent.push(...messages);
    return messages.map(() => ({ status: "ok" as const }));
  };
  await flushLiveActivities(sender, Date.now());
  assert.equal(sent.length, 1);
  const focus = viewProps(sent[0].liveActivity.contentState);
  assert.equal(focus.name, "FlowplanFocus");
  assert.deepEqual(Object.keys(focus.props).sort(), FOCUS_KEYS);
  assert.equal(focus.props.phase, "focus");
  assert.equal(focus.props.label, "Focus");
  assert.equal(focus.props.title, "Focus");
  assert.equal(focus.props.stopLabel, "End");
  assert.ok(Math.abs(focus.props.endsAt - (started + 25 * 60_000)) < 5000);
  // The time in the phone's time zone and language, as the app's clock() writes it.
  const berlin = new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" }).format(new Date(focus.props.endsAt));
  assert.equal(focus.props.untilLabel, `until ${berlin}`);
  assert.equal(sent[0].liveActivity.staleDate, Math.ceil(focus.props.endsAt / 1000));
  // When the focus time is over: the break.
  await flushLiveActivities(sender, started + 25 * 60_000 + 2000);
  assert.equal(sent.length, 2);
  const pause = viewProps(sent[1].liveActivity.contentState).props;
  assert.equal(pause.phase, "break");
  assert.equal(pause.label, "Break");
  assert.equal(pause.startedAt, focus.props.endsAt);
  // Gone (the activity was dismissed): the token is forgotten, the end is not sent.
  await flushLiveActivities(async (messages) => messages.map(() => ({ status: "gone" as const })), started + 31 * 60_000);
  assert.equal(one("SELECT 1 FROM mobile_live_activities l JOIN mobile_devices d ON d.id=l.device_id WHERE d.user_id=?", user.id), undefined);
});

// The relay's test vectors (flowplan-push docs/test-vectors.json). The
// relay repository's current file when it is checked out next to this one,
// else the copy in tests/fixtures/push-relay-vectors.json. Vectors that
// name their instance (protocol v1.1, §6.9) are reproduced byte for byte;
// older ones (v1.0, no instance binding) only check the shared steps.
function siblingVectors() {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const file = join(dir, "flowplan-push", "docs", "test-vectors.json");
    if (existsSync(file)) return file;
    dir = join(dir, "..");
  }
  return null;
}
const vectors = JSON.parse(readFileSync(siblingVectors() ?? join(import.meta.dirname, "fixtures", "push-relay-vectors.json"), "utf8")) as {
  e2e: { vectors: Record<string, string>[]; invalid: { name: string; payload: string; devicePrivateKey: string; instance?: string }[] };
  signatures: { vectors: (Record<string, string> & { ts: number; headers: Record<string, string>; wellKnown: unknown })[] };
};

test("relay test vectors: encryption gives exactly the relay's payloads, the decryptor reads them and refuses the broken ones", () => {
  assert.ok(vectors.e2e.vectors.length >= 3);
  // The protocol is v1.1 now: at least the copy in tests/fixtures binds to the instance.
  assert.ok(vectors.e2e.vectors.every((v) => v.instance), "test vectors predate protocol v1.1");
  for (const v of vectors.e2e.vectors) {
    const info = Buffer.from(v.hkdfInfo, "utf8"),
      aad = Buffer.from(v.aad, "utf8");
    const ephemeral = x25519FromRaw(Buffer.from(v.ephemeralPrivateKey, "base64url").toString("hex"));
    assert.equal(rawX(createPublicKey(ephemeral)).toString("base64url"), v.ephemeralPublicKey, v.name);
    const device = x25519FromRaw(Buffer.from(v.devicePrivateKey, "base64url").toString("hex"));
    assert.equal(diffieHellman({ privateKey: ephemeral, publicKey: createPublicKey(device) }).toString("hex"), v.sharedSecretHex, v.name);
    assert.equal(Buffer.from(hkdfSync("sha256", Buffer.from(v.sharedSecretHex, "hex"), Buffer.from(v.hkdfSaltHex, "hex"), info, 32)).toString("hex"), v.keyHex, v.name);
    assert.equal(decrypt(device, v.payload, v.instance ?? INSTANCE, info, aad), v.plaintext, v.name);
    if (v.instance) {
      assert.throws(() => decrypt(device, v.payload, "https://other.example.test"), Error, v.name);
      assert.equal(v.hkdfInfo, `flowplan-push-v1\n${v.instance}`);
      assert.equal(v.aad, v.hkdfInfo);
      const payload = encryptForDevice(v.devicePublicKey, v.instance, v.plaintext, { privateKey: ephemeral, publicKey: createPublicKey(ephemeral) }, Buffer.from(v.nonceHex, "hex"));
      assert.equal(payload, v.payload, v.name);
    }
  }
  assert.ok(vectors.e2e.invalid.length >= 5);
  const first = vectors.e2e.vectors[0];
  for (const v of vectors.e2e.invalid) {
    const device = x25519FromRaw(Buffer.from(v.devicePrivateKey, "base64url").toString("hex"));
    // v1.1 vectors name the instance to decrypt as; v1.0 ones use the plain context.
    const info = v.instance ? contextFor(v.instance) : Buffer.from(first.hkdfInfo, "utf8");
    assert.throws(() => decrypt(device, v.payload, v.instance ?? INSTANCE, info, info), Error, v.name);
  }
});

test("relay test vectors: signing string, signature, header and key document", () => {
  assert.ok(vectors.signatures.vectors.length >= 1);
  for (const v of vectors.signatures.vectors) {
    const body = Buffer.from(v.body, "utf8");
    assert.equal(identity.signatureBase(v.instance, v.ts, body).toString("utf8"), v.signingString);
    const key = ed25519FromRaw(Buffer.from(v.privateKeySeed, "base64url").toString("hex"));
    assert.equal(createPublicKey(key).export({ format: "jwk" }).x, v.publicKey);
    const sig = sign(null, identity.signatureBase(v.instance, v.ts, body), key).toString("base64url");
    assert.equal(sig, v.signature);
    assert.equal(`kid=${v.kid}, ts=${v.ts}, sig=${sig}`, v.headers["flowplan-signature"]);
    assert.equal(v.instance, v.headers["flowplan-instance"]);
    assert.equal(v.instance, new URL(v.instance).origin);
    assert.equal(verify(null, identity.signatureBase(v.instance, v.ts, body), identity.publicKeyObject(v.publicKey), Buffer.from(v.signature, "base64url")), true);
  }
  // Our document has the same shape as the relay's example.
  const ours = identity.pushIdentityDocument();
  const theirs = vectors.signatures.vectors[0].wellKnown as typeof ours;
  assert.deepEqual(Object.keys(ours).sort(), Object.keys(theirs).sort());
  assert.deepEqual(Object.keys(ours.keys[0]).sort(), Object.keys(theirs.keys[0]).sort());
});

// ---- The contract with the app (flowplan-app test/fixtures/push-contract.json) ----
//
// What this instance really sends – an alert through the whole queue, and
// the Live Activity states of both views – kept in
// tests/fixtures/push-contract.json. The app's tests decrypt that payload
// with its own code and read the states with its views' props; this test
// checks that the fixture is still what the code produces.
// FLOWPLAN_WRITE_CONTRACT=1 writes it anew (then copy it to the app).
const CONTRACT = join(import.meta.dirname, "fixtures", "push-contract.json");
// A fixed device key (only for the fixture).
const CONTRACT_DEVICE = "a8abababababababababababababababababababababababababababababab6b";

test("contract with the app: an alert and both Live Activity views, as sent", async () => {
  const devicePrivate = x25519FromRaw(CONTRACT_DEVICE);
  const devicePublic = rawX(createPublicKey(devicePrivate)).toString("base64url");
  const { user, token } = account("relay-contract");
  const relay = relayToken();
  registerMobileDevice(user, token, { installationId: randomUUID(), platform: "ios", relayToken: relay, publicKey: devicePublic, relayUrl: process.env.PUSH_RELAY_URL });
  const notificationId = id();
  run("INSERT INTO notifications(id,user_id,body) VALUES(?,?,?)", notificationId, user.id, "Anna commented on Roadmap");
  requests.length = 0;
  handler = okAll;
  await flushPushQueue(noWebPush, noExpo);
  const [message] = messagesOf(requests[0]);
  const plaintext = JSON.parse(decrypt(devicePrivate, message.payload));
  // A comment, through the same encryption (its category is the one with "Reply").
  const comment = encryptForDevice(
    devicePublic,
    INSTANCE,
    plaintextJson({ title: "Flowplan", body: "Ben: Looks good", url: `${INSTANCE}/#page=00000000-0000-4000-8000-000000000001`, id: "contract-comment", category: "flowplan.comment", data: { kind: "comment" }, sentAt: plaintext.sentAt }),
  );
  const at = Date.UTC(2026, 9, 24, 12, 0, 0);
  // German: "14:25" is formatted the same by every ICU version.
  const LABELS = { locale: "de", timeZone: "Europe/Berlin", focus: { focus: "Fokus", break: "Pause", until: "bis {time}", stop: "Beenden" }, timer: { label: "Zeiterfassung" } };
  const task = { title: "Write the release notes", url: "/#page=00000000-0000-4000-8000-000000000002" };
  const live = {
    labels: LABELS,
    focus: contentState("focus", focusProps({ phase: "focus", startedAt: at, focusEndsAt: at + 25 * 60_000, breakEndsAt: at + 30 * 60_000, task }, LABELS, false)),
    focusBreakWithContent: contentState("focus", focusProps({ phase: "break", startedAt: at, focusEndsAt: at + 25 * 60_000, breakEndsAt: at + 30 * 60_000, task }, LABELS, true)),
    timer: contentState("timer", timerProps({ start: at, title: "Client call", database: "Billable work", url: "/#page=00000000-0000-4000-8000-000000000003" }, LABELS, false)),
    timerWithContent: contentState("timer", timerProps({ start: at, title: "Client call", database: "Billable work", url: "/#page=00000000-0000-4000-8000-000000000003" }, LABELS, true)),
  };
  const fresh = {
    instance: INSTANCE,
    devicePrivateKey: Buffer.from(CONTRACT_DEVICE, "hex").toString("base64url"),
    devicePublicKey: devicePublic,
    alert: { message: { ...message, to: "<relay token>" }, plaintext },
    comment: { payload: comment, sentAt: plaintext.sentAt },
    liveActivity: live,
  };
  if (process.env.FLOWPLAN_WRITE_CONTRACT === "1") writeFileSync(CONTRACT, `${JSON.stringify(fresh, null, 2)}\n`);
  const kept = JSON.parse(readFileSync(CONTRACT, "utf8")) as typeof fresh & { alert: { message: Record<string, any> } };
  assert.equal(kept.instance, INSTANCE);
  assert.equal(kept.devicePublicKey, devicePublic);
  // The kept alert still opens and has exactly the fields and kinds of values sent now.
  const keptPlain = JSON.parse(decrypt(devicePrivate, kept.alert.message.payload));
  assert.deepEqual(keptPlain, kept.alert.plaintext);
  const shape = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).map(([k, v]) => [k, v === null ? "null" : typeof v]));
  assert.deepEqual(shape(keptPlain), shape(plaintext));
  assert.deepEqual(shape({ ...kept.alert.message, payload: "" }), shape({ ...message, to: "<relay token>", payload: "" }));
  assert.equal(kept.alert.message.category, message.category);
  assert.equal(keptPlain.category, plaintext.category);
  assert.equal(new URL(keptPlain.url).origin, INSTANCE);
  assert.equal(Number.isInteger(keptPlain.sentAt) && keptPlain.sentAt < 1e11, true, "sentAt in seconds");
  assert.equal(JSON.parse(decrypt(devicePrivate, kept.comment.payload)).category, "flowplan.comment");
  // The Live Activity states are made the same way still.
  assert.deepEqual(kept.liveActivity, JSON.parse(JSON.stringify(live)));
  // No title or link of the person's data without MOBILE_PUSH_CONTENT=on.
  assert.doesNotMatch(JSON.stringify([live.focus, live.timer]), /release notes|Client call|Billable|page=/);
});

test("Live Activities without the app's labels (older apps): only the end is pushed", () => {
  const { user } = account("relay-no-labels");
  // No focus session, no timer: the end, whose texts nobody sees.
  const ended = liveActivityMessage("timer", user, null)!;
  assert.equal(ended.end, true);
  assert.equal(ended.message.liveActivity!.event, "end");
  assert.equal((ended.message.liveActivity!.contentState as { name: string }).name, "FlowplanTimer");
  run("INSERT INTO widget_focus(user_id,started_at,focus_ms,break_ms) VALUES(?,?,?,?)", user.id, Date.now(), 25 * 60_000, 5 * 60_000);
  assert.equal(liveActivityMessage("focus", user, null), null);
  assert.equal(liveActivityMessage("focus", user, LABELS)!.message.liveActivity!.event, "update");
  // A long title is shortened to fit the relay's 2 KB.
  const long = contentState("timer", timerProps({ start: 1, title: "x".repeat(5000), database: "", url: "/" }, LABELS, true));
  assert.ok(Buffer.byteLength(JSON.stringify(long)) <= 1900);
});
