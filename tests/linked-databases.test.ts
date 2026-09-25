import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import { Fragment, Slice } from "@tiptap/pm/model";
import { documentSchema } from "../lib/document-schema";
import { freshLinkedIds } from "../lib/linked-paste";
import { htmlState, stateHtml, escaped } from "../lib/document-server";
import { queryRows } from "../lib/database";
import type { Identity, View, Field } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-linked-"));
const { id, run, one, all } = await import("../lib/db");
const { command, database, rows, bootstrap, pageData } =
  await import("../lib/api");
const { linkedDatabaseData } = await import("../lib/linked-databases");
const { createWorkspace } = await import("../lib/seed");
const { exportArchive, importArchive } = await import("../lib/archive");
const { sharedContent, mutateSharedContent } =
  await import("../lib/shared-content");
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
  editor = user("editor"),
  viewer = user("viewer"),
  stranger = user("stranger");
const wid = createWorkspace(owner.id, "Linked views"),
  boot = bootstrap(owner, wid);
run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const act = (body: Record<string, unknown>, actor = owner): any =>
  command(actor, body);
const create = (kind = "document", extra = {}) =>
  act({
    action: "page.create",
    workspaceId: wid,
    spaceId: boot.spaces[0].id,
    kind,
    title: "Linked fixture",
    ...extra,
  }).id as string;
const stored = (host: string) =>
  one<{ html: string; state: Uint8Array; generation: string }>(
    "SELECT * FROM documents WHERE page_id=?",
    host,
  )!;
