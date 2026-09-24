import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chartPoints,
  chartSchema,
  chartConfigError,
  defaultChart,
  type ChartConfig,
} from "../lib/database-chart";
import { queryRows } from "../lib/database";
import { view as viewSchema } from "../lib/database-schema";
import type { Field, Row, View, Identity } from "../lib/types";
const fields: Field[] = [
  { id: "title", name: "Name", type: "text" },
  { id: "status", name: "Status", type: "select", options: ["Open", "Done"] },
  { id: "amount", name: "Aufwand", type: "number" },
  { id: "date", name: "Termin", type: "date" },
  { id: "tags", name: "Tags", type: "multiselect" },
  { id: "double", name: "Doppelt", type: "formula", formula: "{Aufwand} * 2" },
];
const config: ChartConfig = {
  ...defaultChart(fields),
  aggregate: "sum",
  yField: "amount",
};
const view: View = {
  id: "chart",
  name: "Auswertung",
  type: "chart",
  chart: config,
  filters: [],
  sorts: [],
};
function row(id: string, cells: Record<string, unknown>): Row {
  return {
    id,
    page_id: "p",
    cells,
    position: 0,
    version: 1,
    created_at: "",
    updated_at: "",
    created_by: "",
    updated_by: "",
  };
}
const samples = [
  row("a", {
    title: "Alpha",
    status: "Open",
    amount: 0,
    tags: ["A", "B", "A"],
  }),
  row("b", { title: "Beta", status: "Open", amount: 10, tags: ["A"] }),
  row("c", { title: "Gamma", status: "Done", amount: -2, tags: [] }),
  row("d", { title: "Delta", status: "Done", amount: "" }),
];
test("chart aggregates preserve zero/negative values and ignore blanks, booleans, computation errors and non-finite results", () => {
  for (const [aggregate, expected] of Object.entries({
    count: 2,
    sum: 10,
    average: 5,
    min: 0,
    max: 10,
  })) {
    const points = chartPoints(samples, fields, {
      ...config,
      aggregate: aggregate as ChartConfig["aggregate"],
    });
    assert.equal(points.find((p) => p.label === "Open")!.value, expected);
    assert.equal(
      points.find((p) => p.label === "Done")!.value,
      aggregate === "count" ? 2 : -2,
    );
  }
  const bad = [
    null,
    "",
    " ",
    true,
    false,
    "#ACCESS!",
    "bad",
    Infinity,
    [5],
    {},
  ].map((amount, i) => row(String(i), { amount }));
  assert.equal(
    chartPoints(bad, fields, { ...config, xField: undefined })[0].value,
    null,
  );
  assert.equal(
    chartPoints([...bad, row("valid", { amount: "0" })], fields, {
      ...config,
      xField: undefined,
    })[0].value,
    0,
  );
  assert.equal(
    chartPoints(
      [row("x", { amount: 1e308 }), row("y", { amount: 1e308 })],
      fields,
      { ...config, xField: undefined },
    )[0].value,
    null,
  );
  assert.equal(
    chartPoints(
      [row("x", { amount: 1e308 }), row("y", { amount: 1e308 })],
      fields,
      { ...config, aggregate: "average", xField: undefined },
    )[0].value,
    1e308,
  );
});
test("group memberships are unique per row, typed, sorted and labeled without disclosing inaccessible relation IDs", () => {
  const result = chartPoints(samples, fields, {
    ...config,
    xField: "tags",
    aggregate: "count",
    order: "value_desc",
  });
  assert.deepEqual(
    result.map((p) => [p.label, p.value]),
    [
      ["A", 2],
      ["Ohne Wert", 2],
      ["B", 1],
    ],
  );
  assert.equal(
    chartPoints(samples, fields, {
      ...config,
      xField: "tags",
      includeEmpty: false,
    }).length,
    2,
  );
  const people: Field[] = [
    { id: "person", name: "Person", type: "person" },
    { id: "link", name: "Relation", type: "relation", relationPage: "target" },
    { id: "done", name: "Done", type: "checkbox" },
  ];
  const r = row("one", { person: ["u", "u"], link: ["hidden"], done: false });
  assert.equal(
    chartPoints(
      [r],
      people,
      { ...config, aggregate: "count", xField: "person" },
      {},
      [{ id: "u", name: "Ada" }],
    )[0].label,
    "Ada",
  );
  assert.equal(
    chartPoints([r], people, {
      ...config,
      aggregate: "count",
      xField: "link",
    })[0].label,
    "Nicht verfügbar",
  );
  assert.equal(
    chartPoints([r], people, {
      ...config,
      aggregate: "count",
      xField: "done",
    })[0].label,
    "Nicht abgehakt",
  );
});
test("date buckets use calendar dates and Monday weeks across years without normalizing invalid dates", () => {
  const dates = [
    "2025-12-31",
    "2026-01-01T23:00:00-05:00",
    "2026-01-05",
    "2026-02-30",
    "",
  ].map((date, i) => row(String(i), { date }));
  const cfg = { ...config, xField: "date", aggregate: "count" as const };
  assert.deepEqual(
    chartPoints(dates, fields, {
      ...cfg,
      dateBucket: "week",
      includeEmpty: false,
    }).map((p) => [p.label, p.value]),
    [
      ["Woche ab 2025-12-29", 2],
      ["Woche ab 2026-01-05", 1],
    ],
  );
  assert.deepEqual(
    chartPoints(dates, fields, { ...cfg, dateBucket: "month" }).map((p) => [
      p.label,
      p.value,
    ]),
    [
      ["2025-12", 1],
      ["2026-01", 2],
      ["Ohne Wert", 2],
    ],
  );
});
test("charts consume common search/filter/computed results and diagnose removed fields; configuration is validated", () => {
  const narrowed = {
    ...view,
    filters: [{ field: "status", op: "eq" as const, value: "Open" }],
  };
  const selected = queryRows(samples, fields, narrowed, "Beta");
  assert.equal(selected.length, 1);
  assert.equal(chartPoints(selected, fields, config)[0].value, 10);
  assert.equal(
    chartPoints(selected, fields, { ...config, yField: "double" })[0].value,
    20,
  );
  assert.match(
    chartConfigError({ ...config, yField: "missing" }, fields)!,
    /Mess|Zahl/,
  );
  assert.match(
    chartConfigError({ ...config, xField: "missing" }, fields)!,
    /fehlt/,
  );
  assert.deepEqual(
    chartPoints(samples, fields, { ...config, xField: "missing" }),
    [],
  );
  assert.equal(
    chartSchema.safeParse({ ...config, kind: "fake" }).success,
    false,
  );
  assert.equal(
    chartSchema.safeParse({ ...config, showValues: "true" }).success,
    false,
  );
  assert.deepEqual(viewSchema.parse(view), view);
});

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-chart-"));
const { id, run, one } = await import("../lib/db");
const { command, database, rows, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { exportArchive, importArchive } = await import("../lib/archive");
function user(name: string): Identity {
  const uid = id();
  run(
    "INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)",
    uid,
    uid,
    name,
    `${name}@test.invalid`,
  );
  return {
    id: uid,
    name,
    email: `${name}@test.invalid`,
    groups: [],
    isAdmin: false,
    disabled: 0,
    created_at: "",
  };
}
const owner = user("owner"),
  viewer = user("viewer"),
  wid = createWorkspace(owner.id, "Charts"),
  boot = bootstrap(owner, wid);
run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const act = (body: Record<string, unknown>, as = owner): any =>
  command(as, body);
function fixture() {
  const page = act({
    action: "page.create",
    workspaceId: wid,
    spaceId: boot.spaces[0].id,
    kind: "database",
    title: "Chart source",
  }).id;
  act({
    action: "database.update",
    pageId: page,
    version: database(page).version,
    fields,
    views: [view],
  });
  for (const r of samples)
    act({ action: "row.create", pageId: page, cells: r.cells });
  return page as string;
}
test("chart configuration persists with version, role and lock guards; rejected saves do not mutate schema", () => {
  const page = fixture(),
    d = database(page);
  const update = {
    action: "database.update",
    pageId: page,
    version: d.version,
    fields,
    views: [{ ...view, chart: { ...config, kind: "donut" } }],
  };
  assert.throws(() => act(update, viewer), /Berechtigung/);
  assert.throws(
    () => act({ ...update, version: d.version - 1 }),
    /zwischenzeitlich/,
  );
  assert.throws(() =>
    act({
      ...update,
      views: [{ ...view, chart: { ...config, aggregate: "sql" } }],
    }),
  );
  assert.deepEqual(database(page), d);
  act(update);
  assert.equal(database(page).views[0].chart?.kind, "donut");
  act({ action: "page.update", pageId: page, patch: { locked: true } });
  assert.throws(
    () => act({ ...update, version: database(page).version }),
    /gesperrt/,
  );
});
test("chart configuration and results survive duplication, templates, JSON/ZIP and restored snapshots", async () => {
  const page = fixture();
  const check = (target: string) => {
    const d = database(target);
    assert.deepEqual(d.views[0].chart, config);
    assert.deepEqual(
      chartPoints(
        queryRows(rows(target), d.fields, d.views[0]),
        d.fields,
        d.views[0].chart!,
      ).map((p) => [p.label, p.value]),
      [
        ["Done", -2],
        ["Open", 10],
      ],
    );
  };
  act({ action: "page.snapshot", pageId: page });
  check(act({ action: "page.duplicate", pageId: page }).id);
  const template = act({
    action: "template.save",
    pageId: page,
    name: "Chart template",
  }).id;
  check(
    act({
      action: "page.create",
      workspaceId: wid,
      spaceId: boot.spaces[0].id,
      title: "Chart instance",
      templateId: template,
    }).id,
  );
  check(
    act({
      action: "workspace.import",
      workspaceId: wid,
      spaceId: boot.spaces[0].id,
      backup: {
        format: "flowplan-1",
        pages: [
          {
            id: page,
            parent_id: null,
            title: "Chart JSON",
            kind: "database",
            data: { database: database(page), rows: rows(page) },
          },
        ],
      },
    }).pageIds[page],
  );
  const dest = createWorkspace(owner.id, "Chart restore"),
    imported = await importArchive(
      owner,
      dest,
      await exportArchive(owner, wid),
    ),
    restored = imported.pageIds[page];
  check(restored);
  const snapshot = one<{ id: string }>(
    "SELECT id FROM snapshots WHERE page_id=?",
    restored,
  )!.id;
  act({
    action: "database.update",
    pageId: restored,
    version: database(restored).version,
    fields,
    views: [{ ...view, chart: { ...config, kind: "line" } }],
  });
  act({ action: "snapshot.restore", pageId: restored, snapshotId: snapshot });
  check(restored);
});

test("data series split groups, merge long tails, keep multi-values per series and validate configuration", async () => {
  const { chartSeries, canStack, MAX_SERIES, OTHER_SERIES } =
    await import("../lib/database-chart");
  const rows = [
    row("a", { status: "Open", tags: ["X", "Y"], amount: 2 }),
    row("b", { status: "Open", tags: ["X"], amount: 3 }),
    row("c", { status: "Done", tags: [], amount: 5 }),
  ];
  const cfg: ChartConfig = {
    ...config,
    xField: "status",
    seriesField: "tags",
    aggregate: "sum",
  };
  const points = chartPoints(rows, fields, cfg);
  const { series, values } = chartSeries(points, fields, cfg);
  assert.deepEqual(
    series.map((s) => s.label),
    ["Ohne Wert", "X", "Y"],
  );
  const open = values.get('"Open"')!;
  assert.equal(open.get('"X"')!.value, 5);
  assert.equal(open.get('"Y"')!.value, 2);
  assert.equal(open.get("empty")!.value, null);
  assert.deepEqual(
    values
      .get('"Done"')!
      .get("empty")!
      .rows.map((r) => r.id),
    ["c"],
  );
  // Counts show zero instead of an empty value.
  const counts = chartSeries(
    chartPoints(rows, fields, { ...cfg, aggregate: "count" }),
    fields,
    { ...cfg, aggregate: "count" },
  );
  assert.equal(counts.values.get('"Done"')!.get('"X"')!.value, 0);
  assert.equal(canStack({ ...cfg, aggregate: "average" }), false);
  assert.equal(canStack(cfg), true);

  // More series than colors merge into "Weitere".
  const many = Array.from({ length: 20 }, (_, i) =>
    row(`m${i}`, { status: "Open", tags: [`T${String(i).padStart(2, "0")}`] }),
  );
  const big = chartSeries(
    chartPoints(many, fields, { ...cfg, aggregate: "count" }),
    fields,
    { ...cfg, aggregate: "count" },
  );
  assert.equal(big.series.length, MAX_SERIES);
  assert.equal(big.series.at(-1)!.key, OTHER_SERIES);
  assert.equal(
    big.values.get('"Open"')!.get(OTHER_SERIES)!.value,
    20 - (MAX_SERIES - 1),
  );

  assert.match(
    chartConfigError({ ...cfg, seriesField: "status" }, fields) || "",
    /Datenreihen/,
  );
  assert.match(
    chartConfigError({ ...cfg, seriesField: "missing" }, fields) || "",
    /Datenreihen/,
  );
  assert.deepEqual(
    chartSeries(points, fields, { ...cfg, seriesField: undefined }).series,
    [],
  );
  // Older configurations without series options stay valid.
  assert.equal(chartSchema.safeParse(defaultChart(fields)).success, true);
  assert.equal(
    chartSchema.safeParse({ ...cfg, seriesMode: "stacked", showLegend: false })
      .success,
    true,
  );
  assert.equal(
    chartSchema.safeParse({ ...cfg, seriesMode: "pie" }).success,
    false,
  );
});

test("chart style options validate palettes and grid visibility", () => {
  assert.equal(
    chartSchema.safeParse({ ...config, palette: "cool", showGrid: false })
      .success,
    true,
  );
  assert.equal(
    chartSchema.safeParse({ ...config, palette: "neon" }).success,
    false,
  );
});
