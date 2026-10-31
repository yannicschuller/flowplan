// Administration → Sicherheit: the summary of the security events and
// incidents (lib/security-events.ts, lib/security-detect.ts) and what an
// administrator does about them – block an address or network, end
// sessions, disable an account, revoke tokens and links.
import { z } from "zod";
import { all, id, one, run } from "./db";
import { HttpError, adminUserIds } from "./auth";
import { clientAddress } from "./client-address";
import { setUserDisabled } from "./account-deletion";
import { mailConfig } from "./mail";
import { metricsAuthorized } from "./instance-ops";
import { alertSettingsForAdmin } from "./admin-ops";
import {
  addressHash,
  countryHeaderConfigured,
  invalidateSecurityBlocks,
  networkOf,
  otlpLogsEndpoint,
  securityEvent,
  securityLogMode,
  securityRetentionDays,
} from "./security-events";
import { SECURITY_THRESHOLDS } from "./security-detect";
import { isSecurityKind, securityRules, type SecurityRule } from "./security-kinds";
import type { Identity } from "./types";

const HOUR = 3_600_000,
  DAY = 24 * HOUR;
const count = (sql: string, ...args: (string | number)[]) => Number(one<{ n: number }>(sql, ...args)?.n || 0);

type EventRow = {
  id: number;
  at: number;
  kind: string;
  severity: string;
  actor_id: string | null;
  name: string | null;
  email: string | null;
  subject: string;
  network: string;
  address_key: string;
  country: string;
  device: string;
  detail: string;
};

