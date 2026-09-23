import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  aggregateRollup,
  allowedAggregates,
  rollupAggregates,
} from "../lib/rollups";
import { computedCells, queryRows } from "../lib/database";
import { databaseGroups, groupCellValue } from "../lib/database-groups";
import type { Field, Row, Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(
  join(tmpdir(), "flowplan-rollups-"),
);
const { id, run } = await import("../lib/db");
const { command, database, rows, pageData, bootstrap } =
  await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { exportArchive, importArchive } = await import("../lib/archive");
const makeRow = (
  id: string,
  page_id: string,
  cells: Record<string, unknown>,
): Row => ({
  id,
  page_id,
  cells,
  position: 0,
  version: 1,
  created_at: "2026-09-22",
  updated_at: "2026-09-23",
  created_by: "",
  updated_by: "",
});

test("rollups distinguish blanks, zeroes, unique values, booleans and dates across all calculations", () => {
  assert.equal(rollupAggregates.length, 22);
  const values = [10, null, 0, 20, ""];
  for (const [op, result] of Object.entries({
    count: 5,
    count_values: 3,
    count_unique: 3,
    count_empty: 2,
    count_not_empty: 3,
    percent_empty: 0.4,
    percent_not_empty: 0.6,
    sum: 30,
    average: 10,
    median: 10,
    min: 0,
    max: 20,
    range: 20,
  }))
    assert.equal(aggregateRollup(values, op as any), result, op);
  assert.equal(aggregateRollup([2, 4], "median"), 3);
  assert.equal(aggregateRollup([], "average"), null);
  assert.equal(aggregateRollup([], "sum"), 0);
  assert.equal(aggregateRollup([], "percent_checked"), 0);
  assert.equal(aggregateRollup([false, true, true, null], "count_checked"), 2);
  assert.equal(
    aggregateRollup([false, true, true, null], "count_unchecked"),
    2,
  );
  assert.equal(
    aggregateRollup([false, true, true, null], "percent_checked"),
    0.5,
  );
  assert.equal(
    aggregateRollup([false, true, true, null], "percent_unchecked"),
    0.5,
  );
  assert.deepEqual(
    aggregateRollup([["Red", "Blue"], ["Red"], []], "show_unique"),
    ["Red", "Blue"],
  );
  assert.deepEqual(aggregateRollup([["Red"], ["Red"]], "show_original"), [
    "Red",
    "Red",
  ]);
  assert.equal(
    aggregateRollup(["2026-09-23", null, "2026-09-20", "bad"], "earliest_date"),
    "2026-09-20",
  );
  assert.equal(
    aggregateRollup(["2026-09-23", "2026-09-20"], "latest_date"),
    "2026-09-23",
  );
  assert.equal(aggregateRollup(["2026-09-23", "2026-09-20"], "date_range"), 3);
  assert.ok(
    !allowedAggregates({ id: "x", name: "Text", type: "text" }).includes("sum"),
  );
});

test("nested rollups resolve formula dependencies, preserve filtering, and stop cycles or inaccessible targets", () => {
  const projectFields: Field[] = [
    { id: "title", name: "Projekt", type: "text" },
    { id: "tasks", name: "Aufgaben", type: "relation", relationPage: "tasks" },
    {
      id: "sum",
      name: "Summe",
      type: "rollup",
      relationField: "tasks",
      rollupField: "double",
      aggregate: "sum",
    },
    {
      id: "ratio",
      name: "Anteil",
      type: "formula",
      formula: 'prop("Summe") / 10',
    },
  ];
  const taskFields: Field[] = [
    { id: "hours", name: "Aufwand", type: "number" },
    {
      id: "double",
      name: "Doppelt",
      type: "formula",
      formula: 'prop("Aufwand") * 2',
    },
  ];
  const project = makeRow("p", "projects", {
    title: "Projekt",
    tasks: ["a", "b"],
  });
  const related = {
    tasks: [
      makeRow("a", "tasks", { hours: 2 }),
      makeRow("b", "tasks", { hours: 3 }),
    ],
  };
  const schemas = { tasks: taskFields };
  assert.equal(computedCells(project, projectFields, related, schemas).sum, 10);
  assert.equal(
    computedCells(project, projectFields, related, schemas).ratio,
    1,
  );
  assert.equal(
    queryRows(
      [project],
      projectFields,
      {
        id: "view",
        name: "View",
        type: "table",
        filters: [{ field: "sum", op: "gt", value: "9" }],
        sorts: [],
      },
      "",
      related,
      schemas,
    ).length,
    1,
  );
  assert.equal(
    computedCells(project, projectFields, {}, schemas).sum,
    "#ACCESS",
  );
  assert.equal(
    computedCells(project, projectFields, related, { tasks: [] }).sum,
    "#PROPERTY",
  );
  const cyclic: Field[] = [
    { id: "a", name: "A", type: "formula", formula: 'prop("B")' },
    { id: "b", name: "B", type: "formula", formula: 'prop("A")' },
  ];
  assert.equal(computedCells(project, cyclic).a, "#CYCLE");
  const selfFields: Field[] = [
    { id: "link", name: "Link", type: "relation", relationPage: "projects" },
    {
      id: "sum",
      name: "Sum",
      type: "rollup",
      relationField: "link",
      rollupField: "sum",
      aggregate: "sum",
    },
  ];
  const self = makeRow("self", "projects", { link: ["self"] });
  assert.equal(
    computedCells(
      self,
      selfFields,
      { projects: [self] },
      { projects: selfFields },
    ).sum,
    "#CYCLE",
  );
});

test("relation and multiselect board groups use labels and preserve unrelated links on a move", () => {
  const field: Field = {
    id: "link",
    name: "Projekte",
    type: "relation",
    relationPage: "projects",
  };
  const records = [
    makeRow("a", "tasks", { link: ["p", "q"] }),
    makeRow("b", "tasks", { link: [] }),
  ];
  const groups = databaseGroups(records, field, {
    projects: [
      makeRow("p", "projects", { title: "Alpha" }),
      makeRow("q", "projects", { title: "Beta" }),
    ],
  });
  assert.deepEqual(
    groups.map((g) => g.label),
    ["Alpha", "Beta", "Ohne Gruppe"],
  );
  assert.equal(groups[0].rows[0].id, "a");
  assert.equal(groups[1].rows[0].id, "a");
  const view = {
    id: "view",
    name: "View",
    type: "table" as const,
    filters: [],
    sorts: [],
  };
  const related = { projects: [makeRow("p", "projects", { title: "Alpha" })] };
  assert.equal(queryRows(records, [field], view, "Alpha", related).length, 1);
  assert.equal(
    queryRows(records, [field], {
      ...view,
      filters: [{ field: "link", op: "eq", value: "p" }],
    }).length,
    1,
  );
  assert.equal(
    queryRows(records, [field], {
      ...view,
      filters: [{ field: "link", op: "neq", value: "p" }],
    }).length,
    1,
  );
  assert.deepEqual(
    groupCellValue(field, "r", ["p", "q"], JSON.stringify("p")),
    ["q", "r"],
  );
  assert.deepEqual(groupCellValue(field, null, ["p", "q"]), []);
  assert.equal(
    databaseGroups(records, field, {}).some((g) => g.label === "p"),
    false,
  );
});

function user(name: string): Identity {
  const uid = id();
  run(
    "INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)",
    uid,
    uid,
    name,
    `${name}@example.com`,
  );
  return {
    id: uid,
    name,
    email: `${name}@example.com`,
    isAdmin: false,
    groups: [],
    disabled: 0,
    created_at: "",
  };
}
const owner = user("owner"),
  editor = user("editor"),
  wid = createWorkspace(owner.id, "Relations"),
  boot = bootstrap(owner, wid);
run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
function create(title: string, extra = {}) {
  return (
    command(owner, {
      action: "page.create",
      workspaceId: wid,
      spaceId: boot.spaces[0].id,
      kind: "database",
      title,
      ...extra,
    }) as { id: string }
  ).id;
}
function schema(pageId: string, fields: Field[]) {
  const d = database(pageId);
  command(owner, {
    action: "database.update",
    pageId,
    version: d.version,
    fields,
    views: d.views,
  });
}

test("rollup configuration validates actual target properties and related data respects nested private access", () => {
  const target = create("Hours"),
    source = create("Projects"),
    document = create("Document", { kind: "document" });
  schema(target, [
    { id: "title", name: "Title", type: "text" },
    { id: "hours", name: "Hours", type: "number" },
  ]);
  const fields: Field[] = [
    { id: "title", name: "Title", type: "text" },
    { id: "linked", name: "Tasks", type: "relation", relationPage: target },
    {
      id: "total",
      name: "Total",
      type: "rollup",
      relationField: "linked",
      rollupField: "hours",
      aggregate: "sum",
      rollupDisplay: "ring",
      rollupMax: 20,
    },
  ];
  schema(source, fields);
  assert.throws(
    () =>
      schema(
        source,
        fields.map((f) =>
          f.id === "total" ? { ...f, rollupField: "missing" } : f,
        ),
      ),
    /Eigenschaft fehlt/,
  );
  assert.throws(
    () =>
      schema(
        source,
        fields.map((f) =>
          f.id === "linked" ? { ...f, relationPage: document } : f,
        ),
      ),
    /Datenbank/,
  );
  assert.throws(
    () =>
      schema(
        source,
        fields.map((f) =>
          f.id === "total" ? { ...f, rollupField: "title" } : f,
        ),
      ),
    /Berechnung/,
  );
  const task = command(owner, {
    action: "row.create",
    pageId: target,
    cells: { title: "Secret task", hours: 8 },
  }) as { id: string };
  const project = command(owner, {
    action: "row.create",
    pageId: source,
    cells: { title: "Project", linked: [task.id] },
  }) as { id: string };
  const before = pageData(editor, source) as any;
  assert.equal(
    computedCells(before.rows[0], fields, before.related, before.relatedSchemas)
      .total,
    8,
  );
  const privateSpace = command(owner, {
    action: "space.create",
    workspaceId: wid,
    name: "Private",
    private: true,
  }) as { id: string };
  run("UPDATE pages SET space_id=? WHERE id=?", privateSpace.id, target);
  const after = pageData(editor, source) as any;
  assert.equal(after.related[target], undefined);
  assert.equal(after.relatedSchemas[target], undefined);
  assert.equal(
    computedCells(after.rows[0], fields, after.related, after.relatedSchemas)
      .total,
    "#ACCESS",
  );
  assert.throws(
    () =>
      command(editor, {
        action: "row.update",
        pageId: source,
        rowId: project.id,
        version: 1,
        cells: { linked: [task.id] },
      }),
    /Berechtigung/,
  );
  const d = database(source);
  command(editor, {
    action: "database.update",
    pageId: source,
    version: d.version,
    fields: d.fields,
    views: d.views.map((v) => ({ ...v, name: "Renamed" })),
  });
});

test("rollup settings and computed results survive archive round trips", async () => {
  const from = create("Archive source"),
    to = create("Archive target");
  schema(to, [
    { id: "title", name: "Title", type: "text" },
    { id: "done", name: "Done", type: "checkbox" },
  ]);
  schema(from, [
    { id: "title", name: "Title", type: "text" },
    { id: "items", name: "Items", type: "relation", relationPage: to },
    {
      id: "progress",
      name: "Progress",
      type: "rollup",
      relationField: "items",
      rollupField: "done",
      aggregate: "percent_checked",
      rollupDisplay: "bar",
      rollupMax: 1,
    },
  ]);
  const a = command(owner, {
    action: "row.create",
    pageId: to,
    cells: { title: "A", done: true },
  }) as { id: string };
  command(owner, {
    action: "row.create",
    pageId: from,
    cells: { title: "Project", items: [a.id] },
  });
  const dest = createWorkspace(owner.id, "Restored");
  const result = await importArchive(
    owner,
    dest,
    await exportArchive(owner, wid),
  );
  const restored = pageData(owner, result.pageIds[from]) as any;
  assert.equal(restored.database.fields[2].aggregate, "percent_checked");
  assert.equal(restored.database.fields[2].rollupDisplay, "bar");
  assert.equal(
    computedCells(
      restored.rows[0],
      restored.database.fields,
      restored.related,
      restored.relatedSchemas,
    ).progress,
    1,
  );
});
