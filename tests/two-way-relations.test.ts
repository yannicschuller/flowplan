import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Field, Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(
  join(tmpdir(), "flowplan-two-way-"),
);
const { id, run, all, one } = await import("../lib/db");
const { command, database, rows, bootstrap, pageData } =
  await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { relationPairs, validateRelationGraph } =
  await import("../lib/relation-sync");
const { exportArchive, importArchive, readZip, writeZip } =
  await import("../lib/archive");
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
    groups: [],
    isAdmin: false,
    disabled: 0,
    created_at: "",
  };
}
const owner = user("owner"),
  editor = user("editor"),
  wid = createWorkspace(owner.id, "Two-way relations"),
  boot = bootstrap(owner, wid);
run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
function action(input: Record<string, unknown>, actor = owner): any {
  return command(actor, input);
}
function create(title: string, extra = {}) {
  return action({
    action: "page.create",
    workspaceId: wid,
    spaceId: boot.spaces[0].id,
    kind: "database",
    title,
    ...extra,
  }).id as string;
}
function schema(
  pageId: string,
  fields: Field[],
  relation?: Record<string, unknown>,
  actor = owner,
) {
  const d = database(pageId);
  return action(
    {
      action: "database.update",
      pageId,
      version: d.version,
      views: d.views,
      fields,
      relation,
    },
    actor,
  );
}
function connect(
  source: string,
  target: string,
  fieldId = "links",
  actor = owner,
) {
  schema(
    source,
    database(source).fields,
    {
      fieldId,
      enabled: true,
      name: "Rückrelation",
      targetVersion: database(target).version,
    },
    actor,
  );
  return relationPairs(source).find(
    (p) => p.left_page === source && p.left_field === fieldId,
  )!;
}
function row(pageId: string, cells: Record<string, unknown>) {
  return action({ action: "row.create", pageId, cells }).id as string;
}
function record(pageId: string, rowId: string) {
  return rows(pageId).find((r) => r.id === rowId)!;
}
function update(
  pageId: string,
  rowId: string,
  cells: Record<string, unknown>,
  actor = owner,
) {
  return action(
    {
      action: "row.update",
      pageId,
      rowId,
      version: record(pageId, rowId).version,
      cells,
    },
    actor,
  );
}
function fixture(self = false, extra = {}) {
  const source = create("Projects", extra),
    target = self ? source : create("Tasks", extra);
  schema(source, [
    { id: "title", name: "Title", type: "text" },
    { id: "links", name: "Links", type: "relation", relationPage: target },
  ]);
  const b = row(target, { title: "B" }),
    a = row(source, { title: "A", links: [b] }),
    pair = connect(source, target);
  return { source, target, a, b, pair, inverse: pair.right_field };
}
function cleanQueue() {
  assert.equal(all("SELECT * FROM relation_changes").length, 0);
  assert.equal(all("SELECT * FROM relation_initializations").length, 0);
  assert.equal(one("SELECT syncing FROM relation_sync_control")!.syncing, 0);
}
function checkGraph(pages: string[]) {
  validateRelationGraph(
    relationPairs().filter(
      (p) => pages.includes(p.left_page) && pages.includes(p.right_page),
    ),
    new Map(
      pages.map((p) => [p, { fields: database(p).fields, rows: rows(p) }]),
    ),
  );
}

test("two-way creation backfills existing links and mirrors edits from either side with version conflicts", () => {
  const { source, target, a, b, inverse, pair } = fixture();
  assert.deepEqual(record(target, b).cells[inverse], [a]);
  assert.equal(
    database(target).fields.find((f) => f.id === inverse)!.relationPage,
    source,
  );
  assert.equal((pageData(owner, source) as any).relationPairs[0].id, pair.id);
  const oldVersion = record(target, b).version,
    c = row(source, { title: "C", links: [b] });
  assert.deepEqual(
    new Set(record(target, b).cells[inverse] as string[]),
    new Set([a, c]),
  );
  assert.ok(record(target, b).version > oldVersion);
  assert.throws(
    () =>
      action({
        action: "row.update",
        pageId: target,
        rowId: b,
        version: oldVersion,
        cells: { title: "Stale" },
      }),
    /geändert/,
  );
  update(target, b, { [inverse]: [c] });
  assert.deepEqual(record(source, a).cells.links, []);
  update(source, c, { links: [] });
  assert.deepEqual(record(target, b).cells[inverse], []);
  update(target, b, { [inverse]: [a, c] });
  checkGraph([source, target]);
  cleanQueue();
});

