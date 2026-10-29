// Administration → Überwachung: everything the monitoring dashboard shows,
// in one answer (app/api/admin/monitoring/route.ts), polled every few
// seconds while the page is open. Health of the parts of the instance,
// the live numbers, the charts (requests, people, sign-ins, refusals,
// storage, deliveries, AI tokens), the queues and recent events.
// Numbers, states and codes only – the browser words them.
//
// Data sources: lib/metrics.ts (requests, people, tokens, storage per day –
// collected since this version), lib/ops-events.ts (sign-ins and refusals),
// and tables the instance keeps anyway (mail, push, webhooks, workers …).
// Expensive parts (sizes per workspace, uploads by type) are cached for a
// minute.
import { accessSync, constants, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { all, one } from "./db";
import { buildInfo } from "./build-info";
import { instanceMetrics } from "./instance-ops";
import { mailStatus } from "./mail";
import { scheduledBackupStatus } from "./scheduled-backup";
import { markdownExportStatus } from "./scheduled-markdown-export";
import { storageStatus } from "./storage";
import { instanceAiSettings } from "./ai/settings";
import { instanceProviderConfig } from "./ai/resolve";
import { listModels } from "./ai/providers";
import { pendingRestore } from "./instance-backup";
import { activeAlerts, opsEventSummary, requireOpsAdmin, storageByWorkspace, storedMaintenance, webhookFailures, workerStatuses, LOGIN_ALERT_THRESHOLD } from "./admin-ops";
import {
  activeSeries,
  aiProviderPing,
  aiUsage,
  collectingSince,
  dataDir,
  diskUsage,
  liveNumbers,
  localDay,
  metricsSetting,
  METRICS_KEEP,
  requestSeries,
  storageTrend,
  type RequestRange,
} from "./metrics";
import { pushSummary } from "./push-status";
import type { UpdateStatus } from "./update-check";
import type { Identity } from "./types";

const MINUTE = 60_000,
  HOUR = 3_600_000,
  DAY = 86_400_000;

/* ---------- Health ---------- */

function uploadsWritable() {
  try {
    const uploads = resolve(dataDir(), "uploads");
    mkdirSync(uploads, { recursive: true });
    accessSync(uploads, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
function databaseReachable() {
  try {
    one("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

// The instance provider: switched on, which kind, and whether it answers
// (checked in the background, at most every five minutes).
function aiHealth(now: number) {
  let enabled = false,
    provider: string | null = null;
  try {
    const s = instanceAiSettings();
    enabled = s.enabled;
    provider = s.provider?.kind ?? null;
  } catch {}
  const config = enabled ? instanceProviderConfig() : null;
  const ping =
    config?.ok === true
      ? aiProviderPing(() => listModels(config.config, AbortSignal.timeout(10_000)), now)
      : null;
  return { enabled, provider, configured: config?.ok === true, ping };
}

export function monitoringHealth(now = Date.now(), update: UpdateStatus | null = null) {
  const metrics = instanceMetrics();
  const mirror = storageStatus();
  const backup = scheduledBackupStatus();
  const mail = mailStatus();
  const workers = workerStatuses(now);
  const failing = workers.filter((w) => w.active && w.error && (w.errorAt ?? 0) >= now - DAY);
  return {
    database: { ok: databaseReachable(), bytes: metrics.databaseBytes },
    uploads: { ok: uploadsWritable(), bytes: metrics.uploadBytes, files: metrics.files, disk: diskUsage() },
    s3: mirror.enabled ? { pending: mirror.pending, failing: !!mirror.failing } : null,
    backup: { enabled: backup.enabled, hourly: backup.hourly, target: backup.target, lastAt: backup.last?.at ?? null, error: backup.last?.error ?? null },
    mail: { configured: mail.configured, pending: mail.pending, failed: mail.failed, lastError: mail.lastError },
    ai: aiHealth(now),
    // The push relay (lib/push-status.ts), as last checked.
    push: pushSummary(now),
    workers: { active: workers.filter((w) => w.active).length, failing: failing.map((w) => w.key) },
    update: { version: buildInfo().version, latest: update?.latest ?? null, url: update?.url ?? null },
    restorePending: !!pendingRestore(),
    uptimeSeconds: metrics.uptimeSeconds,
  };
}

/* ---------- Live numbers ---------- */

const midnight = (now: number) => {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
// Different people who used Flowplan since `since`: the app's pings
// (lib/user-activity.ts), else a request of one of their sessions.
export const activeSince = (since: number) =>
  Number(
    one<{ n: number }>(
      "SELECT COUNT(*) n FROM users u WHERE u.disabled=0 AND (u.last_active_at>=? OR EXISTS (SELECT 1 FROM sessions s WHERE s.user_id=u.id AND s.last_seen>=?))",
      since,
      since,
    )?.n || 0,
  );
const events = (kind: string, since: number) => Number(one<{ n: number }>("SELECT COUNT(*) n FROM ops_events WHERE kind=? AND at>=?", kind, since)?.n || 0);

export function monitoringLive(now = Date.now(), range: RequestRange = "24h") {
  const setting = metricsSetting();
  const live = liveNumbers(now);
  return {
    at: now,
    collecting: { enabled: setting.enabled, locked: setting.locked, since: collectingSince() },
    kpis: {
      ...live,
      signinsToday: events("login_success", midnight(now)),
      activeToday: activeSince(midnight(now)),
      failedSigninsToday: events("login_failure", midnight(now)),
    },
    requests: requestSeries(range, now),
  };
}

/* ---------- Storage (cached a minute) ---------- */

const MEDIA: [string, string][] = [
  ["images", "mime LIKE 'image/%'"],
  ["video", "mime LIKE 'video/%'"],
  ["audio", "mime LIKE 'audio/%'"],
  [
    "documents",
    "(mime='application/pdf' OR mime LIKE 'text/%' OR mime LIKE '%officedocument%' OR mime LIKE '%msword%' OR mime LIKE '%ms-excel%' OR mime LIKE '%ms-powerpoint%' OR mime LIKE '%opendocument%' OR mime LIKE '%rtf%')",
  ],
];
const cache = globalThis as unknown as { flowplanMonitoringStorage?: { at: number; value: ReturnType<typeof storageBlockUncached> } };
function storageBlockUncached(now: number) {
  const metrics = instanceMetrics();
  const byType: { key: string; bytes: number; files?: number }[] = [{ key: "database", bytes: metrics.databaseBytes }];
  let counted = 0,
    countedFiles = 0;
  for (const [key, where] of MEDIA) {
    const row = one<{ bytes: number; n: number }>(`SELECT COALESCE(SUM(size),0) bytes,COUNT(*) n FROM files WHERE ${where}`);
    const bytes = Number(row?.bytes || 0);
    counted += bytes;
    countedFiles += Number(row?.n || 0);
    byType.push({ key, bytes, files: Number(row?.n || 0) });
  }
  byType.push({ key: "other", bytes: Math.max(0, metrics.uploadBytes - counted), files: Math.max(0, metrics.files - countedFiles) });
  const trend = storageTrend(now, 30);
  const total = metrics.databaseBytes + metrics.uploadBytes;
  // The value of a week ago (or the oldest within the week).
  const weekAgo = trend.slice(-8, -1).find((d) => d.bytes !== null)?.bytes ?? null;
  return {
    total,
    byType: byType.filter((b) => b.bytes > 0),
    workspaces: storageByWorkspace().slice(0, 6),
    trend: trend.map((d, i) => (i === trend.length - 1 ? { ...d, bytes: total } : d)),
    weekDelta: weekAgo === null ? null : total - weekAgo,
    disk: diskUsage(),
  };
}
export function monitoringStorage(now = Date.now()) {
  const c = cache.flowplanMonitoringStorage;
  if (c && now - c.at < MINUTE && now >= c.at) return c.value;
  const value = storageBlockUncached(now);
  cache.flowplanMonitoringStorage = { at: now, value };
  return value;
}

/* ---------- Deliveries and queues ---------- */

function lastDays(now: number, days: number) {
  const noon = new Date(now);
  noon.setHours(12, 0, 0, 0);
  const keys: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(noon);
    d.setDate(d.getDate() - i);
    keys.push(localDay(d.getTime()));
  }
  return keys;
}
// Successful deliveries per day (7 days) and what failed in that time.
export function deliveries(now = Date.now(), days = 7) {
  const keys = lastDays(now, days);
  const since = midnight(now) - (days - 1) * DAY;
  const out = new Map(keys.map((day) => [day, { day, webhooks: 0, push: 0, mail: 0 }]));
  const add = (kind: "webhooks" | "push" | "mail", times: { at: number }[]) => {
    for (const t of times) {
      const d = out.get(localDay(Number(t.at)));
      if (d) d[kind]++;
    }
  };
  add("webhooks", all<{ at: number }>("SELECT delivered_at at FROM webhook_deliveries WHERE delivered_at>=?", since));
  add("push", all<{ at: number }>("SELECT delivered_at at FROM push_deliveries WHERE delivered_at>=?", since));
  add("mail", all<{ at: number }>("SELECT sent_at at FROM mail_queue WHERE sent_at>=?", since));
  const failed =
    Number(one<{ n: number }>("SELECT COUNT(*) n FROM webhook_deliveries WHERE delivered_at IS NULL AND attempts>=6 AND created_at>=?", since)?.n || 0) +
    Number(one<{ n: number }>("SELECT COUNT(*) n FROM push_deliveries WHERE delivered_at IS NULL AND attempts>=5")?.n || 0) +
    Number(one<{ n: number }>("SELECT COUNT(*) n FROM mail_queue WHERE sent_at IS NULL AND attempts>=8")?.n || 0);
  return { days: [...out.values()], failed };
}

const count = (sql: string, ...args: (string | number)[]) => {
  try {
    return Number(one<{ n: number }>(sql, ...args)?.n || 0);
  } catch {
    return 0;
  }
};
// What waits to be done right now.
export function queues() {
  const mirror = storageStatus();
  const webhooks = webhookFailures();
  const mail = mailStatus();
  return {
    search: count("SELECT COUNT(*) n FROM search_dirty"),
    mail: mail.configured ? mail.pending : null,
    push: count("SELECT COUNT(*) n FROM push_deliveries WHERE delivered_at IS NULL AND attempts<5"),
    aiFields: count("SELECT COUNT(*) n FROM ai_cell_jobs"),
    aiIndex: count("SELECT COUNT(*) n FROM ai_embed_dirty"),
    s3: mirror.enabled ? mirror.pending : null,
    webhooksRetrying: webhooks.retrying,
    webhooksGivenUp: webhooks.givenUp,
  };
}

/* ---------- Events ---------- */

export type MonitoringEvent = {
  kind:
    | "worker_error"
    | "backup_ok"
    | "backup_failed"
    | "export_ok"
    | "export_failed"
    | "alert_sent"
    | "login_spike"
    | "rate_limit_spike"
    | "update"
    | "mail_failed"
    | "webhook_failed"
    | "maintenance"
    | "restore_pending"
    | "started"
    | "admin";
  level: "error" | "warn" | "info" | "ok";
  at: number;
  // A key or name the text names (worker, alert event, host, version, action).
  subject?: string;
  detail?: string;
  count?: number;
};

// Problems and noteworthy things of the last two weeks, newest first.
export function monitoringEvents(now = Date.now(), update: UpdateStatus | null = null, limit = 40): MonitoringEvent[] {
  const since = now - 14 * DAY;
  const out: MonitoringEvent[] = [];
  for (const w of workerStatuses(now))
    if (w.active && w.error && w.errorAt && w.errorAt >= since) out.push({ kind: "worker_error", level: "error", at: w.errorAt, subject: w.key, detail: w.error });
  const backup = scheduledBackupStatus();
  if (backup.last && backup.last.at >= since)
    out.push(
      backup.last.error
        ? { kind: "backup_failed", level: "error", at: backup.last.at, detail: backup.last.error }
        : { kind: "backup_ok", level: "ok", at: backup.last.at, subject: backup.last.name, count: backup.last.bytes },
    );
  for (const r of markdownExportStatus().runs.filter((r) => r.at >= since).slice(-5))
    out.push(r.error ? { kind: "export_failed", level: "error", at: r.at, detail: r.error } : { kind: "export_ok", level: "ok", at: r.at });
  for (const a of all<{ event: string; sent_at: number; status: number | null; error: string | null }>("SELECT event,sent_at,status,error FROM ops_alerts WHERE sent_at>=? ORDER BY sent_at DESC LIMIT 10", since))
    out.push({ kind: "alert_sent", level: "warn", at: a.sent_at, subject: a.event, detail: a.error || (a.status ? `HTTP ${a.status}` : undefined) });
  // Hours with many failed sign-ins or refusals (a fifth of the alert threshold).
  const spike = Math.max(5, Math.round(LOGIN_ALERT_THRESHOLD / 5));
  for (const [kind, event] of [
    ["login_failure", "login_spike"],
    ["rate_limited", "rate_limit_spike"],
  ] as const)
    for (const h of all<{ hour: number; n: number }>(
      "SELECT (at/3600000)*3600000 hour,COUNT(*) n FROM ops_events WHERE kind=? AND at>=? GROUP BY hour HAVING n>=? ORDER BY hour DESC LIMIT 5",
      kind,
      since,
      spike,
    ))
      out.push({ kind: event, level: "warn", at: Number(h.hour) + HOUR - 1, count: Number(h.n) });
  if (update) out.push({ kind: "update", level: "info", at: now, subject: update.latest });
  const mail = one<{ n: number; at: number | null }>("SELECT COUNT(*) n,MAX(next_at) at FROM mail_queue WHERE sent_at IS NULL AND attempts>=8");
  if (mail?.n) out.push({ kind: "mail_failed", level: "warn", at: Number(mail.at || now), count: Number(mail.n) });
  for (const w of webhookFailures().recent.filter((w) => w.attempts >= 6))
    out.push({ kind: "webhook_failed", level: "warn", at: w.at, subject: w.host, detail: w.error, count: w.attempts });
  const maintenance = storedMaintenance();
  if (maintenance && maintenance.end > now) out.push({ kind: "maintenance", level: "info", at: maintenance.start, count: maintenance.end, detail: maintenance.message });
  if (pendingRestore()) out.push({ kind: "restore_pending", level: "warn", at: now });
  out.push({ kind: "started", level: "info", at: now - Math.round(process.uptime() * 1000), subject: buildInfo().version });
  for (const a of all<{ action: string; created_at: string; name: string | null }>(
    "SELECT a.action,a.created_at,u.name FROM audit a LEFT JOIN users u ON u.id=a.actor_id WHERE a.action LIKE 'admin.%' AND a.created_at>=? ORDER BY a.created_at DESC LIMIT 10",
    new Date(since).toISOString().replace("T", " ").slice(0, 19),
  ))
    out.push({ kind: "admin", level: "info", at: Date.parse(a.created_at.replace(" ", "T") + "Z"), subject: a.action, detail: a.name || undefined });
  return out.filter((e) => Number.isFinite(e.at)).sort((a, b) => b.at - a.at).slice(0, limit);
}

/* ---------- The whole dashboard ---------- */

export function monitoringOverview(now = Date.now(), range: RequestRange = "24h", update: UpdateStatus | null = null) {
  const refusals = opsEventSummary(now, 14);
  const live = monitoringLive(now, range);
  return {
    ...live,
    keep: { minuteHours: METRICS_KEEP.minutesMs / HOUR, hourDays: METRICS_KEEP.hoursMs / DAY, days: METRICS_KEEP.days },
    health: monitoringHealth(now, update),
    alerts: activeAlerts(now).map((a) => a.event),
    active: activeSeries(now, 168),
    signins: refusals.days.map((d) => ({ day: d.day, ok: d.login_success, failed: d.login_failure })),
    refused: {
      days: refusals.days.map((d) => ({ day: d.day, login_failure: d.login_failure, rate_limited: d.rate_limited, anonymous_refused: d.anonymous_refused })),
      totals: refusals.totals,
      anonymousBytesToday: refusals.anonymousBytesToday,
    },
    storage: monitoringStorage(now),
    deliveries: deliveries(now, 7),
    ai: aiUsage(now, 14),
    queues: queues(),
    events: monitoringEvents(now, update),
  };
}
export type MonitoringOverview = ReturnType<typeof monitoringOverview>;
export type MonitoringLive = ReturnType<typeof monitoringLive>;

export function monitoringFor(user: Identity, now = Date.now(), range: RequestRange = "24h", update: UpdateStatus | null = null) {
  requireOpsAdmin(user);
  return monitoringOverview(now, range, update);
}