export const eventFilterSchema = z.object({
  severity: z.enum(["all", "info", "warn", "critical"]).default("all"),
  kind: z.string().max(40).default(""),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export function securityEvents(input: unknown) {
  const f = eventFilterSchema.parse(input);
  const where: string[] = [],
    args: (string | number)[] = [];
  if (f.severity !== "all") {
    where.push("e.severity=?");
    args.push(f.severity);
  }
  // A kind ("login.failure") or a group ("login.", "account.").
  if (f.kind) {
    where.push(f.kind.endsWith(".") ? "e.kind LIKE ?" : "e.kind=?");
    args.push(f.kind.endsWith(".") ? `${f.kind}%` : f.kind);
  }
  if (f.before) {
    where.push("e.id<?");
    args.push(f.before);
  }
  const rows = all<EventRow>(
    `SELECT e.*,u.name,u.email FROM security_events e LEFT JOIN users u ON u.id=e.actor_id ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY e.id DESC LIMIT ?`,
    ...args,
    f.limit + 1,
  );
  return {
    events: rows.slice(0, f.limit).map((e) => ({
      id: e.id,
      at: e.at,
      kind: e.kind,
      severity: e.severity,
      actor: e.actor_id ? { id: e.actor_id, name: e.name || "", email: e.email || "" } : null,
      subject: e.subject,
      network: e.network,
      // Lets the administrator block this very address without seeing it.
      address: e.address_key ? e.address_key.slice(0, 12) : "",
      country: e.country,
      device: e.device,
      detail: e.detail,
    })),
    more: rows.length > f.limit,
  };
}

function incidents(now: number) {
  return all<{
    id: string;
    rule: string;
    severity: string;
    actor_id: string | null;
    name: string | null;
    email: string | null;
    network: string;
    address_key: string;
    detail: string;
    first_at: number;
    last_at: number;
    count: number;
    resolved_at: number | null;
    resolver: string | null;
  }>(
    `SELECT i.*,u.name,u.email,r.name resolver FROM security_incidents i LEFT JOIN users u ON u.id=i.actor_id LEFT JOIN users r ON r.id=i.resolved_by
     WHERE i.resolved_at IS NULL OR i.last_at>=? ORDER BY i.resolved_at IS NOT NULL, CASE i.severity WHEN 'critical' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END, i.last_at DESC LIMIT 100`,
    now - 30 * DAY,
  ).map((i) => ({
    id: i.id,
    rule: i.rule,
    severity: i.severity,
    actor: i.actor_id ? { id: i.actor_id, name: i.name || "", email: i.email || "" } : null,
    network: i.network,
    address: i.address_key ? i.address_key.slice(0, 12) : "",
    detail: i.detail,
    firstAt: i.first_at,
    lastAt: i.last_at,
    count: i.count,
    resolvedAt: i.resolved_at,
    resolvedBy: i.resolver,
  }));
}

/* ---------- One incident in detail ---------- */

const MINUTE = 60_000;
// The events a rule looked at: the same address, account or person around
// the incident's time (the rule's window before the first event).
function incidentScope(i: { rule: string; key: string; actor_id: string | null; address_key: string; network: string }) {
  const T = SECURITY_THRESHOLDS;
  switch (i.rule as SecurityRule) {
    case "brute_force_account":
      return { where: "e.subject_key=?", args: [i.key], before: T.window };
    case "brute_force_address":
    case "credential_stuffing":
    case "probing":
      return i.address_key ? { where: "e.address_key=?", args: [i.address_key], before: T.window } : { where: "e.network=?", args: [i.network], before: T.window };
    case "injection_attempts":
      return i.actor_id ? { where: "e.actor_id=?", args: [i.actor_id], before: HOUR } : { where: "e.address_key=?", args: [i.address_key], before: HOUR };
    case "mass_export":
      return { where: "e.actor_id=? AND e.kind='data.export'", args: [i.actor_id ?? ""], before: HOUR };
    case "login_after_failures":
    case "impossible_travel":
    case "admin_new_device":
      return { where: "(e.actor_id=? OR (e.address_key<>'' AND e.address_key=?))", args: [i.actor_id ?? "", i.address_key], before: i.rule === "impossible_travel" ? T.travelWindow : T.window };
    case "privilege_change":
      return { where: "(e.actor_id=? OR e.id=?)", args: [i.actor_id ?? "", Number(i.key.replace(/^event:/, "")) || 0], before: 10 * MINUTE };
  }
  return { where: "e.address_key=?", args: [i.address_key], before: T.window };
}

// Why the rule fired, in words, with its thresholds.
function ruleReason(rule: SecurityRule) {
  const T = SECURITY_THRESHOLDS;
  const min = (ms: number) => Math.round(ms / MINUTE);
  const r: Record<SecurityRule, [string, string]> = {
    brute_force_account: [`Mindestens ${T.accountFailures} fehlgeschlagene oder abgewiesene Anmeldungen bei demselben Konto innerhalb von ${min(T.window)} Minuten.`, `At least ${T.accountFailures} failed or refused sign-ins on the same account within ${min(T.window)} minutes.`],
    brute_force_address: [`Mindestens ${T.addressFailures} fehlgeschlagene Anmeldungen von derselben Adresse innerhalb von ${min(T.window)} Minuten.`, `At least ${T.addressFailures} failed sign-ins from the same address within ${min(T.window)} minutes.`],
    credential_stuffing: [`Von derselben Adresse wurden in ${min(T.window)} Minuten mindestens ${T.stuffingAccounts} verschiedene Konten probiert – typisch für geleakte Passwortlisten.`, `At least ${T.stuffingAccounts} different accounts were tried from the same address within ${min(T.window)} minutes – typical of leaked password lists.`],
    login_after_failures: [`Eine erfolgreiche Anmeldung direkt nach mindestens ${T.failuresBeforeSuccess} Fehlversuchen beim selben Konto (${min(T.window)} Minuten) – das Passwort könnte erraten worden sein.`, `A successful sign-in right after at least ${T.failuresBeforeSuccess} failures on the same account (${min(T.window)} minutes) – the password may have been guessed.`],
    admin_new_device: ["Ein Admin hat sich von einem Gerät angemeldet, das in den letzten 90 Tagen nicht benutzt wurde.", "An admin signed in from a device not used in the last 90 days."],
    impossible_travel: [`Zwei Anmeldungen desselben Kontos aus verschiedenen Ländern innerhalb von ${min(T.travelWindow)} Minuten.`, `Two sign-ins of the same account from different countries within ${min(T.travelWindow)} minutes.`],
    privilege_change: ["Adminrechte wurden vergeben oder etwas geändert, das bestimmt, wer sich anmelden darf (Verzeichnis, Provisionierung, Wiederherstellung, Erweiterungen, Domains).", "Admin rights were granted or something changed that decides who may sign in (directory, provisioning, restore, extensions, domains)."],
    mass_export: [`Mindestens ${T.exportsPerHour} Exporte in einer Stunde und ein Vielfaches des Üblichen dieser Person in den letzten 30 Tagen.`, `At least ${T.exportsPerHour} exports in an hour and many times this person's usual amount over the last 30 days.`],
    probing: [`Mindestens ${T.probes} Anfragen an die API mit der Antwort 401, 403 oder 404 von derselben Adresse innerhalb von ${min(T.probeWindow)} Minuten – jemand probiert Adressen, IDs oder Zugänge durch.`, `At least ${T.probes} API requests answered with 401, 403 or 404 from the same address within ${min(T.probeWindow)} minutes – someone is trying addresses, IDs or access.`],
    injection_attempts: [`Mindestens ${T.contentAttempts} abgewiesene Versuche in einer Stunde, über Inhalte interne Adressen (SSRF) oder gefährliches Markup einzuschleusen.`, `At least ${T.contentAttempts} refused attempts within an hour to sneak in internal addresses (SSRF) or dangerous markup through content.`],
  };
  return r[rule] ?? ["", ""];
}

export function securityIncident(incidentId: string) {
  if (!z.string().uuid().safeParse(incidentId).success) throw new HttpError(400, "Ungültiger Vorfall.");
  const i = one<{
    id: string;
    rule: string;
    key: string;
    severity: string;
    actor_id: string | null;
    name: string | null;
    email: string | null;
    network: string;
    address_key: string;
    detail: string;
    first_at: number;
    last_at: number;
    count: number;
    resolved_at: number | null;
    resolver: string | null;
    evidence: string;
  }>(
    `SELECT i.*,u.name,u.email,r.name resolver FROM security_incidents i LEFT JOIN users u ON u.id=i.actor_id LEFT JOIN users r ON r.id=i.resolved_by WHERE i.id=?`,
    incidentId,
  );
  if (!i) throw new HttpError(404, "Vorfall nicht gefunden.");
  const scope = incidentScope(i);
  const from = i.first_at - scope.before,
    to = i.last_at + MINUTE;
  const where = `${scope.where} AND e.at>=? AND e.at<=?`;
  const args = [...scope.args, from, to];
  const LIMIT = 200;
  const rows = all<EventRow>(
    `SELECT e.*,u.name,u.email FROM security_events e LEFT JOIN users u ON u.id=e.actor_id WHERE ${where} ORDER BY e.at DESC,e.id DESC LIMIT ?`,
    ...args,
    LIMIT,
  );
  const total = count(`SELECT COUNT(*) n FROM security_events e WHERE ${where}`, ...args);
  const group = (column: "kind" | "subject" | "network" | "country" | "device", extra = "") =>
    all<{ value: string; n: number }>(
      `SELECT e.${column} value,COUNT(*) n FROM security_events e WHERE ${where}${extra} AND e.${column}<>'' GROUP BY e.${column} ORDER BY n DESC LIMIT 20`,
      ...args,
    );
  const successes = all<{ subject: string; name: string | null; email: string | null; n: number }>(
    `SELECT e.subject,u.name,u.email,COUNT(*) n FROM security_events e LEFT JOIN users u ON u.id=e.actor_id WHERE ${where} AND e.kind='login.success' GROUP BY e.actor_id ORDER BY n DESC LIMIT 20`,
    ...args,
  );
  const blocked = all<{ kind: string; label: string; until: number | null }>(
    "SELECT kind,label,until FROM security_blocks WHERE ((kind='address' AND value=?) OR (kind='network' AND value=?)) AND (until IS NULL OR until>?)",
    i.address_key,
    i.network,
    Date.now(),
  );
  let evidence: unknown = null;
  try {
    evidence = i.evidence ? JSON.parse(i.evidence) : null;
  } catch {}
  const [de, en] = ruleReason(i.rule as SecurityRule);
  return {
    id: i.id,
    rule: i.rule,
    incident: {
      id: i.id,
      rule: i.rule,
      severity: i.severity,
      actor: i.actor_id ? { id: i.actor_id, name: i.name || "", email: i.email || "" } : null,
      network: i.network,
      address: i.address_key ? i.address_key.slice(0, 12) : "",
      detail: i.detail,
      firstAt: i.first_at,
      lastAt: i.last_at,
      count: i.count,
      resolvedAt: i.resolved_at,
      resolvedBy: i.resolver,
    },
    reason: { de, en },
    window: { from, to },
    total,
    kinds: group("kind"),
    // Accounts someone failed to sign in to (not the successful sign-ins),
    // one per account: masked names of different accounts can look alike.
    accounts: all<{ value: string; n: number }>(
      `SELECT MAX(e.subject) value,COUNT(*) n FROM security_events e WHERE ${where} AND e.kind IN ('login.failure','login.refused') AND e.subject_key<>'' GROUP BY e.subject_key ORDER BY n DESC LIMIT 20`,
      ...args,
    ),
    networks: group("network"),
    countries: group("country"),
    devices: group("device"),
    successes: successes.map((x) => ({ who: x.name || x.email || x.subject, n: x.n })),
    blocked,
    evidence: evidence as { since: number; until: number; statuses: Record<string, number>; paths: { path: string; status: number; count: number }[] } | null,
    events: rows.map((e) => ({
      id: e.id,
      at: e.at,
      kind: e.kind,
      severity: e.severity,
      actor: e.actor_id ? { id: e.actor_id, name: e.name || "", email: e.email || "" } : null,
      subject: e.subject,
      network: e.network,
      address: e.address_key ? e.address_key.slice(0, 12) : "",
      country: e.country,
      device: e.device,
      detail: e.detail,
    })),
    more: Math.max(0, total - rows.length),
  };
}

// Failed sign-ins of the last 24 hours by address: who is trying.
function topAddresses(now: number) {
  const blocked = blockList(now);
  return all<{ network: string; address_key: string; failures: number; accounts: number; last_at: number; refused: number }>(
    `SELECT network,address_key,SUM(kind='login.failure') failures,COUNT(DISTINCT CASE WHEN kind='login.failure' THEN subject_key END) accounts,
       SUM(kind IN ('login.refused','request.probing','security.blocked_request')) refused,MAX(at) last_at
     FROM security_events WHERE at>=? AND address_key<>'' AND kind IN ('login.failure','login.refused','request.probing','security.blocked_request')
     GROUP BY address_key ORDER BY failures DESC, refused DESC LIMIT 10`,
    now - DAY,
  ).map((r) => ({
    network: r.network,
    address: r.address_key.slice(0, 12),
    failures: r.failures,
    accounts: r.accounts,
    refused: r.refused,
    lastAt: r.last_at,
    blocked: blocked.some((b) => (b.kind === "address" && b.value === r.address_key) || (b.kind === "network" && b.value === r.network)),
  }));
}

// Signed-in people: administrators first, then whoever has the most sessions.
function sessions(now: number) {
  const admins = new Set(adminUserIds());
  return all<{ id: string; name: string; email: string; sessions: number; last_seen: number | null; agents: string }>(
    `SELECT u.id,u.name,u.email,COUNT(*) sessions,MAX(s.last_seen) last_seen,GROUP_CONCAT(DISTINCT s.agent) agents
     FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.expires>? AND u.disabled=0 AND u.demo_until IS NULL GROUP BY u.id`,
    now,
  )
    .map((u) => ({ id: u.id, name: u.name, email: u.email, sessions: u.sessions, lastSeen: u.last_seen, admin: admins.has(u.id) }))
    .sort((a, b) => Number(b.admin) - Number(a.admin) || b.sessions - a.sessions || (b.lastSeen || 0) - (a.lastSeen || 0))
    .slice(0, 100);
}

function tokens() {
  return all<{ id: string; name: string; scope: string; prefix: string; created_at: number; last_used_at: number | null; expires_at: number | null; owner: string; email: string }>(
    `SELECT t.id,t.name,t.scope,t.prefix,t.created_at,t.last_used_at,t.expires_at,u.name owner,u.email FROM api_tokens t JOIN users u ON u.id=t.user_id
     WHERE t.expires_at IS NULL OR t.expires_at>? ORDER BY COALESCE(t.last_used_at,t.created_at) DESC LIMIT 200`,
    Date.now(),
  ).map((t) => ({
    id: t.id,
    name: t.name,
    scope: t.scope,
    prefix: t.prefix,
    createdAt: t.created_at,
    lastUsedAt: t.last_used_at,
    expiresAt: t.expires_at,
    owner: t.owner,
    email: t.email,
  }));
}

// Links that open pages to people outside: share links and public pages.
function links() {
  const shares = all<{ token: string; name: string; role: string; title: string; page_id: string; created_at: string; creator: string | null }>(
    `SELECT l.token,l.name,l.role,p.title,p.id page_id,l.created_at,u.name creator FROM share_links l JOIN pages p ON p.id=l.root_id LEFT JOIN users u ON u.id=l.created_by
     WHERE p.deleted_at IS NULL ORDER BY CASE l.role WHEN 'editor' THEN 0 WHEN 'commenter' THEN 1 ELSE 2 END, l.created_at DESC LIMIT 200`,
  ).map((l) => ({ id: l.token.slice(0, 12), name: l.name, role: l.role, page: l.title, pageId: l.page_id, createdAt: l.created_at, creator: l.creator }));
  const published = all<{ id: string; title: string; updated_at: string }>(
    "SELECT id,title,updated_at FROM pages WHERE public_token IS NOT NULL AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 200",
  ).map((p) => ({ id: p.id, page: p.title, updatedAt: p.updated_at }));
  return { shares, published };
}

function blockList(now = Date.now()) {
  return all<{ id: string; kind: string; value: string; label: string; reason: string; created_at: number; until: number | null; creator: string | null }>(
    "SELECT b.*,u.name creator FROM security_blocks b LEFT JOIN users u ON u.id=b.created_by WHERE b.until IS NULL OR b.until>? ORDER BY b.created_at DESC",
    now,
  );
}

// What is set up around the events, with what is missing.
function setup(now: number) {
  const recent = count("SELECT COUNT(*) n FROM security_events WHERE at>=? AND kind IN ('login.success','login.failure')", now - 7 * DAY);
  const withAddress = count(
    "SELECT COUNT(*) n FROM security_events WHERE at>=? AND kind IN ('login.success','login.failure') AND network<>''",
    now - 7 * DAY,
  );
  const alerts = alertSettingsForAdmin();
  const otlp = otlpLogsEndpoint();
  let otlpHost = "";
  try {
    otlpHost = otlp ? new URL(otlp).host : "";
  } catch {}
  return {
    logMode: securityLogMode(),
    otlp: otlpHost,
    countryHeader: countryHeaderConfigured(),
    retentionDays: securityRetentionDays(),
    prometheus: metricsAuthorized(null) !== null,
    webhook: !!alerts.url && alerts.events.includes("security"),
    mail: !!mailConfig(),
    // Sign-ins without an address: the proxy does not pass it on.
    addressMissing: recent >= 3 && withAddress === 0,
  };
}

export function securityOverview(now = Date.now()) {
  const day = now - DAY;
  const hourly = Array.from({ length: 24 }, (_, i) => ({ at: now - (23 - i) * HOUR, failures: 0, signIns: 0 }));
  for (const row of all<{ bucket: number; kind: string; n: number }>(
    `SELECT CAST((? - at) / ${HOUR} AS INTEGER) bucket,kind,COUNT(*) n FROM security_events WHERE at>? AND kind IN ('login.failure','login.success') GROUP BY bucket,kind`,
    now,
    day,
  )) {
    const slot = hourly[23 - row.bucket];
    if (!slot) continue;
    if (row.kind === "login.failure") slot.failures = row.n;
    else slot.signIns = row.n;
  }
  const severities = Object.fromEntries(
    all<{ severity: string; n: number }>("SELECT severity,COUNT(*) n FROM security_events WHERE at>=? GROUP BY severity", day).map((r) => [r.severity, r.n]),
  );
  return {
    summary: {
      openIncidents: count("SELECT COUNT(*) n FROM security_incidents WHERE resolved_at IS NULL"),
      criticalIncidents: count("SELECT COUNT(*) n FROM security_incidents WHERE resolved_at IS NULL AND severity='critical'"),
      failedSignIns: count("SELECT COUNT(*) n FROM security_events WHERE kind='login.failure' AND at>=?", day),
      signIns: count("SELECT COUNT(*) n FROM security_events WHERE kind='login.success' AND at>=?", day),
      refused: count("SELECT COUNT(*) n FROM security_events WHERE kind IN ('login.refused','request.probing','request.origin','security.blocked_request','blocked.ssrf','blocked.content') AND at>=?", day),
      warnings: (severities.warn || 0) + (severities.critical || 0),
      events: (severities.info || 0) + (severities.warn || 0) + (severities.critical || 0),
      blocks: blockList(now).length,
      adminSessions: count(
        "SELECT COUNT(*) n FROM sessions WHERE expires>? AND user_id IN (SELECT value FROM json_each(?))",
        now,
        JSON.stringify(adminUserIds()),
      ),
      exports: count("SELECT COUNT(*) n FROM security_events WHERE kind='data.export' AND at>=?", day),
    },
    hourly,
    incidents: incidents(now),
    events: securityEvents({ limit: 50 }),
    addresses: topAddresses(now),
    sessions: sessions(now),
    tokens: tokens(),
    links: links(),
    blocks: blockList(now).map((b) => ({ id: b.id, kind: b.kind, label: b.label, reason: b.reason, createdAt: b.created_at, until: b.until, creator: b.creator })),
    rules: (Object.keys(securityRules) as SecurityRule[]).map((rule) => ({
      rule,
      severity: securityRules[rule].severity,
      active: rule !== "impossible_travel" || countryHeaderConfigured(),
    })),
    thresholds: SECURITY_THRESHOLDS,
    setup: setup(now),
  };
}

/* ---------- Actions ---------- */

// The full address key behind the short one the page shows.
function fullAddressKey(short: string) {
  if (!/^[a-f0-9]{12}$/.test(short)) throw new HttpError(400, "Ungültige Adresse.");
  const row =
    one<{ address_key: string; network: string }>("SELECT address_key,network FROM security_events WHERE address_key LIKE ? ORDER BY id DESC LIMIT 1", `${short}%`) ||
    one<{ address_key: string; network: string }>("SELECT address_key,network FROM security_incidents WHERE address_key LIKE ? ORDER BY last_at DESC LIMIT 1", `${short}%`);
  if (!row) throw new HttpError(404, "Diese Adresse ist nicht mehr bekannt.");
  return row;
}

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("incident.resolve"), id: z.string().uuid() }),
  z.object({ action: z.literal("incident.reopen"), id: z.string().uuid() }),
  z.object({ action: z.literal("incident.resolveAll") }),
  z.object({
    action: z.literal("block.add"),
    kind: z.enum(["address", "network"]),
    // The short address key of an event or incident, or a network ("203.0.113.0/24").
    value: z.string().trim().min(1).max(60),
    hours: z.number().int().min(1).max(24 * 365).nullable(),
    reason: z.string().trim().max(200).default(""),
  }),
  z.object({ action: z.literal("block.remove"), id: z.string().uuid() }),
  z.object({ action: z.literal("sessions.end"), userId: z.string().uuid() }),
  z.object({ action: z.literal("user.disable"), userId: z.string().uuid() }),
  z.object({ action: z.literal("token.revoke"), id: z.string().max(100) }),
  z.object({ action: z.literal("share.revoke"), id: z.string().regex(/^[A-Za-z0-9_-]{6,20}$/) }),
  z.object({ action: z.literal("publication.end"), pageId: z.string().uuid() }),
]);