test("configuration and updates enforce both page permissions, target schema versions and locks atomically", () => {
  const { source, target, a, b, inverse } = fixture(),
    c = row(source, { title: "C" });
  const privateSpace = action({
    action: "space.create",
    workspaceId: wid,
    name: "Private",
    private: true,
  }).id;
  run("UPDATE pages SET space_id=? WHERE id=?", privateSpace, target);
  run(
    "INSERT INTO grants(resource_id,user_id,role) VALUES(?,?,?)",
    target,
    editor.id,
    "viewer",
  );
  const before = record(source, c);
  assert.throws(
    () => update(source, c, { links: [b] }, editor),
    /Berechtigung|Leserechte/,
  );
  assert.deepEqual(record(source, c), before);
  // Unrelated edits remain allowed; the hidden relation is preserved.
  update(source, a, { title: "Allowed" }, editor);
  assert.deepEqual(record(target, b).cells[inverse], [a]);
  const d = create("Denied configuration");
  schema(d, [
    { id: "title", name: "Title", type: "text" },
    { id: "links", name: "Links", type: "relation", relationPage: target },
  ]);
  const beforeSchema = database(d);
  assert.throws(
    () => connect(d, target, "links", editor),
    /Berechtigung|Leserechte/,
  );
  assert.deepEqual(database(d), beforeSchema);
  assert.throws(
    () =>
      schema(d, beforeSchema.fields, {
        fieldId: "links",
        enabled: true,
        targetVersion: 1,
      }),
    /Zieldatenbank wurde geändert/,
  );
  assert.deepEqual(database(d), beforeSchema);
  action({ action: "page.update", pageId: target, patch: { locked: true } });
  assert.throws(() => update(source, c, { links: [b] }), /gesperrt/);
  assert.deepEqual(record(source, c), before);
  // Deleting a row cleans its references even if the counterpart is locked/read-only.
  action({ action: "row.delete", pageId: source, rowId: a }, editor);
  assert.deepEqual(record(target, b).cells[inverse], []);
  action({ action: "page.update", pageId: target, patch: { locked: false } });
  cleanQueue();
});

test("bulk updates, duplicates, imports and delete/restore keep counterpart cells consistent", () => {
  const { source, target, a, b, inverse } = fixture();
  const result = action({
    action: "rows.bulk",
    pageId: source,
    operation: "duplicate",
    rows: [{ id: a, version: record(source, a).version }],
  });
  assert.deepEqual(
    new Set(record(target, b).cells[inverse] as string[]),
    new Set([a, ...result.ids]),
  );
  action({
    action: "rows.import",
    pageId: source,
    rows: [{ title: "Imported", links: [b] }],
  });
  assert.equal((record(target, b).cells[inverse] as string[]).length, 3);
  const beforeImport = rows(source);
  assert.throws(
    () =>
      action({
        action: "rows.import",
        pageId: source,
        rows: [{ title: "Invalid", links: [id()] }],
      }),
    /Verknüpfter Eintrag fehlt/,
  );
  assert.deepEqual(rows(source), beforeImport);
  cleanQueue();
  const saved = action({
    action: "rows.bulk",
    pageId: source,
    operation: "delete",
    rows: rows(source).map((r) => ({ id: r.id, version: r.version })),
  });
  assert.deepEqual(record(target, b).cells[inverse], []);
  action({
    action: "snapshot.restore",
    pageId: source,
    snapshotId: saved.snapshotId,
  });
  assert.equal((record(target, b).cells[inverse] as string[]).length, 3);
  const reverseSnapshot = action({
    action: "page.snapshot",
    pageId: target,
  }).id;
  update(source, a, { links: [] });
  const version = record(source, a).version;
  action({
    action: "snapshot.restore",
    pageId: target,
    snapshotId: reverseSnapshot,
  });
  assert.deepEqual(record(source, a).cells.links, [b]);
  assert.ok(record(source, a).version > version);
  checkGraph([source, target]);
  cleanQueue();
});

