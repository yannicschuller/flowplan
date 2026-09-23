import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity, Space, Page, Field } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(
  join(tmpdir(), "flowplan-space-copy-"),
);
const { id, run, all, one, transaction } = await import("../lib/db");
const { linkedDatabaseData } = await import("../lib/linked-databases");
const { command, database, rows, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { exportArchive, importArchive, readZip, writeZip } =
  await import("../lib/archive");
const { relationPairs, validateRelationGraph } =
  await import("../lib/relation-sync");
function user(): Identity {
  const uid = id();
  run(
    "INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)",
    uid,
    uid,
    "Copy Tester",
    `${uid}@example.test`,
  );
  return {
    id: uid,
    name: "Copy Tester",
    email: `${uid}@example.test`,
    groups: [],
    isAdmin: false,
    disabled: 0,
    created_at: "",
  };
}
function act(actor: Identity, input: Record<string, unknown>): any {
  return command(actor, input);
}
function fixture() {
  const owner = user(),
    editor = user(),
    viewer = user(),
    wid = createWorkspace(owner.id, "Copy checks");
  run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
  run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
  const sid = act(owner, {
    action: "space.create",
    workspaceId: wid,
    name: "Source",
    private: true,
    icon: "🧑🏽‍🚀",
    iconColor: "blue",
  }).id;
  const page = (title: string, kind = "document", parentId?: string) =>
    act(owner, {
      action: "page.create",
      workspaceId: wid,
      spaceId: sid,
      title,
      kind,
      parentId,
    }).id as string;
  const copy = (actor = owner, extra = {}) =>
    act(actor, {
      action: "space.duplicate",
      spaceId: sid,
      version: space(sid).version,
      name: "Copied",
      visibility: "private",
      ...extra,
    });
  return { owner, editor, viewer, wid, sid, page, copy };
}
function space(sid: string) {
  return one<Space>("SELECT * FROM spaces WHERE id=?", sid)!;
}
function upload(pid: string, actor: Identity) {
  const fid = id(),
    dir = join(process.env.FLOWPLAN_DATA_DIR!, "uploads");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, fid), "Independent content " + fid);
  run(
    "INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)",
    fid,
    pid,
    "sample.txt",
    "text/plain",
    56,
    actor.id,
  );
  return fid;
}
function schema(
  actor: Identity,
  pid: string,
  fields: Field[],
  relation?: unknown,
) {
  const db = database(pid);
  act(actor, {
    action: "database.update",
    pageId: pid,
    version: db.version,
    fields,
    views: db.views,
    relation,
  });
}

test("space appearance validates values, protects roles and stale drafts, and preserves omitted appearance", () => {
  const f = fixture();
  assert.equal(space(f.sid).icon, "🧑🏽‍🚀");
  assert.equal(space(f.sid).icon_color, "blue");
  const update = {
    action: "space.update",
    spaceId: f.sid,
    version: 1,
    name: "Renamed",
    private: true,
    icon: "🇩🇪",
    iconColor: "green",
  };
  for (const actor of [f.editor, f.viewer, user()])
    assert.throws(() => act(actor, update), /eigentümer/i);
  for (const value of ["url(test)", "", "BLUE"])
    assert.throws(() => act(f.owner, { ...update, iconColor: value }));
  assert.throws(() => act(f.owner, { ...update, icon: "a".repeat(31) }));
  act(f.owner, update);
  assert.throws(() => act(f.owner, update), /inzwischen/);
  act(f.owner, {
    action: "space.update",
    spaceId: f.sid,
    name: "Name only",
    private: true,
  });
  assert.equal(space(f.sid).icon, "🇩🇪");
  assert.equal(space(f.sid).icon_color, "green");
  assert.equal(
    bootstrap(f.owner, f.wid).spaces.find((s) => s.id === f.sid)?.icon_color,
    "green",
  );
});

