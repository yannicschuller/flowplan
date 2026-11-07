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
import { mapAsync } from "../lib/each-async";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-linked-"));
const { id, run, one, all } = await import("../lib/db");
const { command, database, rows, bootstrap, pageData } =
  await import("../lib/api");
const { linkedDatabaseData } = await import("../lib/linked-databases");
const { createWorkspace } = await import("../lib/seed");
const { exportArchive, importArchive } = await import("../lib/archive");
const { sharedContent, mutateSharedContent } =
  await import("../lib/shared-content");
async function user(name: string): Promise<Identity> {
  const uid = id();
  await run(
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
const owner = await user("owner"),
  editor = await user("editor"),
  viewer = await user("viewer"),
  stranger = await user("stranger");
const wid = await createWorkspace(owner.id, "Linked views"),
  boot = await bootstrap(owner, wid);
await run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const act = async (body: Record<string, unknown>, actor = owner): Promise<any> =>
  await command(actor, body);
const create = async (kind = "document", extra = {}) =>
  (await act({
    action: "page.create",
    workspaceId: wid,
    spaceId: boot.spaces[0].id,
    kind,
    title: "Linked fixture",
    ...extra,
  })).id as string;
const stored = async (host: string) =>
  (await one<{ html: string; state: Uint8Array; generation: string }>(
    "SELECT * FROM documents WHERE page_id=?",
    host,
  ))!;
async function block(
  source: string,
  blockId: string,
  views = (await database(source)).views.slice(0, 1),
) {
  return `<div data-linked-database="${blockId}" data-linked-source="${source}" data-linked-version="1" data-linked-views="${escaped(JSON.stringify(views))}">Verknüpfte Datenbank · Zugriff im Arbeitsbereich erforderlich</div>`;
}
async function seed(host: string, html: string) {
  await run(
    "UPDATE documents SET html=?,state=? WHERE page_id=?",
    html,
    htmlState(html),
    host,
  );
}
async function fixture() {
  const host = await create(),
    source = await create("database"),
    a = id(),
    b = id();
  const fields: Field[] = [
    { id: "title", name: "Name", type: "text" },
    { id: "status", name: "Status", type: "select", options: ["Todo", "Done"] },
  ];
  const views: View[] = [
    { id: "table", name: "Tabelle", type: "table", filters: [], sorts: [] },
  ];
  await act({
    action: "database.update",
    pageId: source,
    version: (await database(source)).version,
    fields,
    views,
  });
  const ids = await mapAsync(["A", "B", "C"], async (title, i) => {
    const row = (await act({
      action: "row.create",
      pageId: source,
      cells: { title, status: i ? "Done" : "Todo" },
    })).id as string;
    await run("UPDATE rows SET position=? WHERE id=?", i, row);
    return row;
  });
  await seed(host, `<p>Overview</p>${await block(source, a)}${await block(source, b)}<p>End</p>`);
  return { host, source, a, b, ids };
}
async function linked(
  host: string,
  blockId: string,
  mutation: Record<string, unknown>,
  actor = owner,
  extra = {},
) {
  return await act(
    {
      action: "linked.command",
      pageId: host,
      blockId,
      generation: (await stored(host)).generation,
      sourceVersion: (await linkedDatabaseData(owner, host, blockId)).sourceVersion,
      mutation,
      ...extra,
    },
    actor,
  );
}
async function configure(
  host: string,
  blockId: string,
  views: View[],
  actor = owner,
  extra = {},
) {
  const current = await linkedDatabaseData(owner, host, blockId);
  return await linked(
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
const titles = async (host: string, blockId: string) => {
  const d = await linkedDatabaseData(owner, host, blockId);
  return queryRows(d.rows, d.database.fields, d.database.views[0]).map(
    (r) => r.cells.title,
  );
};
test("linked views persist in Yjs, share source rows and keep filters and manual order independent", async () => {
  const { host, source, a, b, ids } = await fixture(),
    before = await database(source);
  const d = await linkedDatabaseData(owner, host, a);
  await configure(
    host,
    a,
    d.database.views.map((v) => ({
      ...v,
      filters: [{ field: "status", op: "eq", value: "Done" }],
    })),
  );
  assert.deepEqual(await titles(host, a), ["B", "C"]);
  assert.deepEqual(await titles(host, b), ["A", "B", "C"]);
  await linked(host, a, {
    action: "row.move",
    viewId: "table",
    version: 2,
    rowId: ids[2],
    rowVersion: 1,
    targetId: ids[1],
    placement: "before",
  });
  assert.deepEqual(await titles(host, a), ["C", "B"]);
  assert.deepEqual(await database(source), before);
  await linked(host, b, {
    action: "row.update",
    pageId: await create("database"),
    rowId: ids[1],
    version: 1,
    cells: { title: "Updated" },
  });
  assert.deepEqual(await titles(host, a), ["C", "Updated"]);
  assert.deepEqual(await titles(host, b), ["A", "Updated", "C"]);
  const added = (await linked(host, a, {
    action: "row.create",
    cells: { title: "D", status: "Done" },
  })).result.id;
  assert.ok((await rows(source)).some((r) => r.id === added));
  assert.ok((await stored(host)).html.includes("data-linked-views"));
  const doc = new Y.Doc();
  Y.applyUpdate(doc, (await stored(host)).state);
  assert.equal(stateHtml(doc), (await stored(host)).html);
  doc.destroy();
  await linked(host, a, { action: "row.delete", rowId: ids[2] });
  assert.deepEqual(await titles(host, a), ["Updated", "D"]);
  assert.ok(
    !(await linkedDatabaseData(owner, host, a)).database.views[0].rowOrder!.includes(
      ids[2],
    ),
  );
});
test("source and host permissions, locks, private spaces, deletion and workspace boundaries are checked independently", async () => {
  const { host, source, a, ids } = await fixture();
  const change = async () => ({
    action: "row.update",
    rowId: ids[0],
    version: (await rows(source))[0].version,
    cells: { title: "Allowed" },
  });
  const grant = async (pageId: string, role: string) =>
    await act({ action: "grant.set", resourceId: pageId, userId: editor.id, role });
  await grant(source, "viewer");
  await configure(
    host,
    a,
    [{ ...(await database(source)).views[0], name: "Local layout" }],
    editor,
  );
  await assert.rejects(async () => await linked(host, a, await change(), editor), /Berechtigung/);
  await grant(source, "editor");
  await grant(host, "viewer");
  await linked(host, a, await change(), editor);
  await assert.rejects(
    async () => await configure(host, a, (await database(source)).views, editor),
    /Berechtigung/,
  );
  await assert.rejects(async () => await linkedDatabaseData(stranger, host, a), /Berechtigung/);
  await assert.rejects(async () => await linked(host, a, await change(), viewer), /Berechtigung/);
  await act({ action: "page.update", pageId: host, patch: { locked: true } });
  await linked(host, a, await change(), owner);
  await assert.rejects(async () => await configure(host, a, (await database(source)).views), /gesperrt/);
  await act({ action: "page.update", pageId: host, patch: { locked: false } });
  await act({ action: "page.update", pageId: source, patch: { locked: true } });
  await configure(host, a, (await database(source)).views);
  await assert.rejects(async () => await linked(host, a, await change()), /gesperrt/);
  const privateSpace = (await act({
    action: "space.create",
    workspaceId: wid,
    name: "Private",
    private: true,
  })).id;
  await run("DELETE FROM grants WHERE resource_id=?", source);
  await run("UPDATE pages SET space_id=? WHERE id=?", privateSpace, source);
  await assert.rejects(async () => await linkedDatabaseData(editor, host, a), /Berechtigung/);
  await act({ action: "page.delete", pageId: source });
  await assert.rejects(async () => await linkedDatabaseData(owner, host, a), /nicht gefunden/);
  const other = await createWorkspace(owner.id, "Other");
  await run(
    "UPDATE pages SET deleted_at=NULL,workspace_id=? WHERE id=?",
    other,
    source,
  );
  await assert.rejects(async () => await linkedDatabaseData(owner, host, a), /Datenquelle/);
});
test("stale source, view, row and document versions fail without overwriting drafts; invalid mutations roll back merged Yjs", async () => {
  const { host, source, a, ids } = await fixture(),
    initial = await linkedDatabaseData(owner, host, a);
  await configure(host, a, [{ ...initial.database.views[0], name: "First" }]);
  await assert.rejects(
    async () =>
      await linked(host, a, {
        action: "database.update",
        version: 1,
        fields: initial.database.fields,
        views: initial.database.views,
      }),
    /Einbettung wurde geändert/,
  );
  await act({
    action: "database.update",
    pageId: source,
    version: (await database(source)).version,
    fields: (await database(source)).fields,
    views: (await database(source)).views,
  });
  await assert.rejects(
    async () =>
      await configure(host, a, initial.database.views, owner, {
        sourceVersion: initial.sourceVersion,
      }),
    /Datenquelle wurde geändert/,
  );
  await assert.rejects(
    async () =>
      await linked(host, a, { action: "row.create", cells: { title: "No" } }, owner, {
        generation: id(),
      }),
    /Dokumentversion/,
  );
  await linked(host, a, {
    action: "row.update",
    rowId: ids[0],
    version: 1,
    cells: { title: "Current" },
  });
  await assert.rejects(
    async () =>
      await linked(host, a, {
        action: "row.update",
        rowId: ids[0],
        version: 1,
        cells: { title: "Stale" },
      }),
    /Datensatz wurde geändert/,
  );
  const before = await stored(host),
    doc = new Y.Doc();
  Y.applyUpdate(doc, before.state);
  const p = new Y.XmlElement("paragraph"),
    text = new Y.XmlText();
  text.insert(0, "Unsaved local paragraph");
  p.insert(0, [text]);
  doc.getXmlFragment("default").push([p]);
  await assert.rejects(
    async () =>
      await linked(host, a, { action: "page.delete", pageId: source }, owner, {
        update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64"),
      }),
    /nicht verfügbar/,
  );
  doc.destroy();
  assert.deepEqual(await stored(host), before);
  await assert.rejects(
    async () =>
      await configure(host, a, [{ ...initial.database.views[0], rowOrder: [id()] }]),
    /fremden/,
  );
  await assert.rejects(
    async () =>
      await configure(host, a, [
        {
          ...initial.database.views[0],
          filters: [{ field: "missing", op: "eq", value: "x" }],
        },
      ]),
    /unbekannte/,
  );
  await assert.rejects(
    async () =>
      await linked(host, a, {
        action: "database.update",
        version: 2,
        fields: [],
        views: initial.database.views,
      }),
    /Quelldatenbank/,
  );
  await assert.rejects(
    async () => await linkedDatabaseData(owner, host, id()),
    /Einbettung fehlt/,
  );
  await seed(host, (await block(source, a)) + (await block(source, a)));
  await assert.rejects(async () => await linkedDatabaseData(owner, host, a), /Einbettung fehlt/);
});
test("group moves commit source cells and host order atomically, including failed reciprocal relation writes", async () => {
  const { host, source, a, ids } = await fixture();
  await configure(host, a, [
    { ...(await database(source)).views[0], type: "board", groupBy: "status" },
  ]);
  const move = async (group: { from: string; to: string }) =>
    await linked(host, a, {
      action: "row.move",
      version: (await linkedDatabaseData(owner, host, a)).database.version,
      viewId: "table",
      rowId: ids[0],
      rowVersion: (await rows(source))[0].version,
      targetId: ids[1],
      placement: "after",
      group,
    });
  await move({ from: JSON.stringify("Todo"), to: JSON.stringify("Done") });
  assert.equal((await rows(source))[0].cells.status, "Done");
  assert.deepEqual(
    (await linkedDatabaseData(owner, host, a)).database.views[0].rowOrder,
    [ids[1], ids[0], ids[2]],
  );
  assert.equal((await database(source)).views[0].rowOrder, undefined);
  const target = await create("database"),
    p = (await act({ action: "row.create", pageId: target, cells: { title: "P" } })).id,
    q = (await act({ action: "row.create", pageId: target, cells: { title: "Q" } })).id;
  const d = await database(source);
  await act({
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
      targetVersion: (await database(target)).version,
    },
  });
  for (const [rowId, link] of [
    [ids[0], p],
    [ids[1], q],
  ])
    await act({
      action: "row.update",
      pageId: source,
      rowId,
      version: (await rows(source)).find((r) => r.id === rowId)!.version,
      cells: { links: [link] },
    });
  await configure(host, a, [
    { ...(await database(source)).views[0], type: "board", groupBy: "links" },
  ]);
  await act({ action: "page.update", pageId: target, patch: { locked: true } });
  const before = await stored(host),
    records = await rows(source);
  await assert.rejects(
    async () => await move({ from: JSON.stringify(p), to: JSON.stringify(q) }),
    /gesperrt/,
  );
  assert.deepEqual(await stored(host), before);
  assert.deepEqual(await rows(source), records);
  await act({ action: "page.update", pageId: target, patch: { locked: false } });
  await move({ from: JSON.stringify(p), to: JSON.stringify(q) });
  assert.deepEqual((await rows(source))[0].cells.links, [q]);
});
test("copies, templates and document snapshots keep independent linked settings; pastes assign fresh block IDs without changing text", async () => {
  const { host, source, a } = await fixture();
  const configured: View[] = [
    { ...(await database(source)).views[0], name: "Saved layout" },
  ];
  await configure(host, a, configured);
  await act({ action: "page.snapshot", pageId: host });
  const snapshot = (await one<{ id: string }>(
    "SELECT id FROM snapshots WHERE page_id=? ORDER BY seq DESC",
    host,
  ))!.id;
  const copy = (await act({ action: "page.duplicate", pageId: host })).id;
  const template = (await act({
    action: "template.save",
    pageId: host,
    name: "Linked template",
  })).id;
  const fromTemplate = await create("document", { templateId: template });
  await configure(host, a, [{ ...configured[0], name: "Later layout" }]);
  for (const p of [copy, fromTemplate])
    assert.equal(
      (await linkedDatabaseData(owner, p, a)).database.views[0].name,
      "Saved layout",
    );
  await act({ action: "snapshot.restore", pageId: host, snapshotId: snapshot });
  assert.equal(
    (await linkedDatabaseData(owner, host, a)).database.views[0].name,
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
  const { host, source, a, ids } = await fixture();
  await act({ action: "page.move", pageId: source, parentId: host });
  const configured: View[] = [
    {
      ...(await database(source)).views[0],
      rowOrder: [ids[2], ids[0], ids[1]],
      filters: [{ field: "title", op: "neq", value: ids[0] }],
    },
  ];
  await configure(host, a, configured);
  await act({ action: "page.snapshot", pageId: host });
  const templateName = `Archive linked ${id()}`;
  await act({ action: "template.save", pageId: host, name: templateName });
  const check = async (h: string, s: string) => {
    const d = await linkedDatabaseData(owner, h, a);
    assert.equal(d.page.id, s);
    assert.notEqual(s, source);
    assert.deepEqual(await titles(h, a), ["C", "A", "B"]);
    assert.equal(d.database.views[0].filters[0].value, ids[0]);
    assert.ok(d.database.views[0].rowOrder!.every((r) => !ids.includes(r)));
  };
  const copied = (await act({ action: "page.duplicate", pageId: host })).id;
  await check(
    copied,
    (await one<{ id: string }>("SELECT id FROM pages WHERE parent_id=?", copied))!.id,
  );
  const destination = await createWorkspace(owner.id, "Linked archive"),
    archive = await exportArchive(owner, wid),
    imported = await importArchive(owner, destination, archive);
  await check(imported.pageIds[host], imported.pageIds[source]);
  const template = (await one<{ id: string }>(
    "SELECT id FROM templates WHERE workspace_id=? AND name=?",
    destination,
    templateName,
  ))!.id;
  const templated = (await act({
    action: "page.create",
    workspaceId: destination,
    spaceId: imported.spaces[0],
    title: "Imported linked",
    templateId: template,
  })).id;
  await check(templated, imported.pageIds[source]);
  const snap = (await all<{ id: string }>(
    "SELECT id FROM snapshots WHERE page_id=?",
    imported.pageIds[host],
  )).at(-1)!.id;
  await act({
    action: "snapshot.restore",
    pageId: imported.pageIds[host],
    snapshotId: snap,
  });
  await check(imported.pageIds[host], imported.pageIds[source]);
  const legacyDestination = await createWorkspace(owner.id, "Linked JSON"),
    legacyBoot = await bootstrap(owner, legacyDestination);
  await act({
    action: "workspace.import",
    workspaceId: legacyDestination,
    spaceId: legacyBoot.spaces[0].id,
    backup: {
      format: "flowplan-1",
      pages: await mapAsync([host, source], async (p) => {
        const d = await pageData(owner, p);
        return { ...d.page, data: d };
      }),
    },
  });
  const restored = await all<{ id: string; kind: string }>(
    "SELECT id,kind FROM pages WHERE workspace_id=? AND title=?",
    legacyDestination,
    "Linked fixture",
  );
  await check(
    restored.find((p) => p.kind === "document")!.id,
    restored.find((p) => p.kind === "database")!.id,
  );
});
test("public links expose placeholders without private source or filter data and guest edits preserve opaque embeds", async () => {
  const { host, source, a } = await fixture();
  await configure(host, a, [
    {
      ...(await database(source)).views[0],
      filters: [{ field: "title", op: "eq", value: "PrivateFilterValue" }],
    },
  ]);
  const token = (await act({
    action: "share.create",
    pageId: host,
    name: "Guest",
    role: "editor",
  })).token;
  const published = await sharedContent(token, host);
  assert.ok(!published.html.includes(source));
  assert.ok(!published.html.includes("PrivateFilterValue"));
  assert.ok(published.html.includes("Zugriff im Arbeitsbereich"));
  await mutateSharedContent(token, {
    action: "save",
    pageId: host,
    title: published.title,
    version: published.version,
    html: published.html + "<p>Guest update</p>",
  });
  assert.equal(
    (await linkedDatabaseData(owner, host, a)).database.views[0].filters[0].value,
    "PrivateFilterValue",
  );
  const next = await sharedContent(token, host);
  await assert.rejects(
    async () =>
      await mutateSharedContent(token, {
        action: "save",
        pageId: host,
        title: next.title,
        version: next.version,
        html: next.html + (await block(source, id())),
      }),
    /nicht freigegeben/,
  );
});
test("deleted source fields are pruned from linked filters and gallery previews without altering source views", async () => {
  const { host, source, a } = await fixture();
  await configure(host, a, [
    {
      ...(await database(source)).views[0],
      filters: [{ field: "status", op: "eq", value: "Done" }],
      sorts: [{ field: "status", direction: "asc" }],
    },
  ]);
  const d = await database(source);
  await act({
    action: "database.update",
    pageId: source,
    version: d.version,
    fields: d.fields.filter((f) => f.id !== "status"),
    views: d.views,
  });
  assert.deepEqual(await titles(host, a), ["A", "B", "C"]);
  assert.deepEqual(
    (await linkedDatabaseData(owner, host, a)).database.views[0].sorts,
    [],
  );
});

test("record documents host linked views with their own configuration", async () => {
  const { source } = await fixture();
  const projects = await create("database"),
    record = (await act({
      action: "row.create",
      pageId: projects,
      cells: { title: "Projekt Alpha" },
    })).id as string,
    blockId = id();
  const html = `<p>Aufgaben</p>${await block(source, blockId)}`;
  await run(
    "INSERT INTO row_documents(row_id,state,html,generation) VALUES(?,?,?,?) ON CONFLICT(row_id) DO UPDATE SET state=excluded.state,html=excluded.html",
    record,
    htmlState(html),
    html,
    id(),
  );
  const rowDoc = async () =>
    (await one<{ html: string; generation: string }>(
      "SELECT html,generation FROM row_documents WHERE row_id=?",
      record,
    ))!;
  const data = await linkedDatabaseData(owner, projects, blockId, record);
  assert.equal(data.page.id, source);
  assert.equal(data.rows.length, 3);
  // The block must exist in exactly this record document.
  const other = (await act({
    action: "row.create",
    pageId: projects,
    cells: { title: "Anderes" },
  })).id as string;
  await assert.rejects(
    async () => await linkedDatabaseData(owner, projects, blockId, other),
    /Einbettung fehlt/,
  );
  await assert.rejects(async () => await linkedDatabaseData(stranger, projects, blockId, record));
  const command = async (mutation: Record<string, unknown>, actor = owner) =>
    await act(
      {
        action: "linked.command",
        pageId: projects,
        rowId: record,
        blockId,
        generation: (await rowDoc()).generation,
        sourceVersion: (await linkedDatabaseData(owner, projects, blockId, record))
          .sourceVersion,
        mutation,
      },
      actor,
    );
  const current = await linkedDatabaseData(owner, projects, blockId, record);
  const filtered = [
    {
      ...current.database.views[0],
      filters: [{ field: "status", op: "eq", value: "Done" }],
    },
  ];
  await assert.rejects(async () =>
    await command(
      {
        action: "database.update",
        version: current.database.version,
        fields: current.database.fields,
        views: filtered,
      },
      viewer,
    ),
  );
  await command({
    action: "database.update",
    version: current.database.version,
    fields: current.database.fields,
    views: filtered,
  });
  // The record document stores the view; the source keeps its own.
  assert.match((await rowDoc()).html, /data-linked-version="2"/);
  assert.match(
    (await one<{ content: string }>("SELECT content FROM rows WHERE id=?", record))!
      .content,
    /Done/,
  );
  assert.deepEqual((await database(source)).views[0].filters, []);
  const updated = await linkedDatabaseData(owner, projects, blockId, record);
  assert.equal(
    queryRows(updated.rows, updated.database.fields, updated.database.views[0])
      .length,
    2,
  );
  // Source records can be added through the embedding.
  await command({ action: "row.create", cells: { title: "D", status: "Done" } });
  assert.equal((await rows(source)).length, 4);
});
