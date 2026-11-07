import { nowText, daysAgoText } from "../lib/db-driver/dialect";
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
const owner = await account("history-owner"),
  stranger = await account("history-stranger");
const wid = await createWorkspace(owner.id, "Verlauf");
const space = (await bootstrap(owner, wid)).spaces[0].id;
const create = async (title: string, kind = "document") =>
  (
    (await command(owner, {
      action: "page.create",
      workspaceId: wid,
      spaceId: space,
      title,
      kind,
    })) as { id: string }
  ).id;
const setHtml = async (pageId: string, html: string) =>
  await run("UPDATE documents SET html=? WHERE page_id=?", html, pageId);

test("paragraph extraction keeps block boundaries and decodes entities", () => {
  assert.deepEqual(
    htmlParagraphs(
      "<h1>Titel</h1><p>A &amp; B<br>C</p><ul><li>eins</li><li> zwei </li></ul><script>x</script>",
    ),
    ["Titel", "A & B", "C", "eins", "zwei"],
  );
});

test("document versions compare to the current text with word-level changes", async () => {
  const page = await create("Protokoll");
  await setHtml(page, "<p>Der Hund bellt laut</p><p>Ende</p>");
  const snapshot = (
    (await command(owner, { action: "page.snapshot", pageId: page })) as { id: string }
  ).id;
  assert.equal(
    (await one<{ kind: string }>("SELECT kind FROM snapshots WHERE id=?", snapshot))!
      .kind,
    "manual",
  );
  await setHtml(page, "<p>Der Hund schläft laut</p><p>Neu</p><p>Ende</p>");
  const result = await snapshotChanges(owner, page, snapshot);
  assert.equal(result.kind, "document");
  assert.deepEqual(result.changes, [
    {
      type: "changed",
      kind: "paragraph",
      parts: [
        { type: "same", text: "Der Hund " },
        { type: "removed", text: "bellt" },
        { type: "added", text: "schläft" },
        { type: "same", text: " laut" },
      ],
    },
    { type: "added", kind: "paragraph", text: "Neu" },
    { type: "same", kind: "paragraph", text: "Ende" },
  ]);
  if (result.kind === "document")
    assert.deepEqual(result.words, { added: 2, removed: 1 });
  await assert.rejects(
    async () => await snapshotChanges(stranger, page, snapshot),
    /Berechtigung/,
  );
  const other = await create("Andere");
  await assert.rejects(
    async () => await snapshotChanges(owner, other, snapshot),
    /nicht gefunden/,
  );
});

test("databases snapshot automatically at the start of an editing session and summarize changes", async () => {
  const page = await create("Aufgaben", "database");
  const d = await database(page);
  await command(owner, {
    action: "database.update",
    pageId: page,
    version: d.version,
    fields: [...d.fields, { id: "note", name: "Notiz", type: "text" }],
    views: d.views,
  });
  const first = (
    (await command(owner, {
      action: "row.create",
      pageId: page,
      cells: { title: "Alt", note: "x" },
    })) as { id: string }
  ).id;
  const snapshots = async () =>
    await all<{ id: string; kind: string }>(
      "SELECT id,kind FROM snapshots WHERE page_id=? ORDER BY seq",
      page,
    );
  // A fresh database has no automatic version yet.
  assert.equal((await snapshots()).length, 0);
  // After ten quiet minutes the next edit keeps the previous state.
  await run("UPDATE pages SET updated_at=? WHERE id=?", nowText(Date.now() - 3_600_000), page);
  await run(
    "UPDATE rows SET updated_at=? WHERE page_id=?", nowText(Date.now() - 3_600_000),
    page,
  );
  await command(owner, {
    action: "row.update",
    pageId: page,
    rowId: first,
    version: 1,
    cells: { note: "y" },
  });
  await command(owner, {
    action: "row.create",
    pageId: page,
    cells: { title: "Neu" },
  });
  assert.deepEqual(
    (await snapshots()).map((s) => s.kind),
    ["auto"],
  );
  const result = await snapshotChanges(owner, page, (await snapshots())[0].id);
  assert.equal(result.kind, "database");
  if (result.kind === "database") {
    assert.deepEqual(result.changes.rows.added, ["Neu"]);
    assert.deepEqual(result.changes.rows.changed, [
      { title: "Alt", fields: ["Notiz"] },
    ]);
    assert.deepEqual(result.changes.fields.added, []);
  }
});

