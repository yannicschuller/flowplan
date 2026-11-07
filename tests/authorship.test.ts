import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import { initProseMirrorDoc } from "@tiptap/y-tiptap";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-authorship-"));
const { id, run, all } = await import("../lib/db");
const { command, bootstrap, pageData } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { documentSchema } = await import("../lib/document-schema");
const { rowDocumentData } = await import("../lib/row-documents");
const { documentAuthors, recordDocumentAuthors } = await import("../lib/document-authors");
const { authorRuns, attributeRuns, authorShares, authorHue, authorColor, changedClients } = await import("../lib/authorship");

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.com`);
  return { id: uid, name, email: `${name}@example.com`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
// A Yjs document whose session id is fixed, so authorship can be checked.
function session(client: number, state?: Uint8Array) {
  const doc = new Y.Doc();
  doc.clientID = client;
  if (state) Y.applyUpdate(doc, state);
  return doc;
}
const paragraph = (text: string) => {
  const p = new Y.XmlElement("paragraph"),
    t = new Y.XmlText();
  t.insert(0, text);
  p.insert(0, [t]);
  return p;
};
const textOf = (doc: Y.Doc, index = 0) => (doc.getXmlFragment("default").get(index) as Y.XmlElement).get(0) as Y.XmlText;
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");

test("text is split into runs per editor session and mapped onto editor positions", () => {
  const anna = session(101);
  anna.getXmlFragment("default").insert(0, [paragraph("Hallo Welt")]);
  const ben = session(202, Y.encodeStateAsUpdate(anna));
  // Ben types in the middle and at the end, deletes a bit of Anna's text
  // and adds a list.
  textOf(ben).insert(6, "schöne ");
  textOf(ben).insert(17, "!");
  textOf(ben).delete(0, 1);
  const list = new Y.XmlElement("bulletList"),
    item = new Y.XmlElement("listItem");
  item.insert(0, [paragraph("Punkt")]);
  list.insert(0, [item]);
  ben.getXmlFragment("default").insert(1, [list]);
  const merged = session(303, Y.encodeStateAsUpdate(anna));
  Y.applyUpdate(merged, Y.encodeStateAsUpdate(ben));
  const fragment = merged.getXmlFragment("default");
  const { doc, mapping } = initProseMirrorDoc(fragment, documentSchema());
  assert.equal(doc.textContent, "allo schöne Welt!Punkt");
  const runs = authorRuns(fragment, doc, mapping as never);
  const text = (r: { from: number; to: number }) => doc.textBetween(r.from, r.to);
  assert.deepEqual(
    runs.map((r) => [text(r), r.client]),
    [
      ["allo ", 101],
      ["schöne ", 202],
      ["Welt", 101],
      ["!", 202],
      ["Punkt", 202],
    ],
  );
  // Sessions → people; the editor's own, unsaved session is oneself;
  // sessions nobody recorded are "früher" (null).
  const ranges = attributeRuns(runs, { "101": "anna" }, { client: 202, userId: "ben" });
  assert.deepEqual(
    ranges.map((r) => [text(r), r.userId]),
    [
      ["allo ", "anna"],
      ["schöne ", "ben"],
      ["Welt", "anna"],
      ["!", "ben"],
      ["Punkt", "ben"],
    ],
  );
  assert.deepEqual(
    attributeRuns(runs, {}).map((r) => r.userId),
    [null, null],
  );
  assert.deepEqual(authorShares(ranges), [
    ["anna", 9],
    ["ben", 13],
  ].sort((a, b) => (b[1] as number) - (a[1] as number)));
  // The document itself is untouched by all of this.
  assert.equal(merged.getXmlFragment("default").length, 2);
});

test("colours are stable per person and the changed sessions of an update are found", () => {
  assert.equal(authorHue("user-a"), authorHue("user-a"));
  assert.notEqual(authorHue("user-a"), authorHue("user-b"));
  assert.ok(authorHue("x") >= 0 && authorHue("x") < 360);
  assert.match(authorColor("user-a"), /^hsl\(\d+ 80% 55% \/ 0\.3\)$/);
  const doc = session(7);
  const before = Y.encodeStateVector(doc);
  doc.getXmlFragment("default").insert(0, [paragraph("x")]);
  const other = session(8, Y.encodeStateAsUpdate(doc));
  textOf(other).insert(0, "y");
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(other));
  assert.deepEqual(changedClients(before, Y.encodeStateVector(doc)).sort(), [7, 8]);
  assert.deepEqual(changedClients(Y.encodeStateVector(doc), Y.encodeStateVector(doc)), []);
});

test("the server notes who sent which session and keeps it per document", async () => {
  const owner = await user("Anna"),
    editor = await user("Ben"),
    reader = await user("Carla"),
    stranger = await user("Dora");
  const wid = await createWorkspace(owner.id, "Autoren");
  await run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
  await run("INSERT INTO members VALUES(?,?,?)", wid, reader.id, "viewer");
  const space = (await bootstrap(owner, wid)).spaces[0].id;
  const pageId = ((await command(owner, { action: "page.create", workspaceId: wid, spaceId: space, title: "Text" })) as { id: string }).id;
  const sync = async (who: Identity, doc: Y.Doc) => {
    const { generation } = (await pageData(who, pageId)) as { generation: string };
    await command(who, { action: "document.sync", pageId, generation, update: b64(Y.encodeStateAsUpdate(doc)) });
  };
  const anna = session(1111);
  anna.getXmlFragment("default").insert(0, [paragraph("Von Anna")]);
  await sync(owner, anna);
  const ben = session(2222, Y.encodeStateAsUpdate(anna));
  textOf(ben).insert(8, " und Ben");
  // Ben's whole state includes Anna's session – it stays Anna's.
  await sync(editor, ben);
  const seen = await documentAuthors(reader, pageId);
  assert.deepEqual(seen.clients, { "1111": owner.id, "2222": editor.id });
  assert.deepEqual(seen.people.map((p) => p.name).sort(), ["Anna", "Ben"]);
  // Nothing new in an update: nothing recorded.
  await sync(editor, ben);
  assert.equal((await all("SELECT 1 FROM document_authors WHERE page_id=?", pageId)).length, 2);
  // Only people who may read the page see the names.
  await assert.rejects(async () => await documentAuthors(stranger, pageId), (e: any) => [403, 404].includes(e.status));
  // A restored version is a new document identity: the old sessions go.
  await command(owner, { action: "page.snapshot", pageId });
  const snapshot = (await all<{ id: string }>("SELECT id FROM snapshots WHERE page_id=? ORDER BY created_at DESC", pageId))[0];
  await command(owner, { action: "snapshot.restore", pageId, snapshotId: snapshot.id });
  assert.deepEqual((await documentAuthors(owner, pageId)).clients, {});
  const fresh = session(3333, Buffer.from(((await pageData(owner, pageId)) as { state: string }).state, "base64"));
  fresh.getXmlFragment("default").insert(0, [paragraph("Neu")]);
  await sync(editor, fresh);
  assert.deepEqual((await documentAuthors(owner, pageId)).clients, { "3333": editor.id });
  assert.equal((await all("SELECT 1 FROM document_authors WHERE page_id=?", pageId)).length, 1);
  // A session belongs to whoever sent it first, even if others resend it.
  const generation = ((await pageData(owner, pageId)) as { generation: string }).generation;
  await recordDocumentAuthors(pageId, null, generation, owner.id, Y.encodeStateVector(session(1)), Y.encodeStateVector(fresh));
  assert.equal((await documentAuthors(owner, pageId)).clients["3333"], editor.id);
});

test("record documents note their authors too", async () => {
  const owner = await user("Eva");
  const wid = await createWorkspace(owner.id, "Records");
  const space = (await bootstrap(owner, wid)).spaces[0].id;
  const db = ((await command(owner, { action: "page.create", workspaceId: wid, spaceId: space, title: "DB", kind: "database" })) as { id: string }).id;
  const rowId = ((await command(owner, { action: "row.create", pageId: db, cells: { title: "Eintrag" } })) as { id: string }).id;
  const initial = await rowDocumentData(owner, db, rowId);
  const doc = session(4444, Buffer.from(initial.state, "base64"));
  doc.getXmlFragment("default").insert(0, [paragraph("Notiz")]);
  await command(owner, { action: "row.document.sync", pageId: db, rowId, generation: initial.generation, update: b64(Y.encodeStateAsUpdate(doc)) });
  assert.deepEqual((await documentAuthors(owner, db, rowId)).clients, { "4444": owner.id });
  assert.deepEqual((await documentAuthors(owner, db, rowId)).people, [{ id: owner.id, name: "Eva" }]);
});
