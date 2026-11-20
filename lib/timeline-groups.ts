// Groups of a database timeline (#394, the view's groupBy): a lighter
// alternative to a hierarchy. Each record sits in one group – a record with
// several values (multi-select) in the group of its first one, so it shows
// once. Groups keep the order tables and boards give them (the options'
// order, checked after unchecked, "No group" last); empty ones are left
// out by the outline (lib/timeline-tree.ts).
import { canGroupField, databaseGroups, groupKey } from "./database-groups";
import { AUTO_COLORS, optionColor, type OptionColor } from "./option-colors";
import type { Field, Row } from "./types";

// Properties a timeline groups by: their values read without the related
// records or members (relations and people group in tables and boards).
export const TIMELINE_GROUP_TYPES = new Set(["select", "multiselect", "checkbox", "text", "number", "url", "email", "phone"]);
export const timelineGroupField = (fields: Field[], id: string | undefined) =>
  id ? fields.find((f) => f.id === id && canGroupField(f) && TIMELINE_GROUP_TYPES.has(f.type)) : undefined;

// "Farbe nach" (#394): the colour of a record's (first) option – its own,
// or for options without one the colour the option's place gives it, so a
// property without colours still tells its values apart. Grey for values
// that are no option; nothing without a value.
export const timelineColorField = (fields: Field[], id: string | undefined) =>
  id ? fields.find((f) => f.id === id && (f.type === "select" || f.type === "multiselect")) : undefined;
export function barColor(field: Field | undefined, row: Pick<Row, "cells">): OptionColor | undefined {
  if (!field) return undefined;
  const raw = row.cells[field.id];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || !value) return undefined;
  const at = (field.options || []).indexOf(value);
  return optionColor(field, value) ?? (at < 0 ? "gray" : AUTO_COLORS[at % AUTO_COLORS.length]);
}

export function timelineGroups(rows: Row[], field: Field, t?: (de: string, en: string) => string) {
  const groups = databaseGroups(rows, field, {}, [], t).map((g) => ({ key: g.key, label: g.label }));
  const keyOf = new Map<string, string>();
  for (const row of rows) {
    const raw = row.cells[field.id];
    const value = field.type === "checkbox" ? !!raw : Array.isArray(raw) ? (raw.length ? raw[0] : null) : raw;
    keyOf.set(row.id, groupKey(value));
  }
  return { groups, keyOf };
}
