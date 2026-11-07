// Restoring a chosen version brings back exactly that version, also when
// several were saved within one second (created_at has whole seconds; on
// PostgreSQL rows of equal created_at come in any order unless seq breaks
// the tie). Runs on SQLite and, with DATABASE_URL, on PostgreSQL.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-version-restore-"));
const { id, run, one } = await import("../lib/db");
const { command, bootstrap, pageData } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { htmlState } = await import("../lib/document-server");
const { rowDocumentData } = await import("../lib/row-documents");

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = await user("owner");
const wid = await createWorkspace(owner.id, "Versions"),
  boot = await bootstrap(owner, wid);
const act = async (body: Record<string, unknown>): Promise<any> => await command(owner, body);

// The page's text replaced through the collaboration path, as an editor does.
async function write(pageId: string, text: string) {
  const data = (await pageData(owner, pageId)) as { state: string; generation: string };
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Buffer.from(data.state, "base64"));
  const before = Y.encodeStateVector(doc);
  const fresh = new Y.Doc();
  Y.applyUpdate(fresh, htmlState(`<p>${text}</p>`));
  const fragment = doc.getXmlFragment("default");
  doc.transact(() => {
    fragment.delete(0, fragment.length);
    fragment.insert(0, fresh.getXmlFragment("default").toArray().map((n) => (n as Y.XmlElement).clone()));
  });
  await act({
    action: "document.sync",
    pageId,
    generation: data.generation,
    update: Buffer.from(Y.encodeStateAsUpdate(doc, before)).toString("base64"),
  });
}
const html = async (pageId: string) => (await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", pageId))!.html;

test("an older version chosen from the history is the one restored, however quickly the versions were saved", async () => {
  const pageId = (await act({ action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, kind: "document", title: "Quick versions" })).id as string;
  // Five manual versions (and the automatic one before the first change),
  // all within a second or two.
  const versions: { id: string; text: string }[] = [];
  for (const text of ["Erste Fassung", "Zweite Fassung", "Dritte Fassung", "Vierte Fassung", "Fünfte Fassung"]) {
    await write(pageId, text);
    versions.push({ id: (await act({ action: "page.snapshot", pageId })).id, text });
  }
  await write(pageId, "Aktueller Stand");
  // As in a migrated instance: every version has the same second.
  await run("UPDATE snapshots SET created_at=? WHERE page_id=?", "2026-11-07 17:38:05", pageId);
  const listed = ((await pageData(owner, pageId)) as { snapshots: { id: string; kind: string }[] }).snapshots;
  const manual = listed.filter((s) => s.kind === "manual").map((s) => s.id);
  // Newest first, as the history shows them.
  assert.deepEqual(manual, versions.map((v) => v.id).reverse());
  // The oldest manual version, then one in the middle, then the newest.
  for (const chosen of [manual[manual.length - 1], manual[2], manual[0]]) {
    await act({ action: "snapshot.restore", pageId, snapshotId: chosen });
    const expected = versions.find((v) => v.id === chosen)!.text;
    const now = await html(pageId);
    assert.match(now, new RegExp(expected), `restored ${chosen}`);
    for (const other of versions.filter((v) => v.id !== chosen)) assert.doesNotMatch(now, new RegExp(other.text));
  }
});

test("record versions saved within one second are listed newest first and restored by id", async () => {
  const db = (await act({ action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, kind: "database", title: "Quick records" })) as { id: string };
  const rowId = (await act({ action: "row.create", pageId: db.id, cells: {} })).id as string;
  await rowDocumentData(owner, db.id, rowId); // the record's text exists from here on
  const versions: { id: string; text: string }[] = [];
  for (const text of ["Notiz eins", "Notiz zwei", "Notiz drei"]) {
    await run("UPDATE row_documents SET html=?,state=? WHERE row_id=?", `<p>${text}</p>`, htmlState(`<p>${text}</p>`), rowId);
    versions.push({ id: (await act({ action: "row.snapshot", pageId: db.id, rowId })).id, text });
  }
  await run("UPDATE row_snapshots SET created_at=? WHERE row_id=?", "2026-11-07 17:38:05", rowId);
  const listed = (await rowDocumentData(owner, db.id, rowId)).snapshots.map((s) => s.id);
  assert.deepEqual(listed, versions.map((v) => v.id).reverse());
  await act({ action: "row.snapshot.restore", pageId: db.id, rowId, snapshotId: versions[0].id });
  const now = (await rowDocumentData(owner, db.id, rowId)).html;
  assert.match(now, /Notiz eins/);
  assert.doesNotMatch(now, /Notiz (zwei|drei)/);
});