export function securityAction(admin: Identity, input: unknown, requestHeaders: Headers, now = Date.now()) {
  const b = actionSchema.parse(input);
  const own = clientAddress(requestHeaders);
  switch (b.action) {
    case "incident.resolve":
      run("UPDATE security_incidents SET resolved_at=?,resolved_by=? WHERE id=? AND resolved_at IS NULL", now, admin.id, b.id);
      break;
    case "incident.reopen":
      run("UPDATE security_incidents SET resolved_at=NULL,resolved_by=NULL WHERE id=?", b.id);
      break;
    case "incident.resolveAll":
      run("UPDATE security_incidents SET resolved_at=?,resolved_by=? WHERE resolved_at IS NULL", now, admin.id);
      break;
    case "block.add": {
      let value: string, label: string;
      if (b.kind === "address") {
        const found = fullAddressKey(b.value);
        value = found.address_key;
        label = found.network ? `${found.network} (${b.value.slice(0, 6)}…)` : b.value;
        // Nobody locks themselves out.
        if (own && addressHash(own) === value) throw new HttpError(409, "Das ist deine eigene Adresse.");
      } else {
        value = networkOf(b.value.replace(/\/\d+$/, "").replace(/::$/, "::1"));
        if (!value) throw new HttpError(400, "Bitte ein Netz wie 203.0.113.0/24 oder 2001:db8:1::/48 angeben.");
        label = value;
        if (own && networkOf(own) === value) throw new HttpError(409, "Das ist dein eigenes Netz.");
      }
      run(
        "INSERT INTO security_blocks(id,kind,value,label,reason,created_by,created_at,until) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(kind,value) DO UPDATE SET until=excluded.until,reason=excluded.reason,created_by=excluded.created_by,created_at=excluded.created_at",
        id(),
        b.kind,
        value,
        label,
        b.reason,
        admin.id,
        now,
        b.hours ? now + b.hours * HOUR : null,
      );
      invalidateSecurityBlocks();
      securityEvent("security.block", { actorId: admin.id, headers: requestHeaders, detail: `${label}${b.hours ? ` ${b.hours} h` : ""}${b.reason ? ` – ${b.reason}` : ""}` });
      break;
    }
    case "block.remove": {
      const block = one<{ label: string }>("SELECT label FROM security_blocks WHERE id=?", b.id);
      run("DELETE FROM security_blocks WHERE id=?", b.id);
      invalidateSecurityBlocks();
      if (block) securityEvent("security.unblock", { actorId: admin.id, headers: requestHeaders, detail: block.label });
      break;
    }
    case "sessions.end":
      if (b.userId === admin.id) throw new HttpError(409, "Die eigenen Sitzungen beendest du unter Einstellungen → Konto → Geräte.");
      run("DELETE FROM sessions WHERE user_id=?", b.userId);
      securityEvent("session.revoked", { actorId: admin.id, headers: requestHeaders, detail: `all sessions of ${b.userId}` });
      break;
    case "user.disable":
      if (b.userId === admin.id) throw new HttpError(409, "Das eigene Konto kann nicht gesperrt werden.");
      if (!one("SELECT 1 FROM users WHERE id=?", b.userId)) throw new HttpError(404, "Konto nicht gefunden.");
      setUserDisabled(b.userId, true);
      securityEvent("admin.user", { actorId: admin.id, headers: requestHeaders, detail: `disabled ${b.userId}` });
      break;
    case "token.revoke":
      if (run("DELETE FROM api_tokens WHERE id=?", b.id).changes)
        securityEvent("account.token_revoked", { actorId: admin.id, headers: requestHeaders, detail: `by an administrator ${b.id}` });
      break;
    case "share.revoke": {
      const link = one<{ token: string; root_id: string }>("SELECT token,root_id FROM share_links WHERE token LIKE ?", `${b.id}%`);
      if (!link) throw new HttpError(404, "Diesen Link gibt es nicht mehr.");
      run("DELETE FROM share_links WHERE token=?", link.token);
      securityEvent("admin.settings", { actorId: admin.id, headers: requestHeaders, severity: "info", detail: `share link revoked ${link.root_id}` });
      break;
    }
    case "publication.end":
      if (run("UPDATE pages SET public_token=NULL WHERE id=?", b.pageId).changes)
        securityEvent("admin.settings", { actorId: admin.id, headers: requestHeaders, severity: "info", detail: `publication ended ${b.pageId}` });
      break;
  }
  return securityOverview(now);
}

