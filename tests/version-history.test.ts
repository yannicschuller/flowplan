import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(
  join(tmpdir(), "flowplan-history-"),
);
const { all, one, run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap, database } = await import("../lib/api");
const { snapshotChanges, pruneSnapshots, htmlParagraphs, retentionDays } =
  await import("../lib/version-history");

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
const owner = account("history-owner"),
  stranger = account("history-stranger");
const wid = createWorkspace(owner.id, "Verlauf");
const space = bootstrap(owner, wid).spaces[0].id;
const create = (title: string, kind = "document") =>
  (
    command(owner, {
      action: "page.create",
      workspaceId: wid,
      spaceId: space,
      title,
      kind,
    }) as { id: string }
  ).id;
const setHtml = (pageId: string, html: string) =>
  run("UPDATE documents SET html=? WHERE page_id=?", html, pageId);

test("paragraph extraction keeps block boundaries and decodes entities", () => {
  assert.deepEqual(
    htmlParagraphs(
      "<h1>Titel</h1><p>A &amp; B<br>C</p><ul><li>eins</li><li> zwei </li></ul><script>x</script>",
    ),
    ["Titel", "A & B", "C", "eins", "zwei"],
  );
});

test("document versions compare to the current text with word-level changes", () => {
  const page = create("Protokoll");
  setHtml(page, "<p>Der Hund bellt laut</p><p>Ende</p>");
  const snapshot = (
    command(owner, { action: "page.snapshot", pageId: page }) as { id: string }
  ).id;
  assert.equal(
    one<{ kind: string }>("SELECT kind FROM snapshots WHERE id=?", snapshot)!
      .kind,
    "manual",
  );
  setHtml(page, "<p>Der Hund schläft laut</p><p>Neu</p><p>Ende</p>");
  const result = snapshotChanges(owner, page, snapshot);
  assert.equal(result.kind, "document");
  assert.deepEqual(result.changes, [
    {
      type: "changed",
      parts: [
        { type: "same", text: "Der Hund " },
        { type: "removed", text: "bellt" },
        { type: "added", text: "schläft" },
        { type: "same", text: " laut" },
      ],
    },
    { type: "added", text: "Neu" },
    { type: "same", text: "Ende" },
  ]);
  assert.throws(
    () => snapshotChanges(stranger, page, snapshot),
    /Berechtigung/,
  );
  const other = create("Andere");
  assert.throws(
    () => snapshotChanges(owner, other, snapshot),
    /nicht gefunden/,
  );
});

test("databases snapshot automatically at the start of an editing session and summarize changes", () => {
  const page = create("Aufgaben", "database");
  const d = database(page);
  command(owner, {
    action: "database.update",
    pageId: page,
    version: d.version,
    fields: [...d.fields, { id: "note", name: "Notiz", type: "text" }],
    views: d.views,
  });
  const first = (
    command(owner, {
      action: "row.create",
      pageId: page,
      cells: { title: "Alt", note: "x" },
    }) as { id: string }
  ).id;
  const snapshots = () =>
    all<{ id: string; kind: string }>(
      "SELECT id,kind FROM snapshots WHERE page_id=? ORDER BY rowid",
      page,
    );
  // A fresh database has no automatic version yet.
  assert.equal(snapshots().length, 0);
  // After ten quiet minutes the next edit keeps the previous state.
  run("UPDATE pages SET updated_at=datetime('now','-1 hour') WHERE id=?", page);
  run(
    "UPDATE rows SET updated_at=datetime('now','-1 hour') WHERE page_id=?",
    page,
  );
  command(owner, {
    action: "row.update",
    pageId: page,
    rowId: first,
    version: 1,
    cells: { note: "y" },
  });
  command(owner, {
    action: "row.create",
    pageId: page,
    cells: { title: "Neu" },
  });
  assert.deepEqual(
    snapshots().map((s) => s.kind),
    ["auto"],
  );
  const result = snapshotChanges(owner, page, snapshots()[0].id);
  assert.equal(result.kind, "database");
  if (result.kind === "database") {
    assert.deepEqual(result.changes.rows.added, ["Neu"]);
    assert.deepEqual(result.changes.rows.changed, [
      { title: "Alt", fields: ["Notiz"] },
    ]);
    assert.deepEqual(result.changes.fields.added, []);
  }
});

test("retention thins and expires automatic versions but keeps manual ones", () => {
  const page = create("Aufbewahrung");
  const insert = (age: string, kind: string, hour = 0) =>
    run(
      "INSERT INTO snapshots(id,page_id,html,title,created_at,kind) VALUES(?,?,?,?,datetime('now',?,'start of day',?),?)",
      id(),
      page,
      "",
      "x",
      age,
      `+${hour} hours`,
      kind,
    );
  // Anchored at the start of a day so hours never cross midnight.
  insert("-1 days", "auto");
  insert("-1 days", "auto", 1);
  insert("-20 days", "auto");
  insert("-20 days", "auto", 1);
  insert("-20 days", "auto", 2);
  insert("-400 days", "auto");
  insert("-400 days", "manual");
  const count = (kind: string) =>
    one<{ n: number }>(
      "SELECT COUNT(*) n FROM snapshots WHERE page_id=? AND kind=?",
      page,
      kind,
    )!.n;
  assert.equal(retentionDays(), 180);
  pruneSnapshots(180);
  // Recent autos stay, the 20-day-old day keeps one, the old one expires.
  assert.equal(count("auto"), 3);
  assert.equal(count("manual"), 1);
  pruneSnapshots(0);
  assert.equal(count("auto"), 3);
  process.env.FLOWPLAN_SNAPSHOT_RETENTION_DAYS = "0";
  assert.equal(retentionDays(), 0);
  process.env.FLOWPLAN_SNAPSHOT_RETENTION_DAYS = "x";
  assert.equal(retentionDays(), 180);
  delete process.env.FLOWPLAN_SNAPSHOT_RETENTION_DAYS;
});
