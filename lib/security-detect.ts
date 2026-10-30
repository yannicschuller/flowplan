// Detection rules over the security events (lib/security-events.ts). Each
// rule opens an incident; the same rule and key within a day counts on the
// open incident instead of opening a new one. A new incident is reported to
// the instance administrators (inbox, push and e-mail as notification kind
// "security") and to the alert webhook of the monitoring (event "security").
//
// Thresholds are deliberately simple and conservative; FLOWPLAN_SECURITY_*
// variables are not needed for normal instances.
import { all, id, one, run } from "./db";
import { securityRules, type SecurityRule } from "./security-kinds";
import type { SecurityEvent } from "./security-events";

const MINUTE = 60_000,
  HOUR = 60 * MINUTE,
  DAY = 24 * HOUR;
export const SECURITY_THRESHOLDS = {
  window: 15 * MINUTE,
  accountFailures: 10,
  addressFailures: 20,
  stuffingAccounts: 5,
  failuresBeforeSuccess: 5,
  travelWindow: 2 * HOUR,
  exportsPerHour: 20,
  contentAttempts: 5,
  probes: 60,
  probeWindow: 10 * MINUTE,
} as const;
const T = SECURITY_THRESHOLDS;

const count = (sql: string, ...args: (string | number)[]) => Number(one<{ n: number }>(sql, ...args)?.n || 0);

export function detectSecurity(e: SecurityEvent) {
  switch (e.kind) {
    // Refused attempts (over the limit, blocked) are attempts as well.
    case "login.failure":
    case "login.refused":
      return loginFailure(e);
    case "login.success":
      return loginSuccess(e);
    case "admin.granted":
      return openIncident("privilege_change", `event:${e.id}`, e, e.detail);
    case "admin.settings":
      // Who may sign in and with which rights: directory, provisioning,
      // restores, extensions and domains that run in the instance.
      if (/^(ldap|scim|instance\.restore|plugin\.register|domain\.add|e2ee\.identity\.reset)/.test(e.detail))
        return openIncident("privilege_change", `event:${e.id}`, e, e.detail);
      return;
    case "data.export":
      return exports(e);
    case "request.probing":
      return openIncident("probing", e.addressKey || e.network, e, e.detail);
    case "blocked.ssrf":
    case "blocked.content":
      return attempts(e);
  }
}

const ATTEMPTS = "kind IN ('login.failure','login.refused')";
function loginFailure(e: SecurityEvent) {
  const since = e.at - T.window;
  if (e.subjectKey) {
    const n = count(`SELECT COUNT(*) n FROM security_events WHERE ${ATTEMPTS} AND subject_key=? AND at>=?`, e.subjectKey, since);
    if (n >= T.accountFailures) openIncident("brute_force_account", e.subjectKey, e, `${e.subject}: ${n}`);
  }
  if (!e.addressKey) return;
  const n = count(`SELECT COUNT(*) n FROM security_events WHERE ${ATTEMPTS} AND address_key=? AND at>=?`, e.addressKey, since);
  if (n >= T.addressFailures) openIncident("brute_force_address", e.addressKey, e, `${e.network}: ${n}`);
  const accounts = count(
    `SELECT COUNT(DISTINCT subject_key) n FROM security_events WHERE ${ATTEMPTS} AND address_key=? AND subject_key<>'' AND at>=?`,
    e.addressKey,
    since,
  );
  if (accounts >= T.stuffingAccounts) openIncident("credential_stuffing", e.addressKey, e, `${e.network}: ${accounts}`);
}

function loginSuccess(e: SecurityEvent) {
  if (!e.actorId) return;
  // Guessed right after many tries: the strongest sign of a taken account.
  if (e.subjectKey) {
    const failures = count(
      "SELECT COUNT(*) n FROM security_events WHERE kind='login.failure' AND subject_key=? AND at>=? AND at<=?",
      e.subjectKey,
      e.at - T.window,
      e.at,
    );
    if (failures >= T.failuresBeforeSuccess) openIncident("login_after_failures", e.actorId, e, `${e.subject}: ${failures}`);
  }
  if (e.country) {
    const last = one<{ country: string; at: number }>(
      "SELECT country,at FROM security_events WHERE kind='login.success' AND actor_id=? AND country<>'' AND id<? ORDER BY id DESC LIMIT 1",
      e.actorId,
      e.id,
    );
    if (last && last.country !== e.country && e.at - last.at <= T.travelWindow)
      openIncident("impossible_travel", e.actorId, e, `${last.country} → ${e.country}`);
  }
  if (!e.device) return;
  const earlier = count("SELECT COUNT(*) n FROM security_events WHERE kind='login.success' AND actor_id=? AND id<? AND at>=?", e.actorId, e.id, e.at - 90 * DAY);
  if (!earlier) return;
  const known = count(
    "SELECT COUNT(*) n FROM security_events WHERE kind='login.success' AND actor_id=? AND device=? AND id<? AND at>=?",
    e.actorId,
    e.device,
    e.id,
    e.at - 90 * DAY,
  );
  if (known) return;
  void newDevice(e);
}

