import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Identity,
  Field,
  Filter,
  FilterGroup,
  Row,
  View,
} from "../lib/types";
import { queryRows } from "../lib/database";
import {
  effectiveFilterGroup,
  filterGroupSchema,
  matches,
  matchesFilterGroup,
} from "../lib/database-filters";
import { mapAsync } from "../lib/each-async";
const condition = (field: string, op: Filter["op"], value = "") => ({
  kind: "condition" as const,
  field,
  op,
  value,
});
const tree: FilterGroup = {
  kind: "group",
  join: "and",
  rules: [
    condition("status", "eq", "Open"),
    {
      kind: "group",
      join: "or",
      rules: [
        condition("priority", "gte", "3"),
        condition("date", "before", "2026-10-01"),
      ],
    },
  ],
};
const fields: Field[] = [
  { id: "title", name: "Name", type: "text" },
  { id: "status", name: "Status", type: "select", options: ["Open", "Done"] },
  { id: "priority", name: "Priority", type: "number" },
  { id: "date", name: "Due", type: "date" },
];
function sample(id: string, cells: Record<string, unknown>, position = 0): Row {
  return {
    id,
    page_id: "page",
    cells,
    position,
    version: 1,
    created_at: "",
    updated_at: "",
    created_by: "",
    updated_by: "",
  };
}
const sampleRows = [
  sample("a", {
    title: "Alpha",
    status: "Open",
    priority: 4,
    date: "2026-11-01",
  }),
  sample(
    "b",
    { title: "Beta", status: "Open", priority: 1, date: "2026-09-25" },
    1,
  ),
  sample(
    "c",
    { title: "Gamma", status: "Done", priority: 4, date: "2026-09-01" },
    2,
  ),
  sample(
    "d",
    { title: "Delta", status: "Open", priority: 1, date: "2026-11-01" },
    3,
  ),
];
const base: View = {
  id: "table",
  name: "Table",
  type: "table",
  filters: [],
  sorts: [],
};

test("nested AND/OR predicates combine with search and manual order, preserving legacy filters and neutral empty groups", () => {
  const view = { ...base, filterGroup: tree, rowOrder: ["b", "a", "c", "d"] };
  assert.deepEqual(
    queryRows(sampleRows, fields, view).map((r) => r.id),
    ["b", "a"],
  );
  assert.deepEqual(
    queryRows(sampleRows, fields, view, "Alpha").map((r) => r.id),
    ["a"],
  );
  const old = {
    ...base,
    filters: [{ field: "status", op: "eq" as const, value: "Done" }],
  };
  assert.equal(effectiveFilterGroup(old).join, "and");
  assert.deepEqual(
    queryRows(sampleRows, fields, old).map((r) => r.id),
    ["c"],
  );
  assert.equal(
    matchesFilterGroup(
      sampleRows[0].cells,
      {
        kind: "group",
        join: "or",
        rules: [
          { kind: "group", join: "and", rules: [] },
          condition("status", "eq", "Done"),
        ],
      },
      fields,
    ),
    false,
  );
  assert.equal(
    matchesFilterGroup({}, { kind: "group", join: "or", rules: [] }, fields),
    true,
  );
  assert.equal(
    matchesFilterGroup(
      {},
      { kind: "group", join: "and", rules: [condition("missing", "empty")] },
      fields,
    ),
    false,
  );
});

test("typed comparisons handle dates, numeric zeroes, booleans, array membership and computation errors", () => {
  assert.equal(
    matches({ priority: 0 }, condition("priority", "eq", "0.0"), fields[2]),
    true,
  );
  assert.equal(
    matches({ priority: "" }, condition("priority", "lt", "1"), fields[2]),
    false,
  );
  assert.equal(
    matches(
      { priority: "not-a-number" },
      condition("priority", "gte", "0"),
      fields[2],
    ),
    false,
  );
  assert.equal(
    matches(
      { date: "2026-10-01T15:00:00Z" },
      condition("date", "on_or_before", "2026-10-01"),
      fields[3],
    ),
    true,
  );
  assert.equal(
    matches(
      { date: "2026-10-01T15:00:00Z" },
      condition("date", "before", "2026-10-01"),
      fields[3],
    ),
    false,
  );
  assert.equal(
    matches(
      { date: "2026-02-31" },
      condition("date", "after", "2026-01-01"),
      fields[3],
    ),
    false,
  );
  assert.equal(
    matches({ date: "2026-10-01" }, condition("date", "neq", "bad"), fields[3]),
    false,
  );
  assert.equal(
    matches({ done: false }, condition("done", "eq", "false")),
    true,
  );
  assert.equal(matches({ done: false }, condition("done", "empty")), false);
  assert.equal(
    matches({ tags: ["Red", "Blue"] }, condition("tags", "eq", "BLUE")),
    true,
  );
  assert.equal(matches({ tags: [] }, condition("tags", "empty")), true);
  assert.equal(
    matches({ title: "Alpha" }, condition("title", "starts_with", "AL")),
    true,
  );
  assert.equal(
    matches({ title: "Alpha" }, condition("title", "ends_with", "ha")),
    true,
  );
  assert.equal(
    matches({ title: "Alpha" }, condition("title", "not_contains", "beta")),
    true,
  );
  assert.equal(
    matches({ total: "#ACCESS" }, condition("total", "neq", "0"), {
      id: "total",
      name: "Total",
      type: "rollup",
    }),
    false,
  );
  // Every formula error, as the table shows it, matches no condition.
  const quote: Field = { id: "q", name: "Quote", type: "formula" };
  for (const code of ["#DIV/0", "#RELATION", "#ERROR", "#CYCLE"])
    for (const [op, value] of [["notempty", ""], ["neq", "5"], ["empty", ""]] as const)
      assert.equal(matches({ q: code }, condition("q", op, value), quote), false, `${code} ${op}`);
});

