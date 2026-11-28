// "Relation = this record" (#649): a linked database view in a record's
// content (and in record templates) filters by a relation to the record it
// sits in. The filter stores a token in place of a record id, so a template
// keeps the reference dynamic and every record made from it shows its own
// records. The token is resolved when the view is shown, for the record
// whose content holds the view (lib/linked-databases.ts sends it along as
// `thisRecord`, after the record has been checked like any other read).
// Without a record – a linked view on a normal page, or a relation to
// another database – the token stays as it is and matches no record id.
import { effectiveFilterGroup, transformFilterGroup } from "./database-filters";
import type { Field, Filter, FilterGroup, FilterNode, View } from "./types";

export const THIS_RECORD = "@this-record";

// The record a linked view sits in: its database and its id.
export type ThisRecord = { database: string; row: string };

// Conditions that keep a record when its relation holds the value.
const POSITIVE = new Set<Filter["op"]>(["eq", "any_of", "all_of"]);
// Conditions that can take the token as their value.
export const THIS_RECORD_OPERATORS = new Set<Filter["op"]>([
  "eq",
  "neq",
  "any_of",
  "none_of",
  "all_of",
]);

// The property can be filtered by "this record": a relation to the
// database the record belongs to.
export function offersThisRecord(
  field: Pick<Field, "type" | "relationPage"> | undefined,
  context: ThisRecord | null | undefined,
) {
  return (
    !!context &&
    field?.type === "relation" &&
    !!field.relationPage &&
    field.relationPage === context.database
  );
}

export const usesToken = (f: Pick<Filter, "value" | "values">) =>
  f.value === THIS_RECORD || !!f.values?.includes(THIS_RECORD);

function conditions(node: FilterNode, out: Filter[] = []): Filter[] {
  if (node.kind === "condition") out.push(node);
  else for (const rule of node.rules) conditions(rule, out);
  return out;
}

// The filter group with the token replaced by the record's id, where the
// property is a relation to the record's database; everything else as it is.
export function resolveThisRecordGroup(
  group: FilterGroup,
  fields: Field[],
  context: ThisRecord | null | undefined,
): FilterGroup {
  if (!context) return group;
  const byId = new Map(fields.map((f) => [f.id, f]));
  return transformFilterGroup(group, (f) =>
    usesToken(f) && offersThisRecord(byId.get(f.field), context)
      ? {
          ...f,
          value: f.value === THIS_RECORD ? context.row : f.value,
          ...(f.values
            ? { values: f.values.map((v) => (v === THIS_RECORD ? context.row : v)) }
            : {}),
        }
      : f,
  );
}

// A view as it filters for the record it sits in (the stored view keeps the
// token: it is what is edited and saved).
export function resolveThisRecord<V extends Pick<View, "filters" | "filterGroup">>(
  view: V,
  fields: Field[],
  context: ThisRecord | null | undefined,
): V {
  if (!context || !hasThisRecord(view)) return view;
  return {
    ...view,
    filters: [],
    filterGroup: resolveThisRecordGroup(effectiveFilterGroup(view), fields, context),
  };
}

export function hasThisRecord(view: Pick<View, "filters" | "filterGroup">) {
  return conditions(effectiveFilterGroup(view)).some(usesToken);
}

// A view whose "this record" condition has no record to stand for: on a
// normal page, or on a relation to another database than the record's.
export function unresolvedThisRecord(
  view: Pick<View, "filters" | "filterGroup">,
  fields: Field[],
  context: ThisRecord | null | undefined,
) {
  const byId = new Map(fields.map((f) => [f.id, f]));
  return conditions(effectiveFilterGroup(view)).some(
    (f) => usesToken(f) && !offersThisRecord(byId.get(f.field), context),
  );
}

// The cells a new record made in the view gets, so that it shows there: the
// relation to this record for each condition that asks for it ("+ Neu",
// also when the property is hidden in the view). `cells`: what the record
// gets anyway; a relation it already has is kept and this record added.
export function thisRecordCells(
  view: Pick<View, "filters" | "filterGroup">,
  fields: Field[],
  context: ThisRecord | null | undefined,
  cells: Record<string, unknown> = {},
  readOnly: Iterable<string> = [],
): Record<string, unknown> {
  if (!context) return {};
  const locked = new Set(readOnly);
  const byId = new Map(fields.map((f) => [f.id, f]));
  const out: Record<string, unknown> = {};
  for (const f of conditions(effectiveFilterGroup(view))) {
    if (!POSITIVE.has(f.op) || !usesToken(f) || locked.has(f.field)) continue;
    if (!offersThisRecord(byId.get(f.field), context)) continue;
    const before = out[f.field] ?? cells[f.field];
    const list = Array.isArray(before)
      ? before.filter((v): v is string => typeof v === "string")
      : typeof before === "string" && before
        ? [before]
        : [];
    out[f.field] = list.includes(context.row) ? list : [...list, context.row];
  }
  return out;
}

// "Nur Einträge zeigen, die mit diesem Eintrag verknüpft sind" in the
// linked-database picker: the source's first view, filtered by its first
// relation to the record's database (`database`); null without one.
export function relatedRecordsView(
  view: View | undefined,
  fields: Field[],
  database: string,
): View | null {
  const relation = fields.find(
    (f) => f.type === "relation" && f.relationPage === database,
  );
  if (!view || !relation) return null;
  const condition: Filter = { field: relation.id, op: "eq", value: THIS_RECORD };
  return view.filterGroup
    ? {
        ...view,
        filters: [],
        filterGroup: {
          kind: "group",
          join: "and",
          rules: [view.filterGroup, { ...condition, kind: "condition" }],
        },
      }
    : { ...view, filters: [...view.filters, condition] };
}
