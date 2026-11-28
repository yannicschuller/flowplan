// "Relation = this record" in linked database views (#649, lib/this-record.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { htmlState, escaped } from "../lib/document-server";
import { queryRows } from "../lib/database";
import {
  THIS_RECORD,
  hasThisRecord,
  offersThisRecord,
  relatedRecordsView,
  resolveThisRecord,
  thisRecordCells,
  unresolvedThisRecord,
} from "../lib/this-record";
import { remapViewReferences } from "../lib/view-references";
import type { Field, Identity, View } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-this-record-"));
const { id, run, one } = await import("../lib/db");
const { command, database, bootstrap } = await import("../lib/api");
const { linkedDatabaseData } = await import("../lib/linked-databases");
const { createWorkspace } = await import("../lib/seed");
const { withPublicEmbeds } = await import("../lib/public-embeds");

const fields: Field[] = [
  { id: "title", name: "Name", type: "text" },
  { id: "project", name: "Projekt", type: "relation", relationPage: "projects" },
  { id: "other", name: "Andere", type: "relation", relationPage: "elsewhere" },
];
const view = (filters: View["filters"], extra: Partial<View> = {}): View => ({
  id: "v",
  name: "Tabelle",
  type: "table",
  filters,
  sorts: [],
  ...extra,
});
const here = { database: "projects", row: "p1" };

test("the token stands for the record the view sits in, only on a relation to its database", () => {
  const v = view([{ field: "project", op: "eq", value: THIS_RECORD }]);
  assert.ok(hasThisRecord(v));
  assert.ok(offersThisRecord(fields[1], here));
  assert.ok(!offersThisRecord(fields[2], here));
  assert.ok(!offersThisRecord(fields[1], null));
  const resolved = resolveThisRecord(v, fields, here);
  assert.deepEqual(resolved.filterGroup?.rules, [{ field: "project", op: "eq", value: "p1", kind: "condition" }]);
  // The stored view keeps the token.
  assert.equal(v.filters[0].value, THIS_RECORD);
  const rows = [
    { id: "a", cells: { title: "A", project: ["p1"] } },
    { id: "b", cells: { title: "B", project: ["p2"] } },
    { id: "c", cells: { title: "C", project: ["p1", "p2"] } },
    { id: "d", cells: { title: "D" } },
  ].map((r) => ({ ...r, page_id: "tasks", position: 0, version: 1, created_at: "", updated_at: "" })) as never[];
  const titles = (x: View, ctx = here as typeof here | null) =>
    queryRows(rows, fields, resolveThisRecord(x, fields, ctx)).map((r: { cells: { title: string } }) => r.cells.title);
  assert.deepEqual(titles(v), ["A", "C"]);
  assert.deepEqual(titles(v, { database: "projects", row: "p2" }), ["B", "C"]);
  // Without a record (a normal page) the token matches no record.
  assert.deepEqual(titles(v, null), []);
  assert.ok(unresolvedThisRecord(v, fields, null));
  assert.ok(!unresolvedThisRecord(v, fields, here));
  // Multi-value conditions and nested groups as well.
  const any = view([], {
    filterGroup: {
      kind: "group",
      join: "or",
      rules: [
        { kind: "condition", field: "title", op: "eq", value: "D" },
        { kind: "group", join: "and", rules: [{ kind: "condition", field: "project", op: "any_of", value: "", values: [THIS_RECORD] }] },
      ],
    },
  });
  assert.deepEqual(titles(any), ["A", "C", "D"]);
  assert.deepEqual(titles(view([{ field: "project", op: "none_of", value: "", values: [THIS_RECORD] }])), ["B", "D"]);
  // A relation to another database keeps the token: nothing matches.
  const wrong = view([{ field: "other", op: "eq", value: THIS_RECORD }]);
  assert.deepEqual(titles(wrong), []);
  assert.ok(unresolvedThisRecord(wrong, fields, here));
});

test("new records made in the view get the relation to this record", () => {
  const v = view([{ field: "project", op: "eq", value: THIS_RECORD }], { hiddenFields: ["project"] });
  assert.deepEqual(thisRecordCells(v, fields, here), { project: ["p1"] });
  // A relation it gets anyway (a board column) keeps its records.
  assert.deepEqual(thisRecordCells(v, fields, here, { project: ["p9"] }), { project: ["p9", "p1"] });
  assert.deepEqual(thisRecordCells(v, fields, here, { project: ["p1"] }), { project: ["p1"] });
  // Not without a record, not for "is not", not for a property this person cannot change.
  assert.deepEqual(thisRecordCells(v, fields, null), {});
  assert.deepEqual(thisRecordCells(view([{ field: "project", op: "neq", value: THIS_RECORD }]), fields, here), {});
  assert.deepEqual(thisRecordCells(v, fields, here, {}, ["project"]), {});
});