test("schema rejects deep and oversized filter trees before recursive evaluation", () => {
  assert.ok(filterGroupSchema.safeParse(tree).success);
  let deep: FilterGroup = {
    kind: "group",
    join: "and",
    rules: [condition("title", "contains", "x")],
  };
  for (let i = 0; i < 200; i++)
    deep = { kind: "group", join: "and", rules: [deep] };
  assert.equal(filterGroupSchema.safeParse(deep).success, false);
  assert.equal(
    filterGroupSchema.safeParse({
      kind: "group",
      join: "and",
      rules: Array.from({ length: 101 }, () => condition("title", "eq", "x")),
    }).success,
    false,
  );
  assert.equal(
    filterGroupSchema.safeParse({
      kind: "group",
      join: "and",
      rules: [condition("title", "eval" as any, "x")],
    }).success,
    false,
  );
});

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-filter-"));
const { id, run, one } = await import("../lib/db");
const { command, database, rows, bootstrap, pageData } =
  await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { exportArchive, importArchive } = await import("../lib/archive");
async function user(name: string): Promise<Identity> {
  const uid = id();
  await run(
    "INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)",
    uid,
    uid,
    name,
    `${name}@example.test`,
  );
  return {
    id: uid,
    name,
    email: `${name}@example.test`,
    groups: [],
    isAdmin: false,
    disabled: 0,
    created_at: "",
  };
}
const owner = await user("owner"),
  viewer = await user("viewer"),
  wid = await createWorkspace(owner.id, "Advanced filters"),
  boot = await bootstrap(owner, wid);
await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const act = async (body: Record<string, unknown>, user = owner): Promise<any> =>
  await command(user, body);
async function create() {
  return (await act({
    action: "page.create",
    workspaceId: wid,
    spaceId: boot.spaces[0].id,
    title: "Filtered database",
    kind: "database",
  })).id as string;
}
async function schema(
  pageId: string,
  patch: Partial<View>,
  nextFields = fields,
  extra = {},
) {
  return await act({
    action: "database.update",
    pageId,
    version: (await database(pageId)).version,
    fields: nextFields,
    views: [{ ...base, ...patch }],
    ...extra,
  });
}
async function fixture() {
  const page = await create();
  await schema(page, { filterGroup: tree });
  const ids = await mapAsync(sampleRows, 
    async (r) =>
      (await act({ action: "row.create", pageId: page, cells: r.cells })).id as string,
  );
  return { page, ids };
}
async function visible(pageId: string) {
  const d = (await pageData(owner, pageId)) as any;
  return queryRows(
    d.rows,
    d.database.fields,
    d.database.views[0],
    "",
    d.related,
    d.relatedSchemas,
  ).map((r) => r.cells.title);
}

test("API guards versions, permissions, unknown fields and conflicting formats; deleting properties prunes nested filters", async () => {
  const { page } = await fixture(),
    before = await database(page);
  assert.deepEqual(await visible(page), ["Alpha", "Beta"]);
  await assert.rejects(
    async () => await schema(page, { filterGroup: tree }, fields, { version: 1 }),
    /zwischenzeitlich/,
  );
  await assert.rejects(
    async () =>
      await act(
        {
          action: "database.update",
          pageId: page,
          version: before.version,
          fields,
          views: before.views,
        },
        viewer,
      ),
    /Berechtigung/,
  );
  await assert.rejects(
    async () =>
      await schema(page, {
        filters: [condition("title", "eq", "x")],
        filterGroup: tree,
      }),
    /nicht gleichzeitig/,
  );
  await assert.rejects(
    async () =>
      await schema(page, {
        filterGroup: {
          kind: "group",
          join: "or",
          rules: [condition("missing", "empty")],
        },
      }),
    /unbekannte Eigenschaft/,
  );
  assert.deepEqual(await database(page), before);
  await schema(
    page,
    { filterGroup: tree, sorts: [{ field: "priority", direction: "asc" }] },
    fields.filter((f) => f.id !== "priority"),
  );
  assert.deepEqual(await visible(page), ["Beta"]);
  assert.deepEqual((await database(page)).views[0].sorts, []);
  assert.equal(
    ((await database(page)).views[0].filterGroup!.rules[1] as FilterGroup).rules.length,
    1,
  );
});

