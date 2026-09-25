import {
  isRelativeOperator,
  relativeDateNames,
  relativeDateWindow,
  relativeCellDay,
  validTimeZone,
} from "./relative-dates";
import { z } from "zod";
import { cellText } from "./cell-text";
import { isEmptyValue } from "./empty-value";
import type { Field, Filter, FilterGroup, FilterNode, View } from "./types";
export const filterOperators = [
  "contains",
  "not_contains",
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "starts_with",
  "ends_with",
  "before",
  "after",
  "on_or_before",
  "on_or_after",
  "empty",
  "notempty",
  "in_relative",
  "not_in_relative",
  "any_of",
  "none_of",
  "all_of",
  "between",
  "checked",
  "unchecked",
  "complete",
  "incomplete",
] as const;
export const multiValueOperators = new Set<string>([
  "any_of",
  "none_of",
  "all_of",
]);
// Operators without a value to enter.
export const valuelessOperators = new Set<string>([
  "empty",
  "notempty",
  "checked",
  "unchecked",
  "complete",
  "incomplete",
]);
export const MAX_FILTER_DEPTH = 4,
  MAX_FILTER_NODES = 100;
export const filterSchema = z
  .object({
    field: z.string().min(1).max(500),
    op: z.enum(filterOperators),
    value: z.string().max(500),
    timeZone: z
      .string()
      .min(1)
      .max(100)
      .refine(validTimeZone, "Ungültige Zeitzone.")
      .optional(),
    days: z.number().int().min(1).max(36600).optional(),
    values: z.array(z.string().max(500)).max(100).optional(),
    to: z.string().max(500).optional(),
  })
  .superRefine((f, ctx) => {
    if (multiValueOperators.has(f.op) && !f.values?.length)
      ctx.addIssue({
        code: "custom",
        message: "Mindestens einen Wert für den Filter wählen.",
      });
    if (f.op === "between" && (!f.value.trim() || !f.to?.trim()))
      ctx.addIssue({
        code: "custom",
        message: "„Liegt zwischen“ benötigt einen Anfangs- und Endwert.",
      });
    if (!isRelativeOperator(f.op)) return;
    if (
      !Object.hasOwn(relativeDateNames, f.value) ||
      !f.timeZone ||
      (["past_days", "next_days"].includes(f.value) && f.days === undefined)
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Relativer Datumsfilter benötigt einen gültigen Zeitraum, eine Zeitzone und gegebenenfalls die Anzahl Tage.",
      });
  });
