import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  columnSummary,
  calculationOptions,
  columnCalculations,
  summaryText,
  validateCalculations,
  calculationsSchema,
  calculationFor,
} from "../lib/database-summary";
import { view as viewSchema } from "../lib/database-schema";
import { computedCells, queryRows } from "../lib/database";
import { databaseGroups } from "../lib/database-groups";
import { availableLinkedViews } from "../lib/linked-views";
import { htmlState, escaped } from "../lib/document-server";
import type { Field, Row, View, Identity } from "../lib/types";
const field = (type: Field["type"]): Field => ({
  id: "value",
  name: "Wert",
  type,
});
const rowsFor = (...values: unknown[]): Row[] =>
  values.map((value, i) => ({
    id: String(i),
    page_id: "page",
    cells: { value },
    position: i,
    created_at: "",
    updated_at: "",
    created_by: "",
    updated_by: "",
    version: 1,
  }));
const baseView: View = {
  id: "table",
  name: "Table",
  type: "table",
  filters: [],
  sorts: [],
};
test("imported property IDs never read inherited settings or alter result prototypes", () => {
  for (const id of ["constructor", "toString", "__proto__"]) {
    const f = { ...field("number"), id };
    const config = calculationsSchema.parse(Object.fromEntries([[id, "sum"]]));
    assert.equal(Object.hasOwn(config, id), true);
    assert.equal(calculationFor(config, id), "sum");
    assert.equal(calculationFor({}, id), undefined);
    const source = { ...rowsFor(0)[0], cells: Object.fromEntries([[id, 2]]) };
    const cells = computedCells(source, [f]);
    assert.equal(Object.getPrototypeOf(cells), Object.prototype);
    assert.equal(Object.hasOwn(cells, id), true);
    assert.equal(cells[id], 2);
    assert.equal(
      columnSummary(f, [{ ...source, cells }], calculationFor(config, id))!
        .value,
      2,
    );
    assert.equal(
      columnSummary(f, [
        { ...source, cells: computedCells({ ...source, cells: {} }, [f]) },
      ])!.value,
      0,
    );
  }
  assert.equal(calculationsSchema.safeParse([["x", "sum"]]).success, false);
});
test("column calculation schemas constrain operations, count and field types", () => {
  assert.equal(columnCalculations.length, 20);
  assert.equal(
    viewSchema.safeParse({ ...baseView, calculations: { value: "eval" } })
      .success,
    false,
  );
  assert.equal(
    viewSchema.safeParse({
      ...baseView,
      calculations: Object.fromEntries(
        Array.from({ length: 81 }, (_, i) => [String(i), "sum"]),
      ),
    }).success,
    false,
  );
  assert.equal(
    viewSchema.safeParse({ ...baseView, calculations: { value: "none" } })
      .success,
    true,
  );
  assert.equal(calculationOptions(field("text")).includes("sum"), false);
  assert.equal(
    calculationOptions(field("checkbox")).includes("percent_checked"),
    true,
  );
  assert.equal(
    calculationOptions(field("formula")).includes("earliest_date"),
    true,
  );
  assert.throws(
    () => validateCalculations({ missing: "count" }, [field("number")]),
    /unbekannte/,
  );
  assert.deepEqual(
    validateCalculations({ value: "sum" }, [field("text")], [field("number")]),
    {},
  );
});
test("numeric column calculations handle zeros, empty cells, invalid values and finite statistics", () => {
  const f = field("number"),
    rows = rowsFor(0, 2, 4, null, "", "bad");
  for (const [operation, expected] of Object.entries({
    sum: 6,
    average: 2,
    median: 2,
    min: 0,
    max: 4,
    range: 4,
  })) {
    const result = columnSummary(f, rows, operation as "sum")!;
    assert.equal(result.value, expected, operation);
    assert.equal(result.errors, 1);
  }
  assert.equal(columnSummary(f, [], "sum")!.value, 0);
  assert.equal(columnSummary(f, [], "average")!.value, null);
  assert.equal(
    columnSummary(f, rowsFor(Number.MIN_VALUE, Number.MIN_VALUE), "average")!
      .value,
    Number.MIN_VALUE,
  );
  assert.equal(
    columnSummary(f, rowsFor(Number.MIN_VALUE, Number.MIN_VALUE), "median")!
      .value,
    Number.MIN_VALUE,
  );
  assert.equal(
    columnSummary(f, rowsFor(Number.MAX_VALUE, Number.MAX_VALUE), "sum")!
      .overflow,
    true,
  );
  assert.equal(
    columnSummary(f, rowsFor(Number.MAX_VALUE, Number.MAX_VALUE), "average")!
      .value,
    Number.MAX_VALUE,
  );
  assert.equal(
    columnSummary(f, rowsFor(-Number.MAX_VALUE, Number.MAX_VALUE), "median")!
      .value,
    0,
  );
  assert.equal(
    columnSummary(f, rowsFor(-Number.MAX_VALUE, Number.MAX_VALUE), "range")!
      .overflow,
    true,
  );
  assert.equal(columnSummary(f, rows, "none"), null);
  assert.match(
    summaryText(columnSummary(f, rows, "sum")!),
    /Σ 6 \(1 fehlerhaft\)/,
  );
});
test("count and percentage calculations distinguish row counts, empty cells and list values", () => {
  const f = field("multiselect"),
    rows = rowsFor(["A", "B"], ["A"], [], null);
  for (const [operation, expected] of Object.entries({
    count: 4,
    count_values: 3,
    count_unique: 2,
    count_empty: 2,
    count_not_empty: 2,
    percent_empty: 0.5,
    percent_not_empty: 0.5,
  }))
    assert.equal(
      columnSummary(f, rows, operation as "count")!.value,
      expected,
      operation,
    );
  assert.equal(
    columnSummary(field("number"), rowsFor(0, null), "count_not_empty")!.value,
    1,
  );
  assert.equal(columnSummary(f, [], "percent_empty")!.value, 0);
  assert.match(summaryText(columnSummary(f, rows, "percent_empty")!), /50\s?%/);
  assert.equal(
    columnSummary(field("text"), rowsFor("#ERROR"), "count_not_empty")!.value,
    1,
  );
});
test("checkbox percentages treat missing values as unchecked and report invalid computed values", () => {
  const f = field("checkbox"),
    rows = rowsFor(true, false, null, "bad");
  assert.equal(columnSummary(f, rows, "count_checked")!.value, 1);
  assert.equal(columnSummary(f, rows, "count_unchecked")!.value, 2);
  assert.equal(columnSummary(f, rows, "percent_checked")!.value, 1 / 3);
  assert.equal(columnSummary(f, rows, "percent_unchecked")!.errors, 1);
  assert.equal(columnSummary(f, rowsFor(false), "count_not_empty")!.value, 1);
});
test("date calculations compare ISO instants in UTC, reject impossible dates and normalize metadata", () => {
  const f = field("date"),
    rows = rowsFor(
      "2026-03-29T01:00+01:00",
      "2026-03-30T02:00+02:00",
      "2026-02-30",
      null,
    );
  assert.equal(columnSummary(f, rows, "date_range")!.value, 1);
  assert.equal(
    columnSummary(f, rows, "earliest_date")!.value,
    "2026-03-29T01:00+01:00",
  );
  assert.equal(columnSummary(f, rows, "latest_date")!.errors, 1);
  assert.equal(
    columnSummary(f, rowsFor("2026-09-23", "2026-09-24"), "date_range")!.value,
    1,
  );
  assert.equal(
    columnSummary(
      field("created_at"),
      rowsFor("2026-09-23 12:30:00"),
      "earliest_date",
    )!.value,
    "2026-09-23T12:30:00Z",
  );
  assert.equal(
    columnSummary(f, rowsFor("2026-09-23T12:30"), "earliest_date")!.value,
    "2026-09-23T12:30Z",
  );
  assert.match(
    summaryText(columnSummary(f, rows, "earliest_date")!),
    /UTC\+00:00/,
  );
});
test("formula and access errors are disclosed and excluded without coercing text into numbers", () => {
  const f = field("formula"),
    rows = rowsFor(2, "#ACCESS", "#DIV/0", "3");
  assert.equal(columnSummary(f, rows, "sum")!.value, 2);
  assert.equal(columnSummary(f, rows, "sum")!.errors, 3);
  assert.equal(columnSummary(f, rows, "count")!.value, 4);
  assert.equal(columnSummary(f, rows, "count_not_empty")!.value, 2);
  assert.equal(columnSummary(f, rows, "percent_not_empty")!.value, 1);
  assert.equal(columnSummary(f, rows), null);
  const computed = computedCells(rowsFor(0)[0], [
    field("number"),
    { id: "f", name: "F", type: "formula", formula: "1/value" },
  ]);
  assert.equal(
    columnSummary(
      { ...f, id: "f" },
      [{ ...rowsFor(0)[0], cells: computed }],
      "sum",
    )!.errors,
    1,
  );
});
test("summaries follow filtered rows and multi-valued groups without double counting the overall result", () => {
  const fields: Field[] = [
    field("number"),
    { id: "tags", name: "Tags", type: "multiselect", options: ["A", "B"] },
  ];
  const rows = rowsFor(1, 3, 5).map((row, i) => ({
    ...row,
    cells: { ...row.cells, tags: i === 1 ? ["A", "B"] : ["A"] },
  }));
  const filtered = queryRows(rows, fields, {
    ...baseView,
    filters: [{ field: "value", op: "gt", value: "1" }],
  });
  assert.equal(columnSummary(fields[0], filtered, "sum")!.value, 8);
  const groups = databaseGroups(filtered, fields[1], {}, []);
  assert.deepEqual(
    groups
      .map((group) => columnSummary(fields[0], group.rows, "sum")!.value)
      .sort(),
    [0, 3, 8],
  );
  assert.equal(columnSummary(fields[0], filtered, "sum")!.value, 8);
});

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(
  join(tmpdir(), "flowplan-calculations-"),
);
const { id, run, one } = await import("../lib/db");
const { command, database, rows, bootstrap } = await import("../lib/api");
const { linkedDatabaseData } = await import("../lib/linked-databases");
const { createWorkspace } = await import("../lib/seed");
const { exportArchive, importArchive } = await import("../lib/archive");
function user(): Identity {
  const uid = id();
  run(
    "INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)",
    uid,
    uid,
    "Calculations",
    `${uid}@test.invalid`,
  );
  return {
    id: uid,
    name: "Calculations",
    email: `${uid}@test.invalid`,
    disabled: 0,
    created_at: "",
    isAdmin: false,
    groups: [],
  };
}
const owner = user(),
  viewer = user(),
  wid = createWorkspace(owner.id, "Calculations"),
  sid = bootstrap(owner, wid).spaces[0].id;
