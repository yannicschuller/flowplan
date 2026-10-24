// Ink on PDF files (lib/ink-store.ts): who sees and changes it, versions,
// last write wins with a conflict notice, search.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-ink-"));
const { run, id, one } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const { readFileInk, saveFileInk, fileInkVersions, fileInkVersion, INK_VERSIONS_KEPT } = await import("../lib/ink-store");
const { processSearchIndex, searchWorkspace } = await import("../lib/search-index");
const { emptyInk, withPage } = await import("../lib/ink/model");

function account(name: string) {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const owner = account("ink-owner"),
  editor = account("ink-editor"),
  viewer = account("ink-viewer"),
  stranger = account("ink-stranger");
const wid = createWorkspace(owner.id, "Tinte");
run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const team = bootstrap(owner, wid).spaces[0].id;
const pageId = (command(owner, { action: "page.create", workspaceId: wid, spaceId: team, title: "Verträge" }) as { id: string }).id;
const file = (name: string, mime: string) => {
  const fid = id();
  run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", fid, pageId, name, mime, 100, owner.id);
  return fid;
};
const pdf = file("Vertrag.pdf", "application/pdf");
const stroke = (n: number) => ({ id: `s${n}`, type: "pen" as const, color: "#1f1f1f", width: 1.6, points: [n, n, 0.5, n + 10, n, 0.6] });
const ink = (...items: Parameters<typeof withPage>[2]) => withPage(emptyInk(), "1", items);

test("readers see the ink, editors change it; others get nothing", () => {
  const empty = readFileInk(viewer, pdf);
  assert.equal(empty.version, 0);
  assert.equal(empty.canEdit, false);
  assert.deepEqual(empty.doc.pages, {});
  assert.equal(readFileInk(editor, pdf).canEdit, true);
  assert.throws(() => readFileInk(stranger, pdf), { status: 403 });
  assert.throws(() => saveFileInk(viewer, pdf, { base: 0, doc: ink(stroke(1)) }), { status: 403 });
  assert.throws(() => saveFileInk({ ...editor, apiScope: "read" }, pdf, { base: 0, doc: ink(stroke(1)) }), { status: 403 });
  assert.throws(() => saveFileInk(editor, pdf, { base: "x", doc: {} }), { status: 400 });
  // Only PDFs.
  const image = file("Foto.png", "image/png");
  assert.throws(() => readFileInk(owner, image), { status: 400 });

  const saved = saveFileInk(editor, pdf, { base: 0, doc: ink(stroke(1)) });
  assert.deepEqual(saved, { version: 1, conflict: null });
  const read = readFileInk(viewer, pdf);
  assert.equal(read.version, 1);
  assert.equal(read.updatedBy, "ink-editor");
  assert.equal(read.doc.pages["1"].length, 1);
  // The file itself is not touched.
  assert.equal(one<{ size: number }>("SELECT size FROM files WHERE id=?", pdf)?.size, 100);
});

test("every save is a version; a save on an older version wins and reports who saved between", () => {
  const start = readFileInk(owner, pdf).version;
  const mine = saveFileInk(owner, pdf, { base: start, doc: ink(stroke(1), stroke(2)) }, 1000);
  assert.equal(mine.conflict, null);
  // The editor still has the state from before the owner's save.
  const theirs = saveFileInk(editor, pdf, { base: start, doc: ink(stroke(3)) }, 2000);
  assert.equal(theirs.version, mine.version + 1);
  assert.deepEqual(theirs.conflict, { by: "ink-owner", at: 1000, version: mine.version });
  assert.deepEqual(readFileInk(owner, pdf).doc.pages["1"].map((i) => i.id), ["s3"]);
  const versions = fileInkVersions(viewer, pdf);
  assert.deepEqual(versions.slice(0, 2).map((v) => [v.version, v.by, v.items]), [
    [theirs.version, "ink-editor", 1],
    [mine.version, "ink-owner", 2],
  ]);
  // The overwritten state can be brought back.
  assert.deepEqual(fileInkVersion(editor, pdf, mine.version).doc.pages["1"].map((i) => i.id), ["s1", "s2"]);
  assert.throws(() => fileInkVersion(editor, pdf, 999), { status: 404 });
  assert.throws(() => fileInkVersions(stranger, pdf), { status: 403 });
});

test("old versions are thinned out; a locked page takes no ink", () => {
  let base = readFileInk(owner, pdf).version;
  for (let i = 0; i < INK_VERSIONS_KEPT + 5; i++) base = saveFileInk(owner, pdf, { base, doc: ink(stroke(i)) }).version;
  const versions = fileInkVersions(owner, pdf);
  assert.equal(versions.length, INK_VERSIONS_KEPT);
  assert.equal(versions[0].version, base);
  run("UPDATE pages SET locked=1 WHERE id=?", pageId);
  try {
    assert.equal(readFileInk(owner, pdf).canEdit, false);
    assert.throws(() => saveFileInk(owner, pdf, { base, doc: ink() }), { status: 409 });
  } finally {
    run("UPDATE pages SET locked=0 WHERE id=?", pageId);
  }
});

test("text written on the PDF is found by search", () => {
  assert.equal(searchWorkspace(owner, wid, "Schlusszahlung").length, 0);
  const base = readFileInk(owner, pdf).version;
  saveFileInk(owner, pdf, {
    base,
    doc: ink({ id: "t", type: "text", color: "#e03131", size: 14, x: 10, y: 10, text: "Schlusszahlung freigegeben" }),
  });
  processSearchIndex(1000);
  assert.ok(searchWorkspace(owner, wid, "Schlusszahlung").length > 0);
});