function block(
  source: string,
  blockId: string,
  views = database(source).views.slice(0, 1),
) {
  return `<div data-linked-database="${blockId}" data-linked-source="${source}" data-linked-version="1" data-linked-views="${escaped(JSON.stringify(views))}">Verknüpfte Datenbank · Zugriff im Arbeitsbereich erforderlich</div>`;
}
function seed(host: string, html: string) {
  run(
    "UPDATE documents SET html=?,state=? WHERE page_id=?",
    html,
    htmlState(html),
    host,
  );
}
function fixture() {
  const host = create(),
    source = create("database"),
    a = id(),
    b = id();
  const fields: Field[] = [
    { id: "title", name: "Name", type: "text" },
    { id: "status", name: "Status", type: "select", options: ["Todo", "Done"] },
  ];
  const views: View[] = [
    { id: "table", name: "Tabelle", type: "table", filters: [], sorts: [] },
  ];
  act({
    action: "database.update",
    pageId: source,
    version: database(source).version,
    fields,
    views,
  });
  const ids = ["A", "B", "C"].map((title, i) => {
    const row = act({
      action: "row.create",
      pageId: source,
      cells: { title, status: i ? "Done" : "Todo" },
    }).id as string;
    run("UPDATE rows SET position=? WHERE id=?", i, row);
    return row;
  });
  seed(host, `<p>Overview</p>${block(source, a)}${block(source, b)}<p>End</p>`);
  return { host, source, a, b, ids };
}
function linked(
  host: string,
  blockId: string,
  mutation: Record<string, unknown>,
  actor = owner,
  extra = {},
) {
  return act(
    {
      action: "linked.command",
      pageId: host,
      blockId,
      generation: stored(host).generation,
      sourceVersion: linkedDatabaseData(owner, host, blockId).sourceVersion,
      mutation,
      ...extra,
    },
    actor,
  );
}
function configure(
  host: string,
  blockId: string,
  views: View[],
  actor = owner,
  extra = {},
) {
  const current = linkedDatabaseData(owner, host, blockId);
  return linked(
    host,
    blockId,
    {
      action: "database.update",
      version: current.database.version,
      fields: current.database.fields,
      views,
    },
    actor,
    extra,
  );
}
const titles = (host: string, blockId: string) => {
  const d = linkedDatabaseData(owner, host, blockId);
  return queryRows(d.rows, d.database.fields, d.database.views[0]).map(
    (r) => r.cells.title,
  );
};
test("linked views persist in Yjs, share source rows and keep filters and manual order independent", () => {
  const { host, source, a, b, ids } = fixture(),
    before = database(source);
  const d = linkedDatabaseData(owner, host, a);
  configure(
    host,
    a,
    d.database.views.map((v) => ({
      ...v,
      filters: [{ field: "status", op: "eq", value: "Done" }],
    })),
  );
  assert.deepEqual(titles(host, a), ["B", "C"]);
  assert.deepEqual(titles(host, b), ["A", "B", "C"]);
  linked(host, a, {
    action: "row.move",
    viewId: "table",
    version: 2,
    rowId: ids[2],
    rowVersion: 1,
    targetId: ids[1],
    placement: "before",
  });
  assert.deepEqual(titles(host, a), ["C", "B"]);
  assert.deepEqual(database(source), before);
  linked(host, b, {
    action: "row.update",
    pageId: create("database"),
    rowId: ids[1],
    version: 1,
    cells: { title: "Updated" },
  });
  assert.deepEqual(titles(host, a), ["C", "Updated"]);
  assert.deepEqual(titles(host, b), ["A", "Updated", "C"]);
  const added = linked(host, a, {
    action: "row.create",
    cells: { title: "D", status: "Done" },
  }).result.id;
  assert.ok(rows(source).some((r) => r.id === added));
  assert.ok(stored(host).html.includes("data-linked-views"));
  const doc = new Y.Doc();
  Y.applyUpdate(doc, stored(host).state);
  assert.equal(stateHtml(doc), stored(host).html);
  doc.destroy();
  linked(host, a, { action: "row.delete", rowId: ids[2] });
  assert.deepEqual(titles(host, a), ["Updated", "D"]);
  assert.ok(
    !linkedDatabaseData(owner, host, a).database.views[0].rowOrder!.includes(
      ids[2],
    ),
  );
});
test("source and host permissions, locks, private spaces, deletion and workspace boundaries are checked independently", () => {
  const { host, source, a, ids } = fixture();
  const change = () => ({
    action: "row.update",
    rowId: ids[0],
    version: rows(source)[0].version,
    cells: { title: "Allowed" },
  });
  const grant = (pageId: string, role: string) =>
    act({ action: "grant.set", resourceId: pageId, userId: editor.id, role });
  grant(source, "viewer");
  configure(
    host,
    a,
    [{ ...database(source).views[0], name: "Local layout" }],
    editor,
  );
  assert.throws(() => linked(host, a, change(), editor), /Berechtigung/);
  grant(source, "editor");
  grant(host, "viewer");
  linked(host, a, change(), editor);
  assert.throws(
    () => configure(host, a, database(source).views, editor),
    /Berechtigung/,
  );
  assert.throws(() => linkedDatabaseData(stranger, host, a), /Berechtigung/);
  assert.throws(() => linked(host, a, change(), viewer), /Berechtigung/);
  act({ action: "page.update", pageId: host, patch: { locked: true } });
  linked(host, a, change(), owner);
  assert.throws(() => configure(host, a, database(source).views), /gesperrt/);
  act({ action: "page.update", pageId: host, patch: { locked: false } });
  act({ action: "page.update", pageId: source, patch: { locked: true } });
  configure(host, a, database(source).views);
  assert.throws(() => linked(host, a, change()), /gesperrt/);
  const privateSpace = act({
    action: "space.create",
    workspaceId: wid,
    name: "Private",
    private: true,
  }).id;
  run("DELETE FROM grants WHERE resource_id=?", source);
  run("UPDATE pages SET space_id=? WHERE id=?", privateSpace, source);
  assert.throws(() => linkedDatabaseData(editor, host, a), /Berechtigung/);
  act({ action: "page.delete", pageId: source });
  assert.throws(() => linkedDatabaseData(owner, host, a), /nicht gefunden/);
  const other = createWorkspace(owner.id, "Other");
  run(
    "UPDATE pages SET deleted_at=NULL,workspace_id=? WHERE id=?",
    other,
    source,
  );
  assert.throws(() => linkedDatabaseData(owner, host, a), /Datenquelle/);
});
test("stale source, view, row and document versions fail without overwriting drafts; invalid mutations roll back merged Yjs", () => {
  const { host, source, a, ids } = fixture(),
    initial = linkedDatabaseData(owner, host, a);
  configure(host, a, [{ ...initial.database.views[0], name: "First" }]);
  assert.throws(
    () =>
      linked(host, a, {
        action: "database.update",
        version: 1,
        fields: initial.database.fields,
        views: initial.database.views,
      }),
    /Einbettung wurde geändert/,
  );
  act({
    action: "database.update",
    pageId: source,
    version: database(source).version,
    fields: database(source).fields,
    views: database(source).views,
  });
  assert.throws(
    () =>
      configure(host, a, initial.database.views, owner, {
        sourceVersion: initial.sourceVersion,
      }),
    /Datenquelle wurde geändert/,
  );
  assert.throws(
    () =>
      linked(host, a, { action: "row.create", cells: { title: "No" } }, owner, {
        generation: id(),
      }),
    /Dokumentversion/,
  );
  linked(host, a, {
    action: "row.update",
    rowId: ids[0],
    version: 1,
    cells: { title: "Current" },
  });
  assert.throws(
    () =>
      linked(host, a, {
        action: "row.update",
        rowId: ids[0],
        version: 1,
        cells: { title: "Stale" },
      }),
    /Datensatz wurde geändert/,
  );
  const before = stored(host),
    doc = new Y.Doc();
  Y.applyUpdate(doc, before.state);
  const p = new Y.XmlElement("paragraph"),
    text = new Y.XmlText();
  text.insert(0, "Unsaved local paragraph");
  p.insert(0, [text]);
  doc.getXmlFragment("default").push([p]);
  assert.throws(
    () =>
      linked(host, a, { action: "page.delete", pageId: source }, owner, {
        update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64"),
      }),
    /nicht verfügbar/,
  );
  doc.destroy();
  assert.deepEqual(stored(host), before);
  assert.throws(
    () =>
      configure(host, a, [{ ...initial.database.views[0], rowOrder: [id()] }]),
    /fremden/,
  );
  assert.throws(
    () =>
      configure(host, a, [
        {
          ...initial.database.views[0],
          filters: [{ field: "missing", op: "eq", value: "x" }],
        },
      ]),
    /unbekannte/,
  );
  assert.throws(
    () =>
      linked(host, a, {
        action: "database.update",
        version: 2,
        fields: [],
        views: initial.database.views,
      }),
    /Quelldatenbank/,
  );
  assert.throws(
    () => linkedDatabaseData(owner, host, id()),
    /Einbettung fehlt/,
  );
  seed(host, block(source, a) + block(source, a));
  assert.throws(() => linkedDatabaseData(owner, host, a), /Einbettung fehlt/);
});
test("group moves commit source cells and host order atomically, including failed reciprocal relation writes", () => {
  const { host, source, a, ids } = fixture();
  configure(host, a, [
    { ...database(source).views[0], type: "board", groupBy: "status" },
  ]);
  const move = (group: { from: string; to: string }) =>
    linked(host, a, {
      action: "row.move",
      version: linkedDatabaseData(owner, host, a).database.version,
      viewId: "table",
      rowId: ids[0],
      rowVersion: rows(source)[0].version,
      targetId: ids[1],
      placement: "after",
      group,
    });
  move({ from: JSON.stringify("Todo"), to: JSON.stringify("Done") });
  assert.equal(rows(source)[0].cells.status, "Done");
  assert.deepEqual(
    linkedDatabaseData(owner, host, a).database.views[0].rowOrder,
    [ids[1], ids[0], ids[2]],
  );
  assert.equal(database(source).views[0].rowOrder, undefined);
  const target = create("database"),
    p = act({ action: "row.create", pageId: target, cells: { title: "P" } }).id,
    q = act({ action: "row.create", pageId: target, cells: { title: "Q" } }).id;
  const d = database(source);
  act({
    action: "database.update",
    pageId: source,
    version: d.version,
    fields: [
      ...d.fields,
      { id: "links", name: "Projects", type: "relation", relationPage: target },
    ],
    views: d.views,
    relation: {
      fieldId: "links",
      enabled: true,
      targetVersion: database(target).version,
    },
  });
  for (const [rowId, link] of [
    [ids[0], p],
    [ids[1], q],
  ])
    act({
      action: "row.update",
      pageId: source,
      rowId,
      version: rows(source).find((r) => r.id === rowId)!.version,
      cells: { links: [link] },
    });
  configure(host, a, [
    { ...database(source).views[0], type: "board", groupBy: "links" },
  ]);
  act({ action: "page.update", pageId: target, patch: { locked: true } });
  const before = stored(host),
    records = rows(source);
  assert.throws(
    () => move({ from: JSON.stringify(p), to: JSON.stringify(q) }),
    /gesperrt/,
  );
  assert.deepEqual(stored(host), before);
  assert.deepEqual(rows(source), records);
  act({ action: "page.update", pageId: target, patch: { locked: false } });
  move({ from: JSON.stringify(p), to: JSON.stringify(q) });
  assert.deepEqual(rows(source)[0].cells.links, [q]);
});
test("copies, templates and document snapshots keep independent linked settings; pastes assign fresh block IDs without changing text", () => {
  const { host, source, a } = fixture();
  const configured: View[] = [
    { ...database(source).views[0], name: "Saved layout" },
  ];
  configure(host, a, configured);
  act({ action: "page.snapshot", pageId: host });
  const snapshot = one<{ id: string }>(
    "SELECT id FROM snapshots WHERE page_id=? ORDER BY rowid DESC",
    host,
  )!.id;
  const copy = act({ action: "page.duplicate", pageId: host }).id;
  const template = act({
    action: "template.save",
    pageId: host,
    name: "Linked template",
  }).id;
  const fromTemplate = create("document", { templateId: template });
  configure(host, a, [{ ...configured[0], name: "Later layout" }]);
  for (const p of [copy, fromTemplate])
    assert.equal(
      linkedDatabaseData(owner, p, a).database.views[0].name,
      "Saved layout",
    );
  act({ action: "snapshot.restore", pageId: host, snapshotId: snapshot });
  assert.equal(
    linkedDatabaseData(owner, host, a).database.views[0].name,
    "Saved layout",
  );
  const schema = documentSchema(),
    original = schema.nodes.linkedDatabase.create({
      id: a,
      source,
      views: JSON.stringify(configured),
      version: "4",
    });
  const slice = new Slice(
    Fragment.fromArray([
      schema.nodes.paragraph.create(null, schema.text("Keep literal text")),
      original,
      original,
    ]),
    0,
    0,
  );
  const fresh = freshLinkedIds(slice);
  assert.equal(fresh.content.child(0).textContent, "Keep literal text");
  assert.notEqual(fresh.content.child(1).attrs.id, a);
  assert.notEqual(
    fresh.content.child(1).attrs.id,
    fresh.content.child(2).attrs.id,
  );
  assert.equal(fresh.content.child(1).attrs.source, source);
  assert.equal(fresh.content.child(1).attrs.version, "1");
});
test("tree copies, legacy JSON and ZIP remap sources and row references, including templates and snapshots, without rewriting literal filters", async () => {
  const { host, source, a, ids } = fixture();
  act({ action: "page.move", pageId: source, parentId: host });
  const configured: View[] = [
    {
      ...database(source).views[0],
      rowOrder: [ids[2], ids[0], ids[1]],
      filters: [{ field: "title", op: "neq", value: ids[0] }],
    },
  ];
  configure(host, a, configured);
  act({ action: "page.snapshot", pageId: host });
  const templateName = `Archive linked ${id()}`;
  act({ action: "template.save", pageId: host, name: templateName });
  const check = (h: string, s: string) => {
    const d = linkedDatabaseData(owner, h, a);
    assert.equal(d.page.id, s);
    assert.notEqual(s, source);
    assert.deepEqual(titles(h, a), ["C", "A", "B"]);
    assert.equal(d.database.views[0].filters[0].value, ids[0]);
    assert.ok(d.database.views[0].rowOrder!.every((r) => !ids.includes(r)));
  };
  const copied = act({ action: "page.duplicate", pageId: host }).id;
  check(
    copied,
    one<{ id: string }>("SELECT id FROM pages WHERE parent_id=?", copied)!.id,
  );
  const destination = createWorkspace(owner.id, "Linked archive"),
    archive = await exportArchive(owner, wid),
    imported = await importArchive(owner, destination, archive);
  check(imported.pageIds[host], imported.pageIds[source]);
  const template = one<{ id: string }>(
    "SELECT id FROM templates WHERE workspace_id=? AND name=?",
    destination,
    templateName,
  )!.id;
  const templated = act({
    action: "page.create",
    workspaceId: destination,
    spaceId: imported.spaces[0],
    title: "Imported linked",
    templateId: template,
  }).id;
  check(templated, imported.pageIds[source]);
  const snap = all<{ id: string }>(
    "SELECT id FROM snapshots WHERE page_id=?",
    imported.pageIds[host],
  ).at(-1)!.id;
  act({
    action: "snapshot.restore",
    pageId: imported.pageIds[host],
    snapshotId: snap,
  });
  check(imported.pageIds[host], imported.pageIds[source]);
  const legacyDestination = createWorkspace(owner.id, "Linked JSON"),
    legacyBoot = bootstrap(owner, legacyDestination);
  act({
    action: "workspace.import",
    workspaceId: legacyDestination,
    spaceId: legacyBoot.spaces[0].id,
    backup: {
      format: "flowplan-1",
      pages: [host, source].map((p) => {
        const d = pageData(owner, p);
        return { ...d.page, data: d };
      }),
    },
  });
  const restored = all<{ id: string; kind: string }>(
    "SELECT id,kind FROM pages WHERE workspace_id=? AND title=?",
    legacyDestination,
    "Linked fixture",
  );
  check(
    restored.find((p) => p.kind === "document")!.id,
    restored.find((p) => p.kind === "database")!.id,
  );
});
test("public links expose placeholders without private source or filter data and guest edits preserve opaque embeds", () => {
  const { host, source, a } = fixture();
  configure(host, a, [
    {
      ...database(source).views[0],
      filters: [{ field: "title", op: "eq", value: "PrivateFilterValue" }],
    },
  ]);
  const token = act({
    action: "share.create",
    pageId: host,
    name: "Guest",
    role: "editor",
  }).token;
  const published = sharedContent(token, host);
  assert.ok(!published.html.includes(source));
  assert.ok(!published.html.includes("PrivateFilterValue"));
  assert.ok(published.html.includes("Zugriff im Arbeitsbereich"));
  mutateSharedContent(token, {
    action: "save",
    pageId: host,
    title: published.title,
    version: published.version,
    html: published.html + "<p>Guest update</p>",
  });
  assert.equal(
    linkedDatabaseData(owner, host, a).database.views[0].filters[0].value,
    "PrivateFilterValue",
  );
  const next = sharedContent(token, host);
  assert.throws(
    () =>
      mutateSharedContent(token, {
        action: "save",
        pageId: host,
        title: next.title,
        version: next.version,
        html: next.html + block(source, id()),
      }),
    /nicht freigegeben/,
  );
});
test("deleted source fields are pruned from linked filters and gallery previews without altering source views", () => {
  const { host, source, a } = fixture();
  configure(host, a, [
    {
      ...database(source).views[0],
      filters: [{ field: "status", op: "eq", value: "Done" }],
      sorts: [{ field: "status", direction: "asc" }],
    },
  ]);
  const d = database(source);
  act({
    action: "database.update",
    pageId: source,
    version: d.version,
    fields: d.fields.filter((f) => f.id !== "status"),
    views: d.views,
  });
  assert.deepEqual(titles(host, a), ["A", "B", "C"]);
  assert.deepEqual(
    linkedDatabaseData(owner, host, a).database.views[0].sorts,
    [],
  );
});

