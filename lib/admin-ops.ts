// Administration → Operations: what an operator checks first. Refused
// requests (failed sign-ins, 429s, anonymous uploads over budget – counted in
// lib/ops-events.ts), storage per workspace against its quota, the mail
// queue, failing webhooks, the last run and error of background workers, an
// export of the activity log, health alerts to a webhook of the operator and
// a scheduled maintenance notice shown to everyone. Administrators only;
// API tokens never reach any of it (app/api/admin/operations/route.ts).
import { createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
import { all, audit, one, run } from "./db";
import { HttpError } from "./auth";
import { ct } from "./content-locale";
import { flushOpsEvents, opsEventKinds, type OpsEventKind } from "./ops-events";
import { instanceMetrics, workspaceUsage } from "./instance-ops";
import { mailStatus } from "./mail";
import { scheduledBackupStatus } from "./scheduled-backup";
import { markdownExportStatus } from "./scheduled-markdown-export";
import { ldapStatus } from "./ldap-auth";
import { instanceAiSettings } from "./ai/settings";
import { instanceSettings } from "./instance-settings";
import { anonymousBytesToday } from "./anonymous-budget";
import { safeSend } from "./safe-fetch";
import { openSecret, sealSecret } from "./secret-box";
import { requireAdmin } from "./permissions";
import type { Identity } from "./types";

const DAY = 86_400_000;

// Administrators in the browser only: API tokens never administer, not even
// those of administrators.
export function requireOpsAdmin(user: Identity) {
  if (user.apiScope) throw new HttpError(403, "Mit einem API-Token nicht möglich.");
  requireAdmin(user);
  return user;
}
// Refusal counters are kept this long (the dashboard shows two weeks).
const KEEP_EVENTS_DAYS = 35;
// Failed sign-ins within an hour that raise the alert.
export const LOGIN_ALERT_THRESHOLD = 50;
// Share of the quota from which a workspace counts as nearly full.
const STORAGE_ALERT_SHARE = 0.9;

// The local calendar day (server time zone), as in the time reports.
const localDay = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/* ---------- Refused requests ---------- */

export function opsEventSummary(now = Date.now(), days = 14) {
  flushOpsEvents();
  const count = (kind: OpsEventKind, since: number) =>
    Number(one<{ n: number }>("SELECT COUNT(*) n FROM ops_events WHERE kind=? AND at>=?", kind, since)?.n || 0);
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  const series = new Map<string, Record<OpsEventKind, number>>();
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    series.set(localDay(d.getTime()), { login_failure: 0, rate_limited: 0, anonymous_refused: 0 });
  }
  for (const e of all<{ kind: OpsEventKind; at: number }>("SELECT kind,at FROM ops_events WHERE at>=?", start.getTime())) {
    const day = series.get(localDay(e.at));
    if (day && e.kind in day) day[e.kind]++;
  }
  return {
    totals: Object.fromEntries(
      opsEventKinds.map((kind) => [kind, { hour: count(kind, now - 3600_000), day: count(kind, now - DAY), week: count(kind, now - 7 * DAY) }]),
    ) as Record<OpsEventKind, { hour: number; day: number; week: number }>,
    days: [...series].map(([day, counts]) => ({ day, ...counts })),
    anonymousBytesToday: anonymousBytesToday("*", now),
  };
}

export function sweepOpsEvents(now = Date.now()) {
  flushOpsEvents();
  run("DELETE FROM ops_events WHERE at<?", now - KEEP_EVENTS_DAYS * DAY);
  run("DELETE FROM ops_alerts WHERE sent_at<?", now - 90 * DAY);
}

/* ---------- Background workers ---------- */

export type WorkerStatus = {
  key: "backup" | "markdown-export" | "ai" | "calendar-sync" | "issue-sync" | "ldap-sync";
  active: boolean;
  lastRun: number | null;
  error: string | null;
  errorAt: number | null;
  detail?: string;
};

const workerRow = (name: string) =>
  one<{ last_run: number; last_error: string | null; error_at: number | null }>("SELECT last_run,last_error,error_at FROM ops_workers WHERE name=?", name);

