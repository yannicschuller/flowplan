import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity, Field, View } from "../lib/types";
import { queryRows } from "../lib/database";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-order-"));
const { id, run, one } = await import("../lib/db");
const { command, database, rows, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { exportArchive, importArchive } = await import("../lib/archive");
const { relationPairs } = await import("../lib/relation-sync");
function user(name: string): Identity {
  const uid = id();
  run(
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
    isAdmin: false,
    groups: [],
    disabled: 0,
    created_at: "",
  };
}
const owner = user("owner"),
  editor = user("editor"),
  viewer = user("viewer"),
  wid = createWorkspace(owner.id, "Row ordering"),
  boot = bootstrap(owner, wid);
run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const act = (input: Record<string, unknown>, actor = owner): any =>
  command(actor, input);
const makePage = (title: string, extra = {}) =>
  act({
    action: "page.create",
    workspaceId: wid,
    spaceId: boot.spaces[0].id,
    title,
    kind: "database",
    ...extra,
  }).id as string;
function schema(pageId: string, fields: Field[], views: View[], extra = {}) {
  return act({
    action: "database.update",
    pageId,
    fields,
    views,
    version: database(pageId).version,
    ...extra,
  });
}
function fixture() {
  const page = makePage("Ordered rows");
  const fields: Field[] = [
    { id: "title", name: "Name", type: "text" },
    { id: "value", name: "Value", type: "number" },
    { id: "status", name: "Status", type: "select", options: ["Todo", "Done"] },
  ];
  const views: View[] = ["table", "board", "list", "gallery"].map((type) => ({
    id: type,
    name: type,
    type: type as View["type"],
    filters: [],
    sorts: [],
    ...(type === "board" ? { groupBy: "status" } : {}),
  }));
  schema(page, fields, views);
  const ids = ["A", "B", "C", "D"].map((title, i) => {
    const rid = act({
      action: "row.create",
      pageId: page,
      cells: { title, value: 4 - i, status: i < 2 ? "Todo" : "Done" },
    }).id as string;
    run("UPDATE rows SET position=? WHERE id=?", i, rid);
    return rid;
  });
  return { page, ids };
}
function move(
  pageId: string,
  rowId: string,
  targetId: string | undefined,
  placement = "before",
  extra = {},
  actor = owner,
) {
  return act(
    {
      action: "row.move",
      pageId,
      viewId: "table",
      version: database(pageId).version,
      rowId,
      rowVersion: rows(pageId).find((r) => r.id === rowId)!.version,
      targetId,
      placement,
      ...extra,
    },
    actor,
  );
}
function titles(pageId: string, viewId = "table") {
  const d = database(pageId);
  return queryRows(
    rows(pageId),
    d.fields,
    d.views.find((v) => v.id === viewId)!,
  ).map((r) => r.cells.title);
}

test("manual ordering is per-view, keeps filtered rows and appends new records without editing their contents", () => {
  const {
      page,
      ids: [a, b, c, d],
    } = fixture(),
    before = rows(page);
  move(page, c, a);
  assert.deepEqual(titles(page), ["C", "A", "B", "D"]);
  assert.deepEqual(titles(page, "board"), ["A", "B", "C", "D"]);
  assert.deepEqual(rows(page), before);
  const db = database(page);
  schema(
    page,
    db.fields,
    db.views.map((v) =>
      v.id === "table"
        ? { ...v, filters: [{ field: "title", op: "neq", value: "B" }] }
        : v,
    ),
  );
  move(page, d, c);
  assert.deepEqual(titles(page), ["D", "C", "A"]);
  const full = database(page);
  assert.deepEqual(
    queryRows(rows(page), full.fields, { ...full.views[0], filters: [] }).map(
      (r) => r.cells.title,
    ),
    ["D", "C", "A", "B"],
  );
  act({ action: "row.create", pageId: page, cells: { title: "E", value: 8 } });
  assert.deepEqual(titles(page), ["D", "C", "A", "E"]);
  assert.ok(database(page).views[0].rowOrder?.includes(b));
});

test("active sorts require explicit removal and preserve the sorted sequence as a starting point", () => {
  const {
      page,
      ids: [a, b, c, d],
    } = fixture(),
    db = database(page);
  schema(
    page,
    db.fields,
    db.views.map((v) =>
      v.id === "table"
        ? { ...v, sorts: [{ field: "value", direction: "asc" }] }
        : v,
    ),
  );
  assert.deepEqual(titles(page), ["D", "C", "B", "A"]);
  const before = database(page);
  assert.throws(() => move(page, b, d), /Sortierung aufheben/);
  assert.deepEqual(database(page), before);
  move(page, b, d, "before", { clearSorts: true });
  assert.deepEqual(titles(page), ["B", "D", "C", "A"]);
  assert.deepEqual(database(page).views[0].sorts, []);
  const latest = database(page);
  schema(
    page,
    latest.fields,
    latest.views.map((v) =>
      v.id === "table"
        ? { ...v, sorts: [{ field: "status", direction: "asc" }] }
        : v,
    ),
  );
  assert.deepEqual(titles(page), ["D", "C", "B", "A"]); // manual order resolves equal sort values
});

test("reordering rejects stale schemas, stale rows, foreign anchors, invalid orders, viewers and locked/private pages", () => {
  const {
      page,
      ids: [a, b],
    } = fixture(),
    other = fixture(),
    version = database(page).version;
  move(page, b, a);
  const before = database(page);
  assert.throws(
    () => move(page, a, b, "after", { version }),
    /Ansicht wurde geändert/,
  );
  act({
    action: "row.update",
    pageId: page,
    rowId: a,
    version: 1,
    cells: { title: "Updated" },
  });
  assert.throws(
    () => move(page, a, b, "after", { rowVersion: 1 }),
    /Eintrag wurde geändert/,
  );
  assert.throws(() => move(page, a, other.ids[0]), /Zieleintrag/);
  assert.throws(() => move(page, a, b, "after", {}, viewer), /Berechtigung/);
  assert.throws(
    () =>
      schema(
        page,
        before.fields,
        before.views.map((v) => ({ ...v, rowOrder: [other.ids[0]] })),
      ),
    /fremden/,
  );
  assert.throws(() =>
    schema(
      page,
      before.fields,
      before.views.map((v) => ({ ...v, rowOrder: [a, a] })),
    ),
  );
  act({ action: "page.update", pageId: page, patch: { locked: true } });
  assert.throws(() => move(page, a, b), /gesperrt/);
  act({ action: "page.update", pageId: page, patch: { locked: false } });
  const privateSpace = act({
    action: "space.create",
    workspaceId: wid,
    name: "Private",
    private: true,
  }).id;
  run("UPDATE pages SET space_id=? WHERE id=?", privateSpace, page);
  assert.throws(() => move(page, a, b, "after", {}, editor), /Berechtigung/);
  assert.deepEqual(database(page), before);
});

test("board drops save group and order together and roll back when a paired relation cannot be changed", () => {
  const {
    page,
    ids: [a, b, c, d],
  } = fixture();
  move(page, a, c, "before", {
    viewId: "board",
    group: { from: JSON.stringify("Todo"), to: JSON.stringify("Done") },
  });
  assert.equal(rows(page).find((r) => r.id === a)!.cells.status, "Done");
  assert.deepEqual(titles(page, "board"), ["B", "A", "C", "D"]);
  const target = makePage("Projects"),
    p = act({ action: "row.create", pageId: target, cells: { title: "P" } }).id,
    q = act({ action: "row.create", pageId: target, cells: { title: "Q" } }).id;
  let db = database(page);
  schema(
    page,
    [
      ...db.fields,
      { id: "links", name: "Projects", type: "relation", relationPage: target },
    ],
    db.views.map((v) => (v.id === "board" ? { ...v, groupBy: "links" } : v)),
    {
      relation: {
        fieldId: "links",
        enabled: true,
        targetVersion: database(target).version,
      },
    },
  );
  for (const [rowId, linked] of [
    [a, p],
    [b, q],
  ])
    act({
      action: "row.update",
      pageId: page,
      rowId,
      version: rows(page).find((r) => r.id === rowId)!.version,
      cells: { links: [linked] },
    });
  const inverse = relationPairs(page)[0].right_field;
  act({ action: "page.update", pageId: target, patch: { locked: true } });
  const before = rows(page);
  db = database(page);
  assert.throws(
    () =>
      move(page, a, b, "before", {
        viewId: "board",
        group: { from: JSON.stringify(p), to: JSON.stringify(q) },
      }),
    /gesperrt/,
  );
  assert.deepEqual(rows(page), before);
  assert.deepEqual(database(page), db);
  act({ action: "page.update", pageId: target, patch: { locked: false } });
  move(page, a, b, "after", {
    viewId: "board",
    group: { from: JSON.stringify(p), to: JSON.stringify(q) },
  });
  assert.deepEqual(rows(target).find((r) => r.id === p)!.cells[inverse], []);
  assert.deepEqual(
    new Set(rows(target).find((r) => r.id === q)!.cells[inverse] as string[]),
    new Set([a, b]),
  );
  assert.deepEqual(
    database(page).views.find((v) => v.id === "board")!.rowOrder,
    [b, a, c, d],
  );
});

test("duplicates follow originals in manual views, deletes prune orders and snapshots restore them", () => {
  const {
    page,
    ids: [a, b, c, d],
  } = fixture();
  move(page, c, a);
  const snapshot = act({ action: "page.snapshot", pageId: page }).id;
  const duplicated = act({
    action: "rows.bulk",
    pageId: page,
    operation: "duplicate",
    rows: [{ id: a, version: rows(page).find((r) => r.id === a)!.version }],
  }).ids[0];
  assert.deepEqual(database(page).views[0].rowOrder, [c, a, duplicated, b, d]);
  act({ action: "row.delete", pageId: page, rowId: b });
  assert.ok(!database(page).views[0].rowOrder?.includes(b));
  act({
    action: "rows.bulk",
    pageId: page,
    operation: "delete",
    rows: [{ id: c, version: rows(page).find((r) => r.id === c)!.version }],
  });
  assert.ok(!database(page).views[0].rowOrder?.includes(c));
  act({ action: "snapshot.restore", pageId: page, snapshotId: snapshot });
  assert.deepEqual(titles(page), ["C", "A", "B", "D"]);
});

test("page copies, templates, legacy JSON and ZIP archives remap view row IDs including saved versions", async () => {
  const {
    page,
    ids: [a, b, c],
  } = fixture();
  move(page, c, a);
  move(page, b, c, "after", { viewId: "list" });
  const snapshot = act({ action: "page.snapshot", pageId: page }).id;
  const clone = act({ action: "page.duplicate", pageId: page }).id;
  assert.deepEqual(titles(clone), ["C", "A", "B", "D"]);
  assert.deepEqual(titles(clone, "list"), ["A", "C", "B", "D"]);
  assert.ok(!database(clone).views[0].rowOrder?.includes(a));
  const name = `Ordered template ${id()}`,
    template = act({ action: "template.save", pageId: page, name }).id;
  const fromTemplate = makePage("Template copy", { templateId: template });
  assert.deepEqual(titles(fromTemplate), titles(page));
  const json = act({
    action: "workspace.import",
    workspaceId: wid,
    spaceId: boot.spaces[0].id,
    backup: {
      format: "flowplan-1",
      pages: [
        {
          id: page,
          parent_id: null,
          title: "JSON copy",
          kind: "database",
          data: { database: database(page), rows: rows(page) },
        },
      ],
    },
  }).pageIds[page];
  assert.deepEqual(titles(json), titles(page));
  const dest = createWorkspace(owner.id, "Restored order"),
    zip = await importArchive(owner, dest, await exportArchive(owner, wid)),
    restored = zip.pageIds[page];
  assert.deepEqual(titles(restored), titles(page));
  const saved = one<{ id: string }>(
    "SELECT id FROM snapshots WHERE page_id=?",
    restored,
  )!.id;
  const restoredRows = rows(restored);
  move(restored, restoredRows[0].id, undefined, "end");
  act({ action: "snapshot.restore", pageId: restored, snapshotId: saved });
  assert.deepEqual(titles(restored), titles(page));
  const restoredTemplate = one<{ id: string }>(
    "SELECT id FROM templates WHERE workspace_id=? AND name=?",
    dest,
    name,
  )!.id;
  const instance = act({
    action: "page.create",
    workspaceId: dest,
    spaceId: bootstrap(owner, dest).spaces[0].id,
    title: "Restored template",
    templateId: restoredTemplate,
  }).id;
  assert.deepEqual(titles(instance), titles(page));
  assert.deepEqual(titles(instance, "list"), titles(page, "list"));
});
