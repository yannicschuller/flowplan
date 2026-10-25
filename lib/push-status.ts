// Administration → Push-Benachrichtigungen (and the push tiles of the
// landing page and the monitoring): which push service this instance uses
// and whether it works.
//
// - The relay (lib/push-relay.ts): the address in use – the official
//   https://push.flowplan.org or PUSH_RELAY_URL –, switched on or why not
//   (PUSH_RELAY=off, APP_URL not https, PUSH_RELAY_URL invalid), the
//   instance origin it knows this instance by, whether
//   /.well-known/flowplan-push is published and the signing keys
//   (lib/push-identity.ts: ids and dates only).
// - Live checks, cached for a minute: GET <relay>/healthz (PROTOCOL.md of
//   flowplan-push: `{"status":"ok"}`, perhaps a version) and this instance's
//   own /.well-known/flowplan-push fetched at its public address (APP_URL),
//   as the relay would. Five seconds, https only (http for localhost, as
//   for the relay), no redirect followed, at most a few KB read. Only codes
//   come back – never a response body, header, token or key.
// - The Expo fallback (MOBILE_PUSH, MOBILE_PUSH_CONTENT), Web Push (VAPID)
//   and the registered devices per channel.
// - Deliveries of the last 24 hours by channel and result, the last
//   success and the last failure (lib/metrics.ts).
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { one } from "./db";
import { mobilePushEnabled } from "./mobile-devices";
import { pushIdentityStatus } from "./push-identity";
import { DEFAULT_PUSH_RELAY, relayConfig, strictOrigin } from "./push-relay";
import { EXPO_ENDPOINT, RELAY_ENDPOINT } from "./push";
import { dataDir, pushDeliveries, type PushDeliveries } from "./metrics";
import { allow } from "./action-limits";
import { requireOpsAdmin } from "./admin-ops";
import { HttpError } from "./auth";
import { ct } from "./content-locale";
import type { Identity } from "./types";

export const PROBE_TIMEOUT_MS = 5000;
export const PROBE_MAX_AGE_MS = 60_000;
const HEALTH_MAX_BYTES = 4 * 1024;
const WELL_KNOWN_MAX_BYTES = 16 * 1024;
export const WELL_KNOWN_PATH = "/.well-known/flowplan-push";

// Why a check failed: timeout, refused (connection refused), dns (name not
// found), tls (certificate or handshake), network (reset, unreachable …),
// redirect (3xx – never followed), http (another status, see httpStatus),
// too-large, response (not the expected document), insecure (not https),
// mismatch (the key document lacks this instance's signing key).
export type ProbeError = "timeout" | "refused" | "dns" | "tls" | "network" | "redirect" | "http" | "too-large" | "response" | "insecure" | "mismatch";
export type Probe = {
  ok: boolean;
  // Time to the answer (also for a failure with an answer).
  ms: number | null;
  httpStatus: number | null;
  error: ProbeError | null;
  // The relay's version, when its /healthz names one.
  version: string | null;
  // When it was checked.
  at: number;
};

const localHost = (host: string) => host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");
// Only these addresses are checked: https, http only for localhost.
function checkable(url: string) {
  try {
    const u = new URL(url);
    return !u.username && !u.password && (u.protocol === "https:" || (u.protocol === "http:" && localHost(u.hostname)));
  } catch {
    return false;
  }
}

function errorCode(error: unknown): ProbeError {
  const e = error as { name?: string; message?: string; code?: string; cause?: { code?: string; name?: string } };
  if (e?.name === "TimeoutError" || e?.name === "AbortError" || e?.cause?.name === "TimeoutError") return "timeout";
  if (e?.message === "too-large") return "too-large";
  const code = String(e?.cause?.code || e?.code || "");
  if (code === "ECONNREFUSED") return "refused";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "EAI_NONAME") return "dns";
  if (/^(ERR_TLS|ERR_SSL|CERT_|UNABLE_TO_|DEPTH_ZERO|SELF_SIGNED|ERR_SSL)/.test(code) || /CERT|TLS|SSL/.test(code)) return "tls";
  if (code === "UND_ERR_CONNECT_TIMEOUT" || code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT") return "timeout";
  return "network";
}

