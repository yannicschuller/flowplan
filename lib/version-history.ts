import { rowRoleResolver } from "./row-access";
import { hiddenFieldsFor, stripCells } from "./field-access";
import { all, one, run, transaction, nowText, daysAgoText } from "./db";
import { instanceSettings } from "./instance-settings";
import { HttpError } from "./auth";
import { requirePage } from "./permissions";
import { requireUnlocked } from "./journal-extras";
import { ensureRowDocument, requireRow } from "./row-documents";
import { expireTrash } from "./trash";
import { pruneNotifications } from "./notification-retention";
import {
  compareDocuments,
  htmlBlocks,
  type BlockChange,
  type DiffLimit,
} from "./text-diff";
import { cellText } from "./cell-text";
import type { Field, Identity } from "./types";
import { isLeader } from "./cluster/leader";
import { workersPaused } from "./instance-read-only";

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
export async function snapshotChanges(
  user: Identity,
  pageId: string,
  snapshotId: string,
  against?: string,
): Promise<DocumentChanges | { kind: "database"; changes: DatabaseChanges }> {
  const page = await requirePage(user, pageId);
  await requireUnlocked(user, page);
  const load = async (sid: string) => {
    const found = await one<{ html: string | null }>(
      "SELECT html FROM snapshots WHERE id=? AND page_id=?",
      sid,
      page.id,
    );
    if (!found) throw new HttpError(404, "Version nicht gefunden.");
    return found.html || "";
  };
  const before = await load(snapshotId);
  if (page.kind === "database") {
    // Records hidden by their permissions stay out of the comparison.
    const visible = await rowRoleResolver(user, page);
    // Properties hidden from this person (now or in that version) as well.
    const hiddenNow = await hiddenFieldsFor(user, page);
    const withoutHidden = async (state: DatabaseState): Promise<DatabaseState> => {
      const hidden = new Set([...hiddenNow, ...await hiddenFieldsFor(user, page, state.database.fields)]);
      return hidden.size
        ? {
            database: { ...state.database, fields: state.database.fields.filter((f) => !hidden.has(f.id)) },
            rows: state.rows.map((r) => ({ ...r, cells: stripCells(r.cells, hidden) })),
          }
        : state;
    };
    const parse = async (html: string): Promise<DatabaseState> => {
      const parsed = JSON.parse(html || "{}") as Partial<DatabaseState>;
      return await withoutHidden({
        database: parsed.database || { fields: [] },
        rows: (parsed.rows || []).filter((r) => visible(r)),
      });
    };
    const current = async (): Promise<DatabaseState> => ({
      database: {
        fields: JSON.parse(
          (await one<{ fields: string }>(
            "SELECT fields FROM databases WHERE page_id=?",
            page.id,
          ))!.fields,
        ),
      },
      rows: (await all<{
        id: string;
        cells: string;
        access: string;
        created_by: string;
      }>(
        "SELECT id,cells,access,created_by FROM rows WHERE page_id=? ORDER BY position",
        page.id,
      ))
        .filter((r) => visible(r))
        .map((r) => ({ id: r.id, cells: JSON.parse(r.cells) })),
    });
    return {
      kind: "database",
      changes: databaseChanges(
        await parse(before),
        against ? (await parse(await load(against))) : (await withoutHidden(await current())),
      ),
    };
  }
  const after = against
    ? (await load(against))
    : (await one<{ html: string }>(
        "SELECT html FROM documents WHERE page_id=?",
        page.id,
      ))?.html || "";
  return documentChanges(before, after);
}
// Same comparison for record documents.
export async function rowSnapshotChanges(
  user: Identity,
  pageId: string,
  rowId: string,
  snapshotId: string,
  against?: string,
): Promise<DocumentChanges> {
  const { row } = await requireRow(user, pageId, rowId);
  const load = async (sid: string) => {
    const found = await one<{ html: string }>(
      "SELECT html FROM row_snapshots WHERE id=? AND row_id=?",
      sid,
      row.id,
    );
    if (!found) throw new HttpError(404, "Version nicht gefunden.");
    return found.html;
  };
  const after = against ? (await load(against)) : (await ensureRowDocument(row)).html;
  return documentChanges(await load(snapshotId), after);
}

// Retention: manual versions stay. Automatic versions are thinned to one per
// page and day after a week and removed after the retention period
// (FLOWPLAN_SNAPSHOT_RETENTION_DAYS, default 180, 0 keeps everything).
export async function retentionDays() {
  const stored = (await instanceSettings()).retentionDays;
  if (stored !== null) return stored;
  const raw = process.env.FLOWPLAN_SNAPSHOT_RETENTION_DAYS;
  const value = raw === undefined || raw === "" ? 180 : Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 180;
}
export async function pruneSnapshots(days?: number) {
  if (days === undefined) days = await retentionDays();
  let removed = 0;
  await transaction(async () => {
    for (const [table, owner] of [
      ["snapshots", "page_id"],
      ["row_snapshots", "row_id"],
    ] as const) {
      removed += Number(
        (await run(
          `DELETE FROM ${table} WHERE kind='auto' AND created_at<? AND seq NOT IN (
             SELECT max(seq) FROM ${table} WHERE kind='auto' AND created_at<?
             GROUP BY ${owner}, substr(created_at,1,10))`, nowText(Date.now() - 604_800_000), nowText(Date.now() - 604_800_000),
        )).changes,
      );
      if (days > 0)
        removed += Number(
          (await run(
            `DELETE FROM ${table} WHERE kind='auto' AND created_at<?`,
            daysAgoText(days),
          )).changes,
        );
    }
  });
  return removed;
}
const runtime = globalThis as typeof globalThis & {
  flowplanRetentionTimer?: ReturnType<typeof setInterval>;
};
export async function startRetentionWorker() {
  if (runtime.flowplanRetentionTimer) return;
  const tick = async () => {
    // Cluster mode: the leader only (lib/cluster/leader.ts).
    if (!isLeader() || (await workersPaused())) return;
    try {
      await pruneSnapshots();
      // Pages, spaces, records and templates after the trash period (#123).
      await expireTrash();
      // Old notifications (lib/notification-retention.ts).
      await pruneNotifications();
    } catch (error) {
      console.error("Snapshot retention failed", error);
    }
  };
  runtime.flowplanRetentionTimer = setInterval(tick, 6 * 3600 * 1000);
  runtime.flowplanRetentionTimer.unref();
  await tick();
}