const conditionSchema = filterSchema.safeExtend({
  kind: z.literal("condition"),
});
function groupSchema(depth: number): z.ZodType<FilterGroup> {
  return z.object({
    kind: z.literal("group"),
    join: z.enum(["and", "or"]),
    rules: z
      .array(
        depth > 1
          ? z.union([conditionSchema, groupSchema(depth - 1)])
          : conditionSchema,
      )
      .max(MAX_FILTER_NODES),
  });
}
export const filterGroupSchema = z.preprocess((input, ctx) => {
  const stack: { node: unknown; depth: number }[] = [{ node: input, depth: 1 }];
  let count = 0;
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    if (++count > MAX_FILTER_NODES || depth > MAX_FILTER_DEPTH + 1) {
      ctx.addIssue({
        code: "custom",
        message: "Filter ist zu groß oder zu tief verschachtelt.",
      });
      return z.NEVER;
    }
    if (
      node &&
      typeof node === "object" &&
      "kind" in node &&
      node.kind === "group" &&
      "rules" in node &&
      Array.isArray(node.rules)
    ) {
      if (
        depth > MAX_FILTER_DEPTH ||
        node.rules.length + stack.length + count > MAX_FILTER_NODES
      ) {
        ctx.addIssue({
          code: "custom",
          message: "Maximal 100 Filterelemente und vier Gruppenebenen.",
        });
        return z.NEVER;
      }
      for (const rule of node.rules)
        stack.push({ node: rule, depth: depth + 1 });
    }
  }
  return input;
}, groupSchema(MAX_FILTER_DEPTH));
export function effectiveFilterGroup(
  view: Pick<View, "filters" | "filterGroup">,
): FilterGroup {
  return (
    view.filterGroup || {
      kind: "group",
      join: "and",
      rules: view.filters.map((f) => ({ ...f, kind: "condition" })),
    }
  );
}
export function filterCount(node: FilterNode): number {
  return node.kind === "condition"
    ? 1
    : node.rules.reduce((n, r) => n + filterCount(r), 0);
}
export function filterNodeCount(node: FilterNode): number {
  return node.kind === "condition"
    ? 1
    : 1 + node.rules.reduce((n, r) => n + filterNodeCount(r), 0);
}
export function transformFilterGroup(
  group: FilterGroup,
  transform: (f: Filter) => Filter | null,
): FilterGroup {
  return {
    ...group,
    rules: group.rules.flatMap((rule): FilterNode[] => {
      if (rule.kind === "group") {
        const nested = transformFilterGroup(rule, transform);
        return nested.rules.length ? [nested] : [];
      }
      const condition = transform(rule);
      return condition ? [{ ...condition, kind: "condition" }] : [];
    }),
  };
}
function day(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:$|[T ])/.test(value))
    return NaN;
  const key = value.slice(0, 10),
    n = Date.parse(key);
  return Number.isFinite(n) && new Date(n).toISOString().slice(0, 10) === key
    ? n
    : NaN;
}
export function matches(
  cells: Record<string, unknown>,
  f: Filter,
  field?: Field,
  now: Date = new Date(),
) {
  const raw = cells[f.field],
    s = cellText(raw).toLowerCase(),
    v = f.value.toLowerCase();
  if (
    field &&
    ["formula", "rollup"].includes(field.type) &&
    /^#(ERROR|ACCESS|PROPERTY|CYCLE|LIMIT)/.test(s.toUpperCase())
  )
    return false;
  if (multiValueOperators.has(f.op)) {
    const items = (
      Array.isArray(raw) ? raw : isEmptyValue(raw) ? [] : [raw]
    ).map((item) => cellText(item).toLowerCase());
    const wanted = (f.values || []).map((x) => x.toLowerCase());
    if (f.op === "all_of")
      return !!wanted.length && wanted.every((x) => items.includes(x));
    const any = items.some((item) => wanted.includes(item));
    return f.op === "any_of" ? any : !any;
  }
  if (f.op === "checked" || f.op === "unchecked")
    return (raw === true) === (f.op === "checked");
  if (f.op === "complete" || f.op === "incomplete") {
    const items = Array.isArray(raw) ? raw : [];
    const complete =
      items.length > 0 &&
      items.every((item) => !!(item as { done?: boolean })?.done);
    return f.op === "complete" ? complete : !complete;
  }
  if (f.op === "between") {
    const dateField =
      !!field && ["date", "created_at", "updated_at"].includes(field.type);
    const [a, b, x] =
      dateField || (!field && Number.isFinite(day(f.value)))
        ? [day(f.value), day(f.to), day(raw)]
        : [Number(f.value), Number(f.to), s.trim() ? Number(s) : NaN];
    if (![a, b, x].every(Number.isFinite)) return false;
    return x >= Math.min(a, b) && x <= Math.max(a, b);
  }
  if (Array.isArray(raw) && ["eq", "neq"].includes(f.op)) {
    const present = raw.some((value) => cellText(value).toLowerCase() === v);
    return f.op === "eq" ? present : !present;
  }
  switch (f.op) {
    case "in_relative":
    case "not_in_relative": {
      if (
        field &&
        !["date", "created_at", "updated_at", "formula", "rollup"].includes(
          field.type,
        )
      )
        return false;
      if (!f.timeZone) return false;
      const window = relativeDateWindow(f.value, f.timeZone, f.days, now);
      const date = relativeCellDay(raw, f.timeZone);
      if (!window || !Number.isFinite(date)) return false;
      const inside = date >= window.start && date < window.end;
      return f.op === "in_relative" ? inside : !inside;
    }
    case "eq":
    case "neq": {
      if (
        field &&
        ["date", "created_at", "updated_at"].includes(field.type) &&
        v &&
        !Number.isFinite(day(v))
      )
        return false;
      const numeric = field?.type === "number" || typeof raw === "number";
      const equal =
        numeric && v.trim()
          ? !!s.trim() &&
            Number.isFinite(Number(s)) &&
            Number.isFinite(Number(v)) &&
            Number(s) === Number(v)
          : field &&
              ["date", "created_at", "updated_at"].includes(field.type) &&
              v
            ? Number.isFinite(day(raw)) && day(raw) === day(v)
            : s === v;
      return f.op === "eq" ? equal : !equal;
    }
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const a = Number(s),
        b = Number(v);
      if (!s.trim() || !v.trim() || !Number.isFinite(a) || !Number.isFinite(b))
        return false;
      return f.op === "gt"
        ? a > b
        : f.op === "gte"
          ? a >= b
          : f.op === "lt"
            ? a < b
            : a <= b;
    }
    case "before":
    case "after":
    case "on_or_before":
    case "on_or_after": {
      const a = day(raw),
        b = day(f.value);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
      return f.op === "before"
        ? a < b
        : f.op === "after"
          ? a > b
          : f.op === "on_or_before"
            ? a <= b
            : a >= b;
    }
    case "empty":
      return isEmptyValue(raw, field?.type);
    case "notempty":
      return !isEmptyValue(raw, field?.type);
    case "not_contains":
      return !s.includes(v);
    case "starts_with":
      return s.startsWith(v);
    case "ends_with":
      return s.endsWith(v);
    case "contains":
      return s.includes(v);
    default:
      return false;
  }
}
export function matchesFilterGroup(
  cells: Record<string, unknown>,
  group: FilterGroup,
  fields?: Field[],
  now: Date = new Date(),
): boolean {
  const rules = group.rules.filter((rule) => filterCount(rule) > 0);
  if (!rules.length) return true;
  const match = (rule: FilterNode) => {
    if (rule.kind === "group")
      return matchesFilterGroup(cells, rule, fields, now);
    const field = fields?.find((f) => f.id === rule.field);
    return (!fields || !!field) && matches(cells, rule, field, now);
  };
  return group.join === "and" ? rules.every(match) : rules.some(match);
}
export const operatorNames: Record<Filter["op"], string> = {
  in_relative: "liegt im relativen Zeitraum",
  not_in_relative: "liegt außerhalb des relativen Zeitraums",
  contains: "enthält",
  not_contains: "enthält nicht",
  eq: "ist",
  neq: "ist nicht",
  gt: "größer als",
  gte: "größer oder gleich",
  lt: "kleiner als",
  lte: "kleiner oder gleich",
  starts_with: "beginnt mit",
  ends_with: "endet mit",
  before: "vor",
  after: "nach",
  on_or_before: "am oder vor",
  on_or_after: "am oder nach",
  empty: "ist leer",
  notempty: "ist nicht leer",
  any_of: "ist eines von",
  none_of: "ist keines von",
  all_of: "enthält alle",
  between: "liegt zwischen",
  checked: "ist abgehakt",
  unchecked: "ist nicht abgehakt",
  complete: "ist vollständig",
  incomplete: "ist unvollständig",
};
export function operatorsFor(field?: Field): Filter["op"][] {
  const common: Filter["op"][] = ["eq", "neq", "empty", "notempty"];
  if (field && ["date", "created_at", "updated_at"].includes(field.type))
    return [
      "eq",
      "neq",
      "before",
      "after",
      "on_or_before",
      "on_or_after",
      "between",
      "in_relative",
      "not_in_relative",
      "empty",
      "notempty",
    ];
  if (field?.type === "number")
    return [
      "eq",
      "neq",
      "gt",
      "gte",
      "lt",
      "lte",
      "between",
      "empty",
      "notempty",
    ];
  if (field?.type === "checkbox") return ["checked", "unchecked"];
  if (field?.type === "checklist")
    return ["complete", "incomplete", "empty", "notempty"];
  if (field && ["multiselect", "relation", "person"].includes(field.type))
    return [...common, "any_of", "none_of", "all_of"];
  if (field && ["select", "created_by", "updated_by"].includes(field.type))
    return [...common, "any_of", "none_of"];
  if (field && ["formula", "rollup"].includes(field.type))
    return [...filterOperators];
  return [
    "contains",
    "not_contains",
    "eq",
    "neq",
    "starts_with",
    "ends_with",
    "empty",
    "notempty",
  ];
}

export function hasRelativeFilters(node: FilterNode): boolean {
  return node.kind === "group"
    ? node.rules.some(hasRelativeFilters)
    : isRelativeOperator(node.op);
}
