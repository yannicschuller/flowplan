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

async function account(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const owner = await account("ink-owner"),
  editor = await account("ink-editor"),
  viewer = await account("ink-viewer"),
  stranger = await account("ink-stranger");
const wid = await createWorkspace(owner.id, "Tinte");
await run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const team = (await bootstrap(owner, wid)).spaces[0].id;
const pageId = ((await command(owner, { action: "page.create", workspaceId: wid, spaceId: team, title: "Verträge" })) as { id: string }).id;
const file = async (name: string, mime: string) => {
  const fid = id();
  await run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", fid, pageId, name, mime, 100, owner.id);
  return fid;
};
const pdf = await file("Vertrag.pdf", "application/pdf");
const stroke = (n: number) => ({ id: `s${n}`, type: "pen" as const, color: "#1f1f1f", width: 1.6, points: [n, n, 0.5, n + 10, n, 0.6] });
const ink = (...items: Parameters<typeof withPage>[2]) => withPage(emptyInk(), "1", items);

test("readers see the ink, editors change it; others get nothing", async () => {
  const empty = await readFileInk(viewer, pdf);
  assert.equal(empty.version, 0);
  assert.equal(empty.canEdit, false);
  assert.deepEqual(empty.doc.pages, {});
  assert.equal((await readFileInk(editor, pdf)).canEdit, true);
  await assert.rejects(async () => await readFileInk(stranger, pdf), { status: 403 });
  await assert.rejects(async () => await saveFileInk(viewer, pdf, { base: 0, doc: ink(stroke(1)) }), { status: 403 });
  await assert.rejects(async () => await saveFileInk({ ...editor, apiScope: "read" }, pdf, { base: 0, doc: ink(stroke(1)) }), { status: 403 });
  await assert.rejects(async () => await saveFileInk(editor, pdf, { base: "x", doc: {} }), { status: 400 });
  // Only PDFs.
  const image = await file("Foto.png", "image/png");
  await assert.rejects(async () => await readFileInk(owner, image), { status: 400 });

  const saved = await saveFileInk(editor, pdf, { base: 0, doc: ink(stroke(1)) });
  assert.deepEqual(saved, { version: 1, conflict: null });
  const read = await readFileInk(viewer, pdf);
  assert.equal(read.version, 1);
  assert.equal(read.updatedBy, "ink-editor");
  assert.equal(read.doc.pages["1"].length, 1);
  // The file itself is not touched.
  assert.equal((await one<{ size: number }>("SELECT size FROM files WHERE id=?", pdf))?.size, 100);
});

test("every save is a version; a save on an older version wins and reports who saved between", async () => {
  const start = (await readFileInk(owner, pdf)).version;
  const mine = await saveFileInk(owner, pdf, { base: start, doc: ink(stroke(1), stroke(2)) }, 1000);
  assert.equal(mine.conflict, null);
  // The editor still has the state from before the owner's save.
  const theirs = await saveFileInk(editor, pdf, { base: start, doc: ink(stroke(3)) }, 2000);
  assert.equal(theirs.version, mine.version + 1);
  assert.deepEqual(theirs.conflict, { by: "ink-owner", at: 1000, version: mine.version });
  assert.deepEqual((await readFileInk(owner, pdf)).doc.pages["1"].map((i) => i.id), ["s3"]);
  const versions = await fileInkVersions(viewer, pdf);
  assert.deepEqual(versions.slice(0, 2).map((v) => [v.version, v.by, v.items]), [
    [theirs.version, "ink-editor", 1],
    [mine.version, "ink-owner", 2],
  ]);
  // The overwritten state can be brought back.
  assert.deepEqual((await fileInkVersion(editor, pdf, mine.version)).doc.pages["1"].map((i) => i.id), ["s1", "s2"]);
  await assert.rejects(async () => await fileInkVersion(editor, pdf, 999), { status: 404 });
  await assert.rejects(async () => await fileInkVersions(stranger, pdf), { status: 403 });
});

test("old versions are thinned out; a locked page takes no ink", async () => {
  let base = (await readFileInk(owner, pdf)).version;
  for (let i = 0; i < INK_VERSIONS_KEPT + 5; i++) base = (await saveFileInk(owner, pdf, { base, doc: ink(stroke(i)) })).version;
  const versions = await fileInkVersions(owner, pdf);
  assert.equal(versions.length, INK_VERSIONS_KEPT);
  assert.equal(versions[0].version, base);
  await run("UPDATE pages SET locked=1 WHERE id=?", pageId);
  try {
    assert.equal((await readFileInk(owner, pdf)).canEdit, false);
    await assert.rejects(async () => await saveFileInk(owner, pdf, { base, doc: ink() }), { status: 409 });
  } finally {
    await run("UPDATE pages SET locked=0 WHERE id=?", pageId);
  }
});

test("text written on the PDF is found by search", async () => {
  assert.equal((await searchWorkspace(owner, wid, "Schlusszahlung")).length, 0);
  const base = (await readFileInk(owner, pdf)).version;
  await saveFileInk(owner, pdf, {
    base,
    doc: ink({ id: "t", type: "text", color: "#e03131", size: 14, x: 10, y: 10, text: "Schlusszahlung freigegeben" }),
  });
  await processSearchIndex(1000);
  assert.ok((await searchWorkspace(owner, wid, "Schlusszahlung")).length > 0);
});

test("shapes survive a save from a version that does not know them", async () => {
  const { withShape } = await import("../lib/ink/geometry");
  const shaped = withShape({ id: "shape1", type: "pen", color: "#1c5fd6", width: 2, points: [] }, { kind: "ellipse", box: [100, 100, 60, 60, 0], fill: "#1c5fd6" });
  let base = (await readFileInk(owner, pdf)).version;
  base = (await saveFileInk(owner, pdf, { base, doc: ink(shaped) })).version;
  // An older client read it without `shape` and saves it back with a new stroke.
  const { shape: _shape, ...plain } = shaped;
  void _shape;
  await saveFileInk(editor, pdf, { base, doc: ink(plain, stroke(7)) });
  const items = (await readFileInk(owner, pdf)).doc.pages["1"];
  assert.equal(items.length, 2);
  assert.deepEqual((items[0] as typeof shaped).shape, shaped.shape);
});