export function workerStatuses(now = Date.now()): WorkerStatus[] {
  const result: WorkerStatus[] = [];
  const backup = scheduledBackupStatus();
  result.push({
    key: "backup",
    active: backup.enabled,
    lastRun: backup.last?.at ?? null,
    error: backup.last?.error ?? null,
    errorAt: backup.last?.error ? backup.last.at : null,
    detail: backup.target,
  });
  const exports = markdownExportStatus();
  const latest = Math.max(0, ...exports.runs.map((r) => r.at));
  const failed = exports.runs.filter((r) => r.error && r.at >= latest - 3600_000);
  result.push({
    key: "markdown-export",
    active: exports.pages.length > 0,
    lastRun: latest || null,
    error: failed[0]?.error ?? null,
    errorAt: failed[0]?.at ?? null,
  });
  const ai = workerRow("ai");
  let aiOn = false;
  try {
    aiOn = instanceAiSettings().enabled;
  } catch {}
  result.push({ key: "ai", active: aiOn, lastRun: ai?.last_run ?? null, error: ai?.last_error ?? null, errorAt: ai?.error_at ?? null });
  const calendar = one<{ n: number; last: number | null; failing: number }>(
    "SELECT COUNT(*) n,MAX(last_sync_at) last,SUM(CASE WHEN last_error IS NOT NULL AND failures>0 THEN 1 ELSE 0 END) failing FROM calendar_sync_mappings",
  );
  const calendarError = calendar?.failing
    ? one<{ last_error: string }>("SELECT last_error FROM calendar_sync_mappings WHERE last_error IS NOT NULL AND failures>0 ORDER BY next_at DESC LIMIT 1")?.last_error ?? null
    : null;
  result.push({
    key: "calendar-sync",
    active: !!calendar?.n,
    lastRun: calendar?.last ?? null,
    // A mapping that fails right now: its error counts as current.
    error: calendarError,
    errorAt: calendarError ? now : null,
    detail: calendar?.n ? `${calendar.failing || 0}/${calendar.n}` : undefined,
  });
  const issues = workerRow("issue-sync");
  const maps = Number(one<{ n: number }>("SELECT COUNT(*) n FROM issue_sync_maps")?.n || 0);
  result.push({ key: "issue-sync", active: maps > 0, lastRun: issues?.last_run ?? null, error: issues?.last_error ?? null, errorAt: issues?.error_at ?? null });
  const ldap = ldapStatus();
  result.push({
    key: "ldap-sync",
    active: ldap.configured,
    lastRun: ldap.lastSync?.at ?? null,
    error: ldap.lastSync && !ldap.lastSync.ok ? ldap.lastSync.error || "LDAP" : null,
    errorAt: ldap.lastSync && !ldap.lastSync.ok ? ldap.lastSync.at : null,
  });
  return result;
}

/* ---------- Webhooks, storage, overview ---------- */

export function webhookFailures() {
  const count = (sql: string) => Number(one<{ n: number }>(sql)?.n || 0);
  const recent = all<{ url: string; workspace: string | null; error: string | null; status: number | null; attempts: number; at: number }>(
    `SELECT w.url,ws.name workspace,d.error,d.status,d.attempts,d.next_at at FROM webhook_deliveries d JOIN webhooks w ON w.id=d.webhook_id
     LEFT JOIN workspaces ws ON ws.id=w.workspace_id WHERE d.delivered_at IS NULL AND d.attempts>0 ORDER BY d.next_at DESC LIMIT 8`,
  );
  return {
    retrying: count("SELECT COUNT(*) n FROM webhook_deliveries WHERE delivered_at IS NULL AND attempts>0 AND attempts<6"),
    givenUp: count("SELECT COUNT(*) n FROM webhook_deliveries WHERE delivered_at IS NULL AND attempts>=6"),
    // The host only: paths and queries of webhook addresses may hold secrets.
    recent: recent.map((r) => {
      let host = "";
      try {
        host = new URL(r.url).host;
      } catch {}
      return { host, workspace: r.workspace || "", error: r.error || (r.status ? `HTTP ${r.status}` : ""), attempts: r.attempts, at: r.at };
    }),
  };
}