test("self relations and multiple paired properties restore independently without mixing edges", () => {
  const { source, a, b, inverse } = fixture(true),
    c = row(source, { title: "C" });
  update(source, b, { links: [a] });
  update(source, c, { links: [c] });
  assert.deepEqual(record(source, a).cells[inverse], [b]);
  assert.deepEqual(record(source, c).cells[inverse], [c]);
  schema(source, [
    ...database(source).fields,
    { id: "other", name: "Other", type: "relation", relationPage: source },
  ]);
  update(source, a, { other: [c] });
  const second = connect(source, source, "other");
  const snap = action({ action: "page.snapshot", pageId: source }).id;
  update(source, a, { links: [], other: [] });
  action({ action: "snapshot.restore", pageId: source, snapshotId: snap });
  assert.deepEqual(record(source, a).cells.links, [b]);
  assert.deepEqual(record(source, c).cells[second.right_field], [a]);
  checkGraph([source]);
  cleanQueue();
});

test("disconnect and property deletion preserve independent values; incompatible restore is atomic", () => {
  const { source, target, a, b, inverse } = fixture();
  const snap = action({ action: "page.snapshot", pageId: source }).id;
  schema(source, database(source).fields, { fieldId: "links", enabled: false });
  assert.equal(relationPairs(source).length, 0);
  assert.deepEqual(record(target, b).cells[inverse], [a]);
  update(source, a, { links: [] });
  assert.deepEqual(record(target, b).cells[inverse], [a]);
  action({ action: "snapshot.restore", pageId: source, snapshotId: snap });
  assert.equal(relationPairs(source).length, 1);
  checkGraph([source, target]);
  schema(
    target,
    database(target).fields.filter((f) => f.id !== inverse),
  );
  assert.equal(relationPairs(source).length, 0);
  const before = rows(source);
  assert.throws(
    () =>
      action({ action: "snapshot.restore", pageId: source, snapshotId: snap }),
    /Gegeneigenschaft/,
  );
  assert.deepEqual(rows(source), before);
  cleanQueue();
});

test("copying a tree keeps new pairs internal, while copying only one database does not modify originals", () => {
  const root = create("Root", { kind: "document" }),
    { source, target, a, b, inverse } = fixture(false, { parentId: root });
  const dup = action({ action: "page.duplicate", pageId: root });
  const copied = all<{ id: string; title: string }>(
    "SELECT id,title FROM pages WHERE parent_id=?",
    dup.id,
  );
  const cs = copied.find((p) => p.title === "Projects")!.id,
    ct = copied.find((p) => p.title === "Tasks")!.id;
  assert.equal(relationPairs(cs).length, 1);
  checkGraph([cs, ct]);
  assert.notEqual(rows(cs)[0].id, a);
  assert.notEqual(rows(ct)[0].id, b);
  update(cs, rows(cs)[0].id, { links: [] });
  assert.deepEqual(rows(ct)[0].cells[inverse], []);
  assert.deepEqual(record(target, b).cells[inverse], [a]);
  const single = action({ action: "page.duplicate", pageId: source });
  assert.equal(relationPairs(single.id).length, 0);
  update(single.id, rows(single.id)[0].id, { links: [] });
  assert.deepEqual(record(target, b).cells[inverse], [a]);
  cleanQueue();
});

