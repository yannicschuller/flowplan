import { nowText } from "../lib/db-driver/dialect";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
import { mapAsync } from "../lib/each-async";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(
  join(tmpdir(), "flowplan-rowtrash-"),
);
const { one, run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap, rows, database } = await import("../lib/api");
const { listRowTrash, expireRowTrash } = await import("../lib/row-trash");
const { replaceRowDocument } = await import("../lib/row-documents");

async function account(name: string) {
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
  } as Identity;
}
const owner = await account("trash-owner"),
  viewer = await account("trash-viewer");
const wid = await createWorkspace(owner.id, "Papierkorb");
await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const space = (await bootstrap(owner, wid)).spaces[0].id;
const act = async (input: Record<string, unknown>, as = owner) =>
  (await command(as, input)) as { id: string };
const db = async (title: string) =>
  (await act({
    action: "page.create",
    workspaceId: wid,
    spaceId: space,
    title,
    kind: "database",
  })).id;

test("deleted records move to the trash with document and comments and restore under their id", async () => {
  const projects = await db("Projekte"),
    tasks = await db("Aufgaben");
  const d = await database(tasks);
  await command(owner, {
    action: "database.update",
    pageId: tasks,
    version: d.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      {
        id: "project",
        name: "Projekt",
        type: "relation",
        relationPage: projects,
      },
    ],
    views: d.views,
  });
  const project = (await act({
    action: "row.create",
    pageId: projects,
    cells: { title: "Alpha" },
  })).id;
  await act({
    action: "row.create",
    pageId: tasks,
    cells: { title: "Aufgabe", project: [project] },
  });
  await replaceRowDocument(project, "<p>Projektbeschreibung</p>", owner.id);
  await act({
    action: "comment.create",
    pageId: projects,
    rowId: project,
    body: "Wichtig",
  });
  await assert.rejects(
    async () =>
      await act({ action: "row.delete", pageId: projects, rowId: project }, viewer),
    /Berechtigung/,
  );
  await act({ action: "row.delete", pageId: projects, rowId: project });
  assert.equal((await rows(projects)).length, 0);
  const [entry] = await listRowTrash(viewer, wid);
  assert.deepEqual(
    [entry.id, entry.title, entry.pageTitle],
    [project, "Alpha", "Projekte"],
  );
  await assert.rejects(
    async () => await act({ action: "row.trash.restore", trashId: project }, viewer),
    /Berechtigung/,
  );
  await act({ action: "row.trash.restore", trashId: project });
  const [restored] = await rows(projects);
  assert.equal(restored.id, project);
  assert.equal(restored.cells.title, "Alpha");
  assert.match(
    (await one<{ html: string }>(
      "SELECT html FROM row_documents WHERE row_id=?",
      project,
    ))!.html,
    /Projektbeschreibung/,
  );
  assert.equal(
    (await one<{ n: number }>(
      "SELECT COUNT(*) n FROM comments WHERE row_id=?",
      project,
    ))!.n,
    1,
  );
  // The relation from the task resolves again.
  assert.deepEqual((await rows(tasks))[0].cells.project, [project]);
  assert.deepEqual(await listRowTrash(owner, wid), []);
});

test("bulk deletes, purging and expiry", async () => {
  const page = await db("Stapel");
  const ids = await mapAsync(["A", "B"], 
    async (title) => (await act({ action: "row.create", pageId: page, cells: { title } })).id,
  );
  await command(owner, {
    action: "rows.bulk",
    pageId: page,
    operation: "delete",
    rows: ids.map((rid) => ({ id: rid, version: 1 })),
  });
  assert.equal((await listRowTrash(owner, wid)).length, 2);
  await act({ action: "row.trash.purge", trashId: ids[0] });
  assert.equal((await listRowTrash(owner, wid)).length, 1);
  await assert.rejects(
    async () => await act({ action: "row.trash.restore", trashId: ids[0] }),
    /nicht im Papierkorb/,
  );
  await run("UPDATE row_trash SET deleted_at=?", nowText(Date.now() - 3_456_000_000));
  assert.equal(await expireRowTrash(), 1);
  assert.deepEqual(await listRowTrash(owner, wid), []);
});

