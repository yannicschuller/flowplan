import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity, Field, View } from "../lib/types";
import { queryRows } from "../lib/database";
import { mapAsync } from "../lib/each-async";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-order-"));
const { id, run, one } = await import("../lib/db");
const { command, database, rows, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { exportArchive, importArchive } = await import("../lib/archive");
const { relationPairs } = await import("../lib/relation-sync");
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
    isAdmin: false,
    groups: [],
    disabled: 0,
    created_at: "",
  };
}
const owner = await user("owner"),
  editor = await user("editor"),
  viewer = await user("viewer"),
  wid = await createWorkspace(owner.id, "Row ordering"),
  boot = await bootstrap(owner, wid);
await run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const act = async (input: Record<string, unknown>, actor = owner): Promise<any> =>
  await command(actor, input);
const makePage = async (title: string, extra = {}) =>
  (await act({
    action: "page.create",
    workspaceId: wid,
    spaceId: boot.spaces[0].id,
    title,
    kind: "database",
    ...extra,
  })).id as string;
async function schema(pageId: string, fields: Field[], views: View[], extra = {}) {
  return await act({
    action: "database.update",
    pageId,
    fields,
    views,
    version: (await database(pageId)).version,
    ...extra,
  });
}
async function fixture() {
  const page = await makePage("Ordered rows");
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
  await schema(page, fields, views);
  const ids = await mapAsync(["A", "B", "C", "D"], async (title, i) => {
    const rid = (await act({
      action: "row.create",
      pageId: page,
      cells: { title, value: 4 - i, status: i < 2 ? "Todo" : "Done" },
    })).id as string;
    await run("UPDATE rows SET position=? WHERE id=?", i, rid);
    return rid;
  });
  return { page, ids };
}
async function move(
  pageId: string,
  rowId: string,
  targetId: string | undefined,
  placement = "before",
  extra = {},
  actor = owner,
) {
  return await act(
    {
      action: "row.move",
      pageId,
      viewId: "table",
      version: (await database(pageId)).version,
      rowId,
      rowVersion: (await rows(pageId)).find((r) => r.id === rowId)!.version,
      targetId,
      placement,
      ...extra,
    },
    actor,
  );
}
async function titles(pageId: string, viewId = "table") {
  const d = await database(pageId);
  return queryRows(
    await rows(pageId),
    d.fields,
    d.views.find((v) => v.id === viewId)!,
  ).map((r) => r.cells.title);
}

test("manual ordering is per-view, keeps filtered rows and appends new records without editing their contents", async () => {
  const {
      page,
      ids: [a, b, c, d],
    } = await fixture(),
    before = await rows(page);
  await move(page, c, a);
  assert.deepEqual(await titles(page), ["C", "A", "B", "D"]);
  assert.deepEqual(await titles(page, "board"), ["A", "B", "C", "D"]);
  assert.deepEqual(await rows(page), before);
  const db = await database(page);
  await schema(
    page,
    db.fields,
    db.views.map((v) =>
      v.id === "table"
        ? { ...v, filters: [{ field: "title", op: "neq", value: "B" }] }
        : v,
    ),
  );
  await move(page, d, c);
  assert.deepEqual(await titles(page), ["D", "C", "A"]);
  const full = await database(page);
  assert.deepEqual(
    queryRows(await rows(page), full.fields, { ...full.views[0], filters: [] }).map(
      (r) => r.cells.title,
    ),
    ["D", "C", "A", "B"],
  );
  await act({ action: "row.create", pageId: page, cells: { title: "E", value: 8 } });
  assert.deepEqual(await titles(page), ["D", "C", "A", "E"]);
  assert.ok((await database(page)).views[0].rowOrder?.includes(b));
});