run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const act = (data: Record<string, unknown>, actor = owner): any =>
  command(actor, data);
const fields: Field[] = [
  { id: "title", name: "Name", type: "text" },
  field("number"),
];
const configured: View = {
  ...baseView,
  calculations: { title: "count", value: "average" },
};
function fixture() {
  const pid = act({
    action: "page.create",
    workspaceId: wid,
    spaceId: sid,
    kind: "database",
    title: "Calculation fixture",
  }).id;
  act({
    action: "database.update",
    pageId: pid,
    version: 1,
    fields,
    views: [
      configured,
      { ...baseView, id: "other", calculations: { value: "max" } },
    ],
  });
  act({ action: "row.create", pageId: pid, cells: { title: "A", value: 4 } });
  return pid as string;
}
test("server protects calculation settings with rights, locks and versions and cleans changed properties", () => {
  const pid = fixture(),
    input = {
      action: "database.update",
      pageId: pid,
      version: database(pid).version,
      fields,
      views: [configured],
    };
  assert.throws(() => act(input, viewer), /Berechtigung/);
  assert.throws(() => act({ ...input, version: 0 }), /geändert/);
  assert.throws(
    () =>
      act({
        ...input,
        views: [{ ...configured, calculations: { missing: "count" } }],
      }),
    /Berechnung/,
  );
  assert.throws(
    () =>
      act({
        ...input,
        views: [{ ...configured, calculations: { title: "sum" } }],
      }),
    /Berechnung/,
  );
  run("UPDATE pages SET locked=1 WHERE id=?", pid);
  assert.throws(() => act(input), /gesperrt/);
  run("UPDATE pages SET locked=0 WHERE id=?", pid);
  act({ ...input, fields: [fields[0], field("text")] });
  assert.deepEqual(database(pid).views[0].calculations, { title: "count" });
  act({ ...input, version: database(pid).version, fields: [fields[0]] });
  assert.deepEqual(database(pid).views[0].calculations, { title: "count" });
});
test("linked calculations remain independent, reject invalid settings and follow source property removal", () => {
  const pid = fixture(),
    host = act({
      action: "page.create",
      workspaceId: wid,
      spaceId: sid,
      title: "Linked",
      kind: "document",
    }).id,
    blockId = id();
  const html = `<div data-linked-database="${blockId}" data-linked-source="${pid}" data-linked-version="1" data-linked-views="${escaped(JSON.stringify([baseView]))}">Linked</div>`;
  run(
    "UPDATE documents SET html=?,state=? WHERE page_id=?",
    html,
    htmlState(html),
    host,
  );
  const input = {
    action: "linked.command",
    pageId: host,
    blockId,
    generation: "1",
    sourceVersion: database(pid).version,
    mutation: {
      action: "database.update",
      version: 1,
      fields: database(pid).fields,
      views: [{ ...baseView, calculations: { value: "median" } }],
    },
  };
  assert.throws(() => act(input, viewer), /Berechtigung/);
  act(input);
  assert.equal(
    linkedDatabaseData(owner, host, blockId).database.views[0].calculations
      ?.value,
    "median",
  );
  assert.equal(database(pid).views[0].calculations?.value, "average");
  assert.throws(() => act(input), /Einbettung/);
  assert.throws(
    () =>
      act({
        ...input,
        mutation: {
          ...input.mutation,
          version: 2,
          views: [{ ...baseView, calculations: { title: "sum" } }],
        },
      }),
    /Berechnung/,
  );
  assert.deepEqual(
    availableLinkedViews(
      [{ ...baseView, calculations: { value: "sum", title: "count" } }],
      [fields[0]],
      [],
    )[0].calculations,
    { title: "count" },
  );
  act({
    action: "database.update",
    pageId: pid,
    version: database(pid).version,
    fields: [fields[0]],
    views: database(pid).views,
  });
  assert.deepEqual(
    linkedDatabaseData(owner, host, blockId).database.views[0].calculations,
    {},
  );
});
test("calculation preferences survive independent view copies, templates, snapshots and ZIP restoration", async () => {
  const pid = fixture(),
    expected = database(pid).views.map((view) => view.calculations);
  const check = (target: string) =>
    assert.deepEqual(
      database(target).views.map((view) => view.calculations),
      expected,
    );
  check(act({ action: "page.duplicate", pageId: pid }).id);
  const templateId = act({
    action: "template.save",
    pageId: pid,
    name: "Calculations",
  }).id;
  check(
    act({
      action: "page.create",
      workspaceId: wid,
      spaceId: sid,
      title: "Template copy",
      templateId,
    }).id,
  );
  act({ action: "page.snapshot", pageId: pid });
  const snapshotId = one<{ id: string }>(
    "SELECT id FROM snapshots WHERE page_id=? ORDER BY rowid DESC",
    pid,
  )!.id;
  act({
    action: "database.update",
    pageId: pid,
    version: database(pid).version,
    fields,
    views: [baseView],
  });
  act({ action: "snapshot.restore", pageId: pid, snapshotId });
  check(pid);
  const target = createWorkspace(owner.id, "Restored"),
    imported = await importArchive(
      owner,
      target,
      await exportArchive(owner, wid),
    );
  check(imported.pageIds[pid]);
  assert.equal(rows(imported.pageIds[pid]).length, 1);
});