test("copies keep the token; the picker's related view filters by the first relation", () => {
  const v = view([{ field: "project", op: "eq", value: THIS_RECORD }]);
  const copied = remapViewReferences([v], fields, new Map([["p1", "p1-copy"]]));
  assert.equal(copied[0].filters[0].value, THIS_RECORD);
  const related = relatedRecordsView(view([{ field: "title", op: "contains", value: "x" }]), fields, "projects");
  assert.deepEqual(related?.filters, [
    { field: "title", op: "contains", value: "x" },
    { field: "project", op: "eq", value: THIS_RECORD },
  ]);
  assert.equal(relatedRecordsView(view([]), fields, "nowhere"), null);
  const grouped = relatedRecordsView(view([], { filterGroup: { kind: "group", join: "or", rules: [] } }), fields, "projects");
  assert.equal(grouped?.filters.length, 0);
  assert.equal(grouped?.filterGroup?.rules.length, 2);
});

/* ---------- On the server ---------- */

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = await user("owner"),
  viewer = await user("viewer"),
  stranger = await user("stranger");
const wid = await createWorkspace(owner.id, "This record"),
  boot = await bootstrap(owner, wid);
await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const act = async (body: Record<string, unknown>, actor = owner): Promise<any> => await command(actor, body);
const db = async (title: string) =>
  (await act({ action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, kind: "database", title })).id as string;
const projects = await db("Projects"),
  tasks = await db("Tasks");
const taskFields: Field[] = [
  { id: "title", name: "Name", type: "text" },
  { id: "project", name: "Project", type: "relation", relationPage: projects },
];
await act({
  action: "database.update",
  pageId: tasks,
  version: (await database(tasks)).version,
  fields: taskFields,
  views: [{ id: "table", name: "Table", type: "table", filters: [], sorts: [] }],
});
const record = async (pageId: string, cells: Record<string, unknown>, extra = {}) =>
  (await act({ action: "row.create", pageId, cells, ...extra })).id as string;
const alpha = await record(projects, { title: "Alpha" }),
  beta = await record(projects, { title: "Beta" });
await record(tasks, { title: "Alpha 1", project: [alpha] });
const secret = await record(tasks, { title: "Alpha secret", project: [alpha] });
await record(tasks, { title: "Beta 1", project: [beta] });
await record(tasks, { title: "Loose" });
// Only managers (the owner) see a private record.
await run("UPDATE rows SET access='private' WHERE id=?", secret);
const blockId = id();
const linkedViews: View[] = [
  { id: "related", name: "Tasks", type: "table", filters: [{ field: "project", op: "eq", value: THIS_RECORD }], sorts: [] },
];
const block = `<div data-linked-database="${blockId}" data-linked-source="${tasks}" data-linked-version="1" data-linked-views="${escaped(JSON.stringify(linkedViews))}"></div>`;
async function content(rowId: string, html: string) {
  await run(
    "INSERT INTO row_documents(row_id,state,html,generation) VALUES(?,?,?,?) ON CONFLICT(row_id) DO UPDATE SET state=excluded.state,html=excluded.html",
    rowId,
    htmlState(html),
    html,
    id(),
  );
}
const shown = async (rowId: string | undefined, actor = owner, host = projects) => {
  const data = await linkedDatabaseData(actor, host, blockId, rowId);
  return queryRows(data.rows, data.database.fields, resolveThisRecord(data.database.views[0], data.database.fields, data.thisRecord))
    .map((r) => String(r.cells.title))
    .sort();
};

test("a linked view in a record's content shows the records related to it, as far as the reader may see them", async () => {
  await content(alpha, `<p>Tasks</p>${block}`);
  await content(beta, `<p>Tasks</p>${block}`);
  const data = await linkedDatabaseData(owner, projects, blockId, alpha);
  assert.deepEqual(data.thisRecord, { database: projects, row: alpha });
  // The stored view keeps the token.
  assert.equal(data.database.views[0].filters[0].value, THIS_RECORD);
  assert.deepEqual(await shown(alpha), ["Alpha 1", "Alpha secret"]);
  assert.deepEqual(await shown(beta), ["Beta 1"]);
  // The private record stays hidden from a viewer; strangers see nothing.
  assert.deepEqual(await shown(alpha, viewer), ["Alpha 1"]);
  await assert.rejects(async () => await linkedDatabaseData(stranger, projects, blockId, alpha));
  // A record of the shared database the reader cannot see: no view at all.
  await run("UPDATE rows SET access='private' WHERE id=?", beta);
  await assert.rejects(async () => await linkedDatabaseData(viewer, projects, blockId, beta));
  await run("UPDATE rows SET access='inherit' WHERE id=?", beta);
});

