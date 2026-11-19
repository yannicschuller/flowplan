// Previews of record texts kept in the database (#383, schema 110,
// lib/record-previews.ts): opening a database shows the same preview as
// one made from the text (record document, else legacy content), keeps it,
// makes it anew after any change of the text – also one written past the
// app (triggers) – and no longer sends the legacy content.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity, Row } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-record-previews-"));
const { id, run, one, all } = await import("../lib/db");
const { bootstrap, command, pageData } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { documentPreview } = await import("../lib/document-preview");

const uid = id();
await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, "Owner", "owner@example.com");
const owner = { id: uid, name: "Owner", email: "owner@example.com", groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
const wid = await createWorkspace(owner.id, "Previews");
const space = (await bootstrap(owner, wid)).spaces[0].id;
const db = ((await command(owner, { action: "page.create", workspaceId: wid, spaceId: space, title: "Notes", kind: "database" })) as { id: string }).id;
async function record(content = "", html?: string) {
  const rid = id();
  await run("INSERT INTO rows(id,page_id,cells,created_by,content) VALUES(?,?,?,?,?)", rid, db, JSON.stringify({ title: rid.slice(0, 4) }), owner.id, content);
  if (html !== undefined) await run("INSERT INTO row_documents(row_id,state,html,generation) VALUES(?,?,?,?)", rid, new Uint8Array([0]), html, id());
  return rid;
}
const withDocument = await record("old legacy", '<p>Hello <strong>world</strong></p><img src="/api/files/00000000-0000-4000-8000-000000000000">');
const legacy = await record("Plain legacy\ntext");
const empty = await record();
const emptyDocument = await record("ignored", "");
const open = async () => (await pageData(owner, db, { presence: false })) as unknown as { rows: Row[] };
const expected = async (rid: string) => {
  const r = (await one<{ content: string; html: string | null }>("SELECT r.content,d.html FROM rows r LEFT JOIN row_documents d ON d.row_id=r.id WHERE r.id=?", rid))!;
  return documentPreview(r.html ?? r.content ?? "");
};
async function check(label: string) {
  const data = await open();
  for (const row of data.rows) {
    assert.deepEqual(row.preview, await expected(row.id), `${label}: ${row.cells.title}`);
    assert.ok(!("content" in row), `${label}: no legacy content`);
  }
  return data;
}

test("the previews equal those made from the text, and are kept", async () => {
  await check("first opening");
  const kept = await all<{ row_id: string }>("SELECT row_id FROM row_previews");
  assert.deepEqual(kept.map((k) => k.row_id).sort(), [withDocument, legacy, emptyDocument].sort(), "records with a text");
  assert.equal((await one<{ n: number }>("SELECT COUNT(*) AS n FROM row_preview_dirty"))!.n, 0);
  // Kept: opening again changes nothing (a wrong kept preview would show).
  await run("UPDATE row_previews SET preview=? WHERE row_id=?", JSON.stringify({ html: "kept", text: "kept", hasContent: true }), legacy);
  assert.equal((await open()).rows.find((r) => r.id === legacy)!.preview!.text, "kept");
  await run("DELETE FROM row_previews WHERE row_id=?", legacy);
  await check("again");
});

test("every change of a text makes its preview anew", async () => {
  await check("before");
  await run("UPDATE row_documents SET html=? WHERE row_id=?", "<p>Changed</p>", withDocument);
  await check("document changed");
  await run("UPDATE rows SET content=? WHERE id=?", "Other legacy", legacy);
  await check("content changed");
  await run("DELETE FROM row_documents WHERE row_id=?", withDocument);
  await check("document deleted: the legacy content again");
  await run("INSERT INTO row_documents(row_id,state,html,generation) VALUES(?,?,?,?)", empty, new Uint8Array([0]), "<p>Now a document</p>", id());
  await check("document added");
  await run("UPDATE rows SET content=? WHERE id=?", "", legacy);
  await check("content emptied");
  // A preview of an older format is made anew.
  await run("UPDATE row_previews SET format=0,preview=? WHERE row_id=?", JSON.stringify({ html: "old", text: "old", hasContent: true }), empty);
  await check("older format");
  // A record that goes takes its preview with it.
  await run("DELETE FROM rows WHERE id=?", emptyDocument);
  assert.equal(await one("SELECT 1 FROM row_previews WHERE row_id=?", emptyDocument), undefined);
  await check("record deleted");
});

test("a change while a preview is made is not lost", async () => {
  // The mark is gone, the preview is kept – and the text changes after
  // that: the trigger marks the record again.
  await check("before");
  await run("UPDATE row_documents SET html=? WHERE row_id=?", "<p>Racing</p>", empty);
  assert.ok(await one("SELECT 1 FROM row_preview_dirty WHERE row_id=?", empty));
  await check("after");
});