test("active sorts require explicit removal and preserve the sorted sequence as a starting point", async () => {
  const {
      page,
      ids: [a, b, c, d],
    } = await fixture(),
    db = await database(page);
  await schema(
    page,
    db.fields,
    db.views.map((v) =>
      v.id === "table"
        ? { ...v, sorts: [{ field: "value", direction: "asc" }] }
        : v,
    ),
  );
  assert.deepEqual(await titles(page), ["D", "C", "B", "A"]);
  const before = await database(page);
  await assert.rejects(async () => await move(page, b, d), /Sortierung aufheben/);
  assert.deepEqual(await database(page), before);
  await move(page, b, d, "before", { clearSorts: true });
  assert.deepEqual(await titles(page), ["B", "D", "C", "A"]);
  assert.deepEqual((await database(page)).views[0].sorts, []);
  const latest = await database(page);
  await schema(
    page,
    latest.fields,
    latest.views.map((v) =>
      v.id === "table"
        ? { ...v, sorts: [{ field: "status", direction: "asc" }] }
        : v,
    ),
  );
  assert.deepEqual(await titles(page), ["D", "C", "B", "A"]); // manual order resolves equal sort values
});

test("reordering rejects stale schemas, stale rows, foreign anchors, invalid orders, viewers and locked/private pages", async () => {
  const {
      page,
      ids: [a, b],
    } = await fixture(),
    other = await fixture(),
    version = (await database(page)).version;
  await move(page, b, a);
  const before = await database(page);
  await assert.rejects(
    async () => await move(page, a, b, "after", { version }),
    /Ansicht wurde geändert/,
  );
  await act({
    action: "row.update",
    pageId: page,
    rowId: a,
    version: 1,
    cells: { title: "Updated" },
  });
  await assert.rejects(
    async () => await move(page, a, b, "after", { rowVersion: 1 }),
    /Eintrag wurde geändert/,
  );
  await assert.rejects(async () => await move(page, a, other.ids[0]), /Zieleintrag/);
  await assert.rejects(async () => await move(page, a, b, "after", {}, viewer), /Berechtigung/);
  await assert.rejects(
    async () =>
      await schema(
        page,
        before.fields,
        before.views.map((v) => ({ ...v, rowOrder: [other.ids[0]] })),
      ),
    /fremden/,
  );
  await assert.rejects(async () =>
    await schema(
      page,
      before.fields,
      before.views.map((v) => ({ ...v, rowOrder: [a, a] })),
    ),
  );
  await act({ action: "page.update", pageId: page, patch: { locked: true } });
  await assert.rejects(async () => await move(page, a, b), /gesperrt/);
  await act({ action: "page.update", pageId: page, patch: { locked: false } });
  const privateSpace = (await act({
    action: "space.create",
    workspaceId: wid,
    name: "Private",
    private: true,
  })).id;
  await run("UPDATE pages SET space_id=? WHERE id=?", privateSpace, page);
  await assert.rejects(async () => await move(page, a, b, "after", {}, editor), /Berechtigung/);
  assert.deepEqual(await database(page), before);
});

test("board drops save group and order together and roll back when a paired relation cannot be changed", async () => {
  const {
    page,
    ids: [a, b, c, d],
  } = await fixture();
  await move(page, a, c, "before", {
    viewId: "board",
    group: { from: JSON.stringify("Todo"), to: JSON.stringify("Done") },
  });
  assert.equal((await rows(page)).find((r) => r.id === a)!.cells.status, "Done");
  assert.deepEqual(await titles(page, "board"), ["B", "A", "C", "D"]);
  const target = await makePage("Projects"),
    p = (await act({ action: "row.create", pageId: target, cells: { title: "P" } })).id,
    q = (await act({ action: "row.create", pageId: target, cells: { title: "Q" } })).id;
  let db = await database(page);
  await schema(
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
        targetVersion: (await database(target)).version,
      },
    },
  );
  for (const [rowId, linked] of [
    [a, p],
    [b, q],
  ])
    await act({
      action: "row.update",
      pageId: page,
      rowId,
      version: (await rows(page)).find((r) => r.id === rowId)!.version,
      cells: { links: [linked] },
    });
  const inverse = (await relationPairs(page))[0].right_field;
  await act({ action: "page.update", pageId: target, patch: { locked: true } });
  const before = await rows(page);
  db = await database(page);
  await assert.rejects(
    async () =>
      await move(page, a, b, "before", {
        viewId: "board",
        group: { from: JSON.stringify(p), to: JSON.stringify(q) },
      }),
    /gesperrt/,
  );
  assert.deepEqual(await rows(page), before);
  assert.deepEqual(await database(page), db);
  await act({ action: "page.update", pageId: target, patch: { locked: false } });
  await move(page, a, b, "after", {
    viewId: "board",
    group: { from: JSON.stringify(p), to: JSON.stringify(q) },
  });
  assert.deepEqual((await rows(target)).find((r) => r.id === p)!.cells[inverse], []);
  assert.deepEqual(
    new Set((await rows(target)).find((r) => r.id === q)!.cells[inverse] as string[]),
    new Set([a, b]),
  );
  assert.deepEqual(
    (await database(page)).views.find((v) => v.id === "board")!.rowOrder,
    [b, a, c, d],
  );
});