test("space copying remaps every root, nested pages, files, relations and views while preserving literal UUID text", () => {
  const f = fixture(),
    doc = f.page("Document"),
    child = f.page("Child", "document", doc),
    a = f.page("Tasks", "database"),
    b = f.page("Projects", "database"),
    trashed = f.page("Old trash");
  const fid = upload(doc, f.owner);
  schema(f.owner, a, [
    { id: "title", name: "Text", type: "text" },
    { id: "links", name: "Projects", type: "relation", relationPage: b },
    { id: "file", name: "File", type: "files" },
  ]);
  schema(f.owner, a, database(a).fields, {
    fieldId: "links",
    enabled: true,
    name: "Tasks",
    targetVersion: database(b).version,
  });
  const pair = relationPairs(a)[0];
  const rb = act(f.owner, {
    action: "row.create",
    pageId: b,
    cells: { title: "Project" },
  }).id;
  const ra = act(f.owner, {
    action: "row.create",
    pageId: a,
    cells: { title: rb, links: [rb], file: `/api/files/${fid}` },
  }).id;
  const d = database(a);
  act(f.owner, {
    action: "database.update",
    pageId: a,
    version: d.version,
    fields: d.fields,
    views: [
      {
        id: "list",
        name: rb,
        type: "list",
        sorts: [],
        filters: [{ field: "links", op: "contains", value: rb }],
        rowOrder: [ra],
        groupBy: "links",
        groupSettings: {
          collapsed: [JSON.stringify(rb)],
          hideEmpty: false,
          sort: "manual",
        },
      },
    ],
  });
  const blockId = id(),
    linkedViews = JSON.stringify(database(a).views)
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;");
  run(
    "UPDATE documents SET html=? WHERE page_id=?",
    `<p>${b} <a href="/#page=${b}">Project database</a><a href="/api/files/${fid}">File</a></p><div data-linked-database="${blockId}" data-linked-source="${a}" data-linked-version="1" data-linked-views="${linkedViews}">Linked</div>`,
    doc,
  );
  run(
    "UPDATE pages SET cover=?,cover_position=23,locked=1 WHERE id=?",
    `/api/files/${fid}`,
    doc,
  );
  run(
    "UPDATE rows SET content=? WHERE id=?",
    `<p>Row <a href="/#page=${child}">Child</a></p>`,
    ra,
  );
  run(
    "INSERT INTO row_templates(id,page_id,name,cells,html,is_default,created_by) VALUES(?,?,?,?,?,1,?)",
    id(),
    a,
    "Default",
    JSON.stringify({ title: rb, links: [rb] }),
    `<p>${ra}</p>`,
    f.owner.id,
  );
  act(f.owner, {
    action: "form.update",
    pageId: a,
    enabled: true,
    internal: false,
    anonymous: true,
    config: {
      title: "Copied form",
      description: "Description",
      successMessage: "Thanks",
      requiredFields: ["title"],
    },
  });
  act(f.owner, { action: "page.publish", pageId: b, enabled: true });
  act(f.owner, {
    action: "share.create",
    pageId: child,
    name: "Guest",
    role: "editor",
  });
  act(f.owner, { action: "page.delete", pageId: trashed });
  const copy = f.copy();
  assert.equal(copy.pages, 4);
  assert.equal(space(copy.id).icon, "🧑🏽‍🚀");
  assert.equal(space(copy.id).icon_color, "blue");
  const copied = all<Page>("SELECT * FROM pages WHERE space_id=?", copy.id);
  const next = (title: string) => copied.find((p) => p.title === title)!;
  assert.equal(next("Child").parent_id, next("Document").id);
  assert.equal(next("Tasks").parent_id, null);
  const copiedFile = one<{ id: string }>(
    "SELECT id FROM files WHERE page_id=?",
    next("Document").id,
  )!.id;
  assert.notEqual(copiedFile, fid);
  assert.equal(
    readFileSync(
      join(process.env.FLOWPLAN_DATA_DIR!, "uploads", copiedFile),
      "utf8",
    ),
    "Independent content " + fid,
  );
  const html = String(
    one("SELECT html FROM documents WHERE page_id=?", next("Document").id)!
      .html,
  );
  assert.ok(html.includes(b)); // literal text is retained
  assert.ok(html.includes(`/#page=${next("Projects").id}`));
  assert.ok(html.includes(`/api/files/${copiedFile}`));
  assert.equal(next("Document").cover, `/api/files/${copiedFile}`);
  assert.equal(next("Document").cover_position, 23);
  const ca = rows(next("Tasks").id)[0],
    cb = rows(next("Projects").id)[0],
    cdb = database(next("Tasks").id);
  assert.equal(ca.cells.title, rb);
  assert.deepEqual(ca.cells.links, [cb.id]);
  assert.equal(ca.cells.file, `/api/files/${copiedFile}`);
  assert.ok(ca.content?.includes(next("Child").id));
  assert.equal(
    cdb.fields.find((field) => field.id === "links")?.relationPage,
    next("Projects").id,
  );
  const linked = linkedDatabaseData(f.owner, next("Document").id, blockId);
  assert.equal(linked.page.id, next("Tasks").id);
  assert.equal(linked.database.views[0].filters[0].value, cb.id);
  assert.equal(linked.database.views[0].name, rb);
  assert.equal(cdb.views[0].name, rb);
  assert.equal(cdb.views[0].filters[0].value, cb.id);
  assert.deepEqual(cdb.views[0].rowOrder, [ca.id]);
  assert.deepEqual(cdb.views[0].groupSettings?.collapsed, [
    JSON.stringify(cb.id),
  ]);
  assert.deepEqual(cb.cells[pair.right_field], [ca.id]);
  assert.equal(relationPairs(next("Tasks").id).length, 1);
  validateRelationGraph(
    relationPairs(next("Tasks").id),
    new Map(
      [next("Tasks").id, next("Projects").id].map((pid) => [
        pid,
        { fields: database(pid).fields, rows: rows(pid) },
      ]),
    ),
  );
  const template = one<{ cells: string; html: string }>(
    "SELECT cells,html FROM row_templates WHERE page_id=?",
    next("Tasks").id,
  )!;
  assert.deepEqual(JSON.parse(template.cells), { title: rb, links: [cb.id] });
  assert.ok(template.html.includes(ra));
  const form = one<{ enabled: number; config: string; token: string }>(
    "SELECT * FROM forms WHERE page_id=?",
    next("Tasks").id,
  )!;
  assert.equal(form.enabled, 0);
  assert.equal(JSON.parse(form.config).title, "Copied form");
  assert.notEqual(
    form.token,
    one("SELECT token FROM forms WHERE page_id=?", a)?.token,
  );
  for (const page of copied) {
    assert.equal(page.public_token, null);
    assert.equal(
      all("SELECT * FROM grants WHERE resource_id=?", page.id).length,
      0,
    );
    assert.equal(
      all("SELECT * FROM share_links WHERE root_id=?", page.id).length,
      0,
    );
    assert.equal(
      all("SELECT * FROM snapshots WHERE page_id=?", page.id).length,
      0,
    );
  }
  act(f.owner, {
    action: "row.update",
    pageId: next("Tasks").id,
    rowId: ca.id,
    version: ca.version,
    cells: { links: [] },
  });
  assert.deepEqual(rows(next("Projects").id)[0].cells[pair.right_field], []);
  assert.deepEqual(rows(a)[0].cells.links, [rb]);
  unlinkSync(join(process.env.FLOWPLAN_DATA_DIR!, "uploads", fid));
  assert.ok(
    readFileSync(join(process.env.FLOWPLAN_DATA_DIR!, "uploads", copiedFile))
      .length,
  );
});