test("on a normal page the token stands for no record", async () => {
  const host = (await act({ action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, kind: "document", title: "Page" })).id as string;
  await run("UPDATE documents SET html=?,state=? WHERE page_id=?", block, htmlState(block), host);
  const data = await linkedDatabaseData(owner, host, blockId);
  assert.equal(data.thisRecord, undefined);
  assert.deepEqual(await shown(undefined, owner, host), []);
  assert.ok(unresolvedThisRecord(data.database.views[0], data.database.fields, data.thisRecord));
});

test("+ New in the linked view relates the new record; saving the view keeps the token", async () => {
  const generation = async () => (await one<{ generation: string }>("SELECT generation FROM row_documents WHERE row_id=?", alpha))!.generation;
  const linked = async (mutation: Record<string, unknown>) =>
    await act({
      action: "linked.command",
      pageId: projects,
      rowId: alpha,
      blockId,
      generation: await generation(),
      sourceVersion: (await linkedDatabaseData(owner, projects, blockId, alpha)).sourceVersion,
      mutation,
    });
  const data = await linkedDatabaseData(owner, projects, blockId, alpha);
  // What the view sends for "+ Neu" (components/database-view.tsx createRow).
  const cells = { title: "Alpha 2", ...thisRecordCells(data.database.views[0], data.database.fields, data.thisRecord) };
  await linked({ action: "row.create", cells });
  assert.deepEqual(await shown(alpha), ["Alpha 1", "Alpha 2", "Alpha secret"]);
  // Changing the view (here: a sort) stores the token, not the record's id.
  await linked({
    action: "database.update",
    version: data.database.version,
    fields: data.database.fields,
    views: [{ ...data.database.views[0], sorts: [{ field: "title", direction: "asc" }] }],
  });
  const html = (await one<{ html: string }>("SELECT html FROM row_documents WHERE row_id=?", alpha))!.html;
  assert.ok(html.includes(THIS_RECORD) && !html.includes(`"value":"${alpha}"`) && !html.includes(`&quot;${alpha}&quot;`));
});

test("a record template keeps the reference: every new record shows its own records", async () => {
  const source = await record(projects, { title: "Template source" });
  await content(source, `<p>Tasks of this project</p>${block}`);
  const template = (await act({ action: "row.template.save", pageId: projects, rowId: source, name: "Project" })).id as string;
  const stored = (await one<{ html: string }>("SELECT html FROM row_templates WHERE id=?", template))!.html;
  assert.ok(stored.includes(THIS_RECORD) && !stored.includes(source));
  const one_ = await record(projects, { title: "Gamma" }, { templateId: template }),
    two = await record(projects, { title: "Delta" }, { templateId: template });
  await record(tasks, { title: "Gamma 1", project: [one_] });
  await record(tasks, { title: "Delta 1", project: [two] });
  await record(tasks, { title: "Delta 2", project: [two, alpha] });
  for (const rowId of [one_, two]) {
    const html = (await one<{ html: string }>("SELECT html FROM row_documents WHERE row_id=?", rowId))!.html;
    assert.ok(html.includes(THIS_RECORD), "the new record's content keeps the token");
    assert.ok(!html.includes(source), "the template's own record is not frozen in");
  }
  assert.deepEqual(await shown(one_), ["Gamma 1"]);
  assert.deepEqual(await shown(two), ["Delta 1", "Delta 2"]);
  // Applying the template to an existing record by hand as well.
  const empty = await record(projects, { title: "Epsilon" });
  await act({ action: "row.template.apply", pageId: projects, rowId: empty, templateId: template, mode: "empty", snapshotId: id() });
  await record(tasks, { title: "Epsilon 1", project: [empty] });
  assert.deepEqual(await shown(empty), ["Epsilon 1"]);
});

test("published records resolve the token for themselves", async () => {
  const pages = [await (await import("../lib/permissions")).requirePage(owner, tasks)];
  const html = await withPublicEmbeds(block, block, "token", pages, { database: projects, row: beta });
  assert.match(html, /Beta 1/);
  assert.doesNotMatch(html, /Alpha 1/);
  const without = await withPublicEmbeds(block, block, "token", pages);
  assert.doesNotMatch(without, /Beta 1|Alpha 1/);
});
