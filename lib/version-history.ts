import { rowRoleResolver } from "./row-access";
import { all, one, run, transaction } from "./db";
import { instanceSettings } from "./instance-settings";
import { HttpError } from "./auth";
import { requirePage } from "./permissions";
import { requireUnlocked } from "./journal-extras";
import { ensureRowDocument, requireRow } from "./row-documents";
import { expireRowTrash } from "./row-trash";
import {
  compareDocuments,
  htmlBlocks,
  type BlockChange,
  type DiffLimit,
} from "./text-diff";
import { cellText } from "./cell-text";
import type { Field, Identity } from "./types";

// Text blocks of stored document HTML, one entry per paragraph-like element.
export const htmlParagraphs = (html: string) =>
  htmlBlocks(html).map((block) => block.text);

// The comparison of two document versions, block by block with word-level
// changes and the number of words that came and went. `changes` is null
// when the documents are too large (`limit` "size") or differ in too many
// places ("edits") to compare.
export type DocumentChanges = {
  kind: "document";
  changes: BlockChange[] | null;
  words: { added: number; removed: number } | null;
  limit?: DiffLimit;
};
function documentChanges(before: string, after: string): DocumentChanges {
  const result = compareDocuments(before, after);
  return typeof result === "string"
    ? { kind: "document", changes: null, words: null, limit: result }
    : { kind: "document", changes: result.changes, words: result.words };
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

// Changes from a saved version to the current state of the page, or to
// another saved version (`against`).
export function snapshotChanges(
  user: Identity,
  pageId: string,
  snapshotId: string,
  against?: string,
): DocumentChanges | { kind: "database"; changes: DatabaseChanges } {
  const page = requirePage(user, pageId);
  requireUnlocked(user, page);
  const load = (sid: string) => {
    const found = one<{ html: string | null }>(
      "SELECT html FROM snapshots WHERE id=? AND page_id=?",
      sid,
      page.id,
    );
    if (!found) throw new HttpError(404, "Version nicht gefunden.");
    return found.html || "";
  };
  const before = load(snapshotId);
  if (page.kind === "database") {
    // Records hidden by their permissions stay out of the comparison.
    const visible = rowRoleResolver(user, page);
    const parse = (html: string): DatabaseState => {
      const parsed = JSON.parse(html || "{}") as Partial<DatabaseState>;
      return {
        database: parsed.database || { fields: [] },
        rows: (parsed.rows || []).filter((r) => visible(r)),
      };
    };
    const current = (): DatabaseState => ({
      database: {
        fields: JSON.parse(
          one<{ fields: string }>(
            "SELECT fields FROM databases WHERE page_id=?",
            page.id,
          )!.fields,
        ),
      },
      rows: all<{
        id: string;
        cells: string;
        access: string;
        created_by: string;
      }>(
        "SELECT id,cells,access,created_by FROM rows WHERE page_id=? ORDER BY position",
        page.id,
      )
        .filter((r) => visible(r))
        .map((r) => ({ id: r.id, cells: JSON.parse(r.cells) })),
    });
    return {
      kind: "database",
      changes: databaseChanges(
        parse(before),
        against ? parse(load(against)) : current(),
      ),
    };
  }
  const after = against
    ? load(against)
    : one<{ html: string }>(
        "SELECT html FROM documents WHERE page_id=?",
        page.id,
      )?.html || "";
  return documentChanges(before, after);
}
// Same comparison for record documents.
export function rowSnapshotChanges(
  user: Identity,
  pageId: string,
  rowId: string,
  snapshotId: string,
  against?: string,
): DocumentChanges {
  const { row } = requireRow(user, pageId, rowId);
  const load = (sid: string) => {
    const found = one<{ html: string }>(
      "SELECT html FROM row_snapshots WHERE id=? AND row_id=?",
      sid,
      row.id,
    );
    if (!found) throw new HttpError(404, "Version nicht gefunden.");
    return found.html;
  };
  const after = against ? load(against) : ensureRowDocument(row).html;
  return documentChanges(load(snapshotId), after);
}

// Retention: manual versions stay. Automatic versions are thinned to one per
// page and day after a week and removed after the retention period
// (FLOWPLAN_SNAPSHOT_RETENTION_DAYS, default 180, 0 keeps everything).
export function retentionDays() {
  const stored = instanceSettings().retentionDays;
  if (stored !== null) return stored;
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
      expireRowTrash();
    } catch (error) {
      console.error("Snapshot retention failed", error);
    }
  };
  runtime.flowplanRetentionTimer = setInterval(tick, 6 * 3600 * 1000);
  runtime.flowplanRetentionTimer.unref();
  tick();
}
