// Administration → Überwachung: everything the monitoring dashboard shows,
// in one answer (app/api/admin/monitoring/handler.ts), polled every few
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
import { backupRuns, scheduledBackupStatus } from "./scheduled-backup";
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
  errorsDay,
  liveNumbers,
  localDay,
  metricsSetting,
  METRICS_KEEP,
  requestSeries,
  routeStats,
  storageTrend,
  type RequestRange,
} from "./metrics";
import { pushSummary } from "./push-status";
import { cpuByArea, serverNow, serverSeries } from "./server-metrics";
import { aiDaily } from "./ai-statistics";
import { recommendations } from "./recommendations-data";
import type { UpdateStatus } from "./update-check";
import type { Identity } from "./types";
import { systemOverview } from "./cluster/system";
import { flushOpsEvents } from "./ops-events";

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
async function databaseReachable() {
  try {
    await one("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

// The instance provider: switched on, which kind, and whether it answers
// (checked in the background, at most every five minutes).
async function aiHealth(now: number) {
  let enabled = false,
    provider: string | null = null;
  try {
    const s = await instanceAiSettings();
    enabled = s.enabled;
    provider = s.provider?.kind ?? null;
  } catch {}
  const config = enabled ? (await instanceProviderConfig()) : null;
  const ping =
    config?.ok === true
      ? aiProviderPing(() => listModels(config.config, AbortSignal.timeout(10_000)), now)
      : null;
  return { enabled, provider, configured: config?.ok === true, ping };
}

export async function monitoringHealth(now = Date.now(), update: UpdateStatus | null = null) {
  const metrics = await instanceMetrics();
  const mirror = await storageStatus();
  const backup = await scheduledBackupStatus();
  const mail = await mailStatus();
  const workers = await workerStatuses(now);
  const failing = workers.filter((w) => w.active && w.error && (w.errorAt ?? 0) >= now - DAY);
  return {
    database: { ok: await databaseReachable(), bytes: metrics.databaseBytes },
    uploads: { ok: uploadsWritable(), bytes: metrics.uploadBytes, files: metrics.files, disk: diskUsage() },
    s3: mirror.enabled ? { pending: mirror.pending, failing: !!mirror.failing } : null,
    backup: { enabled: backup.enabled, hourly: backup.hourly, target: backup.target, lastAt: backup.last?.at ?? null, error: backup.last?.error ?? null },
    mail: { configured: mail.configured, pending: mail.pending, failed: mail.failed, lastError: mail.lastError },
    ai: await aiHealth(now),
    // The push relay (lib/push-status.ts), as last checked.
    push: await pushSummary(now),
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
export const activeSince = async (since: number) =>
  Number(
    (await one<{ n: number }>(
      "SELECT COUNT(*) n FROM users u WHERE u.disabled=0 AND (u.last_active_at>=? OR EXISTS (SELECT 1 FROM sessions s WHERE s.user_id=u.id AND s.last_seen>=?))",
      since,
      since,
    ))?.n || 0,
  );
const events = async (kind: string, since: number) => Number((await one<{ n: number }>("SELECT COUNT(*) n FROM ops_events WHERE kind=? AND at>=?", kind, since))?.n || 0);

// Whether AI is set up at all (switched on with a provider of the instance,
// or own providers allowed) – the start page shows its AI panel only then.
async function aiConfigured() {
  try {
    const s = await instanceAiSettings();
    return s.enabled && (!!s.provider || s.userProviders);
  } catch {
    return false;
  }
}

export async function monitoringLive(now = Date.now(), range: RequestRange = "24h") {
  const setting = await metricsSetting();
  const live = await liveNumbers(now);
  const ai = setting.enabled && (await aiConfigured());
  return {
    at: now,
    collecting: { enabled: setting.enabled, locked: setting.locked, since: await collectingSince() },
    kpis: {
      ...live,
      signinsToday: await events("login_success", midnight(now)),
      activeToday: await activeSince(midnight(now)),
      // Different people of the last 24 hours (the KPI row of the monitoring).
      active24h: await activeSince(now - DAY),
      failedSigninsToday: await events("login_failure", midnight(now)),
    },
    requests: await requestSeries(range, now),
    // The other charts of the strip's carousel: the server (always), AI
    // tokens (when AI is set up) and the slowest routes (with the statistics).
    server: await serverSeries("24h", now),
    ai: ai ? await aiDaily(now, 14) : null,
    // What the measurements suggest (lib/recommendations.ts; cached 15 min):
    // notices of the strip's state block.
    recommendations: (await recommendations(now).catch(() => null))?.items ?? [],
    slowRoutes: setting.enabled
      ? (await routeStats(now, 24, 30))
          .filter((r) => r.p95 !== null && r.requests >= 3)
          .sort((a, b) => (b.p95 ?? 0) - (a.p95 ?? 0))
          .slice(0, 5)
      : [],
  };
}

const RANGE_HOURS: Record<RequestRange, number> = { "1h": 1, "24h": 24, "7d": 168 };
// Administration → Überwachung → Server: CPU, memory and disk over the
// range, what uses the memory now, the CPU per area and the routes that
// take the most time.
export async function monitoringServer(now = Date.now(), range: RequestRange = "24h") {
  const hours = RANGE_HOURS[range];
  return {
    series: await serverSeries(range, now),
    now: await serverNow(now),
    areas: await cpuByArea(now - hours * HOUR),
    routes: await routeStats(now, hours, 12),
  };
}
export type MonitoringServer = Awaited<ReturnType<typeof monitoringServer>>;

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
const cache = globalThis as unknown as { flowplanMonitoringStorage?: { at: number; value: Awaited<ReturnType<typeof storageBlockUncached>> } };
async function storageBlockUncached(now: number) {
  const metrics = await instanceMetrics();
  const byType: { key: string; bytes: number; files?: number }[] = [{ key: "database", bytes: metrics.databaseBytes }];
  let counted = 0,
    countedFiles = 0;
  for (const [key, where] of MEDIA) {
    const row = await one<{ bytes: number; n: number }>(`SELECT COALESCE(SUM(size),0) bytes,COUNT(*) n FROM files WHERE ${where}`);
    const bytes = Number(row?.bytes || 0);
    counted += bytes;
    countedFiles += Number(row?.n || 0);
    byType.push({ key, bytes, files: Number(row?.n || 0) });
  }
  byType.push({ key: "other", bytes: Math.max(0, metrics.uploadBytes - counted), files: Math.max(0, metrics.files - countedFiles) });
  const trend = await storageTrend(now, 30);
  const total = metrics.databaseBytes + metrics.uploadBytes;
  // The value of a week ago (or the oldest within the week).
  const weekAgo = trend.slice(-8, -1).find((d) => d.bytes !== null)?.bytes ?? null;
  return {
    total,
    byType: byType.filter((b) => b.bytes > 0),
    workspaces: (await storageByWorkspace()).slice(0, 6),
    trend: trend.map((d, i) => (i === trend.length - 1 ? { ...d, bytes: total } : d)),
    weekDelta: weekAgo === null ? null : total - weekAgo,
    disk: diskUsage(),
  };
}
export async function monitoringStorage(now = Date.now()) {
  const c = cache.flowplanMonitoringStorage;
  if (c && now - c.at < MINUTE && now >= c.at) return c.value;
  const value = await storageBlockUncached(now);
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
export async function deliveries(now = Date.now(), days = 7) {
  const keys = lastDays(now, days);
  const since = midnight(now) - (days - 1) * DAY;
  const out = new Map(keys.map((day) => [day, { day, webhooks: 0, push: 0, mail: 0 }]));
  const add = (kind: "webhooks" | "push" | "mail", times: { at: number }[]) => {
    for (const t of times) {
      const d = out.get(localDay(Number(t.at)));
      if (d) d[kind]++;
    }
  };
  add("webhooks", await all<{ at: number }>("SELECT delivered_at at FROM webhook_deliveries WHERE delivered_at>=?", since));
  add("push", await all<{ at: number }>("SELECT delivered_at at FROM push_deliveries WHERE delivered_at>=?", since));
  add("mail", await all<{ at: number }>("SELECT sent_at at FROM mail_queue WHERE sent_at>=?", since));
  const failed =
    Number((await one<{ n: number }>("SELECT COUNT(*) n FROM webhook_deliveries WHERE delivered_at IS NULL AND attempts>=6 AND created_at>=?", since))?.n || 0) +
    Number((await one<{ n: number }>("SELECT COUNT(*) n FROM push_deliveries WHERE delivered_at IS NULL AND attempts>=5"))?.n || 0) +
    Number((await one<{ n: number }>("SELECT COUNT(*) n FROM mail_queue WHERE sent_at IS NULL AND attempts>=8"))?.n || 0);
  return { days: [...out.values()], failed };
}

const count = async (sql: string, ...args: (string | number)[]) => {
  try {
    return Number((await one<{ n: number }>(sql, ...args))?.n || 0);
  } catch {
    return 0;
  }
};
// What waits to be done right now.
export async function queues() {
  const mirror = await storageStatus();
  const webhooks = await webhookFailures();
  const mail = await mailStatus();
  return {
    search: await count("SELECT COUNT(*) n FROM search_dirty"),
    mail: mail.configured ? mail.pending : null,
    push: await count("SELECT COUNT(*) n FROM push_deliveries WHERE delivered_at IS NULL AND attempts<5"),
    aiFields: await count("SELECT COUNT(*) n FROM ai_cell_jobs"),
    aiIndex: await count("SELECT COUNT(*) n FROM ai_embed_dirty"),
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
    | "restart"
    | "admin";
  level: "error" | "warn" | "info" | "ok";
  at: number;
  // A key or name the text names (worker, alert event, host, version, action).
  subject?: string;
  detail?: string;
  count?: number;
};

// Problems and noteworthy things of the last two weeks, newest first.
export async function monitoringEvents(now = Date.now(), update: UpdateStatus | null = null, limit = 40): Promise<MonitoringEvent[]> {
  const since = now - 14 * DAY;
  const out: MonitoringEvent[] = [];
  for (const w of await workerStatuses(now))
    if (w.active && w.error && w.errorAt && w.errorAt >= since) out.push({ kind: "worker_error", level: "error", at: w.errorAt, subject: w.key, detail: w.error });
  const backup = await scheduledBackupStatus();
  if (backup.last && backup.last.at >= since)
    out.push(
      backup.last.error
        ? { kind: "backup_failed", level: "error", at: backup.last.at, detail: backup.last.error }
        : { kind: "backup_ok", level: "ok", at: backup.last.at, subject: backup.last.name, count: backup.last.bytes },
    );
  for (const r of (await markdownExportStatus()).runs.filter((r) => r.at >= since).slice(-5))
    out.push(r.error ? { kind: "export_failed", level: "error", at: r.at, detail: r.error } : { kind: "export_ok", level: "ok", at: r.at });
  for (const a of await all<{ event: string; sent_at: number; status: number | null; error: string | null }>("SELECT event,sent_at,status,error FROM ops_alerts WHERE sent_at>=? ORDER BY sent_at DESC LIMIT 10", since))
    out.push({ kind: "alert_sent", level: "warn", at: a.sent_at, subject: a.event, detail: a.error || (a.status ? `HTTP ${a.status}` : undefined) });
  // Hours with many failed sign-ins or refusals (a fifth of the alert threshold).
  const spike = Math.max(5, Math.round(LOGIN_ALERT_THRESHOLD / 5));
  for (const [kind, event] of [
    ["login_failure", "login_spike"],
    ["rate_limited", "rate_limit_spike"],
  ] as const)
    for (const h of await all<{ hour: number; n: number }>(
      "SELECT (at/3600000)*3600000 AS hour,COUNT(*) n FROM ops_events WHERE kind=? AND at>=? GROUP BY (at/3600000)*3600000 HAVING COUNT(*)>=? ORDER BY hour DESC LIMIT 5",
      kind,
      since,
      spike,
    ))
      out.push({ kind: event, level: "warn", at: Number(h.hour) + HOUR - 1, count: Number(h.n) });
  if (update) out.push({ kind: "update", level: "info", at: now, subject: update.latest });
  const mail = await one<{ n: number; at: number | null }>("SELECT COUNT(*) n,MAX(next_at) at FROM mail_queue WHERE sent_at IS NULL AND attempts>=8");
  if (mail?.n) out.push({ kind: "mail_failed", level: "warn", at: Number(mail.at || now), count: Number(mail.n) });
  for (const w of (await webhookFailures()).recent.filter((w) => w.attempts >= 6))
    out.push({ kind: "webhook_failed", level: "warn", at: w.at, subject: w.host, detail: w.error, count: w.attempts });
  const maintenance = await storedMaintenance();
  if (maintenance && maintenance.end > now) out.push({ kind: "maintenance", level: "info", at: maintenance.start, count: maintenance.end, detail: maintenance.message });
  if (pendingRestore()) out.push({ kind: "restore_pending", level: "warn", at: now });
  out.push({ kind: "started", level: "info", at: now - Math.round(process.uptime() * 1000), subject: buildInfo().version });
  // Unexpected restarts (lib/restarts/history.ts): the reason as subject.
  for (const r of await all<{ at: number; reason: string; instance: string; error: string | null }>(
    "SELECT at,reason,instance,error FROM restart_events WHERE reason<>'clean' AND at>=? ORDER BY at DESC LIMIT 5",
    since,
  ))
    out.push({ kind: "restart", level: r.reason === "crash" ? "error" : "warn", at: Number(r.at), subject: r.reason, detail: r.error ? r.error.split("\n")[0].slice(0, 200) : r.instance || undefined });
  for (const a of await all<{ action: string; created_at: string; name: string | null }>(
    "SELECT a.action,a.created_at,u.name FROM audit a LEFT JOIN users u ON u.id=a.actor_id WHERE a.action LIKE 'admin.%' AND a.created_at>=? ORDER BY a.created_at DESC LIMIT 10",
    new Date(since).toISOString().replace("T", " ").slice(0, 19),
  ))
    out.push({ kind: "admin", level: "info", at: Date.parse(a.created_at.replace(" ", "T") + "Z"), subject: a.action, detail: a.name || undefined });
  return out.filter((e) => Number.isFinite(e.at)).sort((a, b) => b.at - a.at).slice(0, limit);
}

/* ---------- The settings' start page (cached a minute) ---------- */

// SQLite's CURRENT_TIMESTAMP (UTC, "YYYY-MM-DD HH:MM:SS") and back.
const sqliteTime = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);
const fromSqlite = (value: unknown) => {
  if (value instanceof Date) return value.getTime();
  const text = String(value ?? "");
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text.replace(" ", "T") : `${text.replace(" ", "T")}Z`);
};

// Accounts: how many there are and the new ones per day (30 days) – the
// accounts that still exist, without demo guests and deleted accounts.
export async function accountsGlance(now = Date.now(), days = 30) {
  const keys = lastDays(now, days);
  const since = midnight(now) - (days - 1) * DAY;
  const perDay = new Map(keys.map((day) => [day, 0]));
  for (const r of await all<{ created_at: string }>("SELECT created_at FROM users WHERE demo_until IS NULL AND subject NOT LIKE 'deleted:%' AND created_at>=?", sqliteTime(since))) {
    const at = fromSqlite(r.created_at);
    if (!Number.isFinite(at)) continue;
    const day = localDay(at);
    if (perDay.has(day)) perDay.set(day, perDay.get(day)! + 1);
  }
  return {
    total: await count("SELECT COUNT(*) n FROM users WHERE demo_until IS NULL AND subject NOT LIKE 'deleted:%'"),
    disabled: await count("SELECT COUNT(*) n FROM users WHERE demo_until IS NULL AND subject NOT LIKE 'deleted:%' AND disabled=1"),
    sessions: await count("SELECT COUNT(*) n FROM sessions WHERE expires>?", now),
    perDay: [...perDay].map(([day, created]) => ({ day, created })),
  };
}

// Sign-ins per hour, the last 24 hours (lib/ops-events.ts): failed ones
// always, successful ones only with the statistics on (null otherwise).
export async function signinsGlance(now = Date.now(), withSuccess = true) {
  await flushOpsEvents();
  const end = Math.floor(now / HOUR) * HOUR;
  const start = end - 23 * HOUR;
  const hours = new Map<number, { at: number; ok: number; failed: number }>();
  for (let at = start; at <= end; at += HOUR) hours.set(at, { at, ok: 0, failed: 0 });
  for (const r of await all<{ hour: number; kind: string; n: number }>(
    "SELECT (at/3600000)*3600000 AS hour,kind,COUNT(*) n FROM ops_events WHERE at>=? AND kind IN ('login_success','login_failure') GROUP BY (at/3600000)*3600000,kind",
    start,
  )) {
    const h = hours.get(Number(r.hour));
    if (!h) continue;
    if (r.kind === "login_success") h.ok += Number(r.n);
    else h.failed += Number(r.n);
  }
  const points = [...hours.values()];
  return {
    points: points.map((p) => ({ at: p.at, ok: withSuccess ? p.ok : null, failed: p.failed })),
    ok: withSuccess ? points.reduce((a, p) => a + p.ok, 0) : null,
    failed: points.reduce((a, p) => a + p.failed, 0),
  };
}

// The scheduled backup: switched on, how often, where, and its last runs
// (outcome and size; lib/scheduled-backup.ts keeps 30).
export async function backupsGlance() {
  const status = await scheduledBackupStatus();
  const runs = (await backupRuns()).slice(-14);
  return { enabled: status.enabled, hourly: status.hourly, target: status.target, runs: runs.map((r) => ({ at: r.at, bytes: r.bytes, failed: !!r.error })) };
}

async function glanceUncached(now: number, statistics: boolean) {
  const storage = await monitoringStorage(now);
  const workers = await workerStatuses(now);
  return {
    accounts: await accountsGlance(now),
    signins: await signinsGlance(now, statistics),
    // Database and files now, the total per day (30 days, from the
    // statistics' daily snapshot) and the largest workspaces.
    storage: {
      total: storage.total,
      databaseBytes: storage.byType.find((b) => b.key === "database")?.bytes ?? 0,
      uploadBytes: storage.byType.filter((b) => b.key !== "database").reduce((a, b) => a + b.bytes, 0),
      trend: storage.trend,
      weekDelta: storage.weekDelta,
      workspaces: storage.workspaces.slice(0, 3).map((w) => ({ name: w.name, bytes: w.bytes })),
    },
    backups: await backupsGlance(),
    // Deliveries per day (7 days), what waits and the background services.
    background: {
      deliveries: await deliveries(now, 7),
      queues: await queues(),
      workers: { active: workers.filter((w) => w.active).length, failing: workers.filter((w) => w.active && w.error && (w.errorAt ?? 0) >= now - DAY).map((w) => w.key) },
    },
  };
}
const glanceCache = globalThis as unknown as { flowplanMonitoringGlance?: { at: number; statistics: boolean; value: Awaited<ReturnType<typeof glanceUncached>> } };
export async function monitoringGlance(now = Date.now(), statistics = true) {
  const c = glanceCache.flowplanMonitoringGlance;
  if (c && c.statistics === statistics && now - c.at < MINUTE && now >= c.at) return c.value;
  const value = await glanceUncached(now, statistics);
  glanceCache.flowplanMonitoringGlance = { at: now, statistics, value };
  return value;
}
export function forgetMonitoringGlance() {
  delete glanceCache.flowplanMonitoringGlance;
}

// The start page's live panels (?view=live): the live answer and the
// slower facts of the instance (cached a minute).
export async function monitoringStart(now = Date.now(), range: RequestRange = "24h") {
  const live = await monitoringLive(now, range);
  return { ...live, glance: await monitoringGlance(now, live.collecting.enabled) };
}
export type MonitoringStart = Awaited<ReturnType<typeof monitoringStart>>;

/* ---------- The whole dashboard ---------- */

export async function monitoringOverview(now = Date.now(), range: RequestRange = "24h", update: UpdateStatus | null = null) {
  const refusals = await opsEventSummary(now, 14);
  const live = await monitoringLive(now, range);
  return {
    ...live,
    keep: { minuteHours: METRICS_KEEP.minutesMs / HOUR, hourDays: METRICS_KEEP.hoursMs / DAY, days: METRICS_KEEP.days },
    health: await monitoringHealth(now, update),
    alerts: (await activeAlerts(now)).map((a) => a.event),
    active: await activeSeries(now, 168),
    signins: refusals.days.map((d) => ({ day: d.day, ok: d.login_success, failed: d.login_failure })),
    refused: {
      days: refusals.days.map((d) => ({ day: d.day, login_failure: d.login_failure, rate_limited: d.rate_limited, anonymous_refused: d.anonymous_refused })),
      totals: refusals.totals,
      anonymousBytesToday: refusals.anonymousBytesToday,
    },
    // 5xx of the last 24 hours and the 24 before (the error KPI).
    errorsDay: await errorsDay(now),
    storage: await monitoringStorage(now),
    deliveries: await deliveries(now, 7),
    ai: await aiUsage(now, 14),
    queues: await queues(),
    events: await monitoringEvents(now, update),
    // Single container or cluster, database, Redis, object storage,
    // instances and leader (lib/cluster/system.ts).
    system: await systemOverview(now),
    server: await monitoringServer(now, range),
    advice: await recommendations(now),
  };
}
export type MonitoringOverview = Awaited<ReturnType<typeof monitoringOverview>>;
export type MonitoringLive = Awaited<ReturnType<typeof monitoringLive>>;

export async function monitoringFor(user: Identity, now = Date.now(), range: RequestRange = "24h", update: UpdateStatus | null = null) {
  requireOpsAdmin(user);
  return await monitoringOverview(now, range, update);
}
