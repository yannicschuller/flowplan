// Security events: sign-ins, account and rights changes, exports, refused
// requests – one row each in security_events, a JSON line on stdout for the
// operator's log collection (Loki, Elastic, Graylog, fail2ban, CrowdSec), an
// OpenTelemetry log record when OTEL_EXPORTER_OTLP_ENDPOINT is set, and a
// counter for the Prometheus endpoint. The detection rules
// (lib/security-detect.ts) look at every event.
//
// Privacy: the database keeps the network of an address (/24, /48) and a
// keyed hash of the address – enough to group and block, not the address
// itself; account names of failed sign-ins only masked. Only the log line
// on stdout carries the full address (FLOWPLAN_SECURITY_LOG=anonymous
// leaves it out, =off writes none). Events are deleted after
// FLOWPLAN_SECURITY_RETENTION_DAYS (default 90).
import { createHmac, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { headers as requestHeaders } from "next/headers";
import { all, one, onAudit, run } from "./db";
import { clientAddress } from "./client-address";
import { deviceLabel } from "./device-name";
import { securityKinds, type SecurityKind, type SecuritySeverity } from "./security-kinds";
import { detectSecurity } from "./security-detect";

export type SecurityEvent = {
  id: number;
  at: number;
  kind: SecurityKind;
  severity: SecuritySeverity;
  actorId: string | null;
  subject: string;
  subjectKey: string;
  network: string;
  addressKey: string;
  country: string;
  device: string;
  detail: string;
};
export type SecurityInput = {
  actorId?: string | null;
  // The account a sign-in was for (e-mail or name): stored masked.
  subject?: string;
  detail?: string;
  severity?: SecuritySeverity;
  // The request; without it the current Next.js request, if any.
  headers?: Headers | null;
  // The client address when the caller already has it (sign-in paths).
  address?: string;
  at?: number;
};
type Context = { address: string; agent: string; country: string };
const NONE: Context = { address: "", agent: "", country: "" };

const state = globalThis as unknown as {
  flowplanSecurityPepper?: string;
  flowplanSecurityCounts?: Map<string, number>;
  flowplanSecurityOtlp?: { queue: object[]; timer: ReturnType<typeof setTimeout> | null; failed: boolean };
  flowplanSecurityBlocks?: { at: number; addresses: Set<string>; networks: Set<string> };
};

/* ---------- Addresses: network and keyed hash ---------- */

// A secret of this instance for the hashes, made once.
function pepper() {
  if (state.flowplanSecurityPepper) return state.flowplanSecurityPepper;
  const read = () => one<{ value: string }>("SELECT value FROM instance_settings WHERE key='securityPepper'")?.value;
  let value = read();
  if (!value) {
    run("INSERT OR IGNORE INTO instance_settings(key,value) VALUES('securityPepper',?)", JSON.stringify(randomBytes(32).toString("hex")));
    value = read();
  }
  return (state.flowplanSecurityPepper = JSON.parse(value || '""') as string);
}
const keyed = (purpose: string, value: string) =>
  createHmac("sha256", pepper()).update(`${purpose}:${value}`).digest("hex").slice(0, 32);

// "::ffff:203.0.113.7" → "203.0.113.7"; anything that is no address → "".
export function normalAddress(address: string) {
  const value = address.trim().replace(/^\[|\]$/g, "").replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, "$1");
  return isIP(value) ? value.toLowerCase() : "";
}
// The network an address belongs to: IPv4 /24, IPv6 /48.
export function networkOf(address: string) {
  const ip = normalAddress(address);
  if (!ip) return "";
  if (isIP(ip) === 4) return `${ip.split(".").slice(0, 3).join(".")}.0/24`;
  const [head, tail = ""] = ip.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = ip.includes("::") ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right] : left;
  return `${groups
    .slice(0, 3)
    .map((g) => g.replace(/^0+(?=.)/, ""))
    .join(":")}::/48`;
}
export const addressHash = (address: string) => {
  const ip = normalAddress(address);
  return ip ? keyed("address", ip) : "";
};
// "maria@example.com" → "ma***@example.com"; names keep two letters.
export function maskSubject(subject: string) {
  const value = subject.trim().slice(0, 200);
  const at = value.indexOf("@");
  if (at > 0) return `${value.slice(0, Math.min(2, at))}***${value.slice(at)}`;
  return value.length > 2 ? `${value.slice(0, 2)}***` : "***";
}
export const subjectHash = (subject: string) => (subject.trim() ? keyed("subject", subject.trim().toLowerCase()) : "");

