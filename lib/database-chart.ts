import { z } from "zod";
import { cellText } from "./cell-text";
import type { Field, Row, User } from "./types";

export const chartSchema = z.object({
  kind: z.enum(["bar", "horizontal", "line", "donut"]),
  xField: z.string().min(1).max(500).optional(),
  yField: z.string().min(1).max(500).optional(),
  aggregate: z.enum(["count", "sum", "average", "min", "max"]),
  dateBucket: z.enum(["day", "week", "month", "year"]),
  order: z.enum(["label_asc", "label_desc", "value_asc", "value_desc"]),
  includeEmpty: z.boolean(),
  showValues: z.boolean(),
});
export type ChartConfig = z.infer<typeof chartSchema>;
export const chartKinds = {
  bar: "Säulen",
  horizontal: "Balken",
  line: "Linie",
  donut: "Donut",
};
export const chartAggregates = {
  count: "Anzahl Einträge",
  sum: "Summe",
  average: "Mittelwert",
  min: "Minimum",
  max: "Maximum",
};
export const chartGroupField = (f: Field) =>
  !["files", "checklist"].includes(f.type);
export const chartNumberField = (f: Field) =>
  ["number", "formula", "rollup"].includes(f.type);
export const chartDateField = (f?: Field) =>
  !!f && ["date", "created_at", "updated_at"].includes(f.type);
export function defaultChart(fields: Field[]): ChartConfig {
  return {
    kind: "bar",
    xField: fields.find((f) => f.type === "select")?.id,
    aggregate: "count",
    dateBucket: "month",
    order: "label_asc",
    includeEmpty: true,
    showValues: true,
  };
}
export function chartConfigError(
  config: ChartConfig,
  fields: Field[],
): string | null {
  if (
    config.xField &&
    !fields.some((f) => f.id === config.xField && chartGroupField(f))
  )
    return "Die Gruppierungs-Eigenschaft fehlt oder ist ungeeignet. Bitte das Diagramm konfigurieren.";
  if (
    config.aggregate !== "count" &&
    !fields.some((f) => f.id === config.yField && chartNumberField(f))
  )
    return "Für diese Berechnung eine Zahl-, Formel- oder Rollup-Eigenschaft wählen.";
  return null;
}
export type ChartPoint = {
  key: string;
  label: string;
  value: number | null;
  rows: Row[];
  numericCount: number;
};

function dateKey(
  value: unknown,
  bucket: ChartConfig["dateBucket"],
): string | null {
  const raw = cellText(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const date = new Date(raw + "T00:00:00Z");
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== raw
  )
    return null;
  if (bucket === "year") return raw.slice(0, 4);
  if (bucket === "month") return raw.slice(0, 7);
  if (bucket === "week")
    date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}
function numeric(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
// Rows must already be computed and filtered with queryRows and its authorized related data.
export function chartPoints(
  rows: Row[],
  fields: Field[],
  config: ChartConfig,
  related: Record<string, Row[]> = {},
  members: Pick<User, "id" | "name">[] = [],
): ChartPoint[] {
  if (chartConfigError(config, fields)) return [];
  const field = fields.find((f) => f.id === config.xField);
  const groups = new Map<string, ChartPoint>();
  for (const row of rows) {
    const raw = field ? row.cells[field.id] : "Alle Einträge";
    const values = Array.isArray(raw)
      ? raw.length
        ? [...new Set(raw)]
        : [null]
      : [raw];
    const added = new Set<string>();
    for (let value of values) {
      if (chartDateField(field)) value = dateKey(value, config.dateBucket);
      if (
        typeof value === "string" &&
        /^#(?:ACCESS|CYCLE|ERROR|REF|VALUE|DIV)/.test(value)
      )
        value = null;
      const empty = value == null || value === "";
      if (empty && !config.includeEmpty) continue;
      const key = empty ? "empty" : JSON.stringify(value);
      if (added.has(key)) continue;
      added.add(key);
      if (!groups.has(key)) {
        let label = empty ? "Ohne Wert" : cellText(value);
        if (!empty && field?.type === "relation")
          label =
            cellText(
              related[field.relationPage || ""]?.find((r) => r.id === value)
                ?.cells.title,
            ) || "Nicht verfügbar";
        if (
          !empty &&
          field &&
          ["person", "created_by", "updated_by"].includes(field.type)
        )
          label =
            members.find((m) => m.id === value)?.name || "Unbekannte Person";
        if (!empty && field?.type === "checkbox")
          label = value ? "Abgehakt" : "Nicht abgehakt";
        if (!empty && chartDateField(field) && config.dateBucket === "week")
          label = `Woche ab ${label}`;
        groups.set(key, { key, label, value: null, rows: [], numericCount: 0 });
      }
      groups.get(key)!.rows.push(row);
    }
  }
  for (const point of groups.values()) {
    if (config.aggregate === "count") {
      point.value = point.rows.length;
      continue;
    }
    let sum = 0,
      min = Infinity,
      max = -Infinity,
      average = 0;
    for (const row of point.rows) {
      const n = numeric(row.cells[config.yField || ""]);
      if (n === null) continue;
      point.numericCount++;
      sum += n;
      average =
        average * ((point.numericCount - 1) / point.numericCount) +
        n / point.numericCount;
      min = Math.min(min, n);
      max = Math.max(max, n);
    }
    if (point.numericCount) {
      const value =
        config.aggregate === "sum"
          ? sum
          : config.aggregate === "average"
            ? average
            : config.aggregate === "min"
              ? min
              : max;
      point.value = Number.isFinite(value) ? value : null;
    }
  }
  const direction = config.order.endsWith("desc") ? -1 : 1;
  return [...groups.values()].sort((a, b) => {
    if (config.order.startsWith("value")) {
      if (a.value === null && b.value !== null) return 1;
      if (b.value === null && a.value !== null) return -1;
      if (a.value !== b.value)
        return ((a.value || 0) - (b.value || 0)) * direction;
    }
    return (
      a.label.localeCompare(b.label, "de", { numeric: true }) *
        (config.order.startsWith("label") ? direction : 1) ||
      a.key.localeCompare(b.key)
    );
  });
}
