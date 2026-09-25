import { timingSafeEqual } from "node:crypto";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { all, one, run } from "./db";
import { HttpError } from "./auth";
import { retentionDays } from "./version-history";
import { instanceSettings } from "./instance-settings";

// Storage quota in MB: per-workspace override or FLOWPLAN_WORKSPACE_QUOTA_MB;
// 0 or unset means unlimited.
export function defaultQuotaMb() {
  const stored = instanceSettings().defaultQuotaMb;
  if (stored !== null) return stored;
  const value = Number(process.env.FLOWPLAN_WORKSPACE_QUOTA_MB || 0);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
export function workspaceBytes(workspaceId: string) {
  return (
    Number(
      one<{ n: number | null }>(
        "SELECT SUM(f.size) n FROM files f JOIN pages p ON p.id=f.page_id WHERE p.workspace_id=?",
        workspaceId,
      )?.n || 0,
    ) +
    Number(
      one<{ n: number | null }>(
        "SELECT SUM(length(tf.data)) n FROM template_files tf JOIN templates t ON t.id=tf.template_id WHERE t.workspace_id=?",
        workspaceId,
      )?.n || 0,
    )
  );
}
export function workspaceQuotaMb(workspaceId: string) {
  const own = one<{ quota_mb: number | null }>(
    "SELECT quota_mb FROM workspaces WHERE id=?",
    workspaceId,
  )?.quota_mb;
  return own ?? defaultQuotaMb();
}
// Throws before a write that would exceed the workspace quota.
export function enforceQuota(workspaceId: string, addBytes: number) {
  const quota = workspaceQuotaMb(workspaceId);
  if (!quota) return;
  const used = workspaceBytes(workspaceId);
  if (used + addBytes > quota * 1024 * 1024)
    throw new HttpError(
      413,
      `Speicherkontingent des Arbeitsbereichs erschöpft (${formatMb(used)} von ${quota} MB belegt).`,
    );
}
// For copies and imports: call before writing, run the returned check after
// writing. Only growth beyond the quota is refused, inside the transaction.
export function quotaCheckpoint(workspaceId: string) {
  const before = workspaceBytes(workspaceId);
  return () => {
    const quota = workspaceQuotaMb(workspaceId);
    if (!quota) return;
    const after = workspaceBytes(workspaceId);
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
export function instanceMetrics() {
  const dir = resolve(process.env.FLOWPLAN_DATA_DIR || "./data");
  const count = (sql: string, ...args: (string | number)[]) =>
    Number(one<{ n: number }>(sql, ...args)?.n || 0);
  return {
    databaseBytes:
      fileSize(resolve(dir, "flowplan.sqlite")) +
      fileSize(resolve(dir, "flowplan.sqlite-wal")),
    uploadBytes:
      count("SELECT COALESCE(SUM(size),0) n FROM files") +
      count("SELECT COALESCE(SUM(length(data)),0) n FROM template_files"),
    files: count("SELECT COUNT(*) n FROM files"),
    pages: count("SELECT COUNT(*) n FROM pages WHERE deleted_at IS NULL"),
    trashedPages: count(
      "SELECT COUNT(*) n FROM pages WHERE deleted_at IS NOT NULL",
    ),
    rows: count("SELECT COUNT(*) n FROM rows"),
    snapshots:
      count("SELECT COUNT(*) n FROM snapshots") +
      count("SELECT COUNT(*) n FROM row_snapshots"),
    pushPending: count(
      "SELECT COUNT(*) n FROM push_deliveries WHERE delivered_at IS NULL AND attempts<5",
    ),
    pushFailed: count(
      "SELECT COUNT(*) n FROM push_deliveries WHERE delivered_at IS NULL AND attempts>=5",
    ),
    searchBacklog: count("SELECT COUNT(*) n FROM search_dirty"),
    reminders: count("SELECT COUNT(*) n FROM date_reminders"),
    retentionDays: retentionDays(),
    defaultQuotaMb: defaultQuotaMb(),
    uptimeSeconds: Math.round(process.uptime()),
    node: process.version,
  };
}
export function workspaceUsage() {
  return all<{ id: string; quota_mb: number | null }>(
    "SELECT id,quota_mb FROM workspaces",
  ).map((w) => ({
    id: w.id,
    bytes: workspaceBytes(w.id),
    quotaMb: w.quota_mb,
    effectiveQuotaMb: w.quota_mb ?? defaultQuotaMb(),
  }));
}
export function setWorkspaceQuota(workspaceId: string, quotaMb: number | null) {
  if (
    !run("UPDATE workspaces SET quota_mb=? WHERE id=?", quotaMb, workspaceId)
      .changes
  )
    throw new HttpError(404, "Arbeitsbereich nicht gefunden.");
}

// Prometheus text exposition of the instance metrics and per-workspace
// storage. Workspace IDs only, never names or content.
export function prometheusMetrics() {
  const m = instanceMetrics(),
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
  gauge("uptime_seconds", "Process uptime in seconds.", m.uptimeSeconds);
  const usage = workspaceUsage();
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
  return lines.join("\n") + "\n";
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
