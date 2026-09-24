import { statSync } from "node:fs";
import { resolve } from "node:path";
import { all, one, run } from "./db";
import { HttpError } from "./auth";
import { retentionDays } from "./version-history";

// Storage quota in MB: per-workspace override or FLOWPLAN_WORKSPACE_QUOTA_MB;
// 0 or unset means unlimited.
export function defaultQuotaMb() {
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
