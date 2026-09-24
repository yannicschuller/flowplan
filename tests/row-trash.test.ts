import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(
  join(tmpdir(), "flowplan-rowtrash-"),
);
const { one, run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap, rows, database } = await import("../lib/api");
const { listRowTrash, expireRowTrash } = await import("../lib/row-trash");
const { replaceRowDocument } = await import("../lib/row-documents");

function account(name: string) {
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
  } as Identity;
}
const owner = account("trash-owner"),
  viewer = account("trash-viewer");
const wid = createWorkspace(owner.id, "Papierkorb");
run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const space = bootstrap(owner, wid).spaces[0].id;
const act = (input: Record<string, unknown>, as = owner) =>
  command(as, input) as { id: string };
const db = (title: string) =>
  act({
    action: "page.create",
    workspaceId: wid,
    spaceId: space,
    title,
    kind: "database",
  }).id;

test("deleted records move to the trash with document and comments and restore under their id", () => {
  const projects = db("Projekte"),
    tasks = db("Aufgaben");
  const d = database(tasks);
  command(owner, {
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
  const project = act({
    action: "row.create",
    pageId: projects,
    cells: { title: "Alpha" },
  }).id;
  act({
    action: "row.create",
    pageId: tasks,
    cells: { title: "Aufgabe", project: [project] },
  });
  replaceRowDocument(project, "<p>Projektbeschreibung</p>", owner.id);
  act({
    action: "comment.create",
    pageId: projects,
    rowId: project,
    body: "Wichtig",
  });
  assert.throws(
    () =>
      act({ action: "row.delete", pageId: projects, rowId: project }, viewer),
    /Berechtigung/,
  );
  act({ action: "row.delete", pageId: projects, rowId: project });
  assert.equal(rows(projects).length, 0);
  const [entry] = listRowTrash(viewer, wid);
  assert.deepEqual(
    [entry.id, entry.title, entry.pageTitle],
    [project, "Alpha", "Projekte"],
  );
  assert.throws(
    () => act({ action: "row.trash.restore", trashId: project }, viewer),
    /Berechtigung/,
  );
  act({ action: "row.trash.restore", trashId: project });
  const [restored] = rows(projects);
  assert.equal(restored.id, project);
  assert.equal(restored.cells.title, "Alpha");
  assert.match(
    one<{ html: string }>(
      "SELECT html FROM row_documents WHERE row_id=?",
      project,
    )!.html,
    /Projektbeschreibung/,
  );
  assert.equal(
    one<{ n: number }>(
      "SELECT COUNT(*) n FROM comments WHERE row_id=?",
      project,
    )!.n,
    1,
  );
  // The relation from the task resolves again.
  assert.deepEqual(rows(tasks)[0].cells.project, [project]);
  assert.deepEqual(listRowTrash(owner, wid), []);
});

test("bulk deletes, purging and expiry", () => {
  const page = db("Stapel");
  const ids = ["A", "B"].map(
    (title) => act({ action: "row.create", pageId: page, cells: { title } }).id,
  );
  command(owner, {
    action: "rows.bulk",
    pageId: page,
    operation: "delete",
    rows: ids.map((rid) => ({ id: rid, version: 1 })),
  });
  assert.equal(listRowTrash(owner, wid).length, 2);
  act({ action: "row.trash.purge", trashId: ids[0] });
  assert.equal(listRowTrash(owner, wid).length, 1);
  assert.throws(
    () => act({ action: "row.trash.restore", trashId: ids[0] }),
    /nicht im Papierkorb/,
  );
  run("UPDATE row_trash SET deleted_at=datetime('now','-40 days')");
  assert.equal(expireRowTrash(), 1);
  assert.deepEqual(listRowTrash(owner, wid), []);
});

test("records can be favourited per person", () => {
  const page = db("Favoriten");
  const row = act({
    action: "row.create",
    pageId: page,
    cells: { title: "Stern" },
  }).id;
  act(
    { action: "favorite.row", pageId: page, rowId: row, value: true },
    viewer,
  );
  assert.deepEqual(bootstrap(viewer, wid).favoriteRows, [
    { pageId: page, rowId: row, title: "Stern" },
  ]);
  assert.deepEqual(bootstrap(owner, wid).favoriteRows, []);
  act({ action: "row.delete", pageId: page, rowId: row });
  assert.deepEqual(bootstrap(viewer, wid).favoriteRows, []);
});
