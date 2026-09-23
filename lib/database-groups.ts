import { cellText } from "./database";
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
export function configuredGroups(groups: DatabaseGroup[], view: View) {
  const visible = groups.filter(
    (g) =>
      !(
        view.groupSettings?.hideEmpty ??
        (view.type === "table" || view.type === "list")
      ) || g.rows.length,
  );
  if (!view.groupSettings || view.groupSettings.sort === "manual")
    return visible;
  const direction = view.groupSettings.sort === "asc" ? 1 : -1;
  return visible.sort(
    (a, b) =>
      a.label.localeCompare(b.label, "de", { numeric: true }) * direction ||
      a.key.localeCompare(b.key),
  );
}
export function groupKey(value: unknown): string {
  if (value == null || value === "") return "empty";
  const raw = JSON.stringify(value);
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
