// Push to the apps through the Flowplan push relay (flowplan-push,
// PROTOCOL.md v1). The relay holds Flowplan's APNs key and Firebase
// credentials; this instance needs none of its own. What it sends is end-to-
// end encrypted to the app installation's X25519 key (§4): the relay, Apple
// and Google only see ciphertext, the message type, the button category and
// the badge. Requests are signed with the instance's Ed25519 key
// (lib/push-identity.ts) over the exact body bytes (§3).
//
//   PUSH_RELAY_URL   the relay's origin (default https://push.flowplan.org);
//                    https only, http only for localhost; no path, no
//                    credentials. Requests go nowhere else and follow no
//                    redirects.
//   PUSH_RELAY=off   no relay: the apps get push through Expo only (when
//                    they registered an Expo token).
//
// Never logged: relay tokens, keys, payloads, plaintext.
import { createCipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, type KeyObject } from "node:crypto";
import { z } from "zod";
import { signRelayRequest } from "./push-identity";

export const DEFAULT_PUSH_RELAY = "https://push.flowplan.org";
export const PUSH_CONTEXT = "flowplan-push-v1";
export const MAX_BATCH = 100;
// Decoded payload limit of the relay (§6.1, v1.1: 2800 so that the final
// APNs/FCM message stays under 4096 bytes).
export const MAX_PAYLOAD_BYTES = 2800;
const PAYLOAD_VERSION = 0x01;
const TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 256 * 1024;

const off = (value: string | undefined) => /^(0|off|false|no)$/i.test(value || "");
const on = (value: string | undefined) => /^(1|on|true|yes)$/i.test(value || "");
const localHost = (host: string) => host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");

// An origin the relay protocol accepts: https (http only for localhost),
// no credentials, no path, query or fragment. null when not.
export function strictOrigin(text: string | undefined | null): string | null {
  if (!text) return null;
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) return null;
  if (url.protocol !== "https:" && !(url.protocol === "http:" && localHost(url.hostname))) return null;
  return url.origin;
}

let warned = "";
function warnOnce(message: string) {
  if (warned === message) return;
  warned = message;
  console.warn(`push relay: ${message}`);
}

export type RelayConfig = { enabled: true; relay: string; instance: string } | { enabled: false; reason: "off" | "relay-url" | "instance-url" };

// Read on every use, so tests and a changed environment take effect.
export function relayConfig(): RelayConfig {
  if (off(process.env.PUSH_RELAY)) return { enabled: false, reason: "off" };
  const relay = strictOrigin(process.env.PUSH_RELAY_URL?.trim() || DEFAULT_PUSH_RELAY);
  if (!relay) {
    warnOnce("PUSH_RELAY_URL must be an https origin (http only for localhost); the relay is off");
    return { enabled: false, reason: "relay-url" };
  }
  // The instance is known by its public address (APP_URL); without an
  // https address the relay could never fetch its key.
  let instance: string | null = null;
  try {
    instance = strictOrigin(new URL(process.env.APP_URL || "http://localhost:3000").origin);
  } catch {}
  if (!instance) {
    warnOnce("APP_URL must be an https address for the relay; the relay is off");
    return { enabled: false, reason: "instance-url" };
  }
  return { enabled: true, relay, instance };
}

// MOBILE_PUSH_CONTENT: unset → the notification text only where it is end-
// to-end encrypted (the relay); "on" → also through Expo and in Live
// Activity states (which Apple renders and nobody can encrypt); "off" →
// never, only "You have a new notification".
export function pushContent(channel: "relay" | "expo" | "live") {
  const value = process.env.MOBILE_PUSH_CONTENT;
  if (off(value)) return false;
  if (on(value)) return true;
  return channel === "relay";
}

// ---- §4 End-to-end encryption ----

const B64URL = /^[A-Za-z0-9_-]+$/;
export function x25519PublicKey(base64url: string): KeyObject {
  if (!B64URL.test(base64url)) throw new Error("invalid key");
  const raw = Buffer.from(base64url, "base64url");
  if (raw.length !== 32 || raw.toString("base64url") !== base64url) throw new Error("invalid key");
  return createPublicKey({ key: { kty: "OKP", crv: "X25519", x: base64url }, format: "jwk" });
}

// Whether a device key is usable: 32 bytes, canonical base64url, and no
// low-order point (the shared secret would be all zeros – OpenSSL refuses).
export function validDeviceKey(base64url: string) {
  try {
    const shared = diffieHellman({ privateKey: generateKeyPairSync("x25519").privateKey, publicKey: x25519PublicKey(base64url) });
    return shared.length === 32 && !shared.every((b) => b === 0);
  } catch {
    return false;
  }
}