test("removing sort rules during a filtered move retains rows hidden by nested predicates", async () => {
  const { page, ids } = await fixture();
  await schema(page, {
    filterGroup: tree,
    sorts: [{ field: "title", direction: "desc" }],
  });
  await act({
    action: "row.move",
    pageId: page,
    viewId: "table",
    version: (await database(page)).version,
    rowId: ids[0],
    rowVersion: 1,
    targetId: ids[1],
    placement: "before",
    clearSorts: true,
  });
  assert.equal((await database(page)).views[0].rowOrder?.length, 4);
  assert.deepEqual(new Set((await database(page)).views[0].rowOrder), new Set(ids));
  assert.deepEqual(await visible(page), ["Alpha", "Beta"]);
});

test("relation-filter values remap through copies, templates, JSON and ZIP snapshots without touching originals", async () => {
  const page = await create(),
    relation: Field = {
      id: "link",
      name: "Related",
      type: "relation",
      relationPage: page,
    };
  await schema(page, {}, [fields[0], relation]);
  const a = (await act({
      action: "row.create",
      pageId: page,
      cells: { title: "Referenced" },
    })).id,
    b = (await act({
      action: "row.create",
      pageId: page,
      cells: { title: "Match", link: [a] },
    })).id;
  const group: FilterGroup = {
    kind: "group",
    join: "or",
    rules: [condition("link", "eq", a)],
  };
  await schema(page, { filterGroup: group }, [fields[0], relation]);
  await act({ action: "page.snapshot", pageId: page });
  const clone = (await act({ action: "page.duplicate", pageId: page })).id;
  assert.deepEqual(await visible(clone), ["Match"]);
  assert.notEqual(
    ((await database(clone)).views[0].filterGroup!.rules[0] as Filter).value,
    a,
  );
  const templateName = `Filter template ${id()}`,
    template = (await act({
      action: "template.save",
      pageId: page,
      name: templateName,
    })).id;
  const instance = (await act({
    action: "page.create",
    workspaceId: wid,
    spaceId: boot.spaces[0].id,
    title: "Filtered template",
    templateId: template,
  })).id;
  assert.deepEqual(await visible(instance), ["Match"]);
  const json = (await act({
    action: "workspace.import",
    workspaceId: wid,
    spaceId: boot.spaces[0].id,
    backup: {
      format: "flowplan-1",
      pages: [
        {
          id: page,
          parent_id: null,
          title: "Legacy filter copy",
          kind: "database",
          data: { database: await database(page), rows: await rows(page) },
        },
      ],
    },
  })).pageIds[page];
  assert.deepEqual(await visible(json), ["Match"]);
  const dest = await createWorkspace(owner.id, "Restored filters"),
    imported = await importArchive(
      owner,
      dest,
      await exportArchive(owner, wid),
    ),
    restored = imported.pageIds[page];
  assert.deepEqual(await visible(restored), ["Match"]);
  const snapshot = (await one<{ id: string }>(
    "SELECT id FROM snapshots WHERE page_id=?",
    restored,
  ))!.id;
  const d = await database(restored);
  await schema(
    restored,
    { filterGroup: { kind: "group", join: "and", rules: [] } },
    d.fields,
  );
  assert.equal((await visible(restored)).length, 2);
  await act({ action: "snapshot.restore", pageId: restored, snapshotId: snapshot });
  assert.deepEqual(await visible(restored), ["Match"]);
  const restoredTemplate = (await one<{ id: string }>(
    "SELECT id FROM templates WHERE workspace_id=? AND name=?",
    dest,
    templateName,
  ))!.id;
  const destInstance = (await act({
    action: "page.create",
    workspaceId: dest,
    spaceId: (await bootstrap(owner, dest)).spaces[0].id,
    title: "Restored template",
    templateId: restoredTemplate,
  })).id;
  assert.deepEqual(await visible(destInstance), ["Match"]);
  assert.equal(
    ((await database(page)).views[0].filterGroup!.rules[0] as Filter).value,
    a,
  );
});