export function storageByWorkspace() {
  const names = new Map(all<{ id: string; name: string }>("SELECT id,name FROM workspaces").map((w) => [w.id, w.name]));
  return workspaceUsage()
    .map((w) => ({ id: w.id, name: names.get(w.id) || "", bytes: w.bytes, quotaMb: w.effectiveQuotaMb }))
    .sort((a, b) => b.bytes - a.bytes);
}

export function opsOverview(now = Date.now()) {
  const metrics = instanceMetrics();
  return {
    events: opsEventSummary(now),
    storage: { databaseBytes: metrics.databaseBytes, uploadBytes: metrics.uploadBytes, workspaces: storageByWorkspace() },
    mail: mailStatus(),
    webhooks: webhookFailures(),
    workers: workerStatuses(now),
    alerts: alertSettingsForAdmin(),
    maintenance: storedMaintenance(),
  };
}
export type OpsOverview = ReturnType<typeof opsOverview>;

/* ---------- Activity log export ---------- */

const dateParam = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const auditExportSchema = z.object({
  from: dateParam.optional(),
  to: dateParam.optional(),
  format: z.enum(["csv", "json"]).default("csv"),
});
// The activity log between two days (UTC, as stored), newest first.
export function auditExport(input: unknown) {
  const { from, to, format } = auditExportSchema.parse(input);
  if (from && to && from > to) throw new HttpError(400, "Das Startdatum liegt nach dem Enddatum.");
  const where: string[] = [],
    args: string[] = [];
  if (from) {
    where.push("a.created_at>=?");
    args.push(`${from} 00:00:00`);
  }
  if (to) {
    where.push("a.created_at<=?");
    args.push(`${to} 23:59:59`);
  }
  const rows = all<{ created_at: string; name: string | null; email: string | null; action: string; resource_id: string; detail: string }>(
    `SELECT a.created_at,u.name,u.email,a.action,a.resource_id,a.detail FROM audit a LEFT JOIN users u ON u.id=a.actor_id ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY a.created_at DESC LIMIT 200000`,
    ...args,
  );
  const name = `flowplan-audit-${from || "start"}-${to || localDay(Date.now())}`;
  if (format === "json")
    return {
      name: `${name}.json`,
      type: "application/json; charset=utf-8",
      body: JSON.stringify(
        rows.map((r) => ({ at: r.created_at.replace(" ", "T") + "Z", person: r.name, email: r.email, action: r.action, resource: r.resource_id, detail: r.detail })),
        null,
        1,
      ),
    };
  const cell = (v: unknown) => {
    const text = String(v ?? "");
    // Spreadsheet programs must not run formulas from the log.
    const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const csv = [
    [ct("Zeitpunkt (UTC)", "Time (UTC)"), ct("Person", "Person"), ct("E-Mail", "Email"), ct("Aktion", "Action"), ct("Ressource", "Resource"), ct("Details", "Details")]
      .map(cell)
      .join(";"),
    ...rows.map((r) => [r.created_at, r.name, r.email, r.action, r.resource_id, r.detail].map(cell).join(";")),
  ].join("\r\n");
  return { name: `${name}.csv`, type: "text/csv; charset=utf-8", body: "﻿" + csv };
}

/* ---------- Settings stored next to the instance settings ---------- */

function readSetting<T>(key: string): T | null {
  const row = one<{ value: string }>("SELECT value FROM instance_settings WHERE key=?", key);
  try {
    return row ? (JSON.parse(row.value) as T) : null;
  } catch {
    return null;
  }
}
function writeSetting(key: string, value: unknown) {
  if (value === null) run("DELETE FROM instance_settings WHERE key=?", key);
  else
    run(
      "INSERT INTO instance_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      key,
      JSON.stringify(value),
    );
}

/* ---------- Health alerts ---------- */

export const alertEvents = ["backup_failed", "storage_high", "worker_error", "login_failures"] as const;
export type AlertEvent = (typeof alertEvents)[number];
type StoredAlerts = { url: string; events: AlertEvent[]; secret: string };
const ALERTS_KEY = "opsAlerts";
const allowPrivate = () => process.env.FLOWPLAN_WEBHOOK_ALLOW_PRIVATE === "true";

function storedAlerts(): (StoredAlerts & { plainSecret: string }) | null {
  const stored = readSetting<StoredAlerts>(ALERTS_KEY);
  if (!stored?.url) return null;
  let plainSecret = "";
  try {
    plainSecret = openSecret(stored.secret, "ops-alerts");
  } catch {}
  return { ...stored, events: (stored.events || []).filter((e) => alertEvents.includes(e)), plainSecret };
}
export function alertSettingsForAdmin() {
  const stored = storedAlerts();
  return {
    url: stored?.url || "",
    events: stored?.events || [...alertEvents],
    // Shown to administrators to verify the X-Flowplan-Signature header.
    secret: stored?.plainSecret || "",
    sent: all<{ event: string; day: string; sent_at: number; status: number | null; error: string | null }>(
      "SELECT event,day,sent_at,status,error FROM ops_alerts ORDER BY sent_at DESC LIMIT 10",
    ),
  };
}
const alertsSchema = z.object({
  url: z.string().trim().max(500),
  events: z.array(z.enum(alertEvents)).max(alertEvents.length),
  newSecret: z.boolean().optional(),
});
export function saveAlertSettings(actorId: string, input: unknown) {
  const { url, events, newSecret } = alertsSchema.parse(input);
  if (!url) {
    writeSetting(ALERTS_KEY, null);
    audit(actorId, "admin.ops.alerts", "instance", "off");
    return alertSettingsForAdmin();
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new HttpError(400, "Ungültige Webhook-Adresse.");
  }
  if (parsed.protocol !== "https:" && !(allowPrivate() && parsed.protocol === "http:"))
    throw new HttpError(400, "Die Webhook-Adresse muss mit https:// beginnen.");
  const previous = storedAlerts();
  const secret = !newSecret && previous?.plainSecret ? previous.plainSecret : randomBytes(24).toString("base64url");
  writeSetting(ALERTS_KEY, { url: parsed.toString(), events: [...new Set(events)], secret: sealSecret(secret, "ops-alerts") });
  audit(actorId, "admin.ops.alerts", "instance", parsed.host);
  return alertSettingsForAdmin();
}

// The conditions that hold right now, with a short description each.
export function activeAlerts(now = Date.now()): { event: AlertEvent; detail: string }[] {
  const result: { event: AlertEvent; detail: string }[] = [];
  const backup = scheduledBackupStatus();
  if (backup.enabled && backup.last?.error) result.push({ event: "backup_failed", detail: backup.last.error });
  const full = storageByWorkspace().filter((w) => w.quotaMb > 0 && w.bytes >= w.quotaMb * 1024 * 1024 * STORAGE_ALERT_SHARE);
  if (full.length)
    result.push({
      event: "storage_high",
      detail: full.map((w) => `${w.name || w.id}: ${Math.round((w.bytes / (w.quotaMb * 1024 * 1024)) * 100)} %`).join(", "),
    });
  const failing = workerStatuses(now).filter((w) => w.active && w.error && (w.errorAt ?? 0) >= now - DAY);
  if (failing.length) result.push({ event: "worker_error", detail: failing.map((w) => `${w.key}: ${w.error}`).join("; ").slice(0, 500) });
  flushOpsEvents();
  const logins = Number(one<{ n: number }>("SELECT COUNT(*) n FROM ops_events WHERE kind='login_failure' AND at>=?", now - 3600_000)?.n || 0);
  if (logins >= LOGIN_ALERT_THRESHOLD) result.push({ event: "login_failures", detail: String(logins) });
  return result;
}

const alertTitle = (event: AlertEvent | "test") =>
  ({
    backup_failed: ct("Backup fehlgeschlagen", "Backup failed"),
    storage_high: ct("Speicher > 90 %", "Storage > 90 %"),
    worker_error: ct("Worker-Fehler", "Worker error"),
    login_failures: ct("Viele fehlgeschlagene Anmeldungen", "Many failed sign-ins"),
    test: ct("Test-Benachrichtigung", "Test notification"),
  })[event];

async function deliver(config: { url: string; plainSecret: string }, event: AlertEvent | "test", detail: string, now: number) {
  const body = JSON.stringify({
    event: `ops.${event}`,
    title: alertTitle(event),
    detail,
    instance: instanceSettings().name || "Flowplan",
    url: process.env.APP_URL || "",
    at: new Date(now).toISOString(),
  });
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "Flowplan-Alerts",
    "X-Flowplan-Event": `ops.${event}`,
    "X-Flowplan-Signature": `sha256=${createHmac("sha256", config.plainSecret).update(body).digest("hex")}`,
  };
  try {
    const answer = await safeSend(config.url, body, headers, { allowPrivate: allowPrivate() });
    return { status: answer.status, error: answer.status >= 200 && answer.status < 300 ? null : `HTTP ${answer.status}` };
  } catch (error) {
    return { status: null, error: String((error as Error)?.message || error).slice(0, 300) };
  }
}

