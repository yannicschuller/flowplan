import { buildInfo } from "./build-info";
import { storageStatus, uploadsInFlightCount } from "./storage";
import { timingSafeEqual } from "node:crypto";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { all, databaseBytes, lockFor, one, run } from "./db";
import { HttpError } from "./auth";
import { retentionDays } from "./version-history";
import { instanceSettings } from "./instance-settings";
import { demoCounts } from "./demo";
import { securityCounters } from "./security-events";
import { runtimeMetricLines, runtimeMetricsOn } from "./runtime-metrics";
import { clusterMode, instanceId } from "./cluster/config";
import { isLeader, skippedDuties } from "./cluster/leader";
import { liveStreamCount } from "./cluster/runtime";
import { poolStats } from "./db-driver";
import { mapAsync } from "./each-async";

// Storage quota in MB: per-workspace override or FLOWPLAN_WORKSPACE_QUOTA_MB;
// 0 or unset means unlimited.
export async function defaultQuotaMb() {
  const stored = (await instanceSettings()).defaultQuotaMb;
  if (stored !== null) return stored;
  const value = Number(process.env.FLOWPLAN_WORKSPACE_QUOTA_MB || 0);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
export async function workspaceBytes(workspaceId: string) {
  return (
    Number(
      (await one<{ n: number | null }>(
        "SELECT SUM(f.size) n FROM files f JOIN pages p ON p.id=f.page_id WHERE p.workspace_id=?",
        workspaceId,
      ))?.n || 0,
    ) +
    Number(
      (await one<{ n: number | null }>(
        "SELECT SUM(length(tf.data)) n FROM template_files tf JOIN templates t ON t.id=tf.template_id WHERE t.workspace_id=?",
        workspaceId,
      ))?.n || 0,
    ) +
    // Notebook stickers and paper templates (lib/notebook-library.ts).
    Number((await one<{ n: number | null }>("SELECT SUM(COALESCE(length(data),0)) n FROM notebook_stickers WHERE workspace_id=?", workspaceId))?.n || 0) +
    Number((await one<{ n: number | null }>("SELECT SUM(length(data)) n FROM notebook_templates WHERE workspace_id=?", workspaceId))?.n || 0) +
    // Faces uploaded for the workspace's look (lib/workspace-fonts.ts).
    Number((await one<{ n: number | null }>("SELECT SUM(length(data)) n FROM workspace_fonts WHERE workspace_id=?", workspaceId))?.n || 0)
  );
}
export async function workspaceQuotaMb(workspaceId: string) {
  const own = (await one<{ quota_mb: number | null }>(
    "SELECT quota_mb FROM workspaces WHERE id=?",
    workspaceId,
  ))?.quota_mb;
  return own ?? await defaultQuotaMb();
}
// Throws before a write that would exceed the workspace quota.
// Inside a transaction, writes into one workspace with a quota take turns
// until the commit (PostgreSQL, several instances): two uploads cannot
// both pass the check against the same "used". Outside one, the check
// stands alone (as before; at most the concurrent uploads overshoot).
export async function enforceQuota(workspaceId: string, addBytes: number) {
  const quota = await workspaceQuotaMb(workspaceId);
  if (!quota) return;
  await lockFor(`quota:${workspaceId}`);
  const used = await workspaceBytes(workspaceId);
  if (used + addBytes > quota * 1024 * 1024)
    throw new HttpError(
      413,
      `Speicherkontingent des Arbeitsbereichs erschöpft (${formatMb(used)} von ${quota} MB belegt).`,
    );
}
// For copies and imports: call before writing, run the returned check after
// writing. Only growth beyond the quota is refused, inside the transaction.
export async function quotaCheckpoint(workspaceId: string) {
  if (await workspaceQuotaMb(workspaceId)) await lockFor(`quota:${workspaceId}`);
  const before = await workspaceBytes(workspaceId);
  return async () => {
    const quota = await workspaceQuotaMb(workspaceId);
    if (!quota) return;
    const after = await workspaceBytes(workspaceId);
    if (after > before && after > quota * 1024 * 1024)
      throw new HttpError(
        413,
        `Speicherkontingent des Arbeitsbereichs reicht nicht (${formatMb(before)} von ${quota} MB belegt, benötigt zusätzlich ${formatMb(after - before)}).`,
      );
  };
}
const formatMb = (bytes: number) =>
  `${(bytes / 1024 / 1024).toLocaleString("de-DE", { maximumFractionDigits: 1 })} MB`;

function fileSize(path: string) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
// shared=false (the metrics of a cluster pod that does not lead): only what
// belongs to this process, no counts from the database.
export async function instanceMetrics(options: { shared?: boolean } = {}) {
  const dir = resolve(process.env.FLOWPLAN_DATA_DIR || "./data");
  const shared = options.shared ?? true;
  const count = async (sql: string, ...args: (string | number)[]) =>
    shared ? Number((await one<{ n: number }>(sql, ...args))?.n || 0) : 0;
  const demos = await demoCounts();
  return {
    databaseBytes: shared ? await databaseBytes() : 0,
    uploadBytes:
      (await count("SELECT COALESCE(SUM(size),0) n FROM files")) +
      (await count("SELECT COALESCE(SUM(length(data)),0) n FROM template_files")),
    files: await count("SELECT COUNT(*) n FROM files"),
    pages: await count("SELECT COUNT(*) n FROM pages WHERE deleted_at IS NULL"),
    // Of those, days of journals (shown apart: "120 Seiten · 340 Journaltage").
    journalDays: await count("SELECT COUNT(*) n FROM pages WHERE deleted_at IS NULL AND journal_date IS NOT NULL"),
    trashedPages: await count(
      "SELECT COUNT(*) n FROM pages WHERE deleted_at IS NOT NULL",
    ),
    rows: await count("SELECT COUNT(*) n FROM rows"),
    snapshots:
      (await count("SELECT COUNT(*) n FROM snapshots")) +
      (await count("SELECT COUNT(*) n FROM row_snapshots")),
    pushPending: await count(
      "SELECT COUNT(*) n FROM push_deliveries WHERE delivered_at IS NULL AND attempts<5",
    ),
    pushFailed: await count(
      "SELECT COUNT(*) n FROM push_deliveries WHERE delivered_at IS NULL AND attempts>=5",
    ),
    searchBacklog: await count("SELECT COUNT(*) n FROM search_dirty"),
    reminders: await count("SELECT COUNT(*) n FROM date_reminders"),
    demosActive: demos.active,
    demosStarted: demos.started,
    retentionDays: await retentionDays(),
    defaultQuotaMb: await defaultQuotaMb(),
    uptimeSeconds: Math.round(process.uptime()),
    node: process.version,
  };
}
export async function workspaceUsage() {
  return await mapAsync(await all<{ id: string; quota_mb: number | null }>(
    "SELECT id,quota_mb FROM workspaces",
  ), async (w) => ({
    id: w.id,
    bytes: await workspaceBytes(w.id),
    quotaMb: w.quota_mb,
    effectiveQuotaMb: w.quota_mb ?? await defaultQuotaMb(),
  }));
}
export async function setWorkspaceQuota(workspaceId: string, quotaMb: number | null) {
  if (
    !(await run("UPDATE workspaces SET quota_mb=? WHERE id=?", quotaMb, workspaceId))
      .changes
  )
    throw new HttpError(404, "Arbeitsbereich nicht gefunden.");
}

// Prometheus text exposition of the instance metrics and per-workspace
// storage. Workspace IDs only, never names or content.
//
// Cluster mode: every pod is scraped (the Helm chart's ServiceMonitor).
// What belongs to the process – uptime, version, memory and CPU, its
// database connections, open live streams, security events counted in
// memory – each pod reports with its instance_id. The installation's
// figures read from the database (pages, files, queues, workspaces …) only
// the leader reports, so that a sum over the pods counts them once
// (flowplan_metrics_shared says which pod it is).
export async function prometheusMetrics() {
  const cluster = clusterMode();
  const shared = !cluster || isLeader();
  const own: Record<string, string> = cluster ? { instance_id: instanceId() } : {};
  const m = await instanceMetrics({ shared }),
    lines: string[] = [];
  const metric = (
    name: string,
    help: string,
    type: "gauge" | "counter",
    values: [Record<string, string>, number][],
    perProcess = false,
  ) => {
    lines.push(
      `# HELP flowplan_${name} ${help}`,
      `# TYPE flowplan_${name} ${type}`,
    );
    for (const [labels, value] of values) {
      const text = Object.entries(perProcess ? { ...own, ...labels } : labels)
        .map(([k, v]) => `${k}="${v.replace(/["\\\n]/g, "")}"`)
        .join(",");
      lines.push(`flowplan_${name}${text ? `{${text}}` : ""} ${value}`);
    }
  };
  const gauge = (name: string, help: string, value: number) =>
    metric(name, help, "gauge", [[{}, value]]);
  const processGauge = (name: string, help: string, value: number) =>
    metric(name, help, "gauge", [[{}, value]], true);
  if (cluster) {
    processGauge("metrics_shared", "1 on the pod that reports the installation's figures (the leader), else 0.", shared ? 1 : 0);
    processGauge("leader", "1 while this pod leads (runs the singleton jobs).", isLeader() ? 1 : 0);
  }
  if (shared) {
    gauge(
      "database_bytes",
      "SQLite database and WAL size in bytes.",
      m.databaseBytes,
    );
    gauge(
      "upload_bytes",
      "Stored uploads and template files in bytes.",
      m.uploadBytes,
    );
    gauge("files", "Stored files.", m.files);
    const mirror = await storageStatus();
    if (mirror.enabled)
      gauge(
        "object_storage_pending",
        "Files waiting to be uploaded to or deleted from object storage.",
        mirror.pending,
      );
    gauge("pages", "Pages outside the trash.", m.pages);
    gauge("trashed_pages", "Pages in the trash.", m.trashedPages);
    gauge("rows", "Database records.", m.rows);
    gauge("snapshots", "Saved page and record versions.", m.snapshots);
    gauge("push_pending", "Push deliveries waiting for retry.", m.pushPending);
    gauge("push_failed", "Push deliveries given up after retries.", m.pushFailed);
    gauge(
      "search_backlog",
      "Search index entries waiting for indexing.",
      m.searchBacklog,
    );
    gauge("date_reminders", "Scheduled date reminders.", m.reminders);
    gauge("demos_active", "Public demo sessions currently running.", m.demosActive);
  }
  metric("demos_started_total", "Public demos started on this instance.", "counter", [[{}, m.demosStarted]], true);
  processGauge("uptime_seconds", "Process uptime in seconds.", m.uptimeSeconds);
  const build = buildInfo();
  // One family (Prometheus refuses a second HELP/TYPE of the same name).
  metric("build_info", "The running version, commit and Node.js runtime (always 1).", "gauge", [[{ version: build.version, commit: build.commit.slice(0, 12), node: m.node }, 1]], true);
  if (shared) {
    const usage = await workspaceUsage();
    metric(
      "workspace_bytes",
      "Stored bytes per workspace.",
      "gauge",
      usage.map((w) => [{ workspace: w.id }, w.bytes]),
    );
    metric(
      "workspace_quota_bytes",
      "Effective storage quota per workspace in bytes (0 = unlimited).",
      "gauge",
      usage.map((w) => [{ workspace: w.id }, w.effectiveQuotaMb * 1024 * 1024]),
    );
  }
  // Security observability (lib/security-events.ts, lib/security-detect.ts).
  metric(
    "security_events_total",
    "Security events since the process started, by event and severity.",
    "counter",
    securityCounters().map((c) => [{ event: c.kind, severity: c.severity }, c.value]),
    true,
  );
  if (shared) {
    metric(
      "security_incidents_open",
      "Open security incidents by rule and severity.",
      "gauge",
      (await all<{ rule: string; severity: string; n: number }>(
        "SELECT rule,severity,COUNT(*) n FROM security_incidents WHERE resolved_at IS NULL GROUP BY rule,severity",
      )).map((r) => [{ rule: r.rule, severity: r.severity }, r.n]),
    );
    gauge(
      "security_blocks",
      "Blocked addresses and networks.",
      Number((await one<{ n: number }>("SELECT COUNT(*) n FROM security_blocks WHERE until IS NULL OR until>?", Date.now()))?.n || 0),
    );
  }
  if (cluster) {
    // The process, always in cluster mode (FLOWPLAN_METRICS_LOOP adds the
    // event loop and the same figures below for a single container).
    if (!runtimeMetricsOn) {
      const mem = process.memoryUsage(),
        cpu = process.cpuUsage();
      metric("process_cpu_seconds_total", "User and system CPU time of the process.", "counter", [[{}, (cpu.user + cpu.system) / 1e6]], true);
      processGauge("process_resident_memory_bytes", "Resident memory of the process.", mem.rss);
      processGauge("process_heap_used_bytes", "V8 heap in use.", mem.heapUsed);
    }
    const pool = poolStats();
    if (pool)
      metric(
        "db_pool_connections",
        "PostgreSQL connections of this pod's pool by state (total, idle, waiting requests).",
        "gauge",
        [
          [{ state: "total" }, pool.total],
          [{ state: "idle" }, pool.idle],
          [{ state: "waiting" }, pool.waiting],
        ],
        true,
      );
    processGauge("live_streams", "Open server-sent event streams (live editing, cursors) on this pod.", liveStreamCount());
    processGauge("storage_uploads_in_flight", "Files being written to the bucket right now.", uploadsInFlightCount());
    metric("leader_skipped_rounds_total", "Leader rounds left out (another round of the duty still running, or a newer term).", "counter", [[{}, skippedDuties()]], true);
  }
  // Event loop, SQLite time and process (FLOWPLAN_METRICS_LOOP=1, lib/runtime-metrics.ts).
  lines.push(...runtimeMetricLines(walBytes(), own));
  return lines.join("\n") + "\n";
}
function walBytes() {
  try {
    return statSync(resolve(/* turbopackIgnore: true */ process.env.FLOWPLAN_DATA_DIR || "./data", "flowplan.sqlite-wal")).size;
  } catch {
    return 0;
  }
}
// The metrics endpoint is off unless FLOWPLAN_METRICS_TOKEN is set; scrapers
// send it as a bearer token.
export function metricsAuthorized(header: string | null) {
  const token = process.env.FLOWPLAN_METRICS_TOKEN || "";
  if (token.length < 16) return null;
  const given = Buffer.from(/^Bearer (.+)$/.exec(header || "")?.[1] || ""),
    expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