test("retention thins and expires automatic versions but keeps manual ones", async () => {
  const page = await create("Aufbewahrung");
  const insert = async (age: string, kind: string, hour = 0) =>
    await run(
      "INSERT INTO snapshots(id,page_id,html,title,created_at,kind) VALUES(?,?,?,?,?,?)",
      id(),
      page,
      "",
      "x",
      // datetime('now',age,'start of day',+hour)
      nowText(Date.parse(`${daysAgoText(-Number(age.split(" ")[0])).slice(0, 10)}T00:00:00Z`) + hour * 3_600_000),
      kind,
    );
  // Anchored at the start of a day so hours never cross midnight.
  await insert("-1 days", "auto");
  await insert("-1 days", "auto", 1);
  await insert("-20 days", "auto");
  await insert("-20 days", "auto", 1);
  await insert("-20 days", "auto", 2);
  await insert("-400 days", "auto");
  await insert("-400 days", "manual");
  const count = async (kind: string) =>
    (await one<{ n: number }>(
      "SELECT COUNT(*) n FROM snapshots WHERE page_id=? AND kind=?",
      page,
      kind,
    ))!.n;
  assert.equal(await retentionDays(), 180);
  await pruneSnapshots(180);
  // Recent autos stay, the 20-day-old day keeps one, the old one expires.
  assert.equal(await count("auto"), 3);
  assert.equal(await count("manual"), 1);
  await pruneSnapshots(0);
  assert.equal(await count("auto"), 3);
  process.env.FLOWPLAN_SNAPSHOT_RETENTION_DAYS = "0";
  assert.equal(await retentionDays(), 0);
  process.env.FLOWPLAN_SNAPSHOT_RETENTION_DAYS = "x";
  assert.equal(await retentionDays(), 180);
  delete process.env.FLOWPLAN_SNAPSHOT_RETENTION_DAYS;
});

test("two saved versions compare with each other, also for record documents", async () => {
  const { rowSnapshotChanges } = await import("../lib/version-history");
  const { replaceRowDocument } = await import("../lib/row-documents");
  const page = await create("Zwei Versionen");
  const save = async () =>
    (
      (await command(owner, { action: "page.snapshot", pageId: page })) as {
        id: string;
      }
    ).id;
  await setHtml(page, "<p>eins</p>");
  const first = await save();
  await setHtml(page, "<p>eins zwei</p>");
  const second = await save();
  await setHtml(page, "<p>drei</p>");
  assert.deepEqual((await snapshotChanges(owner, page, first, second)).changes, [
    {
      type: "changed",
      kind: "paragraph",
      parts: [
        { type: "same", text: "eins" },
        { type: "added", text: " zwei" },
      ],
    },
  ]);
  await assert.rejects(
    async () => await snapshotChanges(owner, page, first, id()),
    /nicht gefunden/,
  );

  const db = await create("Datensatzversionen", "database");
  const row = (
    (await command(owner, {
      action: "row.create",
      pageId: db,
      cells: { title: "A" },
    })) as { id: string }
  ).id;
  await replaceRowDocument(row, "<p>Alt</p>", owner.id);
  const version = (
    (await command(owner, { action: "row.snapshot", pageId: db, rowId: row })) as {
      id: string;
    }
  ).id;
  await replaceRowDocument(row, "<p>Neu</p>", owner.id);
  const changes = (await rowSnapshotChanges(owner, db, row, version)).changes!;
  assert.deepEqual(
    changes.flatMap((c) =>
      c.type === "changed"
        ? c.parts.map((p) => `${p.type}:${p.text}`)
        : [`${c.type}:${c.text}`],
    ),
    ["removed:Alt", "added:Neu"],
  );
  await assert.rejects(
    async () => await rowSnapshotChanges(stranger, db, row, version),
    /Berechtigung/,
  );
});