// Sends each configured alert that holds now, once per event and day.
export async function checkHealthAlerts(now = Date.now()) {
  const config = storedAlerts();
  if (!config?.plainSecret) return [];
  const day = localDay(now);
  const sent: { event: AlertEvent; status: number | null; error: string | null }[] = [];
  for (const alert of activeAlerts(now)) {
    if (!config.events.includes(alert.event)) continue;
    // Claimed before sending, so two runs at once do not both send.
    if (!run("INSERT OR IGNORE INTO ops_alerts(event,day,sent_at) VALUES(?,?,?)", alert.event, day, now).changes) continue;
    const result = await deliver(config, alert.event, alert.detail, now);
    run("UPDATE ops_alerts SET status=?,error=? WHERE event=? AND day=?", result.status, result.error, alert.event, day);
    sent.push({ event: alert.event, ...result });
  }
  return sent;
}

export async function sendTestAlert(actorId: string) {
  const config = storedAlerts();
  if (!config?.plainSecret) throw new HttpError(400, "Zuerst eine Webhook-Adresse speichern.");
  const result = await deliver(config, "test", ct("Die Benachrichtigungen kommen an.", "Notifications arrive."), Date.now());
  audit(actorId, "admin.ops.alerts.test", "instance", result.error || String(result.status));
  return result;
}

