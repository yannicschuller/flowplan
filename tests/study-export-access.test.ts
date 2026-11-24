// Flashcards and record/property access (#491, #497, #498): the CSV and
// Anki exports leave out tags and the "Deck" sub-deck when their property is
// hidden from the person, the Anki media leave out files of others' private
// records and trashed files, and the optimiser's groups and workload
// simulation count only cards of records the person may see.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-study-access-"));
const { id, run } = await import("../lib/db");
const { command, database, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { studyExport, studyAnkiExport } = await import("../lib/study");
const { writeUpload } = await import("../lib/storage");

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = await user("sa-owner");
const reader = await user("sa-reader");
const editor = await user("sa-editor");
const wid = await createWorkspace(owner.id, "Study access");
const boot = await bootstrap(owner, wid);
await run("INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,?)", wid, reader.id, "viewer");
await run("INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,?)", wid, editor.id, "editor");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const act = async (who: Identity, body: Record<string, unknown>): Promise<any> => await command(who, body);
async function deck(title: string, fields: unknown[], settings: unknown) {
  const pageId = (await act(owner, { action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, kind: "database", title })).id as string;
  const db = await database(pageId);
  await act(owner, { action: "database.update", pageId, version: db.version, fields, views: [{ id: "study", name: "Lernen", type: "study", filters: [], sorts: [] }] });
  await act(owner, { action: "study.settings", pageId, settings });
  return pageId;
}
// The text of a ZIP (the .apkg) with its deflated entries inflated.
function zipText(bytes: Uint8Array) {
  const buf = Buffer.from(bytes);
  let text = buf.toString("latin1");
  for (let i = 0; i + 30 < buf.length; i++) {
    if (buf.readUInt32LE(i) !== 0x04034b50) continue;
    const method = buf.readUInt16LE(i + 8),
      size = buf.readUInt32LE(i + 18),
      nl = buf.readUInt16LE(i + 26),
      el = buf.readUInt16LE(i + 28);
    const start = i + 30 + nl + el;
    if (method === 8)
      try {
        text += inflateRawSync(buf.subarray(start, start + size)).toString("latin1");
      } catch {}
  }
  return text;
}

test("#491: exports leave out tags and the Deck sub-deck of hidden properties", async () => {
  const pageId = await deck(
    "Hidden tags",
    [
      { id: "title", name: "Front", type: "text" },
      { id: "back", name: "Back", type: "text" },
      { id: "tagp", name: "Label", type: "text", access: { read: "owners" } },
      { id: "deck", name: "Deck", type: "select", options: ["DECKVAL-77"], access: { read: "owners" } },
    ],
    { version: 1, front: { field: "title" }, back: { field: "back" }, tags: { field: "tagp" } },
  );
  await act(owner, { action: "row.create", pageId, cells: { title: "q1", back: "a1", tagp: "TAGVAL-55", deck: "DECKVAL-77" } });
  const csv = await studyExport(reader, { pageId });
  assert.equal(csv.cards, 1);
  assert.ok(csv.csv.includes("q1") && !csv.csv.includes("TAGVAL-55"));
  const apkg = zipText((await studyAnkiExport(reader, { pageId })).bytes);
  assert.ok(apkg.includes("q1"));
  assert.ok(!apkg.includes("TAGVAL-55"));
  assert.ok(!apkg.includes("DECKVAL-77"));
  // Whoever may read the properties still gets them.
  assert.ok((await studyExport(owner, { pageId })).csv.includes("TAGVAL-55"));
  const own = zipText((await studyAnkiExport(owner, { pageId })).bytes);
  assert.ok(own.includes("TAGVAL-55") && own.includes("DECKVAL-77"));
});

test("#497: the Anki export leaves out files of others' private records and trashed files", async () => {
  const pageId = await deck("Media", [{ id: "title", name: "Front", type: "text" }], { version: 1, front: { field: "title" }, back: { document: "all" } });
  const file = async (bytes: string, by: string, trashed = false) => {
    const fid = id();
    await run(
      "INSERT INTO files(id,page_id,name,mime,size,created_by,deleted_at) VALUES(?,?,?,?,?,?,?)",
      fid,
      pageId,
      `${bytes}.png`,
      "image/png",
      bytes.length,
      by,
      trashed ? new Date().toISOString() : null,
    );
    await writeUpload(fid, new TextEncoder().encode(bytes));
    return fid;
  };
  const privateFile = await file("PRIVBYTES-98765", owner.id);
  const trashedFile = await file("TRASHBYTES-11111", editor.id, true);
  const ownFile = await file("OWNBYTES-22222", editor.id);
  const priv = await act(owner, { action: "row.create", pageId, cells: { title: "owner private" } });
  await run("UPDATE rows SET content=? WHERE id=?", `<p>s</p><img src="/api/files/${privateFile}">`, priv.id);
  await act(owner, { action: "row.access", pageId, rowId: priv.id, access: "private", grants: [] });
  const mine = await act(editor, { action: "row.create", pageId, cells: { title: "editor card" } });
  await run(
    "UPDATE rows SET content=? WHERE id=?",
    `<p>a</p><img src="/api/files/${privateFile}"><img src="/api/files/${trashedFile}"><img src="/api/files/${ownFile}">`,
    mine.id,
  );
  await run("INSERT INTO study_dirty(page_id,row_id) VALUES(?,?) ON CONFLICT DO NOTHING", pageId, mine.id);
  const text = zipText((await studyAnkiExport(editor, { pageId })).bytes);
  assert.ok(text.includes("OWNBYTES-22222"), "the editor's own file goes along");
  assert.ok(!text.includes("PRIVBYTES-98765"), "not the file of the owner's private record");
  assert.ok(!text.includes("TRASHBYTES-11111"), "not a trashed file");
  // The owner sees their private record and its file.
  assert.ok(zipText((await studyAnkiExport(owner, { pageId })).bytes).includes("PRIVBYTES-98765"));
});

test("#498: history groups and the workload simulation count only visible records", async () => {
  const pageId = await deck(
    "Groups",
    [
      { id: "title", name: "Front", type: "text" },
      { id: "back", name: "Back", type: "text" },
      { id: "sub", name: "Sub", type: "select", options: ["Open", "Hidden"] },
    ],
    { version: 1, front: { field: "title" }, back: { field: "back" }, subdeck: { field: "sub" } },
  );
  await act(owner, { action: "row.create", pageId, cells: { title: "open1", back: "x", sub: "Open" } });
  for (let i = 0; i < 2; i++) {
    const r = await act(owner, { action: "row.create", pageId, cells: { title: `h${i}`, back: "y", sub: "Hidden" } });
    await act(owner, { action: "row.access", pageId, rowId: r.id, access: "private", grants: [] });
  }
  const queue = await act(reader, { action: "study.queue", pageId, zone: "UTC" });
  assert.equal(queue.total, 1);
  const history = await act(reader, { action: "study.history", pageId, zone: "UTC" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.deepEqual(history.groups.map((g: any) => [g.key, g.cards]), [["subdeck:Open", 1]]);
  assert.equal(history.deck.newCards, 1);
  await assert.rejects(act(reader, { action: "study.history", pageId, zone: "UTC", group: "subdeck:Hidden" }), (e: { status?: number }) => e.status === 404);
  // The owner sees all three.
  const own = await act(owner, { action: "study.history", pageId, zone: "UTC" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.deepEqual(own.groups.map((g: any) => [g.key, g.cards]), [["subdeck:Hidden", 2], ["subdeck:Open", 1]]);
  assert.equal(own.deck.newCards, 3);
});