test("saved self-relation templates instantiate independent pairs and replacement cleans old external references", () => {
  const self = fixture(true);
  const template = action({
    action: "template.save",
    pageId: self.source,
    name: "Self relation template",
  }).id;
  const created = create("Template instance", { templateId: template });
  checkGraph([created]);
  assert.equal(relationPairs(created).length, 1);
  const a = rows(created).find((r) => r.cells.title === "A")!,
    b = rows(created).find((r) => r.cells.title === "B")!;
  assert.deepEqual(a.cells.links, [b.id]);
  update(created, a.id, { links: [] });
  assert.deepEqual(record(created, b.id).cells[self.inverse], []);
  assert.deepEqual(record(self.source, self.a).cells.links, [self.b]);
  const external = fixture();
  const replaced = action({
    action: "template.apply",
    pageId: external.source,
    templateId: template,
    version: database(external.source).version,
  });
  assert.deepEqual(
    record(external.target, external.b).cells[external.inverse],
    [],
  );
  assert.equal(relationPairs(external.target).length, 0);
  checkGraph([external.source]);
  // Returning to the prior version reconnects its original target.
  action({
    action: "snapshot.restore",
    pageId: external.source,
    snapshotId: replaced.snapshotId,
  });
  assert.deepEqual(
    record(external.target, external.b).cells[external.inverse],
    [external.a],
  );
  checkGraph([external.source, external.target]);
  cleanQueue();
});

test("archives preserve pairs and remap version/template references, rejecting asymmetric graphs atomically", async () => {
  const { source, target, a, b, pair, inverse } = fixture();
  action({ action: "page.snapshot", pageId: source });
  const templateSource = fixture(true);
  action({
    action: "template.save",
    pageId: templateSource.source,
    name: "Archive self relation template",
  });
  const bytes = await exportArchive(owner, wid),
    dest = createWorkspace(owner.id, "Restored two-way");
  const imported = await importArchive(owner, dest, bytes),
    cs = imported.pageIds[source],
    ct = imported.pageIds[target];
  const newPair = relationPairs(cs)[0];
  assert.notEqual(newPair.id, pair.id);
  assert.equal(newPair.right_page, ct);
  checkGraph([cs, ct]);
  const restoredSnapshot = one<{ id: string }>(
    "SELECT id FROM snapshots WHERE page_id=?",
    cs,
  )!.id;
  const newA = rows(cs)[0],
    newB = rows(ct)[0];
  update(cs, newA.id, { links: [] });
  action({
    action: "snapshot.restore",
    pageId: cs,
    snapshotId: restoredSnapshot,
  });
  assert.deepEqual(record(ct, newB.id).cells[inverse], [newA.id]);
  assert.deepEqual(record(source, a).cells.links, [b]);
  const template = one<{ id: string }>(
    "SELECT id FROM templates WHERE workspace_id=? AND name=?",
    dest,
    "Archive self relation template",
  )!;
  const destBoot = bootstrap(owner, dest);
  const instance = action({
    action: "page.create",
    workspaceId: dest,
    spaceId: destBoot.spaces[0].id,
    title: "Imported template",
    kind: "database",
    templateId: template.id,
  });
  checkGraph([instance.id]);
  assert.equal(relationPairs(instance.id).length, 1);
  const zip = await readZip(bytes),
    manifest = JSON.parse(zip.get("flowplan.json")!.toString());
  const graph = manifest.pages.find((p: any) => p.id === target).database;
  graph.rows.find((r: any) => r.id === b).cells[inverse] = [];
  zip.set("flowplan.json", Buffer.from(JSON.stringify(manifest)));
  const count = one(
    "SELECT count(*) n FROM pages WHERE workspace_id=?",
    dest,
  )!.n;
  const damaged = await writeZip(zip);
  await assert.rejects(
    () => importArchive(owner, dest, damaged),
    /Unvollständige Rückrelation/,
  );
  assert.equal(
    one("SELECT count(*) n FROM pages WHERE workspace_id=?", dest)!.n,
    count,
  );
  const duplicateZip = await readZip(bytes),
    duplicateManifest = JSON.parse(
      duplicateZip.get("flowplan.json")!.toString(),
    );
  duplicateManifest.relationPairs.push({
    ...duplicateManifest.relationPairs[0],
    id: id(),
  });
  duplicateZip.set(
    "flowplan.json",
    Buffer.from(JSON.stringify(duplicateManifest)),
  );
  const duplicateBytes = await writeZip(duplicateZip);
  await assert.rejects(
    () => importArchive(owner, dest, duplicateBytes),
    /Ungültige Rückrelation/,
  );
  assert.equal(
    one("SELECT count(*) n FROM pages WHERE workspace_id=?", dest)!.n,
    count,
  );
  cleanQueue();
});