/* ---------- Maintenance notice ---------- */

export type MaintenanceNotice = { message: string; start: number; end: number };
const MAINTENANCE_KEY = "maintenance";
const maintenanceSchema = z
  .object({
    message: z.string().trim().min(1).max(300),
    start: z.number().int().positive(),
    end: z.number().int().positive(),
  })
  .nullable();

export function storedMaintenance(): MaintenanceNotice | null {
  return readSetting<MaintenanceNotice>(MAINTENANCE_KEY);
}
// Shown to everyone from when it is saved until its end.
export function maintenanceNotice(now = Date.now()): MaintenanceNotice | null {
  const notice = storedMaintenance();
  return notice && notice.end > now ? notice : null;
}
export function saveMaintenance(actorId: string, input: unknown, now = Date.now()) {
  const notice = maintenanceSchema.parse(input);
  if (notice) {
    if (notice.end <= notice.start) throw new HttpError(400, "Das Ende der Wartung muss nach dem Beginn liegen.");
    if (notice.end <= now) throw new HttpError(400, "Das Ende der Wartung liegt in der Vergangenheit.");
  }
  writeSetting(MAINTENANCE_KEY, notice);
  audit(actorId, "admin.ops.maintenance", "instance", notice ? `${new Date(notice.start).toISOString()} – ${new Date(notice.end).toISOString()}` : "off");
  return storedMaintenance();
}

/* ---------- Worker ---------- */

const runtime = globalThis as unknown as { flowplanOpsTimer?: ReturnType<typeof setInterval>; flowplanOpsSwept?: number };
// Every ten minutes: counters written, health alerts checked; once a day the
// old counters go.
export function startOpsWorker() {
  if (runtime.flowplanOpsTimer) return;
  const tick = () => {
    const now = Date.now();
    try {
      flushOpsEvents();
      if (now - (runtime.flowplanOpsSwept ?? 0) >= DAY) {
        sweepOpsEvents(now);
        runtime.flowplanOpsSwept = now;
      }
    } catch (error) {
      console.error("Operations sweep failed", error);
    }
    void checkHealthAlerts(now).catch((error) => console.error("Health alerts failed", error));
  };
  setTimeout(tick, 120_000).unref?.();
  runtime.flowplanOpsTimer = setInterval(tick, 10 * 60_000);
  runtime.flowplanOpsTimer.unref?.();
}
