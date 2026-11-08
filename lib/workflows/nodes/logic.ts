// Logic nodes (docs/specs/workflows.md §6.3): If, Set values, Stop.
import { matches } from "../../database-filters";
import { isFormattedText } from "../../inline-markdown";
import type { Field, Filter } from "../../types";
import type { WorkflowCondition, WorkflowConditionGroup } from "../catalog";
import { conditionField } from "../legacy";
import { isEmpty, renderText, renderValue, type RenderScope } from "../placeholders";
import { toNumber } from "../values";
import { databaseFields } from "./data";
import type { NodeImpl, NodeRun } from "./types";

const DATE = /^\d{4}-\d{2}-\d{2}/;
function inferredType(value: unknown): Field["type"] {
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "checkbox";
  if (Array.isArray(value)) return "multiselect";
  if (typeof value === "string" && DATE.test(value) && Number.isFinite(Date.parse(value))) return "date";
  return "text";
}
const cellOf = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(cellOf);
  if (value && typeof value === "object") {
    const o = value as { title?: unknown; name?: unknown; id?: unknown };
    return typeof o.title === "string" ? o.title : typeof o.name === "string" ? o.name : typeof o.id === "string" ? o.id : JSON.stringify(value);
  }
  return value;
};

// Evaluates a condition group with the operators of the database filters
// (lib/database-filters.ts): a condition on a property of a record before
// this node compares like a view filter on that property (computed values,
// formatted text, time zones); any other left side is compared as a value
// of its own type. And/or as matchesFilterGroup() does it.
const conditionCount = (g: WorkflowConditionGroup): number => g.rules.reduce((n, r) => n + (r.kind === "group" ? conditionCount(r) : 1), 0);
export async function evaluateConditions(group: WorkflowConditionGroup, scope: RenderScope, timeZone: string): Promise<boolean> {
  const fieldCache = new Map<string, Field[]>();
  const now = new Date();
  const test = async (c: WorkflowCondition): Promise<boolean> => {
    const text = (v: string | undefined) => (v === undefined ? undefined : renderText(v, scope));
    const filter = {
      kind: "condition",
      field: "x",
      op: c.op,
      value: text(c.value) ?? "",
      ...(c.values ? { values: c.values.map((v) => renderText(v, scope)) } : {}),
      ...(c.to !== undefined ? { to: text(c.to) } : {}),
      ...(c.timeZone || ["in_relative", "not_in_relative"].includes(c.op) ? { timeZone: c.timeZone || timeZone } : {}),
      ...(c.days !== undefined ? { days: c.days } : {}),
    } as Filter & { kind: "condition" };
    const target = conditionField(c.left);
    const record = target ? (scope.values[target.node] as { record?: { fields?: Record<string, unknown>; database?: { id: string } } } | undefined)?.record : undefined;
    if (target && record?.database) {
      const dbFields = fieldCache.get(record.database.id) ?? (await databaseFields(record.database.id));
      fieldCache.set(record.database.id, dbFields);
      const field = dbFields.find((f) => f.id === target.field);
      // A deleted property: no match, as in a view.
      if (!field) return false;
      return matches({ x: record.fields?.[target.field] }, filter, { ...field, id: "x" }, now, isFormattedText(field, dbFields));
    }
    let value = cellOf(renderValue(c.left, scope));
    let type = inferredType(value);
    if (typeof value === "string" && ["gt", "gte", "lt", "lte"].includes(c.op) && toNumber(value) !== null) {
      value = toNumber(value);
      type = "number";
    }
    return matches({ x: value }, filter, { id: "x", name: "x", type }, now);
  };
  const evaluate = async (g: WorkflowConditionGroup): Promise<boolean> => {
    const results: boolean[] = [];
    let counted = 0;
    for (const rule of g.rules) {
      if (rule.kind === "group") {
        if (!conditionCount(rule)) continue;
        counted++;
        results.push(await evaluate(rule));
      } else {
        counted++;
        results.push(await test(rule));
      }
    }
    if (!counted) return true;
    return g.join === "or" ? results.some(Boolean) : results.every(Boolean);
  };
  return await evaluate(group);
}

export const logicIf: NodeImpl = async (ctx: NodeRun) => {
  const matched = await evaluateConditions(ctx.config.condition as WorkflowConditionGroup, ctx.scope, ctx.scope.timeZone);
  return { port: matched ? "true" : "false", output: { matched } };
};

export const logicSet: NodeImpl = async (ctx) => {
  const out: Record<string, unknown> = {};
  for (const v of (ctx.config.values as { name: string; value: string; type: string }[]) || []) {
    const raw = renderValue(v.value, ctx.scope);
    out[v.name] =
      v.type === "text"
        ? renderText(v.value, ctx.scope)
        : v.type === "number"
          ? toNumber(raw)
          : v.type === "boolean"
            ? typeof raw === "boolean"
              ? raw
              : /^(true|1|ja|yes)$/i.test(String(raw ?? "").trim())
            : v.type === "date"
              ? isEmpty(raw)
                ? null
                : String(raw).slice(0, 10)
              : v.type === "list"
                ? Array.isArray(raw)
                  ? raw
                  : isEmpty(raw)
                    ? []
                    : [raw]
                : raw;
  }
  return { port: "out", output: out };
};

export const logicStop: NodeImpl = async (ctx) => ({
  stop: ctx.config.result === "failed" ? "failed" : "succeeded",
  message: renderText(String(ctx.config.message || ""), ctx.scope).slice(0, 500),
});