// The person learns about a sign-in from a device they have not used in 90
// days; for administrators it is an incident too.
async function newDevice(e: SecurityEvent) {
  const where = [e.device, e.network, e.country].filter(Boolean).join(", ");
  run(
    "INSERT INTO notifications(id,user_id,body,kind) VALUES(?,?,?,'security')",
    id(),
    e.actorId,
    `Neue Anmeldung bei deinem Konto: ${where}. Warst du das nicht? Ändere dein Passwort und melde unter Einstellungen → Konto → Geräte alle anderen Geräte ab.`,
  );
  const { securityEvent } = await import("./security-events");
  securityEvent("login.new_device", { actorId: e.actorId, detail: where, address: "", at: e.at });
  const { adminUserIds } = await import("./auth");
  if (adminUserIds().includes(e.actorId!)) openIncident("admin_new_device", `${e.actorId}:${e.device}`, e, where);
  else void dispatch();
}

function exports(e: SecurityEvent) {
  if (!e.actorId) return;
  const lastHour = count("SELECT COUNT(*) n FROM security_events WHERE kind='data.export' AND actor_id=? AND at>=?", e.actorId, e.at - HOUR);
  if (lastHour < T.exportsPerHour) return;
  // Compared with the person's usual hour of the last 30 days.
  const month = count("SELECT COUNT(*) n FROM security_events WHERE kind='data.export' AND actor_id=? AND at>=? AND at<?", e.actorId, e.at - 30 * DAY, e.at - HOUR);
  if (lastHour >= Math.max(T.exportsPerHour, (month / (30 * 24)) * 10)) openIncident("mass_export", e.actorId, e, String(lastHour));
}

function attempts(e: SecurityEvent) {
  const key = e.actorId || e.addressKey;
  if (!key) return;
  const n = count(
    `SELECT COUNT(*) n FROM security_events WHERE kind IN ('blocked.ssrf','blocked.content') AND ${e.actorId ? "actor_id" : "address_key"}=? AND at>=?`,
    key,
    e.at - HOUR,
  );
  if (n >= T.contentAttempts) openIncident("injection_attempts", key, e, `${n}: ${e.detail}`);
}

/* ---------- Incidents ---------- */

export function openIncident(rule: SecurityRule, key: string, e: Pick<SecurityEvent, "at" | "actorId" | "network" | "addressKey">, detail: string) {
  const open = one<{ id: string }>(
    "SELECT id FROM security_incidents WHERE rule=? AND key=? AND resolved_at IS NULL AND last_at>=?",
    rule,
    key,
    e.at - DAY,
  );
  if (open) {
    run("UPDATE security_incidents SET count=count+1,last_at=?,detail=? WHERE id=?", e.at, detail.slice(0, 500), open.id);
    return open.id;
  }
  const incident = id();
  run(
    "INSERT INTO security_incidents(id,rule,key,severity,actor_id,network,address_key,detail,first_at,last_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    incident,
    rule,
    key,
    securityRules[rule].severity,
    e.actorId,
    e.network,
    e.addressKey,
    detail.slice(0, 500),
    e.at,
    e.at,
  );
  void report(rule, detail, e.at);
  return incident;
}

const state = globalThis as unknown as { flowplanSecurityReports?: number[] };
// At most 30 reports an hour: an attack must not flood the administrators.
function mayReport(now: number) {
  const recent = (state.flowplanSecurityReports ?? []).filter((at) => at > now - HOUR);
  state.flowplanSecurityReports = recent;
  if (recent.length >= 30) return false;
  recent.push(now);
  return true;
}
async function report(rule: SecurityRule, detail: string, now: number) {
  if (!mayReport(now)) return;
  try {
    const { adminUserIds } = await import("./auth");
    const title = securityRules[rule].de;
    for (const admin of adminUserIds())
      run(
        "INSERT INTO notifications(id,user_id,body,kind) VALUES(?,?,?,'security')",
        id(),
        admin,
        `Sicherheit: ${title}${detail ? ` – ${detail}` : ""}. Details unter Administration → Sicherheit.`,
      );
    await dispatch();
    const { sendSecurityAlert } = await import("./admin-ops");
    await sendSecurityAlert(rule, detail, now);
  } catch (error) {
    console.error("Security report failed", error);
  }
}
async function dispatch() {
  try {
    const { dispatchPush } = await import("./push");
    await dispatchPush();
  } catch {}
}

/* ---------- Probing: refused requests per address ---------- */

const probes = new Map<string, { since: number; count: number; reported: boolean; sample: string }>();
// Called for every answered request (lib/request-metrics.ts): many 401, 403
// and 404 answers of the API from one address in ten minutes are recorded
// as one event, which opens an incident.
export function noteRefusal(address: string, status: number, path: string, now = Date.now(), record?: (detail: string) => void) {
  if (!address || ![401, 403, 404].includes(status) || !path.startsWith("/api/")) return;
  let entry = probes.get(address);
  if (!entry || now - entry.since > T.probeWindow) {
    if (probes.size > 10_000) probes.clear();
    entry = { since: now, count: 0, reported: false, sample: "" };
    probes.set(address, entry);
  }
  entry.count += 1;
  if (!entry.sample) entry.sample = `${status} ${path.split("?")[0].slice(0, 80)}`;
  if (entry.count < T.probes || entry.reported) return;
  entry.reported = true;
  record?.(`${entry.count} × 401/403/404, z. B. ${entry.sample}`);
}

export function openIncidentCount() {
  return count("SELECT COUNT(*) n FROM security_incidents WHERE resolved_at IS NULL");
}
export function incidentsSince(since: number) {
  return all<{ rule: string; severity: string; n: number }>(
    "SELECT rule,severity,COUNT(*) n FROM security_incidents WHERE first_at>=? GROUP BY rule,severity",
    since,
  );
}