async function readLimited(response: Response, max: number) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw Object.assign(new Error("too-large"), { name: "TooLarge" });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export type ProbeOptions = { timeoutMs?: number };
// One GET: the status, the time and the parsed JSON (null when it is none).
// Exported for tests.
export async function probeJson(url: string, maxBytes: number, options: ProbeOptions = {}): Promise<{ probe: Probe; json: unknown }> {
  const started = Date.now();
  const base = { ms: null, httpStatus: null, version: null, at: started };
  if (!checkable(url)) return { probe: { ...base, ok: false, error: "insecure" }, json: null };
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json", "User-Agent": "Flowplan push status" },
      // Never followed: a redirect is reported as such.
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(options.timeoutMs ?? PROBE_TIMEOUT_MS),
    });
    const ms = Date.now() - started;
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {});
      return { probe: { ...base, ok: false, ms, httpStatus: response.status, error: "redirect" }, json: null };
    }
    let json: unknown = null;
    try {
      json = JSON.parse(await readLimited(response, maxBytes));
    } catch (error) {
      if ((error as Error)?.message === "too-large") return { probe: { ...base, ok: false, ms, httpStatus: response.status, error: "too-large" }, json: null };
      if (!(error instanceof SyntaxError)) throw error;
    }
    return { probe: { ...base, ok: response.ok, ms, httpStatus: response.status, error: response.ok ? null : "http" }, json };
  } catch (error) {
    const code = errorCode(error);
    return { probe: { ...base, ok: false, ms: code === "timeout" ? null : Date.now() - started, error: code }, json: null };
  }
}

// GET <relay>/healthz: reachable when it answers 200 {"status":"ok"}.
export async function checkRelayHealth(relay: string, options: ProbeOptions = {}): Promise<Probe> {
  const { probe, json } = await probeJson(`${relay}/healthz`, HEALTH_MAX_BYTES, options);
  if (!probe.ok) return probe;
  const doc = json as { status?: unknown; version?: unknown } | null;
  if (!doc || doc.status !== "ok") return { ...probe, ok: false, error: "response" };
  const version = typeof doc.version === "string" && /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,31}$/.test(doc.version) ? doc.version : null;
  return { ...probe, version };
}

// This instance's key document at its public address, as the relay fetches
// it: published when it lists the key that signs now.
export async function checkWellKnown(instance: string, signingKid: string | null, options: ProbeOptions = {}): Promise<Probe> {
  const { probe, json } = await probeJson(`${instance}${WELL_KNOWN_PATH}`, WELL_KNOWN_MAX_BYTES, options);
  if (!probe.ok) return probe;
  const doc = json as { version?: unknown; keys?: unknown } | null;
  if (!doc || doc.version !== 1 || !Array.isArray(doc.keys)) return { ...probe, ok: false, error: "response" };
  if (signingKid && !doc.keys.some((k) => (k as { id?: unknown })?.id === signingKid)) return { ...probe, ok: false, error: "mismatch" };
  return probe;
}

/* ---------- Cache (a minute, one check at a time per address) ---------- */

type Entry = { probe?: Probe; pending?: Promise<Probe> };
const holder = globalThis as unknown as { flowplanPushProbes?: Map<string, Entry> };
const probes = () => (holder.flowplanPushProbes ??= new Map());

function cachedProbe(key: string, check: () => Promise<Probe>, force: boolean, now: number): Promise<Probe> {
  const map = probes();
  const entry = map.get(key) || {};
  if (entry.pending) return entry.pending;
  if (!force && entry.probe && now - entry.probe.at < PROBE_MAX_AGE_MS) return Promise.resolve(entry.probe);
  const pending = check()
    .catch((): Probe => ({ ok: false, ms: null, httpStatus: null, error: "network", version: null, at: Date.now() }))
    .then((probe) => {
      map.set(key, { probe });
      return probe;
    });
  map.set(key, { ...entry, pending });
  if (map.size > 20) for (const k of [...map.keys()].slice(0, map.size - 20)) map.delete(k);
  return pending;
}
// What is known without checking (null: never checked or older than five
// minutes – a stale "reachable" says nothing).
function knownProbe(key: string, now: number) {
  const probe = probes().get(key)?.probe;
  return probe && now - probe.at < 5 * PROBE_MAX_AGE_MS ? probe : null;
}
export function resetPushProbes() {
  probes().clear();
}
const healthKey = (relay: string) => `health ${relay}`;
const selfKey = (instance: string) => `self ${instance}`;

/* ---------- The configuration ---------- */

