import { buildInfo } from "./build-info";
import { storageStatus } from "./storage";
import { timingSafeEqual } from "node:crypto";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { all, databaseBytes, one, run } from "./db";
import { HttpError } from "./auth";
import { retentionDays } from "./version-history";
import { instanceSettings } from "./instance-settings";
import { demoCounts } from "./demo";
import { securityCounters } from "./security-events";
import { runtimeMetricLines } from "./runtime-metrics";
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
    )
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
export async function enforceQuota(workspaceId: string, addBytes: number) {
  const quota = await workspaceQuotaMb(workspaceId);
  if (!quota) return;
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
export async function instanceMetrics() {
  const dir = resolve(process.env.FLOWPLAN_DATA_DIR || "./data");
  const count = async (sql: string, ...args: (string | number)[]) =>
    Number((await one<{ n: number }>(sql, ...args))?.n || 0);
  const demos = await demoCounts();
  return {
    databaseBytes: await databaseBytes(),
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
export async function prometheusMetrics() {
  const m = await instanceMetrics(),
    lines: string[] = [];
  const metric = (
    name: string,
    help: string,
    type: "gauge" | "counter",
    values: [Record<string, string>, number][],
  ) => {
    lines.push(
      `# HELP flowplan_${name} ${help}`,
      `# TYPE flowplan_${name} ${type}`,
    );
    for (const [labels, value] of values) {
      const text = Object.entries(labels)
        .map(([k, v]) => `${k}="${v.replace(/["\\\n]/g, "")}"`)
        .join(",");
      lines.push(`flowplan_${name}${text ? `{${text}}` : ""} ${value}`);
    }
  };
  const gauge = (name: string, help: string, value: number) =>
    metric(name, help, "gauge", [[{}, value]]);
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
  metric("demos_started_total", "Public demos started on this instance.", "counter", [[{}, m.demosStarted]]);
  gauge("uptime_seconds", "Process uptime in seconds.", m.uptimeSeconds);
  const build = buildInfo();
  metric("build_info", "The running version and commit (always 1).", "gauge", [[{ version: build.version, commit: build.commit.slice(0, 12) }, 1]]);
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
  metric("build_info", "Runtime version.", "gauge", [[{ node: m.node }, 1]]);
  // Security observability (lib/security-events.ts, lib/security-detect.ts).
  metric(
    "security_events_total",
    "Security events since the process started, by event and severity.",
    "counter",
    securityCounters().map((c) => [{ event: c.kind, severity: c.severity }, c.value]),
  );
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
  // Event loop, SQLite time and process (FLOWPLAN_METRICS_LOOP=1, lib/runtime-metrics.ts).
  lines.push(...runtimeMetricLines(walBytes()));
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