// The events as CSV or JSON for the operator's own tools.
export function securityExport(format: "csv" | "json", now = Date.now()) {
  const rows = all<EventRow>(
    "SELECT e.*,u.name,u.email FROM security_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.at>=? ORDER BY e.id DESC LIMIT 200000",
    now - securityRetentionDays() * DAY,
  ).filter((e) => isSecurityKind(e.kind));
  const records = rows.map((e) => ({
    time: new Date(e.at).toISOString(),
    event: e.kind,
    severity: e.severity,
    user: e.email || e.name || "",
    subject: e.subject,
    network: e.network,
    address: e.address_key.slice(0, 12),
    country: e.country,
    device: e.device,
    detail: e.detail,
  }));
  const name = `flowplan-security-${new Date(now).toISOString().slice(0, 10)}`;
  if (format === "json") return { name: `${name}.json`, type: "application/json", body: JSON.stringify(records, null, 1) };
  const cell = (v: string) => (/[",\n;]/.test(v) || /^[=+\-@]/.test(v) ? `"${(/^[=+\-@]/.test(v) ? `'${v}` : v).replace(/"/g, '""')}"` : v);
  const head = Object.keys(records[0] || { time: "", event: "", severity: "", user: "", subject: "", network: "", address: "", country: "", device: "", detail: "" });
  const csv = [head.join(","), ...records.map((r) => head.map((k) => cell(String(r[k as keyof typeof r] ?? ""))).join(","))].join("\r\n");
  return { name: `${name}.csv`, type: "text/csv; charset=utf-8", body: "﻿" + csv };
}