test("duplication enforces private content access, ownership, versions and trash, and supports empty spaces", () => {
  const f = fixture();
  for (const actor of [f.editor, f.viewer, user()])
    assert.throws(() => f.copy(actor), /eigentümer/i);
  run("UPDATE spaces SET owner_id=? WHERE id=?", f.editor.id, f.sid);
  assert.throws(() => f.copy(f.owner), /Zugriff/); // workspace admin metadata is not content access
  const clone = f.copy(f.editor, { visibility: "team" });
  assert.equal(clone.pages, 0);
  assert.equal(space(clone.id).owner_id, f.editor.id);
  assert.equal(space(clone.id).visibility, "team");
  assert.throws(() => f.copy(f.editor, { version: 0 }));
  assert.throws(() => f.copy(f.editor, { version: 2 }), /inzwischen/);
  assert.throws(() => f.copy(f.editor, { visibility: "public" }));
  assert.throws(() => f.copy(f.editor, { name: "   " }));
  run(
    "UPDATE members SET role='viewer' WHERE workspace_id=? AND user_id=?",
    f.wid,
    f.editor.id,
  );
  assert.throws(() => f.copy(f.editor), /eigentümer/i);
  run(
    "UPDATE members SET role='editor' WHERE workspace_id=? AND user_id=?",
    f.wid,
    f.editor.id,
  );
  act(f.editor, {
    action: "space.delete",
    spaceId: f.sid,
    version: 1,
    confirmName: "Source",
  });
  assert.throws(() => f.copy(f.editor), /wiederherstellen/);
});

