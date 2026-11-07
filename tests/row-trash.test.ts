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