// An address as it may be shown: no credentials, query or fragment.
export function displayUrl(text: string | undefined | null): string | null {
  if (!text?.trim()) return null;
  try {
    const u = new URL(text.trim());
    if (!/^https?:$/.test(u.protocol)) return null;
    return `${u.protocol}//${u.host}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return null;
  }
}

// How the relay is set up (no checks). Also the diagnostics of the test
// notification (lib/push-test.ts).
export function relaySetup() {
  const config = relayConfig();
  const custom = !!process.env.PUSH_RELAY_URL?.trim();
  const raw = process.env.PUSH_RELAY_URL?.trim() || DEFAULT_PUSH_RELAY;
  const url = config.enabled ? config.relay : strictOrigin(raw) || displayUrl(raw);
  let appUrl: string | null = null;
  try {
    appUrl = new URL(process.env.APP_URL || "http://localhost:3000").origin;
  } catch {}
  const instance = config.enabled ? config.instance : appUrl;
  return {
    enabled: config.enabled,
    reason: config.enabled ? null : config.reason,
    url,
    official: url === DEFAULT_PUSH_RELAY,
    custom,
    instance,
    // app/.well-known/flowplan-push answers exactly while the relay is on.
    wellKnown: config.enabled,
    wellKnownUrl: instance ? `${instance}${WELL_KNOWN_PATH}` : null,
  };
}
export type RelaySetup = ReturnType<typeof relaySetup>;

function contentMode(): "default" | "on" | "off" {
  const v = process.env.MOBILE_PUSH_CONTENT || "";
  return /^(0|off|false|no)$/i.test(v) ? "off" : /^(1|on|true|yes)$/i.test(v) ? "on" : "default";
}
// VAPID: from the environment, the generated file, not created yet, or only
// one of the two variables (the file is used then).
function vapidSource(): "env" | "partial" | "file" | "pending" {
  const pub = !!process.env.WEB_PUSH_PUBLIC_KEY,
    priv = !!process.env.WEB_PUSH_PRIVATE_KEY;
  if (pub && priv) return "env";
  const file = existsSync(resolve(dataDir(), "web-push-keys.json"));
  if (pub || priv) return "partial";
  return file ? "file" : "pending";
}

const count = (sql: string, ...args: (string | number)[]) => {
  try {
    return Number(one<{ n: number }>(sql, ...args)?.n || 0);
  } catch {
    return 0;
  }
};
function devices(now: number) {
  return {
    // App installations; of them registered with the relay, with the relay
    // only (no Expo token), and with an Expo token.
    apps: count("SELECT COUNT(*) n FROM mobile_devices"),
    relay: count("SELECT COUNT(*) n FROM mobile_push_relay"),
    relayOnly: count(`SELECT COUNT(*) n FROM push_subscriptions WHERE endpoint LIKE '${RELAY_ENDPOINT}%'`),
    expo: count(`SELECT COUNT(*) n FROM push_subscriptions WHERE endpoint LIKE '${EXPO_ENDPOINT}%'`),
    web: count(
      `SELECT COUNT(*) n FROM push_subscriptions s JOIN sessions se ON se.token=s.session_token WHERE se.expires>? AND s.endpoint NOT LIKE '${EXPO_ENDPOINT}%' AND s.endpoint NOT LIKE '${RELAY_ENDPOINT}%'`,
      now,
    ),
  };
}

export type PushTone = "ok" | "warn" | "error" | "off" | "info";
// One word for the tiles: error – the relay is set up wrong or does not
// answer; warn – it answers, but this instance's key document is not
// reachable from here, its last deliveries failed or APP_URL is not https;
// off – PUSH_RELAY=off (on purpose); info – not checked yet.
export function pushTone(
  s: { relay: RelaySetup; health: Probe | null; self: Probe | null; deliveries: Pick<PushDeliveries, "lastOk" | "lastError"> },
  now = Date.now(),
): PushTone {
  const r = s.relay;
  if (!r.enabled) return r.reason === "off" ? "off" : r.reason === "relay-url" ? "error" : "warn";
  if (!s.health) return "info";
  if (!s.health.ok) return "error";
  const e = s.deliveries.lastError;
  const relayFailing = !!e && e.channel === "relay" && e.result !== "rate_limited" && e.at > (s.deliveries.lastOk.relay ?? 0) && now - e.at < 86_400_000;
  if ((s.self && !s.self.ok) || relayFailing) return "warn";
  return "ok";
}

export type PushStatusOptions = { force?: boolean; now?: number; timeoutMs?: number; check?: boolean };

// Everything the push page shows. `check` (default) runs the live checks
// (cached a minute; `force` checks again); without it only what is known.
export async function pushStatus(options: PushStatusOptions = {}) {
  const now = options.now ?? Date.now();
  const relay = relaySetup();
  const keys = relay.enabled ? pushIdentityStatus(now) : [];
  const signing = keys.find((k) => k.signing)?.id ?? null;
  let health: Probe | null = null,
    self: Probe | null = null;
  if (relay.enabled && relay.url && relay.instance) {
    const { url, instance } = relay;
    if (options.check === false) {
      health = knownProbe(healthKey(url), now);
      self = knownProbe(selfKey(instance), now);
    } else
      [health, self] = await Promise.all([
        cachedProbe(healthKey(url), () => checkRelayHealth(url, { timeoutMs: options.timeoutMs }), !!options.force, now),
        cachedProbe(selfKey(instance), () => checkWellKnown(instance, signing, { timeoutMs: options.timeoutMs }), !!options.force, now),
      ]);
  }
  const deliveries = pushDeliveries(now);
  return {
    at: now,
    tone: pushTone({ relay, health, self, deliveries }, now),
    relay: {
      ...relay,
      health,
      self,
      // Ids and dates only. A key with activeFrom in the future waits to
      // sign (a rotation); one with retireAt ends then.
      keys: keys.map((k) => ({ id: k.id, signing: k.signing, createdAt: k.createdAt, activeFrom: k.activeFrom, retireAt: k.retireAt })),
    },
    mobile: { enabled: mobilePushEnabled(), content: contentMode() },
    web: { vapid: vapidSource(), subject: !!process.env.WEB_PUSH_SUBJECT?.trim() },
    devices: devices(now),
    queue: {
      pending: count("SELECT COUNT(*) n FROM push_deliveries WHERE delivered_at IS NULL AND attempts<5"),
      givenUp: count("SELECT COUNT(*) n FROM push_deliveries WHERE delivered_at IS NULL AND attempts>=5"),
    },
    deliveries,
  };
}
export type PushStatus = Awaited<ReturnType<typeof pushStatus>>;

// Reading: 60 a minute per person (the page and its refreshes); checking
// again at once: 6 a minute.
export const PUSH_STATUS_LIMIT = { read: { max: 60, windowMs: 60_000 }, check: { max: 6, windowMs: 60_000 } };

// For the route (app/api/admin/push): administrators in the browser only,
// rate limited.
export async function pushStatusFor(user: Identity, options: { force?: boolean } = {}) {
  requireOpsAdmin(user);
  const limit = options.force ? PUSH_STATUS_LIMIT.check : PUSH_STATUS_LIMIT.read;
  if (!allow(`push-status${options.force ? "-check" : ""}:${user.id}`, limit.max, limit.windowMs))
    throw new HttpError(429, ct("Zu viele Anfragen. Bitte kurz warten.", "Too many requests. Please wait a moment."));
  return pushStatus({ force: !!options.force });
}

// For the tiles (lib/admin-summary.ts, lib/admin-monitoring.ts): what is
// known now, without a network request and without creating a key.
export function pushSummary(now = Date.now()) {
  const relay = relaySetup();
  const health = relay.enabled && relay.url ? knownProbe(healthKey(relay.url), now) : null;
  const self = relay.enabled && relay.instance ? knownProbe(selfKey(relay.instance), now) : null;
  const deliveries = pushDeliveries(now);
  const sum = (result: "ok" | "error") =>
    Object.values(deliveries.totals).reduce((a, c) => a + (result === "ok" ? c.ok : c.error + c.forbidden + c.invalid + c.rate_limited), 0);
  return {
    tone: pushTone({ relay, health, self, deliveries }, now),
    enabled: relay.enabled,
    reason: relay.reason,
    url: relay.url,
    official: relay.official,
    health: health ? { ok: health.ok, ms: health.ms, error: health.error, httpStatus: health.httpStatus } : null,
    self: self ? { ok: self.ok, error: self.error } : null,
    mobile: mobilePushEnabled(),
    delivered24h: sum("ok"),
    failed24h: sum("error"),
    hourly: deliveries.collecting ? deliveries.hourly.map((h) => h.ok) : null,
  };
}
export type PushSummary = ReturnType<typeof pushSummary>;

// Runs the live checks for the tiles, waiting at most `budgetMs`; what is
// not done by then shows on the next load.
export async function warmPushChecks(budgetMs = 1500) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    pushStatus().catch(() => null),
    new Promise((resolve) => {
      timer = setTimeout(resolve, budgetMs);
      timer.unref?.();
    }),
  ]);
  clearTimeout(timer);
}
