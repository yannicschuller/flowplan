import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  databaseGroups,
  configuredGroups,
  groupKey,
  groupCellValue,
  groupingField,
} from "../lib/database-groups";
import { queryRows } from "../lib/database";
import { view as viewSchema } from "../lib/database-schema";
import type { Field, View, Row, Identity } from "../lib/types";
const fields: Field[] = [
  { id: "title", name: "Name", type: "text" },
  {
    id: "status",
    name: "Status",
    type: "select",
    options: ["Open", "Done", "Empty"],
  },
  { id: "tags", name: "Tags", type: "multiselect", options: ["A", "B", "C"] },
  { id: "amount", name: "Aufwand", type: "number" },
];
const view: View = {
  id: "table",
  name: "Tabelle",
  type: "table",
  filters: [],
  sorts: [],
  groupBy: "status",
  groupSettings: { hideEmpty: true, sort: "manual", collapsed: ['"Open"'] },
};
const sample = (id: string, cells: Record<string, unknown>): Row => ({
  id,
  cells,
  page_id: "p",
  position: 0,
  version: 1,
  created_at: "",
  updated_at: "",
  created_by: "",
  updated_by: "",
});
test("table/list groups retain configured options, deduplicate memberships and hide empty groups by default", () => {
  const rows = [
    sample("a", { status: "Open", tags: ["A", "B", "A"] }),
    sample("b", { status: "Done", tags: [null, ""] }),
  ];
  const groups = databaseGroups(rows, fields[1], {});
  assert.deepEqual(
    groups.map((g) => g.label),
    ["Open", "Done", "Empty", "Ohne Gruppe"],
  );
  assert.deepEqual(
    configuredGroups(groups, { ...view, groupSettings: undefined }).map(
      (g) => g.label,
    ),
    ["Open", "Done"],
  );
  assert.equal(
    configuredGroups(groups, {
      ...view,
      type: "list",
      groupSettings: undefined,
    }).length,
    2,
  );
  assert.equal(
    configuredGroups(groups, {
      ...view,
      type: "board",
      groupSettings: undefined,
    }).length,
    4,
  );
  assert.deepEqual(
    configuredGroups(groups, {
      ...view,
      groupSettings: { ...view.groupSettings!, sort: "asc" },
    }).map((g) => g.label),
    ["Done", "Open"],
  );
  assert.deepEqual(
    databaseGroups(rows, fields[2], {})
      .find((g) => g.key === '"A"')!
      .rows.map((r) => r.id),
    ["a"],
  );
  assert.equal(
    databaseGroups(rows, fields[2], {}).find((g) => g.key === "empty")!.rows
      .length,
    1,
  );
  assert.deepEqual(groupCellValue(fields[2], "C", ["A", "B"], '"A"'), [
    "B",
    "C",
  ]);
});
test("group keys are bounded for long values; member/checkbox groups are meaningful and non-groupable fields stay flat", () => {
  const raw = "Very long ".repeat(1000),
    key = groupKey(raw);
  assert.ok(key.length < 100);
  assert.notEqual(key, groupKey(raw + "!"));
  assert.equal(
    databaseGroups([sample("a", { title: raw })], fields[0], {})[0].key,
    key,
  );
  assert.deepEqual(groupCellValue(fields[2], "Next", [raw, "Keep"], key), [
    "Keep",
    "Next",
  ]);
  const person: Field = { id: "who", name: "Who", type: "person" },
    checkbox: Field = { id: "check", name: "Check", type: "checkbox" };
  assert.equal(
    databaseGroups([sample("a", { who: "u" })], person, {}, [
      { id: "u", name: "Ada" },
    ])[0].label,
    "Ada",
  );
  const checks = databaseGroups(
    [sample("a", {}), sample("b", { check: true })],
    checkbox,
    {},
  );
  assert.deepEqual(
    checks.map((g) => [g.label, g.rows.length]),
    [
      ["Nicht abgehakt", 1],
      ["Abgehakt", 1],
    ],
  );
  assert.equal(groupingField(fields, { ...view, groupBy: "" }), undefined);
  assert.equal(
    groupingField(fields, { ...view, groupBy: "", type: "board" })?.id,
    "status",
  );
  assert.equal(
    groupingField([{ id: "file", name: "File", type: "files" }], {
      ...view,
      groupBy: "file",
    }),
    undefined,
  );
  assert.equal(
    viewSchema.safeParse({
      ...view,
      groupSettings: { ...view.groupSettings, collapsed: ["same", "same"] },
    }).success,
    false,
  );
});
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-groups-"));
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
  wid = createWorkspace(owner.id, "Grouped views"),
  boot = bootstrap(owner, wid);
