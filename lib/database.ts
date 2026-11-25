import { rowOrderRanks } from "./row-order";
import { aggregateRollup } from "./rollups";
import type { Field, Row, View } from "./types";
import { cellText } from "./cell-text";
import { isFormattedText, toPlain } from "./inline-markdown";
export { cellText } from "./cell-text";
export { matches } from "./database-filters";
import { effectiveFilterGroup, matchesFilterGroup } from "./database-filters";
import {
  evaluateFormula,
  FormulaFault,
  formulaErrorMessage,
  isFormulaError,
  type FormulaDiagnostic,
} from "./formula";
export { formula } from "./formula";
import { ticketId } from "./ticket-ids";
import { subtaskProgress } from "./subtasks";
import { sqlTimestampToIso } from "./date-values";
// Created and edited time as ISO instants for formulas and rollups (#129).
const timestampTypes = new Set<Field["type"]>(["created_at", "updated_at"]);
const asInstant = (field: Field, value: unknown) =>
  timestampTypes.has(field.type) ? sqlTimestampToIso(value) : value;
export function computedCells(
  row: Row,
  fields: Field[],
  related: Record<string, Row[]> = {},
  schemas: Record<string, Field[]> = {},
  now: Date = new Date(),
): Record<string, unknown> {
  return computedCellsDetailed(row, fields, related, schemas, now).cells;
}
export function computedCellsDetailed(
  row: Row,
  fields: Field[],
  related: Record<string, Row[]> = {},
  schemas: Record<string, Field[]> = {},
  now: Date = new Date(),
): {
  cells: Record<string, unknown>;
  diagnostics: Record<string, FormulaDiagnostic>;
} {
  const cache = new Map<string, unknown>();
  const diagnostics: Record<string, FormulaDiagnostic> = {};
  let evaluations = 0;
  function resolve(
    record: Row,
    properties: Field[],
    field: Field,
    trail: Set<string>,
  ): unknown {
    const key = `${record.page_id}:${record.id}:${field.id}`;
    if (cache.has(key)) return cache.get(key);
    if (trail.has(key)) return "#CYCLE";
    if (trail.size > 50 || ++evaluations > 10000) return "#LIMIT";
    const next = new Set(trail).add(key);
    let value: unknown = Object.hasOwn(record.cells, field.id)
      ? record.cells[field.id]
      : undefined;
    if (
      ["created_at", "updated_at", "created_by", "updated_by"].includes(
        field.type,
      )
    )
      value = record[field.type as "created_at"];
    if (field.type === "id") value = ticketId(field, record.number);
    if (field.type === "progress")
      value = subtaskProgress(record, field, related[record.page_id] || []);
    if (field.type === "rollup") {
      const relation = properties.find(
        (f) => f.id === field.relationField && f.type === "relation",
      );
      if (!relation?.relationPage) value = "#RELATION";
      else if (!Object.hasOwn(related, relation.relationPage))
        value = "#ACCESS";
      else {
        const ids = Array.isArray(record.cells[relation.id])
          ? (record.cells[relation.id] as string[])
          : [];
        const selectedIds = new Set(ids);
        const linked = related[relation.relationPage].filter((r) =>
          selectedIds.has(r.id),
        );
        const targetFields = schemas[relation.relationPage];
        const target = targetFields?.find((f) => f.id === field.rollupField);
        if (
          field.aggregate !== "count" &&
          field.aggregate !== undefined &&
          targetFields &&
          !target
        )
          value = "#PROPERTY";
        else {
          const values = linked.map((r) =>
            target && targetFields
              ? asInstant(target, resolve(r, targetFields, target, next))
              : r.cells[field.rollupField || ""],
          );
          const error = values.find(
            (v) =>
              typeof v === "string" &&
              /^#(CYCLE|LIMIT|ACCESS|PROPERTY|RELATION|ERROR|DIV)/.test(v),
          );
          value =
            field.aggregate === "count" || !field.aggregate
              ? linked.length
              : error || aggregateRollup(values, field.aggregate);
        }
      }
    }
    if (field.type === "formula") {
      const refs = { ...record.cells };
      for (const alias of ["name", "id"] as const)
        for (const prop of properties) {
          const name = prop[alias];
          Object.defineProperty(refs, name, {
            configurable: true,
            enumerable: true,
            get: () => {
              const v = asInstant(prop, resolve(record, properties, prop, next));
              if (
                ["formula", "rollup"].includes(prop.type) &&
                isFormulaError(v)
              )
                throw new FormulaFault({
                  code: v,
                  message: formulaErrorMessage(v),
                  start: 0,
                  end: 0,
                });
              // Formatted text (#126) reads as plain text in formulas.
              return isFormattedText(prop, properties) && typeof v === "string" ? toPlain(v) : v;
            },
          });
        }
      const result = evaluateFormula(field.formula || "", refs, { now });
      value = result.ok ? result.value : result.error.code;
      if (!result.ok && record.id === row.id && record.page_id === row.page_id)
        diagnostics[field.id] = result.error;
    }
    if (typeof value === "number" && !Number.isFinite(value)) value = "#ERROR";
    cache.set(key, value);
    return value;
  }
  const result = { ...row.cells };
  for (const f of fields)
    Object.defineProperty(result, f.id, {
      value: resolve(row, fields, f, new Set()),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  return { cells: result, diagnostics };
}
export type QueryLabels = {
  members?: readonly { id: string; name: string }[];
  sprints?: readonly { id: string; name: string }[];
};
const personTypes = new Set<Field["type"]>(["person", "created_by", "updated_by"]);
// The text of a cell and the names of people, related records and sprints,
// as search and sorting read them. Formatted text (#126) reads as plain text.
function cellLabels(
  fields: Field[],
  related: Record<string, Row[]>,
  schemas: Record<string, Field[]>,
  labels: QueryLabels,
) {
  const formatted = new Set(fields.filter((f) => isFormattedText(f, fields)).map((f) => f.id));
  const textOf = (id: string, v: unknown) => (formatted.has(id) ? toPlain(cellText(v)) : cellText(v));
  // People, related records and sprints by the names the table shows
  // (lib/database-groups.ts); undefined for other properties.
  const members = new Map(labels.members?.map((m) => [m.id, m.name])),
    sprints = new Map(labels.sprints?.map((m) => [m.id, m.name])),
    byId = new Map(fields.map((f) => [f.id, f]));
  const titles = new Map<string, Map<string, string>>();
  const relatedTitles = (page: string) => {
    if (!titles.has(page)) {
      const key = schemas[page]?.[0]?.id || "title";
      titles.set(page, new Map((related[page] || []).map((r) => [r.id, toPlain(cellText(r.cells[key]))])));
    }
    return titles.get(page)!;
  };
  const labelOf = (id: string, v: unknown): string | undefined => {
    const f = byId.get(id);
    const names =
      f?.type === "relation"
        ? relatedTitles(f.relationPage || "")
        : f && personTypes.has(f.type) && labels.members
          ? members
          : f?.type === "sprint" && labels.sprints
            ? sprints
            : undefined;
    if (!names) return undefined;
    const ids = Array.isArray(v) ? v : v === null || v === undefined || v === "" ? [] : [v];
    return ids.map((x) => names.get(String(x)) ?? "").filter(Boolean).join(", ");
  };
  return { textOf, labelOf };
}
// One collator for all comparisons: the order of
// a.localeCompare(b, "de", { numeric: true }) without a collator per call
// (#383: that was most of a sorted query's time).
const collator = new Intl.Collator("de", { numeric: true });
// The order of a view: its sorts (numbers as numbers, everything else by the
// text the table shows), then the saved row order, then the position.
// A value that sorts as empty: nothing, an empty text or an empty list.
const sortsEmpty = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
// `cells` are the computed cells, at least those of the sorted properties.
export function rowComparator(
  fields: Field[],
  view: Pick<View, "sorts" | "rowOrder">,
  related: Record<string, Row[]> = {},
  schemas: Record<string, Field[]> = {},
  labels: QueryLabels = {},
) {
  const ranks = rowOrderRanks(view.rowOrder);
  const { textOf, labelOf } = cellLabels(fields, related, schemas, labels);
  const sorts = view.sorts || [];
  // The sort text of a row, once per row and sort.
  const keys = sorts.map(() => new WeakMap<object, string>());
  const sortText = (i: number, cells: Record<string, unknown>) => {
    let text = keys[i].get(cells);
    if (text === undefined) {
      const id = sorts[i].field,
        v = cells[id];
      text = labelOf(id, v) ?? textOf(id, v);
      keys[i].set(cells, text);
    }
    return text;
  };
  return (a: Pick<Row, "id" | "position" | "cells">, b: Pick<Row, "id" | "position" | "cells">) => {
    for (let i = 0; i < sorts.length; i++) {
      const s = sorts[i];
      const av = a.cells[s.field],
        bv = b.cells[s.field];
      // Empty values always go last, whatever the direction (#551, like
      // Notion and AFFiNE): a date sorted ascending no longer starts with
      // every record that has none.
      const ae = sortsEmpty(av),
        be = sortsEmpty(bv);
      if (ae !== be) return ae ? 1 : -1;
      if (ae) continue;
      const n =
        typeof av === "number" && typeof bv === "number"
          ? av - bv
          : collator.compare(sortText(i, a.cells), sortText(i, b.cells));
      if (n) return s.direction === "asc" ? n : -n;
    }
    return (
      (ranks.get(a.id) ?? Infinity) - (ranks.get(b.id) ?? Infinity) ||
      a.position - b.position
    );
  };
}
// Whether a query has to read records of other databases: rollups and
// subtask progress compute from them, sorting and search by a relation
// read the linked records' titles.
export function needsRelatedRows(fields: Field[], view: Pick<View, "sorts">, query = "") {
  const byId = new Map(fields.map((f) => [f.id, f]));
  return (
    fields.some((f) => f.type === "rollup" || f.type === "progress") ||
    (view.sorts || []).some((s) => byId.get(s.field)?.type === "relation") ||
    (!!query && fields.some((f) => f.type === "relation"))
  );
}
export function queryRows<T extends Row>(
  rows: T[],
  fields: Field[],
  view: View,
  query = "",
  related: Record<string, Row[]> = {},
  schemas: Record<string, Field[]> = {},
  now: Date = new Date(),
  // Names for people and sprints, so they sort and are found by name.
  labels: QueryLabels = {},
) {
  const filters = effectiveFilterGroup(view);
  const { textOf, labelOf } = cellLabels(fields, related, schemas, labels);
  const q = query.toLowerCase();
  return rows
    .map((r) => ({
      ...r,
      cells: computedCells(r, fields, related, schemas, now),
    }))
    .filter(
      (r) =>
        matchesFilterGroup(r.cells, filters, fields, now) &&
        (!query ||
          r.preview?.text.toLowerCase().includes(q) ||
          Object.entries(r.cells).some(([id, v]) =>
            textOf(id, v).toLowerCase().includes(q) ||
            !!labelOf(id, v)?.toLowerCase().includes(q),
          )),
    )
    .sort(rowComparator(fields, view, related, schemas, labels));
}