test("failed or rolled-back space copies remove all new metadata and physical files", () => {
  const f = fixture(),
    doc = f.page("Uploads"),
    first = upload(doc, f.owner),
    missing = upload(doc, f.owner);
  const dir = join(process.env.FLOWPLAN_DATA_DIR!, "uploads");
  unlinkSync(join(dir, missing));
  const beforeFiles = readdirSync(dir).sort(),
    beforeSpaces = all("SELECT id FROM spaces WHERE workspace_id=?", f.wid),
    beforePages = all("SELECT id FROM pages WHERE workspace_id=?", f.wid);
  assert.throws(() => f.copy(), /ENOENT/);
  assert.deepEqual(readdirSync(dir).sort(), beforeFiles);
  assert.deepEqual(
    all("SELECT id FROM spaces WHERE workspace_id=?", f.wid),
    beforeSpaces,
  );
  assert.deepEqual(
    all("SELECT id FROM pages WHERE workspace_id=?", f.wid),
    beforePages,
  );
  run("DELETE FROM files WHERE id=?", missing);
  assert.throws(
    () =>
      transaction(() => {
        command(
          f.owner,
          {
            action: "space.duplicate",
            spaceId: f.sid,
            version: space(f.sid).version,
            name: "Rollback copy",
            visibility: "private",
          },
          true,
        );
        throw Error("Rollback test");
      }),
    /Rollback test/,
  );
  assert.deepEqual(readdirSync(dir).sort(), beforeFiles);
  assert.deepEqual(
    all("SELECT id FROM spaces WHERE workspace_id=?", f.wid),
    beforeSpaces,
  );
  assert.ok(readFileSync(join(dir, first)).length);
});

test("space icon and color survive archive restoration; legacy archives default to no background", async () => {
  const f = fixture();
  f.page("Archived");
  const bytes = await exportArchive(f.owner, f.wid),
    destination = createWorkspace(f.owner.id, "Destination");
  const result = await importArchive(f.owner, destination, bytes);
  const copied = all<Space>(
    "SELECT * FROM spaces WHERE workspace_id=?",
    destination,
  ).find((s) => s.name === "Source (Import)")!;
  assert.ok(result.spaces.some((sid) => sid === copied.id));
  assert.equal(copied.icon, "🧑🏽‍🚀");
  assert.equal(copied.icon_color, "blue");
  const entries = await readZip(bytes);
  const manifestKey = [...entries.keys()].find((k) => k.endsWith(".json"))!;
  const manifest = JSON.parse(entries.get(manifestKey)!.toString());
  for (const space of manifest.spaces) delete space.icon_color;
  entries.set(manifestKey, Buffer.from(JSON.stringify(manifest)));
  const legacyDestination = createWorkspace(f.owner.id, "Legacy");
  await importArchive(f.owner, legacyDestination, await writeZip(entries));
  assert.equal(
    all<Space>(
      "SELECT * FROM spaces WHERE workspace_id=?",
      legacyDestination,
    ).find((s) => s.name === "Source (Import)")?.icon_color,
    "none",
  );
});
