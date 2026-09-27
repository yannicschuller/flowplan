import { test } from "node:test";
import assert from "node:assert/strict";
import { chartConfigError, chartPoints, chartSeries, canStack, type ChartConfig } from "../lib/database-chart";
import { publicLayout } from "../components/public-views";
import type { Field, Row, View } from "../lib/types";

const fields: Field[] = [
  { id: "title", name: "Name", type: "text" },
  { id: "month", name: "Monat", type: "select", options: ["Jan", "Feb"] },
  { id: "revenue", name: "Umsatz", type: "number" },
  { id: "cost", name: "Kosten", type: "number" },
  { id: "team", name: "Team", type: "select", options: ["A", "B"] },
];
const row = (id: string, cells: Record<string, unknown>) => ({ id, page_id: "p", cells, position: 0, version: 1 }) as unknown as Row;
const rows = [
  row("1", { title: "a", month: "Jan", revenue: 100, cost: 40 }),
  row("2", { title: "b", month: "Jan", revenue: 50, cost: 10 }),
  row("3", { title: "c", month: "Feb", revenue: 70, cost: 90 }),
];
const base: ChartConfig = {
  kind: "bar",
  xField: "month",
  yField: "revenue",
  aggregate: "sum",
  dateBucket: "month",
  order: "label_asc",
  includeEmpty: false,
  showValues: true,
};

test("further values become series next to the main value", () => {
  const config: ChartConfig = { ...base, measures: [{ field: "cost", aggregate: "sum" }, { field: "cost", aggregate: "max" }] };
  assert.equal(chartConfigError(config, fields), null);
  const points = chartPoints(rows, fields, config);
  const { series, values } = chartSeries(points, fields, config);
  assert.deepEqual(series.map((s) => s.label), ["Summe von Umsatz", "Summe von Kosten", "Maximum von Kosten"]);
  const feb = points.find((p) => p.label === "Feb")!.key;
  const jan = points.find((p) => p.label === "Jan")!.key;
  assert.equal(values.get(jan)!.get("m0")!.value, 150);
  assert.equal(values.get(jan)!.get("m1")!.value, 50);
  assert.equal(values.get(jan)!.get("m2")!.value, 40);
  assert.equal(values.get(feb)!.get("m1")!.value, 90);
  // Different measures are never stacked into one bar.
  assert.equal(canStack(config), false);
});

test("further values need numbers and exclude series by a property", () => {
  assert.match(String(chartConfigError({ ...base, measures: [{ field: "team", aggregate: "sum" }] }, fields)), /Zahl/);
  assert.match(
    String(chartConfigError({ ...base, seriesField: "team", measures: [{ field: "cost", aggregate: "sum" }] }, fields)),
    /nicht kombinieren/,
  );
});

test("feeds and charts with further values can be published when their properties are public", () => {
  const view = (patch: Partial<View>) => ({ id: "v", name: "v", type: "table", filters: [], sorts: [], ...patch }) as View;
  assert.equal(publicLayout(view({ type: "feed" }), fields), true);
  const chart = view({ type: "chart", chart: { ...base, measures: [{ field: "cost", aggregate: "sum" }] } });
  assert.equal(publicLayout(chart, fields), true);
});