const rawX25519 = (key: KeyObject) => Buffer.from(key.export({ format: "jwk" }).x as string, "base64url");

// HKDF info and AES-GCM additional data (§6.9, v1.1): bound to the instance
// origin exactly as sent in Flowplan-Instance, so a payload made for one
// instance does not open as another's.
export const bindingContext = (instance: string) => Buffer.from(`${PUSH_CONTEXT}\n${instance}`, "utf8");

// payload = base64url(0x01 || e.public (32) || nonce (12) || ciphertext || tag (16))
export function encryptForDevice(
  devicePublicKey: string,
  instance: string,
  plaintext: string | Uint8Array,
  ephemeral?: { privateKey: KeyObject; publicKey: KeyObject },
  nonce?: Buffer,
) {
  if (strictOrigin(instance) !== instance) throw new Error("invalid instance origin");
  const context = bindingContext(instance);
  const device = x25519PublicKey(devicePublicKey);
  const e = ephemeral ?? generateKeyPairSync("x25519");
  const shared = diffieHellman({ privateKey: e.privateKey, publicKey: device });
  if (shared.every((b) => b === 0)) throw new Error("invalid key");
  const ePublic = rawX25519(e.publicKey);
  const key = Buffer.from(hkdfSync("sha256", shared, Buffer.concat([ePublic, rawX25519(device)]), context, 32));
  const iv = nonce ?? randomBytes(12);
  if (iv.length !== 12) throw new Error("invalid nonce");
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(context);
  const body = Buffer.concat([cipher.update(typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext), cipher.final(), cipher.getAuthTag()]);
  key.fill(0);
  shared.fill(0);
  return Buffer.concat([Buffer.from([PAYLOAD_VERSION]), ePublic, iv, body]).toString("base64url");
}
// Bytes the envelope adds to the plaintext.
export const PAYLOAD_OVERHEAD = 1 + 32 + 12 + 16;

// The plaintext of an alert or background message (§4).
export type PushPlaintext = {
  title: string;
  body: string;
  url: string | null;
  id: string;
  category: string | null;
  data: Record<string, unknown> | null;
  sentAt: number;
};
// Serialised so that it fits the relay's limit: the body is shortened
// (never the fields the app needs) until it does.
export function plaintextJson(message: PushPlaintext) {
  const all = [...message.body];
  let chars = all;
  for (;;) {
    const body = chars.length < all.length ? `${chars.join("").trimEnd()}…` : message.body;
    const text = JSON.stringify({ ...message, body });
    if (Buffer.byteLength(text, "utf8") + PAYLOAD_OVERHEAD <= MAX_PAYLOAD_BYTES) return text;
    if (!chars.length) throw new Error("push payload too large");
    chars = chars.slice(0, Math.max(0, chars.length - 50));
  }
}

// ---- §3 Sending ----

export type RelayCategory = "task" | "comment" | "default";
export type RelayMessage = {
  to: string;
  type: "alert" | "background" | "liveactivity";
  payload?: string;
  category: RelayCategory | null;
  collapseId: string | null;
  badge: number | null;
  priority: "high" | "normal";
  ttl: number;
  liveActivity: {
    event: "update" | "end";
    contentState: Record<string, unknown>;
    staleDate: number | null;
    dismissalDate: number | null;
  } | null;
};
export type RelayStatus = "ok" | "gone" | "forbidden" | "invalid" | "rate_limited" | "error";
// Why a request or a message failed ("error"), for the test notification in
// the settings (lib/push-test.ts): unreachable (timeout, refused, redirect),
// signature (401: the relay could not verify this instance's key), blocked
// (403), rejected (another 4xx; httpStatus says which), upstream (APNs/FCM
// failed, 502 or per message), response (an unexpected answer), off.
export type RelayFailure = "unreachable" | "signature" | "blocked" | "rejected" | "upstream" | "response" | "off";
export type RelayResult = { status: RelayStatus; retryAfter?: number; reason?: RelayFailure; httpStatus?: number };
// Sends one batch (1–100 messages); results in message order. Never throws.
export type RelaySender = (messages: RelayMessage[]) => Promise<RelayResult[]>;