run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const act = (body: Record<string, unknown>, as = owner): any =>
  command(as, body);
const create = () =>
  act({
    action: "page.create",
    workspaceId: wid,
    spaceId: boot.spaces[0].id,
    title: "Grouped database",
    kind: "database",
  }).id as string;
function schema(pageId: string, views: View[], nextFields = fields) {
  act({
    action: "database.update",
    pageId,
    version: database(pageId).version,
    fields: nextFields,
    views,
  });
}
function fixture() {
  const page = create();
  schema(page, [
    view,
    { ...view, id: "list", type: "list", groupBy: "tags" },
    { ...view, id: "plain", groupBy: undefined },
  ]);
  const a = act({
      action: "row.create",
      pageId: page,
      cells: { title: "Alpha", status: "Open", tags: ["A", "B"], amount: 4 },
    }).id,
    b = act({
      action: "row.create",
      pageId: page,
      cells: { title: "Beta", status: "Done", tags: ["C"], amount: 2 },
    }).id;
  return { page, a, b };
}
test("grouped table/list moves atomically update membership and order while preserving other memberships and view independence", () => {
  const { page, a, b } = fixture();
  act({
    action: "row.move",
    pageId: page,
    viewId: "table",
    version: database(page).version,
    rowId: a,
    rowVersion: 1,
    targetId: b,
    placement: "after",
    group: { from: '"Open"', to: '"Done"' },
  });
  assert.equal(rows(page).find((r) => r.id === a)!.cells.status, "Done");
  assert.deepEqual(database(page).views[0].rowOrder, [b, a]);
  assert.equal(database(page).views[1].rowOrder, undefined);
  act({
    action: "row.move",
    pageId: page,
    viewId: "list",
    version: database(page).version,
    rowId: a,
    rowVersion: 2,
    targetId: b,
    placement: "before",
    group: { from: '"A"', to: '"C"' },
  });
  assert.deepEqual(rows(page).find((r) => r.id === a)!.cells.tags, ["B", "C"]);
  assert.deepEqual(database(page).views[1].rowOrder, [a, b]);
  assert.deepEqual(
    queryRows(rows(page), fields, database(page).views[0]).map((r) => r.id),
    [b, a],
  );
});
test("grouped moves reject stale/foreign groups, plain views, viewers and locked pages without partial changes", () => {
  const { page, a, b } = fixture(),
    d = database(page),
    before = rows(page);
  const move = {
    action: "row.move",
    pageId: page,
    viewId: "table",
    version: d.version,
    rowId: a,
    rowVersion: 1,
    targetId: b,
    placement: "before",
    group: { from: '"Open"', to: '"Done"' },
  };
  assert.throws(() => act(move, viewer), /Berechtigung/);
  assert.throws(() => act({ ...move, viewId: "plain" }), /Gruppe/);
  assert.throws(
    () => act({ ...move, group: { from: '"Done"', to: '"Open"' } }),
    /Gruppenzuordnung/,
  );
  assert.throws(() => act({ ...move, version: 0 }));
  assert.deepEqual(rows(page), before);
  assert.deepEqual(database(page), d);
  act({ action: "page.update", pageId: page, patch: { locked: true } });
  assert.throws(() => act(move), /gesperrt/);
});
test("collapsed relation groups remap through page copies, templates, JSON/ZIP and snapshots", async () => {
  const page = create(),
    nextFields: Field[] = [
      fields[0],
      { id: "link", name: "Relation", type: "relation", relationPage: page },
    ];
  schema(page, [{ ...view, groupBy: "link" }], nextFields);
  const a = act({
    action: "row.create",
    pageId: page,
    cells: { title: "Referenced" },
  }).id;
  act({
    action: "row.create",
    pageId: page,
    cells: { title: "Linked", link: [a] },
  });
  schema(
    page,
    [
      {
        ...view,
        groupBy: "link",
        groupSettings: {
          hideEmpty: false,
          sort: "desc",
          collapsed: [JSON.stringify(a)],
        },
      },
    ],
    nextFields,
  );
  const check = (target: string) => {
    const d = database(target),
      targetId = rows(target).find((r) => r.cells.title === "Referenced")!.id;
    assert.equal(d.views[0].groupBy, "link");
    assert.deepEqual(d.views[0].groupSettings, {
      hideEmpty: false,
      sort: "desc",
      collapsed: [JSON.stringify(targetId)],
    });
    if (target !== page) assert.notEqual(targetId, a);
  };
  act({ action: "page.snapshot", pageId: page });
  check(act({ action: "page.duplicate", pageId: page }).id);
  const template = act({
    action: "template.save",
    pageId: page,
    name: "Grouped template",
  }).id;
  check(
    act({
      action: "page.create",
      workspaceId: wid,
      spaceId: boot.spaces[0].id,
      title: "Grouped copy",
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
            title: "Grouped JSON",
            kind: "database",
            data: { database: database(page), rows: rows(page) },
          },
        ],
      },
    }).pageIds[page],
  );
  const dest = createWorkspace(owner.id, "Restored groups"),
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
  schema(
    restored,
    [{ ...view, groupBy: undefined }],
    database(restored).fields,
  );
  act({ action: "snapshot.restore", pageId: restored, snapshotId: snapshot });
  check(restored);
});

