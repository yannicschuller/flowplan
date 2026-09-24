import { formatFieldDate, formatNumber } from "./field-format";
import type { Field, Row } from "./types";
import { isFormulaError } from "./formula";
import { z } from "zod";
import {
  aggregateRollup,
  allowedAggregates,
  aggregateNames,
  emptyRollupValue,
  numericAggregates,
  checkboxAggregates,
  dateAggregates,
  rollupAggregates,
  percentAggregate,
} from "./rollups";
import {
  validDateValue,
  isTimed,
  hasOffset,
  formatDateValue,
} from "./date-values";

export const columnCalculations = rollupAggregates.filter(
  (value) => value !== "show_original" && value !== "show_unique",
);
export type ColumnCalculation = (typeof columnCalculations)[number];
export type CalculationChoice = ColumnCalculation | "none";
// Parse entries explicitly: a record parser drops the valid imported ID __proto__.
export const calculationsSchema = z.preprocess(
  (value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.entries(value)
      : undefined,
  z
    .array(
      z.tuple([
        z.string().min(1).max(500),
        z.enum(["none", ...columnCalculations]),
      ]),
    )
    .max(80)
    .transform((entries): Record<string, CalculationChoice> =>
      Object.fromEntries(entries),
    ),
);
export function calculationFor(
  settings: Record<string, CalculationChoice> | undefined,
  id: string,
) {
  return settings && Object.hasOwn(settings, id) ? settings[id] : undefined;
}
export function calculationOptions(field: Field): ColumnCalculation[] {
  const allowed = allowedAggregates(field);
  return columnCalculations.filter(
    (a) =>
      allowed.includes(a) ||
      (["formula", "rollup"].includes(field.type) &&
        (checkboxAggregates.has(a) || dateAggregates.has(a))),
  );
}
export const calculationName = (choice: CalculationChoice | "auto") =>
  choice === "auto"
    ? "Automatisch"
    : choice === "none"
      ? "Keine Berechnung"
      : choice === "count"
        ? "Einträge zählen"
        : aggregateNames[choice];
export function availableCalculations(
  settings: Record<string, CalculationChoice>,
  fields: Field[],
) {
  return Object.fromEntries(
    Object.entries(settings).filter(([id, choice]) => {
      const field = fields.find((f) => f.id === id);
      return (
        field &&
        (choice === "none" || calculationOptions(field).includes(choice))
      );
    }),
  );
}
export function validateCalculations(
  settings: Record<string, CalculationChoice> | undefined,
  fields: Field[],
  previous: Field[] = [],
) {
  if (!settings) return undefined;
  const valid = availableCalculations(settings, fields);
  for (const key of Object.keys(settings)) {
    if (Object.hasOwn(valid, key)) continue;
    const old = previous.find((f) => f.id === key);
    const current = fields.find((f) => f.id === key);
    // Removing or changing a property also removes its obsolete calculation.
    if (old && (!current || current.type !== old.type)) continue;
    throw new Error(
      "Berechnung verweist auf eine unbekannte oder ungeeignete Eigenschaft.",
    );
  }
  return valid;
}
export type ColumnSummary = {
  calculation: ColumnCalculation;
  value: unknown;
  errors: number;
  overflow: boolean;
};
export function columnSummary(
  field: Field,
  rows: Row[],
  choice?: CalculationChoice,
): ColumnSummary | null {
  if (choice === "none") return null;
  if (!choice) {
    const result = numericSummary(field, rows);
    return result
      ? {
          calculation: "sum",
          value: result.sum,
          errors: result.errors,
          overflow: result.sum === null,
        }
      : null;
  }
  if (!calculationOptions(field).includes(choice)) return null;
  if (choice === "count")
    return {
      calculation: choice,
      value: rows.length,
      errors: 0,
      overflow: false,
    };
  const values: unknown[] = [];
  let errors = 0;
  for (const row of rows) {
    let value = Object.hasOwn(row.cells, field.id)
      ? row.cells[field.id]
      : undefined;
    if (["formula", "rollup"].includes(field.type) && isFormulaError(value)) {
      errors++;
      continue;
    }
    if (numericAggregates.has(choice) && !emptyRollupValue(value)) {
      const numeric =
        typeof value === "number"
          ? value
          : field.type === "number" && typeof value === "string" && value.trim()
            ? Number(value)
            : NaN;
      if (!Number.isFinite(numeric)) {
        errors++;
        continue;
      }
      value = numeric;
    }
    if (checkboxAggregates.has(choice)) {
      if (emptyRollupValue(value)) value = false;
      else if (typeof value !== "boolean") {
        errors++;
        continue;
      }
    }
    if (dateAggregates.has(choice) && !emptyRollupValue(value)) {
      if (
        ["created_at", "updated_at"].includes(field.type) &&
        typeof value === "string"
      )
        value = value.replace(" ", "T");
      if (!validDateValue(value)) {
        errors++;
        continue;
      }
      if (isTimed(value) && !hasOffset(value)) value += "Z";
    }
    values.push(value);
  }
  let value = aggregateRollup(values, choice);
  if (
    (choice === "average" || choice === "median") &&
    typeof value === "number" &&
    !Number.isFinite(value)
  ) {
    const numbers = values
      .filter((v): v is number => typeof v === "number")
      .sort((a, b) => a - b);
    if (numbers.length)
      value =
        choice === "average"
          ? numbers.reduce((sum, n) => sum + n / numbers.length, 0)
          : numbers.length % 2
            ? numbers[Math.floor(numbers.length / 2)]
            : numbers[numbers.length / 2 - 1] / 2 +
              numbers[numbers.length / 2] / 2;
  }
  const overflow = typeof value === "number" && !Number.isFinite(value);
  return {
    calculation: choice,
    value: overflow ? null : value,
    errors,
    overflow,
  };
}
export function summaryText(
  result: ColumnSummary,
  field?: Pick<Field, "type" | "format" | "timeFormat">,
) {
  const label =
    result.calculation === "sum"
      ? "Σ"
      : result.calculation === "average"
        ? "Ø"
        : calculationName(result.calculation);
  const value = result.overflow
    ? "Zahlenbereich überschritten"
    : result.value === null || result.value === undefined
      ? "Keine Werte"
      : typeof result.value === "number" &&
          field?.type === "number" &&
          field.format &&
          ["sum", "average", "median", "min", "max", "range"].includes(
            result.calculation,
          )
        ? formatNumber(result.value, field.format)
        : typeof result.value === "number"
          ? new Intl.NumberFormat("de-DE", {
              maximumFractionDigits: 4,
              ...(percentAggregate(result.calculation)
                ? { style: "percent" as const }
                : {}),
            }).format(result.value)
          : field?.type === "date"
            ? formatFieldDate(result.value, field, "UTC")
            : formatDateValue(result.value, "UTC");
  return `${label} ${value}${result.errors ? ` (${result.errors} fehlerhaft)` : ""}`;
}

// Rows must already contain computed cells and match the active filters.
export function numericSummary(field: Field, rows: Row[]) {
  if (!["number", "formula", "rollup"].includes(field.type)) return null;
  let sum = 0,
    count = 0,
    errors = 0;
  for (const row of rows) {
    const value = Object.hasOwn(row.cells, field.id)
      ? row.cells[field.id]
      : undefined;
    if (value === null || value === undefined || value === "") continue;
    if (isFormulaError(value)) {
      errors++;
      continue;
    }
    const number = field.type === "number" ? Number(value) : value;
    if (typeof number !== "number") return null;
    if (!Number.isFinite(number)) {
      errors++;
      continue;
    }
    count++;
    sum += number;
  }
  if (!count && field.type !== "number" && !errors) return null;
  return { sum: Number.isFinite(sum) ? sum : null, count, errors };
}