test("records can be favourited per person", async () => {
  const page = await db("Favoriten");
  const row = (await act({
    action: "row.create",
    pageId: page,
    cells: { title: "Stern" },
  })).id;
  await act(
    { action: "favorite.row", pageId: page, rowId: row, value: true },
    viewer,
  );
  assert.deepEqual((await bootstrap(viewer, wid)).favoriteRows, [
    { pageId: page, rowId: row, title: "Stern" },
  ]);
  assert.deepEqual((await bootstrap(owner, wid)).favoriteRows, []);
  await act({ action: "row.delete", pageId: page, rowId: row });
  assert.deepEqual((await bootstrap(viewer, wid)).favoriteRows, []);
});

test("a record restores although a record it was linked to two-way is gone; the dead link is dropped", async () => {
  const projects = await db("Zweiweg-Projekte"),
    tasks = await db("Zweiweg-Aufgaben");
  const d = await database(projects);
  await command(owner, {
    action: "database.update",
    pageId: projects,
    version: d.version,
    views: d.views,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "links", name: "Aufgaben", type: "relation", relationPage: tasks },
    ],
  });
  const t1 = (await act({ action: "row.create", pageId: tasks, cells: { title: "T1" } })).id,
    t2 = (await act({ action: "row.create", pageId: tasks, cells: { title: "T2" } })).id;
  const p = (await act({ action: "row.create", pageId: projects, cells: { title: "P", links: [t1, t2] } })).id;
  const d2 = await database(projects);
  await command(owner, {
    action: "database.update",
    pageId: projects,
    version: d2.version,
    views: d2.views,
    fields: d2.fields,
    relation: { fieldId: "links", enabled: true, name: "Projekte", targetVersion: (await database(tasks)).version },
  });
  await act({ action: "row.delete", pageId: projects, rowId: p });
  await act({ action: "row.delete", pageId: tasks, rowId: t1 });
  await act({ action: "row.trash.restore", trashId: p });
  const [project] = await rows(projects);
  assert.deepEqual(project.cells.links, [t2]);
  const back = (await database(tasks)).fields.find((f) => f.type === "relation")!;
  assert.deepEqual((await rows(tasks)).find((r) => r.id === t2)!.cells[back.id], [p]);
  // The task restores too, without the link.
  await act({ action: "row.trash.restore", trashId: t1 });
  assert.deepEqual((await rows(projects))[0].cells.links, [t2]);
});

test("a restored record keeps its versions, visitor comments and comment reactions", async () => {
  const page = await db("Verlauf");
  const rid = (await act({ action: "row.create", pageId: page, cells: { title: "Mit Verlauf" } })).id;
  await replaceRowDocument(rid, "<p>Erste Fassung</p>", owner.id);
  await act({ action: "row.snapshot", pageId: page, rowId: rid });
  await run(
    "INSERT INTO shared_comments(id,page_id,row_id,name,body) VALUES(?,?,?,?,?)",
    id(), page, rid, "Gast", "Von außen",
  );
  await act({ action: "comment.create", pageId: page, rowId: rid, body: "Intern" });
  const comment = (await one<{ id: string }>("SELECT id FROM comments WHERE row_id=?", rid))!.id;
  await act({ action: "comment.react", pageId: page, commentId: comment, emoji: "👍" });
  const counts = async () => ({
    snapshots: (await one<{ n: number }>("SELECT COUNT(*) n FROM row_snapshots WHERE row_id=?", rid))!.n,
    shared: (await one<{ n: number }>("SELECT COUNT(*) n FROM shared_comments WHERE row_id=?", rid))!.n,
    reactions: (await one<{ n: number }>("SELECT COUNT(*) n FROM comment_reactions WHERE comment_id=?", comment))!.n,
  });
  const before = await counts();
  assert.ok(Number(before.snapshots) >= 1);
  assert.deepEqual([Number(before.shared), Number(before.reactions)], [1, 1]);
  await act({ action: "row.delete", pageId: page, rowId: rid });
  await act({ action: "row.trash.restore", trashId: rid });
  assert.deepEqual(await counts(), before);
  assert.match(
    (await one<{ html: string }>("SELECT html FROM row_snapshots WHERE row_id=? ORDER BY created_at LIMIT 1", rid))!.html,
    /Erste Fassung/,
  );
});
