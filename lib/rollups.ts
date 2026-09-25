import { isEmptyValue } from "./empty-value";
import type { Field } from "./types";
export const rollupAggregates = [
  "count",
  "show_original",
  "show_unique",
  "count_values",
  "count_unique",
  "count_empty",
  "count_not_empty",
  "percent_empty",
  "percent_not_empty",
  "sum",
  "average",
  "median",
  "min",
  "max",
  "range",
  "count_checked",
  "count_unchecked",
  "percent_checked",
  "percent_unchecked",
  "earliest_date",
  "latest_date",
  "date_range",
] as const;
export type RollupAggregate = (typeof rollupAggregates)[number];
export const aggregateNames: Record<RollupAggregate, string> = {
  count: "Verknüpfte Einträge zählen",
  show_original: "Originalwerte anzeigen",
  show_unique: "Eindeutige Werte anzeigen",
  count_values: "Werte zählen",
  count_unique: "Eindeutige Werte zählen",
  count_empty: "Leere Werte zählen",
  count_not_empty: "Gefüllte Werte zählen",
  percent_empty: "Anteil leer",
  percent_not_empty: "Anteil gefüllt",
  sum: "Summe",
  average: "Durchschnitt",
  median: "Median",
  min: "Minimum",
  max: "Maximum",
  range: "Spannweite",
  count_checked: "Abgehakte Werte zählen",
  count_unchecked: "Nicht abgehakte Werte zählen",
  percent_checked: "Anteil abgehakt",
  percent_unchecked: "Anteil nicht abgehakt",
  earliest_date: "Frühestes Datum",
  latest_date: "Spätestes Datum",
  date_range: "Zeitraum in Tagen",
};
export const numericAggregates = new Set<RollupAggregate>([
  "sum",
  "average",
  "median",
  "min",
  "max",
  "range",
]);
export const checkboxAggregates = new Set<RollupAggregate>([
  "count_checked",
  "count_unchecked",
  "percent_checked",
  "percent_unchecked",
]);
export const dateAggregates = new Set<RollupAggregate>([
  "earliest_date",
  "latest_date",
  "date_range",
]);
export const percentAggregate = (a?: string) =>
  a?.startsWith("percent_") || false;
export function allowedAggregates(field?: Field): RollupAggregate[] {
  if (!field) return ["count"];
  return rollupAggregates.filter(
    (a) =>
      (!numericAggregates.has(a) &&
        !checkboxAggregates.has(a) &&
        !dateAggregates.has(a)) ||
      (numericAggregates.has(a) &&
        ["number", "formula", "rollup"].includes(field.type)) ||
      (checkboxAggregates.has(a) && field.type === "checkbox") ||
      (dateAggregates.has(a) &&
        ["date", "created_at", "updated_at"].includes(field.type)),
  );
}
export const emptyRollupValue = (v: unknown) => isEmptyValue(v);
export function aggregateRollup(
  values: unknown[],
  aggregate: RollupAggregate,
): unknown {
  const filled = values.filter((v) => !emptyRollupValue(v));
  const flat = filled.flat();
  const unique = [...new Map(flat.map((v) => [JSON.stringify(v), v])).values()];
  const ratio = (n: number) => (values.length ? n / values.length : 0);
  switch (aggregate) {
    case "count":
      return values.length;
    case "show_original":
      return flat;
    case "show_unique":
      return unique;
    case "count_values":
      return flat.length;
    case "count_unique":
      return unique.length;
    case "count_empty":
      return values.length - filled.length;
    case "count_not_empty":
      return filled.length;
    case "percent_empty":
      return ratio(values.length - filled.length);
    case "percent_not_empty":
      return ratio(filled.length);
    case "count_checked":
      return values.filter((v) => v === true).length;
    case "count_unchecked":
      return values.filter((v) => v !== true).length;
    case "percent_checked":
      return ratio(values.filter((v) => v === true).length);
    case "percent_unchecked":
      return ratio(values.filter((v) => v !== true).length);
    case "earliest_date":
    case "latest_date":
    case "date_range": {
      const dates = filled
        .filter((v) => typeof v === "string")
        .map((v) => ({ value: v as string, time: Date.parse(v as string) }))
        .filter((d) => Number.isFinite(d.time))
        .sort((a, b) => a.time - b.time);
      if (!dates.length) return null;
      return aggregate === "earliest_date"
        ? dates[0].value
        : aggregate === "latest_date"
          ? dates[dates.length - 1].value
          : (dates[dates.length - 1].time - dates[0].time) / 86400000;
    }
    default: {
      const nums = filled
        .filter(
          (v) =>
            typeof v === "number" || (typeof v === "string" && v.trim() !== ""),
        )
        .map(Number)
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
      if (aggregate === "sum") return nums.reduce((a, b) => a + b, 0);
      if (!nums.length) return null;
      if (aggregate === "average")
        return nums.reduce((a, b) => a + b, 0) / nums.length;
      if (aggregate === "min") return nums[0];
      if (aggregate === "max") return nums[nums.length - 1];
      if (aggregate === "range") return nums[nums.length - 1] - nums[0];
      if (aggregate === "median")
        return nums.length % 2
          ? nums[Math.floor(nums.length / 2)]
          : (nums[nums.length / 2 - 1] + nums[nums.length / 2]) / 2;
      return null;
    }
  }
}
