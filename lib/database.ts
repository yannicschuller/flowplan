import { rowOrderRanks } from "./row-order";
import { aggregateRollup } from "./rollups";
import type { Field, Row, View } from "./types";
import { cellText } from "./cell-text";
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
              ? resolve(r, targetFields, target, next)
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
              const v = resolve(record, properties, prop, next);
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
              return v;
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
export function queryRows(
  rows: Row[],
  fields: Field[],
  view: View,
  query = "",
  related: Record<string, Row[]> = {},
  schemas: Record<string, Field[]> = {},
  now: Date = new Date(),
) {
  const ranks = rowOrderRanks(view.rowOrder),
    filters = effectiveFilterGroup(view);
  return rows
    .map((r) => ({
      ...r,
      cells: computedCells(r, fields, related, schemas, now),
    }))
    .filter(
      (r) =>
        matchesFilterGroup(r.cells, filters, fields, now) &&
        (!query ||
          r.preview?.text.toLowerCase().includes(query.toLowerCase()) ||
          Object.values(r.cells).some((v) =>
            cellText(v).toLowerCase().includes(query.toLowerCase()),
          ) ||
          fields.some(
            (f) =>
              f.type === "relation" &&
              Array.isArray(r.cells[f.id]) &&
              (related[f.relationPage || ""] || []).some(
                (target) =>
                  (r.cells[f.id] as unknown[]).includes(target.id) &&
                  cellText(target.cells.title)
                    .toLowerCase()
                    .includes(query.toLowerCase()),
              ),
          )),
    )
    .sort((a, b) => {
      for (const s of view.sorts) {
        const av = a.cells[s.field],
          bv = b.cells[s.field];
        const n =
          typeof av === "number" && typeof bv === "number"
            ? av - bv
            : cellText(av).localeCompare(cellText(bv), "de", { numeric: true });
        if (n) return s.direction === "asc" ? n : -n;
      }
      return (
        (ranks.get(a.id) ?? Infinity) - (ranks.get(b.id) ?? Infinity) ||
        a.position - b.position
      );
    });
}
