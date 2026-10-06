// Subtasks: a relation to the own database marked as "parent" makes every
// record able to sit below another one (epic → story → task). A progress
// property shows the share of done subtasks, rolled up through all levels.
// Client-safe.
import type { Field, Row } from "./types";

const parentIds = (value: unknown) => (Array.isArray(value) ? value : value ? [value] : []).filter((v): v is string => typeof v === "string");

export const parentField = (fields: Field[]) => fields.find((f) => f.type === "relation" && f.parent);

function done(field: Field, cells: Record<string, unknown>) {
  if (!field.doneField) return false;
  const value = cells[field.doneField];
  if (typeof value === "boolean") return value;
  return typeof value === "string" && (field.doneValues || []).includes(value);
}

// Share of done work below `row` (0–1), or null without subtasks. Each
// child counts equally; a child with its own subtasks counts by their share.
export function subtaskProgress(row: Pick<Row, "id">, field: Field, rows: Row[]): number | null {
  if (!field.parentField) return null;
  const children = new Map<string, Row[]>();
  for (const r of rows)
    for (const p of parentIds(r.cells[field.parentField])) children.set(p, [...(children.get(p) || []), r]);
  const seen = new Set<string>();
  const measure = (id: string, depth: number): number | null => {
    const list = children.get(id);
    if (!list?.length || depth > 20 || seen.has(id)) return null;
    seen.add(id);
    const parts = list.map((c) => measure(c.id, depth + 1) ?? (done(field, c.cells) ? 1 : 0));
    seen.delete(id);
    return parts.reduce((a, b) => a + b, 0) / parts.length;
  };
  return measure(row.id, 0);
}

// Records in tree order: parents before their children, with the depth.
export function treeOrder(rows: Row[], parent: Field, collapsed: Set<string> = new Set()) {
  const ids = new Set(rows.map((r) => r.id));
  const children = new Map<string, Row[]>();
  const parentOf = new Map<string, string>();
  const roots: Row[] = [];
  for (const r of rows) {
    const p = parentIds(r.cells[parent.id]).find((x) => ids.has(x) && x !== r.id);
    if (p) {
      children.set(p, [...(children.get(p) || []), r]);
      parentOf.set(r.id, p);
    } else roots.push(r);
  }
  const out: { row: Row; depth: number; children: number }[] = [];
  const seen = new Set<string>();
  const walk = (r: Row, depth: number) => {
    if (seen.has(r.id)) return;
    seen.add(r.id);
    const kids = children.get(r.id) || [];
    out.push({ row: r, depth, children: kids.length });
    if (!collapsed.has(r.id)) kids.forEach((k) => walk(k, depth + 1));
  };
  roots.forEach((r) => walk(r, 0));
  // Below a collapsed record?
  const hidden = (id: string) => {
    for (let p = parentOf.get(id), i = 0; p && i < 200; p = parentOf.get(p), i++) if (collapsed.has(p)) return true;
    return false;
  };
  // Records caught in a loop still show up.
  rows.forEach((r) => !seen.has(r.id) && !hidden(r.id) && walk(r, 0));
  return out;
}

// Would setting `parentId` as the parent of `rowId` create a loop?
export function createsCycle(rowId: string, parentId: string, parentOf: (id: string) => string | null) {
  let current: string | null = parentId;
  for (let i = 0; current && i < 200; i++) {
    if (current === rowId) return true;
    current = parentOf(current);
  }
  return false;
}
