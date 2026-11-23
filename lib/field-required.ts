// "Pflichtfeld" / "Required" per database property (#443): a switch in a
// property's settings, next to its default value (lib/field-defaults.ts).
//
// Which properties can be required: those a person fills in and for which
// "empty" means something – text, number, date, select (status properties
// are selects), multi-select, url, e-mail, phone, person, relation and
// files. Not: checkbox (unchecked is a value), computed ones (formula,
// rollup, created/edited time and by, ID, progress, time tracking), AI
// properties (the AI fills them), sprints (empty is the backlog),
// checklists, aliases and the parent relation of subtasks (top-level
// records have none).
//
// The rules, the same on the server and in the browser:
// - A new record (every path that gives defaults, lib/field-defaults.ts
//   withDefaults: views, API, SDKs, MCP, forms, record templates,
//   automations and workflows, quick capture, e-mail inboxes, share links,
//   the database's own imports, the offline queue) gets, for each required
//   property without a value of its own: its default value; without one, a
//   select its first option. Other required properties without a default
//   stay empty – the record is created and the property shows as missing.
//   Unlike plain defaults, an empty column of an import counts as no value
//   for a required property.
// - Clearing a required property's value is refused (400) – by hand, by
//   the API, by moving a card to the board's empty column, by bulk
//   changes, share links and automations. A value that was already empty
//   may stay empty (old records are never changed by the switch).
// - Forms ask a required property as a required question.
// - Grouped by a required property, the empty group ("Ohne Gruppe") is left
//   out while no record is empty; otherwise it is shown as "Wert fehlt".
//
// Client-safe: no database access here.
import { isEmptyValue } from "./empty-value";
import type { Field } from "./types";

export const REQUIRABLE_TYPES: ReadonlySet<Field["type"]> = new Set([
  "text",
  "number",
  "date",
  "select",
  "multiselect",
  "url",
  "email",
  "phone",
  "person",
  "relation",
  "files",
]);

export function canBeRequired(field: Pick<Field, "type" | "ai" | "parent">) {
  return REQUIRABLE_TYPES.has(field.type) && !field.ai && !field.parent;
}
// Only a switch that fits the property counts (a stored flag of a property
// that became a formula, say, is dropped when the schema is saved).
export const isRequired = (field: (Pick<Field, "type" | "ai" | "parent"> & { required?: boolean }) | undefined | null) =>
  !!field?.required && canBeRequired(field);

// A required property without a value in these cells.
export const isMissing = (field: Field, cells: Record<string, unknown>) => isRequired(field) && isEmptyValue(cells[field.id], field.type);
export const missingRequired = (fields: Field[], cells: Record<string, unknown>) => fields.filter((f) => isMissing(f, cells));
// How many of these records miss a value for the property.
export const missingCount = (field: Field, rows: { cells: Record<string, unknown> }[]) =>
  canBeRequired(field) ? rows.filter((r) => isEmptyValue(r.cells[field.id], field.type)).length : 0;

// What a new record gets for a required property without a value of its
// own and without a default: a select's first option, nothing otherwise.
export function requiredFallback(field: Field): unknown {
  if (!isRequired(field)) return undefined;
  if (field.type === "select") return (field.options || []).find((o) => o.trim()) ?? undefined;
  return undefined;
}

// The first required property this change would clear (`before`: the
// record's stored cells); undefined when the change keeps them all.
export function clearedRequired(fields: Field[], patch: Record<string, unknown>, before: Record<string, unknown>) {
  return fields.find(
    (f) => isRequired(f) && f.id in patch && isEmptyValue(patch[f.id], f.type) && !isEmptyValue(before[f.id], f.type),
  );
}
// The server's message (German; lib/i18n-errors.ts has the English).
export const requiredMessage = (field: Pick<Field, "name">) => `„${field.name}“ ist ein Pflichtfeld und kann nicht leer sein.`;

// Stored properties: the flag only where it fits, and only `true`.
export function cleanRequired<T extends Field & { required?: unknown }>(fields: T[]): T[] {
  for (const f of fields)
    if (f.required !== undefined && !(f.required === true && canBeRequired(f))) delete f.required;
  return fields;
}