// The country of the request, when the proxy in front says it
// (FLOWPLAN_COUNTRY_HEADER, e.g. CF-IPCountry) – never from the client.
function countryOf(h: Headers) {
  const name = process.env.FLOWPLAN_COUNTRY_HEADER?.trim();
  if (!name) return "";
  const value = (h.get(name) || "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(value) && value !== "XX" ? value : "";
}
export const countryHeaderConfigured = () => !!process.env.FLOWPLAN_COUNTRY_HEADER?.trim();
export function requestContext(h: Headers): Context {
  return { address: clientAddress(h), agent: (h.get("user-agent") || "").slice(0, 300), country: countryOf(h) };
}

/* ---------- Recording ---------- */

// Written right after the current synchronous work: refusals usually happen
// inside a transaction that is rolled back, and the event must stay
// (transactions here never span an await).
export function securityEvent(kind: SecurityKind, input: SecurityInput = {}) {
  const at = input.at ?? Date.now();
  const later = (context: Context) => queueMicrotask(() => write(kind, { ...input, at }, context));
  if (input.headers) return later({ ...requestContext(input.headers), ...(input.address !== undefined ? { address: input.address } : {}) });
  if (input.address !== undefined) return later({ ...NONE, address: input.address });
  // Inside a request: its address and device; elsewhere (workers, tests) none.
  let pending: Promise<Headers> | null = null;
  try {
    pending = Promise.resolve(requestHeaders() as unknown as Promise<Headers>);
  } catch {}
  if (!pending) return later(NONE);
  pending.then(
    (h) => write(kind, { ...input, at }, requestContext(h)),
    () => write(kind, { ...input, at }, NONE),
  );
}

function write(kind: SecurityKind, input: SecurityInput, context: Context) {
  const event: Omit<SecurityEvent, "id"> = {
    at: input.at ?? Date.now(),
    kind,
    severity: input.severity ?? securityKinds[kind].severity,
    actorId: input.actorId || null,
    subject: input.subject ? maskSubject(input.subject) : "",
    subjectKey: input.subject ? subjectHash(input.subject) : "",
    network: networkOf(context.address),
    addressKey: addressHash(context.address),
    country: context.country,
    device: context.agent ? deviceLabel(context.agent) : "",
    detail: (input.detail || "").replace(/\s+/g, " ").trim().slice(0, 500),
  };
  let rowId = 0;
  try {
    rowId = Number(
      run(
        "INSERT INTO security_events(at,kind,severity,actor_id,subject,subject_key,network,address_key,country,device,detail) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        event.at,
        event.kind,
        event.severity,
        event.actorId,
        event.subject,
        event.subjectKey,
        event.network,
        event.addressKey,
        event.country,
        event.device,
        event.detail,
      ).lastInsertRowid,
    );
  } catch (error) {
    console.error("Security event not stored", error);
    return;
  }
  const counts = (state.flowplanSecurityCounts ??= new Map());
  const counter = `${kind}|${event.severity}`;
  counts.set(counter, (counts.get(counter) || 0) + 1);
  logLine(event, normalAddress(context.address));
  exportOtlp(event, normalAddress(context.address));
  try {
    detectSecurity({ ...event, id: rowId });
  } catch (error) {
    console.error("Security detection failed", error);
  }
}

// Counted since the process started (Prometheus counters).
export function securityCounters() {
  return [...(state.flowplanSecurityCounts ?? new Map<string, number>()).entries()].map(([key, value]) => {
    const [kind, severity] = key.split("|");
    return { kind, severity, value };
  });
}

/* ---------- Log line and OpenTelemetry ---------- */

export function securityLogMode(): "on" | "anonymous" | "off" {
  const raw = (process.env.FLOWPLAN_SECURITY_LOG || "").trim().toLowerCase();
  if (raw === "off" || raw === "false" || raw === "0") return "off";
  if (raw === "anonymous") return "anonymous";
  if (!raw && process.env.NODE_TEST_CONTEXT) return "off";
  return "on";
}
export function securityLogRecord(event: Omit<SecurityEvent, "id">, address: string, mode = securityLogMode()) {
  return {
    ts: new Date(event.at).toISOString(),
    level: event.severity === "info" ? "info" : event.severity === "warn" ? "warn" : "error",
    logger: "flowplan.security",
    event: event.kind,
    severity: event.severity,
    ...(mode === "on" && address ? { ip: address } : {}),
    ...(event.network ? { network: event.network } : {}),
    ...(event.actorId ? { user: event.actorId } : {}),
    ...(event.subject ? { subject: event.subject } : {}),
    ...(event.country ? { country: event.country } : {}),
    ...(event.device ? { device: event.device } : {}),
    ...(event.detail ? { detail: event.detail } : {}),
  };
}
function logLine(event: Omit<SecurityEvent, "id">, address: string) {
  const mode = securityLogMode();
  if (mode === "off") return;
  try {
    process.stdout.write(`${JSON.stringify(securityLogRecord(event, address, mode))}\n`);
  } catch {}
}

export function otlpLogsEndpoint() {
  const logs = process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT?.trim();
  if (logs) return logs;
  const base = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  return base ? `${base.replace(/\/+$/, "")}/v1/logs` : "";
}
// "api-key=abc,x-scope=flowplan" (the OpenTelemetry convention).
export function otlpHeaders(raw = process.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS || process.env.OTEL_EXPORTER_OTLP_HEADERS || "") {
  const result: Record<string, string> = {};
  for (const part of raw.split(",")) {
    const at = part.indexOf("=");
    if (at <= 0) continue;
    try {
      result[decodeURIComponent(part.slice(0, at).trim())] = decodeURIComponent(part.slice(at + 1).trim());
    } catch {}
  }
  return result;
}
const SEVERITY_NUMBER = { info: 9, warn: 13, critical: 17 } as const;
export function otlpRecord(event: Omit<SecurityEvent, "id">, address: string) {
  const record = securityLogRecord(event, address);
  return {
    timeUnixNano: `${event.at}000000`,
    severityNumber: SEVERITY_NUMBER[event.severity],
    severityText: event.severity.toUpperCase(),
    body: { stringValue: event.kind },
    attributes: Object.entries(record)
      .filter(([key]) => !["ts", "level", "logger"].includes(key))
      .map(([key, value]) => ({ key: `flowplan.${key}`, value: { stringValue: String(value) } })),
  };
}
function exportOtlp(event: Omit<SecurityEvent, "id">, address: string) {
  const endpoint = otlpLogsEndpoint();
  if (!endpoint) return;
  const otlp = (state.flowplanSecurityOtlp ??= { queue: [], timer: null, failed: false });
  if (otlp.queue.length < 5000) otlp.queue.push(otlpRecord(event, address));
  if (otlp.timer) return;
  otlp.timer = setTimeout(() => void flushOtlp(endpoint), 2000);
  otlp.timer.unref?.();
}
async function flushOtlp(endpoint: string) {
  const otlp = state.flowplanSecurityOtlp!;
  otlp.timer = null;
  const records = otlp.queue.splice(0, otlp.queue.length);
  if (!records.length) return;
  const body = {
    resourceLogs: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: process.env.OTEL_SERVICE_NAME || "flowplan" } }] },
        scopeLogs: [{ scope: { name: "flowplan.security" }, logRecords: records }],
      },
    ],
  };
  try {
    const answer = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...otlpHeaders() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!answer.ok) throw new Error(`HTTP ${answer.status}`);
    otlp.failed = false;
  } catch (error) {
    // Once per outage, not for every batch.
    if (!otlp.failed) console.error("OpenTelemetry export of security events failed", error);
    otlp.failed = true;
  }
}