test("manual group order keeps unlisted groups in their natural slot and survives relation remaps", async () => {
  const { orderedGroups, moveGroupOrder } =
    await import("../lib/database-groups");
  const { remapViewReferences } = await import("../lib/view-references");
  const groups = databaseGroups(
    [sample("a", { status: "Open" }), sample("b", { status: "Done" })],
    fields[1],
    {},
  );
  const keys = groups.map((g) => g.key);
  assert.deepEqual(keys, ['"Open"', '"Done"', '"Empty"', "empty"]);
  const ordered = (order: string[]) =>
    configuredGroups(groups, {
      ...view,
      type: "board",
      groupSettings: { hideEmpty: false, sort: "manual", collapsed: [], order },
    }).map((g) => g.key);
  assert.deepEqual(ordered(['"Done"', '"Open"']), [
    '"Done"',
    '"Open"',
    '"Empty"',
    "empty",
  ]);
  // A new option inserted between saved keys keeps its property slot.
  assert.deepEqual(ordered(['"Empty"', '"Open"']), [
    '"Empty"',
    '"Done"',
    '"Open"',
    "empty",
  ]);
  // Stale keys of removed options are ignored.
  assert.deepEqual(ordered(['"Gone"', "empty", '"Open"']), [
    "empty",
    '"Done"',
    '"Empty"',
    '"Open"',
  ]);
  // Alphabetical sort still overrides the saved order.
  assert.deepEqual(
    configuredGroups(groups, {
      ...view,
      type: "board",
      groupSettings: {
        hideEmpty: false,
        sort: "asc",
        collapsed: [],
        order: ["empty"],
      },
    }).map((g) => g.label),
    ["Done", "Empty", "Ohne Gruppe", "Open"],
  );
  assert.deepEqual(orderedGroups([{ key: "x" }], []), [{ key: "x" }]);

  // Moving within displayed groups retains saved keys of hidden groups.
  assert.deepEqual(
    moveGroupOrder(['"Open"', '"Done"'], ['"Hidden"', '"Done"'], '"Done"', 0),
    ['"Done"', '"Open"', '"Hidden"'],
  );
  assert.equal(moveGroupOrder(['"Open"'], [], '"Open"', 1), null);
  assert.equal(moveGroupOrder(['"Open"'], [], '"Missing"', 0), null);

  assert.equal(
    viewSchema.safeParse({
      ...view,
      groupSettings: { ...view.groupSettings, order: ["a", "a"] },
    }).success,
    false,
  );
  assert.equal(
    viewSchema.safeParse({
      ...view,
      groupSettings: { ...view.groupSettings, order: ['"Done"'] },
    }).success,
    true,
  );

  const relationFields: Field[] = [
    { id: "title", name: "Name", type: "text" },
    { id: "rel", name: "Projekt", type: "relation", relationPage: "p2" },
  ];
  const [remapped] = remapViewReferences(
    [
      {
        ...view,
        groupBy: "rel",
        groupSettings: {
          hideEmpty: false,
          sort: "manual",
          collapsed: ['"old-1"'],
          order: ['"old-2"', '"old-1"', "empty"],
        },
      },
    ],
    relationFields,
    new Map([
      ["old-1", "new-1"],
      ["old-2", "new-2"],
    ]),
  );
  assert.deepEqual(remapped.groupSettings?.order, [
    '"new-2"',
    '"new-1"',
    "empty",
  ]);
  assert.deepEqual(remapped.groupSettings?.collapsed, ['"new-1"']);
});

