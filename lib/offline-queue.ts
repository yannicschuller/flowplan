// Record changes made without a connection. They are kept per person on the
// device, shown in the views right away and sent in order once the
// connection is back. A change to a record that was changed elsewhere in
// the meantime is merged field by field; fields changed on both sides and
// records deleted elsewhere become conflicts the person resolves.
import type { Row } from "./types";

export type QueuedChange =
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
]);
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// The rows of a database as they look with the waiting changes applied.
export function applyQueue(
  rows: Row[],
  queue: QueuedChange[],
  pageId: string,
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
          cells: change.cells,
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
export function queueKey(userId: string) {
  return `flowplan-offline-queue:${userId}`;
}
