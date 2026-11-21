// Record changes made without a connection. They are kept per person on the
// device, shown in the views right away and sent in order once the
// connection is back. A change to a record that was changed elsewhere in
// the meantime is merged field by field; fields changed on both sides and
// records deleted elsewhere become conflicts the person resolves.
import type { Field, Row } from "./types";
import { withDefaults } from "./field-defaults";
import { browserZone } from "./date-values";

// `key`: the Idempotency-Key the change is sent with, also on every later
// attempt (lib/idempotency-key.ts) – the one of the online attempt that
// failed without an answer, so a change that did arrive is not applied twice.
export type QueuedChange = { key?: string } & (
  | {
      id: string;
      kind: "update";
      pageId: string;
      rowId: string;
      version: number;
      cells: Record<string, unknown>;
      // Values before the change, to tell own from foreign changes.
      base: Record<string, unknown>;
      at: number;
    }
  | {
      id: string;
      kind: "create";
      pageId: string;
      rowId: string;
      cells: Record<string, unknown>;
      at: number;
    }
  | {
      id: string;
      kind: "delete";
      pageId: string;
      rowId: string;
      at: number;
    }
  // Quick capture: title and text go into a new record once online.
  | {
      id: string;
      kind: "capture";
      pageId: string;
      rowId: string;
      title: string;
      text: string;
      at: number;
    }
  // A page made offline (#370, lib/offline-create.ts): created with this
  // id once online, then its content (the editor's, the board's or the
  // notebook's, kept on the device) is sent.
  | OfflinePageChange
  // A picture or file added offline: the blob waits in IndexedDB
  // (components/offline-uploads.ts) and is uploaded with this id.
  | OfflineUploadChange
);
export type OfflinePageKind = "document" | "database" | "whiteboard" | "notebook";
export type OfflinePageChange = {
  id: string;
  kind: "page";
  pageId: string;
  workspaceId: string;
  spaceId: string;
  parentId: string | null;
  pageKind: OfflinePageKind;
  title: string;
  icon: string;
  fullWidth?: boolean;
  // Databases: what they start as (lib/database-setup.ts) or a built-in
  // template with the ids of its example records.
  databaseKind?: string;
  starterTemplate?: string;
  rowIds?: string[];
  // Notebooks: the first sheet, drawn on offline.
  sheetId?: string;
  // The page exists on the server; its uploads or content still wait.
  created?: boolean;
  at: number;
  key?: string;
};
export type OfflineUploadChange = {
  id: string;
  kind: "upload";
  pageId: string;
  fileId: string;
  name: string;
  type: string;
  size: number;
  at: number;
  key?: string;
};
export type Conflict = {
  change: Extract<QueuedChange, { kind: "update" }>;
  // Fields changed on both sides with the current values, or null when the
  // record was deleted elsewhere.
  current: Record<string, unknown> | null;
  fields: string[];
};
export const queueableActions = new Set([
  "row.update",
  "row.create",
  "row.delete",
  "capture.record",
]);
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// The rows of a database as they look with the waiting changes applied.
// With the database's properties, a record made offline shows the defaults
// it gets once sent (#411, lib/field-defaults.ts), as of when it was made.
export function applyQueue(
  rows: Row[],
  queue: QueuedChange[],
  pageId: string,
  defaults?: { fields: Field[]; creator: string },
): Row[] {
  let result = rows;
  for (const change of queue) {
    if (change.pageId !== pageId) continue;
    if (change.kind === "create") {
      if (result.some((r) => r.id === change.rowId)) continue;
      const now = new Date(change.at).toISOString();
      result = [
        ...result,
        {
          id: change.rowId,
          page_id: pageId,
          cells: defaults ? withDefaults(defaults.fields, change.cells, { creator: defaults.creator, now: change.at, timeZone: browserZone() }) : change.cells,
          position: Number.MAX_SAFE_INTEGER,
          created_at: now,
          updated_at: now,
          created_by: "",
          updated_by: "",
          version: 1,
          role: "editor",
        },
      ];
    } else if (change.kind === "delete")
      result = result.filter((r) => r.id !== change.rowId);
    else if (change.kind === "capture" || change.kind === "page" || change.kind === "upload") continue;
    else
      result = result.map((r) =>
        r.id === change.rowId
          ? { ...r, cells: { ...r.cells, ...change.cells } }
          : r,
      );
  }
  return result;
}
// Decides how a waiting change is sent against the record as it is now.
export function mergeChange(
  change: Extract<QueuedChange, { kind: "update" }>,
  current: Row | undefined,
):
  | { send: Record<string, unknown>; version: number }
  | { conflict: Conflict }
  | { skip: true } {
  if (!current)
    return {
      conflict: { change, current: null, fields: Object.keys(change.cells) },
    };
  const fields = Object.keys(change.cells);
  const foreign = fields.filter(
    (f) =>
      !same(current.cells[f], change.base[f]) &&
      !same(current.cells[f], change.cells[f]),
  );
  if (foreign.length)
    return {
      conflict: {
        change,
        current: Object.fromEntries(foreign.map((f) => [f, current.cells[f]])),
        fields: foreign,
      },
    };
  const send = Object.fromEntries(
    fields
      .filter((f) => !same(current.cells[f], change.cells[f]))
      .map((f) => [f, change.cells[f]]),
  );
  return Object.keys(send).length
    ? { send, version: current.version }
    : { skip: true };
}
// Answers after which a waiting change stays in the queue for the next
// flush instead of being discarded: the proxy while the app restarts (502,
// 503, 504 – what api() in components/ui.tsx calls transient and queues the
// change for), a timeout and a rate limit. 423 (the instance moves) is a
// final answer (lib/auth.ts checkOrigin).
const RETRY_STATUSES = new Set([408, 429, 502, 503, 504]);
export const retryLater = (status: number) => RETRY_STATUSES.has(status);
// The conflicts once one is resolved, from the list as it is now: a flush
// may have added others while resolving waited for the server.
export const withoutConflict = (list: Conflict[], resolved: Conflict) =>
  list.filter((c) => c.change.id !== resolved.change.id);
export function queueKey(userId: string) {
  return `flowplan-offline-queue:${userId}`;
}