// HTML someone sends that carries scripts, event handlers or script URLs:
// the cleaning removes them; repeated attempts open an incident.
const DANGEROUS_HTML = /<script\b|<[^>]+\son[a-z]+\s*=|(?:href|src|action)\s*=\s*["']?\s*(?:javascript|vbscript):|srcdoc\s*=|data:text\/html/i;
export function dangerousHtml(html: string) {
  return DANGEROUS_HTML.test(html.slice(0, 2_000_000));
}
export function noteDangerousHtml(html: string, input: { actorId?: string | null; detail: string }) {
  if (dangerousHtml(html)) securityEvent("blocked.content", input);
}

/* ---------- Blocked addresses and networks ---------- */

function blocks(now = Date.now()) {
  const cached = state.flowplanSecurityBlocks;
  if (cached && now - cached.at < 15_000) return cached;
  const rows = all<{ kind: string; value: string }>("SELECT kind,value FROM security_blocks WHERE until IS NULL OR until>?", now);
  return (state.flowplanSecurityBlocks = {
    at: now,
    addresses: new Set(rows.filter((r) => r.kind === "address").map((r) => r.value)),
    networks: new Set(rows.filter((r) => r.kind === "network").map((r) => r.value)),
  });
}
export function invalidateSecurityBlocks() {
  state.flowplanSecurityBlocks = undefined;
}
// Whether the administrators blocked this address or its network.
export function blockedAddress(address: string, now = Date.now()) {
  const ip = normalAddress(address);
  if (!ip) return false;
  let current;
  try {
    current = blocks(now);
  } catch {
    return false;
  }
  if (!current.addresses.size && !current.networks.size) return false;
  return current.addresses.has(addressHash(ip)) || current.networks.has(networkOf(ip));
}

// A request from a blocked address: counts as not signed in. Recorded once
// a minute per address, not for every request.
const lastBlockedLog = new Map<string, number>();
export function blockedRequest(h: Headers, now = Date.now()) {
  const address = clientAddress(h);
  if (!blockedAddress(address, now)) return false;
  const key = addressHash(address);
  if (now - (lastBlockedLog.get(key) || 0) >= 60_000) {
    if (lastBlockedLog.size > 5000) lastBlockedLog.clear();
    lastBlockedLog.set(key, now);
    securityEvent("security.blocked_request", { headers: h });
  }
  return true;
}

/* ---------- Retention ---------- */

export function securityRetentionDays() {
  const days = Number.parseInt(process.env.FLOWPLAN_SECURITY_RETENTION_DAYS || "", 10);
  return Number.isFinite(days) && days >= 7 ? Math.min(days, 3650) : 90;
}
export function sweepSecurityEvents(now = Date.now()) {
  const day = 86_400_000;
  run("DELETE FROM security_events WHERE at<?", now - securityRetentionDays() * day);
  run("DELETE FROM security_incidents WHERE resolved_at IS NOT NULL AND last_at<?", now - Math.max(365, securityRetentionDays()) * day);
  if (run("DELETE FROM security_blocks WHERE until IS NOT NULL AND until<=?", now).changes) invalidateSecurityBlocks();
}

/* ---------- From the activity log ---------- */

// Entries of the activity log that matter for security, as events.
const ADMIN_SETTINGS = /^(ldap\.(enable|disable)|scim\.token\.(create|revoke)|admin\.(ops\.alerts|ops\.maintenance|push\.rotate|ai|metrics\.clear)|instance\.(backup|restore\.staged)|plugin\.(register|update|delete)|domain\.(add|remove)|e2ee\.identity\.reset|inbound\.rotate)$/;
const EXPORTS = /(\.export|^instance\.backup)$/;
export function auditToSecurity(actor: string, action: string, resource: string, detail: string): [SecurityKind, SecurityInput] | null {
  if (action === "account.delete") return ["account.deleted", { actorId: actor, detail: resource }];
  if (action === "admin.deleteUser") return ["admin.user", { actorId: actor, detail: `deleted ${resource}` }];
  if (action === "scim.user.deactivate" || action === "scim.user.delete" || action === "scim.user.activate")
    return ["admin.user", { actorId: actor || null, detail: `${action} ${resource}` }];
  if (action === "share.create") return ["share.created", { actorId: actor, detail: `${resource} ${detail}`.trim() }];
  if (EXPORTS.test(action)) return ["data.export", { actorId: actor, detail: `${action} ${resource}`.trim() }];
  if (ADMIN_SETTINGS.test(action)) return ["admin.settings", { actorId: actor || null, detail: `${action}${detail ? ` ${detail}` : ""}` }];
  return null;
}
onAudit((actor, action, resource, detail) => {
  const mapped = auditToSecurity(actor, action, resource, detail);
  if (mapped) securityEvent(mapped[0], mapped[1]);
});