test("duplicates follow originals in manual views, deletes prune orders and snapshots restore them", async () => {
  const {
    page,
    ids: [a, b, c, d],
  } = await fixture();
  await move(page, c, a);
  const snapshot = (await act({ action: "page.snapshot", pageId: page })).id;
  const duplicated = (await act({
    action: "rows.bulk",
    pageId: page,
    operation: "duplicate",
    rows: [{ id: a, version: (await rows(page)).find((r) => r.id === a)!.version }],
  })).ids[0];
  assert.deepEqual((await database(page)).views[0].rowOrder, [c, a, duplicated, b, d]);
  await act({ action: "row.delete", pageId: page, rowId: b });
  assert.ok(!(await database(page)).views[0].rowOrder?.includes(b));
  await act({
    action: "rows.bulk",
    pageId: page,
    operation: "delete",
    rows: [{ id: c, version: (await rows(page)).find((r) => r.id === c)!.version }],
  });
  assert.ok(!(await database(page)).views[0].rowOrder?.includes(c));
  await act({ action: "snapshot.restore", pageId: page, snapshotId: snapshot });
  assert.deepEqual(await titles(page), ["C", "A", "B", "D"]);
});

test("page copies, templates, legacy JSON and ZIP archives remap view row IDs including saved versions", async () => {
  const {
    page,
    ids: [a, b, c],
  } = await fixture();
  await move(page, c, a);
  await move(page, b, c, "after", { viewId: "list" });
  const snapshot = (await act({ action: "page.snapshot", pageId: page })).id;
  const clone = (await act({ action: "page.duplicate", pageId: page })).id;
  assert.deepEqual(await titles(clone), ["C", "A", "B", "D"]);
  assert.deepEqual(await titles(clone, "list"), ["A", "C", "B", "D"]);
  assert.ok(!(await database(clone)).views[0].rowOrder?.includes(a));
  const name = `Ordered template ${id()}`,
    template = (await act({ action: "template.save", pageId: page, name })).id;
  const fromTemplate = await makePage("Template copy", { templateId: template });
  assert.deepEqual(await titles(fromTemplate), await titles(page));
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
          title: "JSON copy",
          kind: "database",
          data: { database: await database(page), rows: await rows(page) },
        },
      ],
    },
  })).pageIds[page];
  assert.deepEqual(await titles(json), await titles(page));
  const dest = await createWorkspace(owner.id, "Restored order"),
    zip = await importArchive(owner, dest, await exportArchive(owner, wid)),
    restored = zip.pageIds[page];
  assert.deepEqual(await titles(restored), await titles(page));
  const saved = (await one<{ id: string }>(
    "SELECT id FROM snapshots WHERE page_id=?",
    restored,
  ))!.id;
  const restoredRows = await rows(restored);
  await move(restored, restoredRows[0].id, undefined, "end");
  await act({ action: "snapshot.restore", pageId: restored, snapshotId: saved });
  assert.deepEqual(await titles(restored), await titles(page));
  const restoredTemplate = (await one<{ id: string }>(
    "SELECT id FROM templates WHERE workspace_id=? AND name=?",
    dest,
    name,
  ))!.id;
  const instance = (await act({
    action: "page.create",
    workspaceId: dest,
    spaceId: (await bootstrap(owner, dest)).spaces[0].id,
    title: "Restored template",
    templateId: restoredTemplate,
  })).id;
  assert.deepEqual(await titles(instance), await titles(page));
  assert.deepEqual(await titles(instance, "list"), await titles(page, "list"));
});