test("subgroups nest a second property, move across both levels atomically and remap collapsed keys", async () => {
  const {
    subgroupingField,
    databaseSubgroups,
    nestedKey,
    splitNestedKey,
    subgroupCollapseKey,
  } = await import("../lib/database-groups");
  const { remapViewReferences } = await import("../lib/view-references");
  const sub: View = { ...view, subGroupBy: "tags" };
  assert.equal(subgroupingField(fields, sub, fields[1])?.id, "tags");
  // Same field, boards and missing primaries have no second level.
  assert.equal(
    subgroupingField(fields, { ...sub, subGroupBy: "status" }, fields[1]),
    undefined,
  );
  assert.equal(
    subgroupingField(fields, { ...sub, type: "board" }, fields[1]),
    undefined,
  );
  assert.equal(subgroupingField(fields, sub, undefined), undefined);
  const key = nestedKey('"Open"', "empty");
  assert.deepEqual(splitNestedKey(key), { group: '"Open"', subgroup: "empty" });
  assert.deepEqual(splitNestedKey('"Open"'), {
    group: '"Open"',
    subgroup: undefined,
  });
  // Values containing the control character are escaped by JSON keys.
  assert.equal(
    splitNestedKey(nestedKey(groupKey("a\u001fb"), '"x"')).subgroup,
    '"x"',
  );
  assert.ok(subgroupCollapseKey("x".repeat(1900), "y").startsWith("long:"));

  const [group] = databaseGroups(
    [
      sample("a", { status: "Open", tags: ["A", "B"] }),
      sample("b", { status: "Open", tags: [] }),
    ],
    fields[1],
    {},
  );
  assert.deepEqual(
    databaseSubgroups(group, fields[2], {}).map((g) => [
      g.label,
      g.rows.map((r) => r.id),
    ]),
    [
      ["A", ["a"]],
      ["B", ["a"]],
      ["Ohne Gruppe", ["b"]],
    ],
  );

  const { page, a, b } = fixture();
  schema(page, [sub, { ...view, id: "list", type: "list", groupBy: "tags" }]);
  const move = {
    action: "row.move",
    pageId: page,
    viewId: "table",
    version: database(page).version,
    rowId: a,
    rowVersion: 1,
    targetId: b,
    placement: "after",
    group: { from: '"Open"', to: '"Done"' },
    subgroup: { from: '"B"', to: '"C"' },
  };
  // Stale subgroup memberships are rejected without partial changes.
  const before = rows(page);
  assert.throws(
    () => act({ ...move, subgroup: { from: '"C"', to: '"C"' } }),
    /Gruppenzuordnung/,
  );
  assert.throws(
    () => act({ ...move, subgroup: { from: '"B"', to: '"A"' } }),
    /Gruppenzuordnung/,
  );
  assert.throws(() => act({ ...move, group: undefined }), /Untergruppe/);
  assert.throws(() => act(move, viewer), /Berechtigung/);
  assert.deepEqual(rows(page), before);
  act(move);
  const moved = rows(page).find((r) => r.id === a)!;
  assert.equal(moved.cells.status, "Done");
  assert.deepEqual(moved.cells.tags, ["A", "C"]);
  assert.equal(moved.version, 2);
  assert.deepEqual(database(page).views[0].rowOrder, [b, a]);

  const relationFields: Field[] = [
    { id: "title", name: "Name", type: "text" },
    { id: "status", name: "Status", type: "select", options: ["Open"] },
    { id: "rel", name: "Projekt", type: "relation", relationPage: "p2" },
  ];
  const [remapped] = remapViewReferences(
    [
      {
        ...view,
        groupBy: "status",
        subGroupBy: "rel",
        groupSettings: {
          hideEmpty: true,
          sort: "manual",
          collapsed: [
            subgroupCollapseKey('"Open"', '"old"'),
            '"Open"',
            "not json",
          ],
        },
      },
    ],
    relationFields,
    new Map([["old", "new"]]),
  );
  assert.deepEqual(remapped.groupSettings?.collapsed, [
    subgroupCollapseKey('"Open"', '"new"'),
    '"Open"',
    "not json",
  ]);
  assert.equal(
    viewSchema.safeParse({ ...sub, subGroupBy: "x".repeat(201) }).success,
    false,
  );
});