const resultsSchema = z.object({
  results: z.array(
    z.object({
      status: z.enum(["ok", "gone", "forbidden", "invalid", "rate_limited", "error"]),
      retryAfter: z.number().finite().nonnegative().optional(),
    }),
  ),
});
const retrySeconds = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(3600, Math.ceil(n)) : 60;
};

// The request exactly as it goes out: the body bytes and the headers that
// sign them. Exported for tests.
export function relayRequest(config: { relay: string; instance: string }, messages: RelayMessage[], now = Date.now()) {
  if (!messages.length || messages.length > MAX_BATCH) throw new Error("1–100 messages per request");
  // requestId (§6.5): the relay refuses a repeated one (replay protection).
  const body = Buffer.from(JSON.stringify({ requestId: randomBytes(16).toString("base64url"), messages }), "utf8");
  const { header } = signRelayRequest(config.instance, body, now);
  return {
    url: `${config.relay}/v1/send`,
    body,
    headers: { "Content-Type": "application/json", Accept: "application/json", "Flowplan-Instance": config.instance, "Flowplan-Signature": header },
  };
}

async function readLimited(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error("response too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export const sendToRelay: RelaySender = async (messages) => {
  const config = relayConfig();
  const failed = (status: RelayStatus, retryAfter?: number, reason?: RelayFailure, httpStatus?: number): RelayResult[] =>
    messages.map(() => ({ status, ...(retryAfter ? { retryAfter } : {}), ...(reason ? { reason } : {}), ...(httpStatus ? { httpStatus } : {}) }));
  if (!config.enabled) return failed("error", undefined, "off");
  try {
    const request = relayRequest(config, messages);
    const response = await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      // Only the configured origin: no redirect is followed anywhere.
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 429) {
      await response.body?.cancel().catch(() => {});
      return failed("rate_limited", retrySeconds(response.headers.get("retry-after")));
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      // Whole-request errors (§6.6) never drop registrations – a fault of
      // this instance (400, 413, 415), a key the relay does not know yet
      // (401), a blocked instance (403), a replay (409) or Apple/Google (502)
      // says nothing about a device. All are retried with the backoff.
      const reasons: Record<number, string> = {
        400: "invalid request",
        401: "signature not accepted (is /.well-known/flowplan-push reachable at APP_URL?)",
        403: "this instance is blocked by the relay",
        409: "request replayed",
        413: "request too large",
        415: "not JSON",
        502: "upstream push service failed",
      };
      warnOnce(`the relay answered HTTP ${response.status}${reasons[response.status] ? ` (${reasons[response.status]})` : ""}`);
      const reason: RelayFailure =
        response.status === 401 ? "signature" : response.status === 403 ? "blocked" : response.status === 502 ? "upstream" : response.status >= 500 ? "unreachable" : "rejected";
      return failed("error", undefined, reason, response.status);
    }
    const parsed = resultsSchema.safeParse(JSON.parse(await readLimited(response)));
    if (!parsed.success || parsed.data.results.length !== messages.length) {
      warnOnce("the relay answered with an unexpected document");
      return failed("error", undefined, "response");
    }
    // "error" for one message: Apple or Google did not take it.
    return parsed.data.results.map((r): RelayResult =>
      r.status === "rate_limited" ? { status: r.status, retryAfter: retrySeconds(r.retryAfter) } : r.status === "error" ? { status: r.status, reason: "upstream" } : { status: r.status },
    );
  } catch (error) {
    // Timeouts, refused connections, redirects, broken answers: retried later.
    return failed("error", undefined, error instanceof SyntaxError ? "response" : "unreachable");
  }
};

// Sends any number of messages in batches of at most 100.
export async function sendBatched(messages: RelayMessage[], send: RelaySender = sendToRelay): Promise<RelayResult[]> {
  const results: RelayResult[] = [];
  for (let i = 0; i < messages.length; i += MAX_BATCH) {
    const chunk = messages.slice(i, i + MAX_BATCH);
    let answer: RelayResult[];
    try {
      answer = await send(chunk);
    } catch {
      answer = [];
    }
    for (let j = 0; j < chunk.length; j++) results.push(answer[j] ?? { status: "error", reason: "response" });
  }
  return results;
}

// The additional data that binds a sealed relay token to its device (and
// Live Activity kind): copied into another row it does not open.
export const relayTokenAad = (deviceId: string) => `push-relay:${deviceId}`;
export const liveTokenAad = (deviceId: string, kind: string) => `push-live:${deviceId}:${kind}`;

// Relay tokens are opaque base64url strings of at least 128 bits (§2).
export const relayTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{22,512}$/);
