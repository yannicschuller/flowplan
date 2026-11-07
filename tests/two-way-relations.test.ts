import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Field, Identity } from "../lib/types";
import { mapAsync } from "../lib/each-async";
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
  editor = await user("editor"),
  wid = await createWorkspace(owner.id, "Two-way relations"),
  boot = await bootstrap(owner, wid);
await run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
async function action(input: Record<string, unknown>, actor = owner): Promise<any> {
  return await command(actor, input);
}
async function create(title: string, extra = {}) {
  return (await action({
    action: "page.create",
    workspaceId: wid,
    spaceId: boot.spaces[0].id,
    kind: "database",
    title,
    ...extra,
  })).id as string;
}
async function schema(
  pageId: string,
  fields: Field[],
  relation?: Record<string, unknown>,
  actor = owner,
) {
  const d = await database(pageId);
  return await action(
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
async function connect(
  source: string,
  target: string,
  fieldId = "links",
  actor = owner,
) {
  await schema(
    source,
    (await database(source)).fields,
    {
      fieldId,
      enabled: true,
      name: "Rückrelation",
      targetVersion: (await database(target)).version,
    },
    actor,
  );
  return (await relationPairs(source)).find(
    (p) => p.left_page === source && p.left_field === fieldId,
  )!;
}
async function row(pageId: string, cells: Record<string, unknown>) {
  return (await action({ action: "row.create", pageId, cells })).id as string;
}
async function record(pageId: string, rowId: string) {
  return (await rows(pageId)).find((r) => r.id === rowId)!;
}
async function update(
  pageId: string,
  rowId: string,
  cells: Record<string, unknown>,
  actor = owner,
) {
  return await action(
    {
      action: "row.update",
      pageId,
      rowId,
      version: (await record(pageId, rowId)).version,
      cells,
    },
    actor,
  );
}
async function fixture(self = false, extra = {}) {
  const source = await create("Projects", extra),
    target = self ? source : (await create("Tasks", extra));
  await schema(source, [
    { id: "title", name: "Title", type: "text" },
    { id: "links", name: "Links", type: "relation", relationPage: target },
  ]);
  const b = await row(target, { title: "B" }),
    a = await row(source, { title: "A", links: [b] }),
    pair = await connect(source, target);
  return { source, target, a, b, pair, inverse: pair.right_field };
}
async function cleanQueue() {
  assert.equal((await all("SELECT * FROM relation_changes")).length, 0);
  assert.equal((await all("SELECT * FROM relation_initializations")).length, 0);
  assert.equal((await one("SELECT syncing FROM relation_sync_control"))!.syncing, 0);
}
async function checkGraph(pages: string[]) {
  validateRelationGraph(
    (await relationPairs()).filter(
      (p) => pages.includes(p.left_page) && pages.includes(p.right_page),
    ),
    new Map(
      await mapAsync(pages, async (p) => [p, { fields: (await database(p)).fields, rows: await rows(p) }]),
    ),
  );
}

test("two-way creation backfills existing links and mirrors edits from either side with version conflicts", async () => {
  const { source, target, a, b, inverse, pair } = await fixture();
  assert.deepEqual((await record(target, b)).cells[inverse], [a]);
  assert.equal(
    (await database(target)).fields.find((f) => f.id === inverse)!.relationPage,
    source,
  );
  assert.equal(((await pageData(owner, source)) as any).relationPairs[0].id, pair.id);
  const oldVersion = (await record(target, b)).version,
    c = await row(source, { title: "C", links: [b] });
  assert.deepEqual(
    new Set((await record(target, b)).cells[inverse] as string[]),
    new Set([a, c]),
  );
  assert.ok((await record(target, b)).version > oldVersion);
  await assert.rejects(
    async () =>
      await action({
        action: "row.update",
        pageId: target,
        rowId: b,
        version: oldVersion,
        cells: { title: "Stale" },
      }),
    /geändert/,
  );
  await update(target, b, { [inverse]: [c] });
  assert.deepEqual((await record(source, a)).cells.links, []);
  await update(source, c, { links: [] });
  assert.deepEqual((await record(target, b)).cells[inverse], []);
  await update(target, b, { [inverse]: [a, c] });
  await checkGraph([source, target]);
  await cleanQueue();
});

test("configuration and updates enforce both page permissions, target schema versions and locks atomically", async () => {
  const { source, target, a, b, inverse } = await fixture(),
    c = await row(source, { title: "C" });
  const privateSpace = (await action({
    action: "space.create",
    workspaceId: wid,
    name: "Private",
    private: true,
  })).id;
  await run("UPDATE pages SET space_id=? WHERE id=?", privateSpace, target);
  await run(
    "INSERT INTO grants(resource_id,user_id,role) VALUES(?,?,?)",
    target,
    editor.id,
    "viewer",
  );
  const before = await record(source, c);
  await assert.rejects(
    async () => await update(source, c, { links: [b] }, editor),
    /Berechtigung|Leserechte/,
  );
  assert.deepEqual(await record(source, c), before);
  // Unrelated edits remain allowed; the hidden relation is preserved.
  await update(source, a, { title: "Allowed" }, editor);
  assert.deepEqual((await record(target, b)).cells[inverse], [a]);
  const d = await create("Denied configuration");
  await schema(d, [
    { id: "title", name: "Title", type: "text" },
    { id: "links", name: "Links", type: "relation", relationPage: target },
  ]);
  const beforeSchema = await database(d);
  await assert.rejects(
    async () => await connect(d, target, "links", editor),
    /Berechtigung|Leserechte/,
  );
  assert.deepEqual(await database(d), beforeSchema);
  await assert.rejects(
    async () =>
      await schema(d, beforeSchema.fields, {
        fieldId: "links",
        enabled: true,
        targetVersion: 1,
      }),
    /Zieldatenbank wurde geändert/,
  );
  assert.deepEqual(await database(d), beforeSchema);
  await action({ action: "page.update", pageId: target, patch: { locked: true } });
  await assert.rejects(async () => await update(source, c, { links: [b] }), /gesperrt/);
  assert.deepEqual(await record(source, c), before);
  // Deleting a row cleans its references even if the counterpart is locked/read-only.
  await action({ action: "row.delete", pageId: source, rowId: a }, editor);
  assert.deepEqual((await record(target, b)).cells[inverse], []);
  await action({ action: "page.update", pageId: target, patch: { locked: false } });
  await cleanQueue();
});

test("bulk updates, duplicates, imports and delete/restore keep counterpart cells consistent", async () => {
  const { source, target, a, b, inverse } = await fixture();
  const result = await action({
    action: "rows.bulk",
    pageId: source,
    operation: "duplicate",
    rows: [{ id: a, version: (await record(source, a)).version }],
  });
  assert.deepEqual(
    new Set((await record(target, b)).cells[inverse] as string[]),
    new Set([a, ...result.ids]),
  );
  await action({
    action: "rows.import",
    pageId: source,
    rows: [{ title: "Imported", links: [b] }],
  });
  assert.equal(((await record(target, b)).cells[inverse] as string[]).length, 3);
  const beforeImport = await rows(source);
  await assert.rejects(
    async () =>
      await action({
        action: "rows.import",
        pageId: source,
        rows: [{ title: "Invalid", links: [id()] }],
      }),
    /Verknüpfter Eintrag fehlt/,
  );
  assert.deepEqual(await rows(source), beforeImport);
  await cleanQueue();
  const saved = await action({
    action: "rows.bulk",
    pageId: source,
    operation: "delete",
    rows: (await rows(source)).map((r) => ({ id: r.id, version: r.version })),
  });
  assert.deepEqual((await record(target, b)).cells[inverse], []);
  await action({
    action: "snapshot.restore",
    pageId: source,
    snapshotId: saved.snapshotId,
  });
  assert.equal(((await record(target, b)).cells[inverse] as string[]).length, 3);
  const reverseSnapshot = (await action({
    action: "page.snapshot",
    pageId: target,
  })).id;
  await update(source, a, { links: [] });
  const version = (await record(source, a)).version;
  await action({
    action: "snapshot.restore",
    pageId: target,
    snapshotId: reverseSnapshot,
  });
  assert.deepEqual((await record(source, a)).cells.links, [b]);
  assert.ok((await record(source, a)).version > version);
  await checkGraph([source, target]);
  await cleanQueue();
});

test("self relations and multiple paired properties restore independently without mixing edges", async () => {
  const { source, a, b, inverse } = await fixture(true),
    c = await row(source, { title: "C" });
  await update(source, b, { links: [a] });
  await update(source, c, { links: [c] });
  assert.deepEqual((await record(source, a)).cells[inverse], [b]);
  assert.deepEqual((await record(source, c)).cells[inverse], [c]);
  await schema(source, [
    ...(await database(source)).fields,
    { id: "other", name: "Other", type: "relation", relationPage: source },
  ]);
  await update(source, a, { other: [c] });
  const second = await connect(source, source, "other");
  const snap = (await action({ action: "page.snapshot", pageId: source })).id;
  await update(source, a, { links: [], other: [] });
  await action({ action: "snapshot.restore", pageId: source, snapshotId: snap });
  assert.deepEqual((await record(source, a)).cells.links, [b]);
  assert.deepEqual((await record(source, c)).cells[second.right_field], [a]);
  await checkGraph([source]);
  await cleanQueue();
});

test("disconnect and property deletion preserve independent values; incompatible restore is atomic", async () => {
  const { source, target, a, b, inverse } = await fixture();
  const snap = (await action({ action: "page.snapshot", pageId: source })).id;
  await schema(source, (await database(source)).fields, { fieldId: "links", enabled: false });
  assert.equal((await relationPairs(source)).length, 0);
  assert.deepEqual((await record(target, b)).cells[inverse], [a]);
  await update(source, a, { links: [] });
  assert.deepEqual((await record(target, b)).cells[inverse], [a]);
  await action({ action: "snapshot.restore", pageId: source, snapshotId: snap });
  assert.equal((await relationPairs(source)).length, 1);
  await checkGraph([source, target]);
  await schema(
    target,
    (await database(target)).fields.filter((f) => f.id !== inverse),
  );
  assert.equal((await relationPairs(source)).length, 0);
  const before = await rows(source);
  await assert.rejects(
    async () =>
      await action({ action: "snapshot.restore", pageId: source, snapshotId: snap }),
    /Gegeneigenschaft/,
  );
  assert.deepEqual(await rows(source), before);
  await cleanQueue();
});

test("copying a tree keeps new pairs internal, while copying only one database does not modify originals", async () => {
  const root = await create("Root", { kind: "document" }),
    { source, target, a, b, inverse } = await fixture(false, { parentId: root });
  const dup = await action({ action: "page.duplicate", pageId: root });
  const copied = await all<{ id: string; title: string }>(
    "SELECT id,title FROM pages WHERE parent_id=?",
    dup.id,
  );
  const cs = copied.find((p) => p.title === "Projects")!.id,
    ct = copied.find((p) => p.title === "Tasks")!.id;
  assert.equal((await relationPairs(cs)).length, 1);
  await checkGraph([cs, ct]);
  assert.notEqual((await rows(cs))[0].id, a);
  assert.notEqual((await rows(ct))[0].id, b);
  await update(cs, (await rows(cs))[0].id, { links: [] });
  assert.deepEqual((await rows(ct))[0].cells[inverse], []);
  assert.deepEqual((await record(target, b)).cells[inverse], [a]);
  const single = await action({ action: "page.duplicate", pageId: source });
  assert.equal((await relationPairs(single.id)).length, 0);
  await update(single.id, (await rows(single.id))[0].id, { links: [] });
  assert.deepEqual((await record(target, b)).cells[inverse], [a]);
  await cleanQueue();
});

test("saved self-relation templates instantiate independent pairs and replacement cleans old external references", async () => {
  const self = await fixture(true);
  const template = (await action({
    action: "template.save",
    pageId: self.source,
    name: "Self relation template",
  })).id;
  const created = await create("Template instance", { templateId: template });
  await checkGraph([created]);
  assert.equal((await relationPairs(created)).length, 1);
  const a = (await rows(created)).find((r) => r.cells.title === "A")!,
    b = (await rows(created)).find((r) => r.cells.title === "B")!;
  assert.deepEqual(a.cells.links, [b.id]);
  await update(created, a.id, { links: [] });
  assert.deepEqual((await record(created, b.id)).cells[self.inverse], []);
  assert.deepEqual((await record(self.source, self.a)).cells.links, [self.b]);
  const external = await fixture();
  const replaced = await action({
    action: "template.apply",
    pageId: external.source,
    templateId: template,
    version: (await database(external.source)).version,
  });
  assert.deepEqual(
    (await record(external.target, external.b)).cells[external.inverse],
    [],
  );
  assert.equal((await relationPairs(external.target)).length, 0);
  await checkGraph([external.source]);
  // Returning to the prior version reconnects its original target.
  await action({
    action: "snapshot.restore",
    pageId: external.source,
    snapshotId: replaced.snapshotId,
  });
  assert.deepEqual(
    (await record(external.target, external.b)).cells[external.inverse],
    [external.a],
  );
  await checkGraph([external.source, external.target]);
  await cleanQueue();
});

test("archives preserve pairs and remap version/template references, rejecting asymmetric graphs atomically", async () => {
  const { source, target, a, b, pair, inverse } = await fixture();
  await action({ action: "page.snapshot", pageId: source });
  const templateSource = await fixture(true);
  await action({
    action: "template.save",
    pageId: templateSource.source,
    name: "Archive self relation template",
  });
  const bytes = await exportArchive(owner, wid),
    dest = await createWorkspace(owner.id, "Restored two-way");
  const imported = await importArchive(owner, dest, bytes),
    cs = imported.pageIds[source],
    ct = imported.pageIds[target];
  const newPair = (await relationPairs(cs))[0];
  assert.notEqual(newPair.id, pair.id);
  assert.equal(newPair.right_page, ct);
  await checkGraph([cs, ct]);
  const restoredSnapshot = (await one<{ id: string }>(
    "SELECT id FROM snapshots WHERE page_id=?",
    cs,
  ))!.id;
  const newA = (await rows(cs))[0],
    newB = (await rows(ct))[0];
  await update(cs, newA.id, { links: [] });
  await action({
    action: "snapshot.restore",
    pageId: cs,
    snapshotId: restoredSnapshot,
  });
  assert.deepEqual((await record(ct, newB.id)).cells[inverse], [newA.id]);
  assert.deepEqual((await record(source, a)).cells.links, [b]);
  const template = (await one<{ id: string }>(
    "SELECT id FROM templates WHERE workspace_id=? AND name=?",
    dest,
    "Archive self relation template",
  ))!;
  const destBoot = await bootstrap(owner, dest);
  const instance = await action({
    action: "page.create",
    workspaceId: dest,
    spaceId: destBoot.spaces[0].id,
    title: "Imported template",
    kind: "database",
    templateId: template.id,
  });
  await checkGraph([instance.id]);
  assert.equal((await relationPairs(instance.id)).length, 1);
  const zip = await readZip(bytes),
    manifest = JSON.parse(zip.get("flowplan.json")!.toString());
  const graph = manifest.pages.find((p: any) => p.id === target).database;
  graph.rows.find((r: any) => r.id === b).cells[inverse] = [];
  zip.set("flowplan.json", Buffer.from(JSON.stringify(manifest)));
  const count = (await one(
    "SELECT count(*) n FROM pages WHERE workspace_id=?",
    dest,
  ))!.n;
  const damaged = await writeZip(zip);
  await assert.rejects(
    () => importArchive(owner, dest, damaged),
    /Unvollständige Rückrelation/,
  );
  assert.equal(
    (await one("SELECT count(*) n FROM pages WHERE workspace_id=?", dest))!.n,
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
    (await one("SELECT count(*) n FROM pages WHERE workspace_id=?", dest))!.n,
    count,
  );
  await cleanQueue();
});
