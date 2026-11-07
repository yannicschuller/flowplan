// Collaborative documents have a size cap (FLOWPLAN_MAX_DOCUMENT_MB): a
// sync that would grow a document past it is refused with 413 and nothing
// is written.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-document-size-"));
process.env.APP_URL = "https://flowplan.example.test";
process.env.FLOWPLAN_MAX_DOCUMENT_MB = "1";
const { run, one, id } = await import("../lib/db");
const { createWorkspace, createPage } = await import("../lib/seed");
const { identityFromToken } = await import("../lib/auth");
const { command } = await import("../lib/api");
const { withContentLocale } = await import("../lib/content-locale");
const { rowDocumentData } = await import("../lib/row-documents");
import type { Identity } from "../lib/types";

async function person(name: string): Promise<Identity> {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name.toLowerCase()}@example.test`);
  const token = randomBytes(16).toString("hex");
  run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", createHash("sha256").update(token).digest("hex"), uid, "[]", Date.now() + 3600_000);
  return (await identityFromToken(token))!;
}
const owner = await person("Own");
const editor = await person("Ed");
const wid = createWorkspace(owner.id, "W");
run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
const space = one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", wid)!.id;

// A client document mirroring `state`; push() sends one paragraph.
function client(state: Uint8Array | null) {
  const doc = new Y.Doc();
  if (state) Y.applyUpdate(doc, state);
  const frag = doc.getXmlFragment("default");
  return (text: string) => {
    const sv = Y.encodeStateVector(doc);
    doc.transact(() => {
      const p = new Y.XmlElement("paragraph");
      p.insert(0, [new Y.XmlText(text)]);
      frag.push([p]);
    });
    return Buffer.from(Y.encodeStateAsUpdate(doc, sv)).toString("base64");
  };
}
const KB = 1024;

test("a page document grows up to the cap, then a sync that grows it is refused and nothing is stored", () => {
  const page = createPage(wid, space, owner.id, "Doc");
  const stored = () => one<{ state: Uint8Array | null; html: string; generation: string }>("SELECT state,html,generation FROM documents WHERE page_id=?", page)!;
  const push = client(stored().state);
  const sync = (text: string) => command(editor, { action: "document.sync", pageId: page, generation: stored().generation, update: push(text) });
  sync("a".repeat(600 * KB));
  const size = stored().state!.byteLength;
  assert.ok(size > 600 * KB && size < 1024 * KB);
  const html = stored().html;
  assert.throws(
    () => withContentLocale("en", () => sync("b".repeat(600 * KB))),
    (e: { status?: number; message?: string }) => e.status === 413 && /at most 1 MB/.test(e.message || ""),
  );
  assert.equal(stored().state!.byteLength, size, "stored size unchanged");
  assert.equal(stored().html, html);
});

test("a record's document has the same cap", () => {
  const db = createPage(wid, space, owner.id, "Tabelle", "database");
  const row = command(owner, { action: "row.create", pageId: db, cells: { title: "Eintrag" } }) as { id: string };
  const first = rowDocumentData(editor, db, row.id);
  const push = client(Buffer.from(first.state, "base64"));
  const stored = () => one<{ state: Uint8Array }>("SELECT state FROM row_documents WHERE row_id=?", row.id)!.state.byteLength;
  command(editor, { action: "row.document.sync", pageId: db, rowId: row.id, generation: first.generation, update: push("a".repeat(600 * KB)) });
  const size = stored();
  assert.throws(
    () => command(editor, { action: "row.document.sync", pageId: db, rowId: row.id, generation: first.generation, update: push("b".repeat(600 * KB)) }),
    (e: { status?: number; message?: string }) => e.status === 413 && /Das Dokument ist zu groß/.test(e.message || ""),
  );
  assert.equal(stored(), size);
});
