import { cellText } from "./database";
import { orderedGroupRows } from "./row-order";
import type { Field, Row, View, User } from "./types";
export type DatabaseGroup = {
  key: string;
  label: string;
  value: unknown;
  rows: Row[];
};
export function databaseGroups(
  rows: Row[],
  field: Field | undefined,
  related: Record<string, Row[]>,
  members: Pick<User, "id" | "name">[] = [],
) {
  const groups = new Map<string, DatabaseGroup>();
  function add(value: unknown, row?: Row) {
    const empty = value === null || value === undefined || value === "";
    const key = groupKey(value);
    if (!groups.has(key)) {
      const label = empty
        ? "Ohne Gruppe"
        : field?.type === "relation"
          ? cellText(
              related[field.relationPage || ""]?.find((r) => r.id === value)
                ?.cells.title,
            ) || "Nicht verfügbar"
          : field && ["person", "created_by", "updated_by"].includes(field.type)
            ? members.find((m) => m.id === value)?.name || "Unbekannte Person"
            : field?.type === "checkbox"
              ? value
                ? "Abgehakt"
                : "Nicht abgehakt"
              : cellText(value);
      groups.set(key, { key, label, value: empty ? null : value, rows: [] });
    }
    if (row) groups.get(key)!.rows.push(row);
  }
  for (const option of field?.options || []) add(option);
  if (field?.type === "checkbox") {
    add(false);
    add(true);
  }
  for (const row of rows) {
    const raw = field ? row.cells[field.id] : null;
    const value = field?.type === "checkbox" ? !!raw : raw;
    if (Array.isArray(value)) {
      if (!value.length) add(null, row);
      else {
        const seen = new Set<string>();
        for (const item of value) {
          const key = groupKey(item);
          if (!seen.has(key)) add(item, row);
          seen.add(key);
        }
      }
    } else add(value, row);
  }
  if (field?.type !== "checkbox") add(null);
  return [...groups.values()];
}
export function groupCellValue(
  field: Field,
  value: unknown,
  current: unknown = [],
  sourceKey?: string,
) {
  if (["relation", "multiselect"].includes(field.type)) {
    if (value === null) return [];
    const selected = Array.isArray(current) ? current : [];
    return [
      ...new Set([...selected.filter((v) => groupKey(v) !== sourceKey), value]),
    ];
  }
  if (field.type === "checkbox") return !!value;
  if (field.type === "number") return value === null ? null : Number(value);
  return value === null ? "" : value;
}

export const canGroupField = (field: Field) =>
  !["files", "checklist"].includes(field.type);
export function groupingField(fields: Field[], view: View) {
  return (
    fields.find((f) => f.id === view.groupBy && canGroupField(f)) ||
    (view.type === "board"
      ? fields.find((f) => f.type === "select")
      : undefined)
  );
}
// Board columns keep their own card order unless a sort is active.
export function boardCardOrder<T extends { key: string; rows: Row[] }>(
  groups: T[],
  view: Pick<View, "type" | "sorts" | "groupRowOrder">,
) {
  if (view.type !== "board" || view.sorts.length || !view.groupRowOrder)
    return groups;
  return groups.map((g) =>
    view.groupRowOrder![g.key]
      ? { ...g, rows: orderedGroupRows(g.rows, view.groupRowOrder![g.key]) }
      : g,
  );
}
export function configuredGroups(groups: DatabaseGroup[], view: View) {
  const visible = groups.filter(
    (g) =>
      !(
        view.groupSettings?.hideEmpty ??
        (view.type === "table" || view.type === "list")
      ) || g.rows.length,
  );
  const withCards = boardCardOrder(visible, view);
  if (!view.groupSettings || view.groupSettings.sort === "manual")
    return orderedGroups(withCards, view.groupSettings?.order);
  const direction = view.groupSettings.sort === "asc" ? 1 : -1;
  return withCards.sort(
    (a, b) =>
      a.label.localeCompare(b.label, "de", { numeric: true }) * direction ||
      a.key.localeCompare(b.key),
  );
}
// Listed groups take the saved order; unlisted groups (new options, new values)
// keep their natural slot so a saved order never hides or jumbles them.
export function orderedGroups<T extends { key: string }>(
  groups: T[],
  order: string[] = [],
) {
  if (!order.length) return groups;
  const rank = new Map(order.map((key, i) => [key, i]));
  const listed = groups
    .filter((g) => rank.has(g.key))
    .sort((a, b) => rank.get(a.key)! - rank.get(b.key)!);
  let next = 0;
  return groups.map((g) => (rank.has(g.key) ? listed[next++] : g));
}
// Moves a group one step within the displayed groups and returns the full
// saved order, retaining entries of currently hidden or filtered groups.
export function moveGroupOrder(
  displayed: string[],
  saved: string[] = [],
  key: string,
  target: number,
) {
  const from = displayed.indexOf(key);
  if (from < 0 || target < 0 || target >= displayed.length || from === target)
    return null;
  const moved = displayed.filter((k) => k !== key);
  moved.splice(target, 0, key);
  const shownKeys = new Set(displayed);
  return [...moved, ...saved.filter((k) => !shownKeys.has(k))].slice(0, 1000);
}
export function groupKey(value: unknown): string {
  if (value == null || value === "") return "empty";
  return boundedKey(JSON.stringify(value));
}
function boundedKey(raw: string) {
  if (raw.length <= 1800) return raw;
  // Bounded identifiers also allow grouping long text cells and saving collapsed state.
  let a = 2166136261,
    b = 0x9e3779b9;
  for (let i = 0; i < raw.length; i++) {
    a = Math.imul(a ^ raw.charCodeAt(i), 16777619);
    b = Math.imul(b ^ raw.charCodeAt(i), 2246822519);
  }
  return `long:${raw.length}:${(a >>> 0).toString(16)}:${(b >>> 0).toString(16)}`;
}

// Second grouping level: nested groups in tables/lists, swimlanes on boards.
export function subgroupingField(
  fields: Field[],
  view: View,
  primary: Field | undefined,
) {
  if (!primary || !["table", "list", "board"].includes(view.type))
    return undefined;
  return fields.find(
    (f) => f.id === view.subGroupBy && f.id !== primary.id && canGroupField(f),
  );
}
export function databaseSubgroups(
  group: DatabaseGroup,
  field: Field,
  related: Record<string, Row[]>,
  members: Pick<User, "id" | "name">[] = [],
) {
  return databaseGroups(group.rows, field, related, members).filter(
    (g) => g.rows.length,
  );
}
// Client-side address of a subgroup. Group keys are JSON or plain ASCII
// identifiers, so they never contain the raw separator.
const SEPARATOR = "\u001f";
export const nestedKey = (group: string, subgroup: string) =>
  `${group}${SEPARATOR}${subgroup}`;
export function splitNestedKey(key: string) {
  const [group, subgroup] = key.split(SEPARATOR);
  return { group, subgroup: subgroup as string | undefined };
}
// Persisted collapsed state of a subgroup; bounded like group keys.
export const subgroupCollapseKey = (group: string, subgroup: string) =>
  boundedKey(JSON.stringify(["sub", group, subgroup]));
