// Default values per database property (#411): "Standardwert" in a
// property's settings. A new record gets the default of every property it
// has no value for; existing records never change.
//
// - Fixed values for text, number, select (status properties are selects),
//   multi-select, checkbox and date properties.
// - Dynamic values: "Heute"/"Jetzt" for dates (today, or now when the date
//   property has a time), "Ersteller" for person properties (the person who
//   creates the record; nobody for an anonymous form answer).
// - When a value counts as "not given" (DefaultMode):
//   "empty"   – missing or empty: records made in a view, by a form (also
//               hidden or unanswered questions), by automations and
//               workflows, MCP, the API and SDKs, quick capture, e-mail
//               inboxes, the clipper, share links and pages turned into
//               records.
//   "missing" – only properties the source does not carry: the database's
//               own imports (CSV, Markdown, vCard). A column of the file
//               that is empty in a record stays empty – the file says so.
//   Copies, restores, duplicates, repeating records, templates of the
//   instance, imports of whole workspaces or other tools (which make their
//   own databases), browser bookmarks and the syncs with outside sources
//   (calendars, CalDAV, issue trackers, LDAP contacts) keep what they
//   bring: those records are not new to their data.
// - Records made offline (#370) show their defaults on the device at once
//   (lib/offline-queue.ts applyQueue) and get them from the server when
//   they are sent, "Heute"/"Jetzt" as of the moment they were made.
// - Required properties (#443, lib/field-required.ts) go through the same
//   paths: withDefaults also gives them their value.
//
// Client-safe: no database access here.
import { z } from "zod";
import { Temporal } from "@js-temporal/polyfill";
import { isEmptyValue } from "./empty-value";
import { validDateValue, validZone } from "./date-values";
import { isRequired, requiredFallback } from "./field-required";
import type { Field } from "./types";

export const fieldDefaultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("value"),
    value: z.union([z.string().max(10000), z.number().finite(), z.boolean(), z.array(z.string().max(100)).max(100)]),
  }),
  // "Heute" (date without time) or "Jetzt" (date with time).
  z.object({ kind: z.literal("now") }),
  // The person who creates the record.
  z.object({ kind: z.literal("creator") }),
]);
export type FieldDefault = z.infer<typeof fieldDefaultSchema>;
export type DefaultMode = "empty" | "missing";

// The properties that can have a default, and which kinds each offers.
const FIXED = new Set(["text", "number", "select", "multiselect", "checkbox", "date"]);
export function defaultKinds(field: Pick<Field, "type" | "ai" | "tagOptions" | "parent">): FieldDefault["kind"][] {
  // Computed by AI or the workspace's tags as options: no fixed value.
  if (field.ai || field.tagOptions || field.parent) return [];
  if (field.type === "date") return ["value", "now"];
  if (field.type === "person") return ["creator"];
  return FIXED.has(field.type) ? ["value"] : [];
}

// The default as it may be stored for this property, or undefined when it
// does not fit (any more): another type, an option that is gone, a time on
// a date without time. The server stores what this returns.
export function cleanDefault(field: Field & { defaultValue?: unknown }): FieldDefault | undefined {
  const parsed = fieldDefaultSchema.safeParse(field.defaultValue);
  if (!parsed.success) return undefined;
  const d = parsed.data;
  if (!defaultKinds(field).includes(d.kind)) return undefined;
  if (d.kind !== "value") return d;
  const v = d.value;
  switch (field.type) {
    case "text":
      return typeof v === "string" && v.trim() ? { kind: "value", value: v } : undefined;
    case "number":
      return typeof v === "number" ? d : undefined;
    case "checkbox":
      // Unchecked is what an empty checkbox is already.
      return v === true ? d : undefined;
    case "select":
      return typeof v === "string" && (field.options || []).includes(v) ? d : undefined;
    case "multiselect": {
      if (!Array.isArray(v)) return undefined;
      const kept = [...new Set(v.filter((o) => (field.options || []).includes(o)))];
      return kept.length ? { kind: "value", value: kept } : undefined;
    }
    case "date":
      if (typeof v !== "string" || !validDateValue(v)) return undefined;
      return { kind: "value", value: field.noTime ? v.slice(0, 10) : v };
  }
  return undefined;
}
// Every property of a schema with its default cleaned (dropped where it no
// longer fits); renamed options take their default along.
export function cleanDefaults<T extends Field & { defaultValue?: unknown }>(fields: T[], renames: { field: string; from: string; to: string }[] = []): T[] {
  for (const f of fields) {
    if (f.defaultValue === undefined) continue;
    let value: unknown = f.defaultValue;
    const own = renames.filter((r) => r.field === f.id);
    if (own.length) value = renameDefault(value, own);
    const clean = cleanDefault({ ...f, defaultValue: value });
    if (clean) (f as { defaultValue?: unknown }).defaultValue = clean;
    else delete f.defaultValue;
  }
  return fields;
}
// An option renamed in the property's settings: its default follows.
export function renameDefault(value: unknown, renames: { from: string; to: string }[]) {
  const parsed = fieldDefaultSchema.safeParse(value);
  if (!parsed.success || parsed.data.kind !== "value") return value;
  const rename = (o: string) => renames.find((r) => r.from === o)?.to ?? o;
  const v = parsed.data.value;
  if (typeof v === "string") return { kind: "value", value: rename(v) };
  if (Array.isArray(v)) return { kind: "value", value: [...new Set(v.map(rename))] };
  return value;
}

// "Heute" in the zone, "Jetzt" as an instant to the minute.
function nowValue(field: Field, now: number, zone?: string) {
  const instant = Temporal.Instant.fromEpochMilliseconds(now);
  if (field.noTime) return instant.toZonedDateTimeISO(zone && validZone(zone) ? zone : "UTC").toPlainDate().toString();
  return `${new Date(now).toISOString().slice(0, 16)}Z`;
}
// The value a property's default gives a record made now (undefined: none).
export function defaultCell(field: Field & { defaultValue?: unknown }, context: { creator: string | null; now?: number; timeZone?: string }) {
  const d = cleanDefault(field);
  if (!d) return undefined;
  if (d.kind === "creator") return context.creator || undefined;
  if (d.kind === "now") return nowValue(field, context.now ?? Date.now(), context.timeZone);
  return Array.isArray(d.value) ? [...d.value] : d.value;
}
// The cells of a new record with the defaults of the properties it has no
// value for (see DefaultMode); the given cells are not changed.
// Required properties (#443, lib/field-required.ts): an empty value counts
// as none in every mode, and without a default a select gets its first
// option; other required properties without a default stay empty.
export function withDefaults(
  fields: (Field & { defaultValue?: unknown })[],
  cells: Record<string, unknown>,
  context: { creator: string | null; now?: number; timeZone?: string; mode?: DefaultMode },
): Record<string, unknown> {
  let out = cells;
  for (const f of fields) {
    const required = isRequired(f);
    if (f.defaultValue === undefined && !required) continue;
    const given = context.mode === "missing" && !required ? f.id in cells : !isEmptyValue(cells[f.id], f.type);
    if (given) continue;
    const value = defaultCell(f, context) ?? requiredFallback(f);
    if (value === undefined) continue;
    if (out === cells) out = { ...cells };
    out[f.id] = value;
  }
  return out;
}
// The moment a record was made, as a client reports it (a record made
// offline and sent later): within the last 30 days, else now.
export function creationTime(value: unknown, now = Date.now()) {
  return typeof value === "number" && Number.isFinite(value) && value <= now && value >= now - 30 * 86_400_000 ? value : now;
}