test("record documents host linked views with their own configuration", () => {
  const { source } = fixture();
  const projects = create("database"),
    record = act({
      action: "row.create",
      pageId: projects,
      cells: { title: "Projekt Alpha" },
    }).id as string,
    blockId = id();
  const html = `<p>Aufgaben</p>${block(source, blockId)}`;
  run(
    "INSERT INTO row_documents(row_id,state,html,generation) VALUES(?,?,?,?) ON CONFLICT(row_id) DO UPDATE SET state=excluded.state,html=excluded.html",
    record,
    htmlState(html),
    html,
    id(),
  );
  const rowDoc = () =>
    one<{ html: string; generation: string }>(
      "SELECT html,generation FROM row_documents WHERE row_id=?",
      record,
    )!;
  const data = linkedDatabaseData(owner, projects, blockId, record);
  assert.equal(data.page.id, source);
  assert.equal(data.rows.length, 3);
  // The block must exist in exactly this record document.
  const other = act({
    action: "row.create",
    pageId: projects,
    cells: { title: "Anderes" },
  }).id as string;
  assert.throws(
    () => linkedDatabaseData(owner, projects, blockId, other),
    /Einbettung fehlt/,
  );
  assert.throws(() => linkedDatabaseData(stranger, projects, blockId, record));
  const command = (mutation: Record<string, unknown>, actor = owner) =>
    act(
      {
        action: "linked.command",
        pageId: projects,
        rowId: record,
        blockId,
        generation: rowDoc().generation,
        sourceVersion: linkedDatabaseData(owner, projects, blockId, record)
          .sourceVersion,
        mutation,
      },
      actor,
    );
  const current = linkedDatabaseData(owner, projects, blockId, record);
  const filtered = [
    {
      ...current.database.views[0],
      filters: [{ field: "status", op: "eq", value: "Done" }],
    },
  ];
  assert.throws(() =>
    command(
      {
        action: "database.update",
        version: current.database.version,
        fields: current.database.fields,
        views: filtered,
      },
      viewer,
    ),
  );
  command({
    action: "database.update",
    version: current.database.version,
    fields: current.database.fields,
    views: filtered,
  });
  // The record document stores the view; the source keeps its own.
  assert.match(rowDoc().html, /data-linked-version="2"/);
  assert.match(
    one<{ content: string }>("SELECT content FROM rows WHERE id=?", record)!
      .content,
    /Done/,
  );
  assert.deepEqual(database(source).views[0].filters, []);
  const updated = linkedDatabaseData(owner, projects, blockId, record);
  assert.equal(
    queryRows(updated.rows, updated.database.fields, updated.database.views[0])
      .length,
    2,
  );
  // Source records can be added through the embedding.
  command({ action: "row.create", cells: { title: "D", status: "Done" } });
  assert.equal(rows(source).length, 4);
});
