import { all, one, run, transaction } from "./db";
import { HttpError } from "./auth";
import { requirePage } from "./permissions";
import { compareParagraphs, type TextChange } from "./text-diff";
import { cellText } from "./cell-text";
import type { Field, Identity } from "./types";

// Text blocks of stored document HTML, one entry per paragraph-like element.
export function htmlParagraphs(html: string) {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(
      /<\/(p|h[1-6]|li|blockquote|pre|div|tr|figcaption)>|<br\s*\/?>/gi,
      "\n",
    )
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

type DatabaseState = {
  database: { fields: Field[] };
  rows: { id: string; cells: Record<string, unknown> }[];
};
export type DatabaseChanges = {
  fields: { added: string[]; removed: string[]; renamed: string[] };
  rows: {
    added: string[];
    removed: string[];
    changed: { title: string; fields: string[] }[];
  };
};
function databaseChanges(before: DatabaseState, after: DatabaseState) {
  const oldFields = new Map(before.database.fields.map((f) => [f.id, f]));
  const newFields = new Map(after.database.fields.map((f) => [f.id, f]));
  const title = (row: { cells: Record<string, unknown> }) =>
    cellText(row.cells[after.database.fields[0]?.id || "title"]) ||
    cellText(row.cells[before.database.fields[0]?.id || "title"]) ||
    "Ohne Titel";
  const oldRows = new Map(before.rows.map((r) => [r.id, r]));
  const newRows = new Map(after.rows.map((r) => [r.id, r]));
  const changes: DatabaseChanges = {
    fields: {
      added: after.database.fields
        .filter((f) => !oldFields.has(f.id))
        .map((f) => f.name),
      removed: before.database.fields
        .filter((f) => !newFields.has(f.id))
        .map((f) => f.name),
      renamed: after.database.fields
        .filter(
          (f) => oldFields.has(f.id) && oldFields.get(f.id)!.name !== f.name,
        )
        .map((f) => `${oldFields.get(f.id)!.name} → ${f.name}`),
    },
    rows: {
      added: after.rows.filter((r) => !oldRows.has(r.id)).map(title),
      removed: before.rows.filter((r) => !newRows.has(r.id)).map(title),
      changed: [],
    },
  };
  for (const row of after.rows) {
    const old = oldRows.get(row.id);
    if (!old) continue;
    const fields = after.database.fields
      .filter(
        (f) =>
          JSON.stringify(old.cells[f.id] ?? null) !==
          JSON.stringify(row.cells[f.id] ?? null),
      )
      .map((f) => f.name);
    if (fields.length) changes.rows.changed.push({ title: title(row), fields });
  }
  return changes;
}

// Changes from a saved version to the current state of the page.
export function snapshotChanges(
  user: Identity,
  pageId: string,
  snapshotId: string,
):
  | { kind: "document"; changes: TextChange[] | null }
  | { kind: "database"; changes: DatabaseChanges } {
  const page = requirePage(user, pageId);
  const snapshot = one<{ html: string | null }>(
    "SELECT html FROM snapshots WHERE id=? AND page_id=?",
    snapshotId,
    page.id,
  );
  if (!snapshot) throw new HttpError(404, "Version nicht gefunden.");
  if (page.kind === "database") {
    const before = JSON.parse(snapshot.html || "{}") as DatabaseState;
    const stored = one<{ fields: string }>(
      "SELECT fields FROM databases WHERE page_id=?",
      page.id,
    )!;
    const after: DatabaseState = {
      database: { fields: JSON.parse(stored.fields) },
      rows: all<{ id: string; cells: string }>(
        "SELECT id,cells FROM rows WHERE page_id=? ORDER BY position",
        page.id,
      ).map((r) => ({ id: r.id, cells: JSON.parse(r.cells) })),
    };
    return {
      kind: "database",
      changes: databaseChanges(
        {
          database: before.database || { fields: [] },
          rows: before.rows || [],
        },
        after,
      ),
    };
  }
  const current =
    one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", page.id)
      ?.html || "";
  return {
    kind: "document",
    changes: compareParagraphs(
      htmlParagraphs(snapshot.html || ""),
      htmlParagraphs(current),
    ),
  };
}

// Retention: manual versions stay. Automatic versions are thinned to one per
// page and day after a week and removed after the retention period
// (FLOWPLAN_SNAPSHOT_RETENTION_DAYS, default 180, 0 keeps everything).
export function retentionDays() {
  const raw = process.env.FLOWPLAN_SNAPSHOT_RETENTION_DAYS;
  const value = raw === undefined || raw === "" ? 180 : Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 180;
}
export function pruneSnapshots(days = retentionDays()) {
  let removed = 0;
  transaction(() => {
    for (const [table, owner] of [
      ["snapshots", "page_id"],
      ["row_snapshots", "row_id"],
    ] as const) {
      removed += Number(
        run(
          `DELETE FROM ${table} WHERE kind='auto' AND created_at<datetime('now','-7 days') AND rowid NOT IN (
             SELECT max(rowid) FROM ${table} WHERE kind='auto' AND created_at<datetime('now','-7 days')
             GROUP BY ${owner}, date(created_at))`,
        ).changes,
      );
      if (days > 0)
        removed += Number(
          run(
            `DELETE FROM ${table} WHERE kind='auto' AND created_at<datetime('now',?)`,
            `-${days} days`,
          ).changes,
        );
    }
  });
  return removed;
}
const runtime = globalThis as typeof globalThis & {
  flowplanRetentionTimer?: ReturnType<typeof setInterval>;
};
export function startRetentionWorker() {
  if (runtime.flowplanRetentionTimer) return;
  const tick = () => {
    try {
      pruneSnapshots();
    } catch (error) {
      console.error("Snapshot retention failed", error);
    }
  };
  runtime.flowplanRetentionTimer = setInterval(tick, 6 * 3600 * 1000);
  runtime.flowplanRetentionTimer.unref();
  tick();
}
