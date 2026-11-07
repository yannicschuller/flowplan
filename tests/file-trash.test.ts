// Deleting files from the media library (#164): into the trash, restored,
// deleted for good with everything derived from them; unused files; rights.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import type { Identity } from "../lib/types";

// A minimal S3 stand-in (path-style objects in memory), as in storage.test.ts.
const objects = new Map<string, Buffer>();
const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const path = decodeURIComponent(req.url || "");
    const source = req.headers["x-amz-copy-source"];
    if (req.method === "PUT" && typeof source === "string") {
      const body = objects.get(decodeURIComponent(source));
      if (!body) return void res.writeHead(404).end();
      objects.set(path, body);
      return void res.writeHead(200).end("<CopyObjectResult/>");
    }
    if (req.method === "PUT") objects.set(path, Buffer.concat(chunks));
    if (req.method === "DELETE") objects.delete(path);
    if (req.method === "GET") {
      const url = new URL(req.url || "", "http://x");
      if (url.searchParams.get("list-type") === "2")
        return void res.writeHead(200).end("<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>");
      const body = objects.get(path);
      if (!body) return void res.writeHead(404).end();
      return void res.writeHead(200).end(body);
    }
    res.writeHead(200).end();
  });
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
server.unref();
const dir = mkdtempSync(join(tmpdir(), "flowplan-file-trash-"));
process.env.FLOWPLAN_DATA_DIR = dir;
process.env.S3_ENDPOINT = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
process.env.S3_BUCKET = "bucket";
process.env.S3_ACCESS_KEY_ID = "key";
process.env.S3_SECRET_ACCESS_KEY = "secret";

const { all, one, run, id } = await import("../lib/db");
const { command, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { mediaLibrary } = await import("../lib/media-library");
const { listFileTrash } = await import("../lib/file-trash");
const { trashCounts, expireTrash } = await import("../lib/trash");
const { readableFileIds } = await import("../lib/image-placeholders");
const { processSearchIndex } = await import("../lib/search-index");
const { pageFiles } = await import("../lib/page-covers");
const { hiddenFileIds } = await import("../lib/row-files");
const { saveInstanceSettings } = await import("../lib/instance-settings");

function user(name: string): Identity {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}-${uid}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, disabled: 0, created_at: "", groups: [], isAdmin: false };
}
const owner = user("Owner"),
  editor = user("Editor"),
  viewer = user("Viewer"),
  guest = user("Guest");
const wid = createWorkspace(owner.id, "Files");
run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
run("INSERT INTO members VALUES(?,?,?)", wid, guest.id, "editor");
run("INSERT INTO workspace_guests(workspace_id,user_id) VALUES(?,?)", wid, guest.id);
const team = bootstrap(owner, wid).spaces[0].id;
const page = (title: string, kind = "document", actor = owner, spaceId = team) =>
  (command(actor, { action: "page.create", workspaceId: wid, spaceId, title, kind }) as { id: string }).id;
const uploads = join(dir, "uploads");
mkdirSync(uploads, { recursive: true });
function file(pageId: string, name = "bild.png", mime = "image/png", actor = owner) {
  const fid = id();
  writeFileSync(join(uploads, fid), `bytes of ${name}`);
  run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", fid, pageId, name, mime, 20, actor.id);
  return fid;
}
const object = (fid: string) => `/bucket/flowplan/uploads/${fid}`;
const until = async (check: () => boolean, label: string) => {
  for (let i = 0; i < 250; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail(`timed out: ${label}`);
};
const listed = (as: Identity, options = {}) => mediaLibrary(as, wid, options).items;
const act = (as: Identity, input: Record<string, unknown>) => command(as, input) as Record<string, unknown>;

test("a deleted file goes to the trash, is no longer served, and comes back unchanged", async () => {
  const doc = page("Bilder");
  const fid = file(doc);
  run("UPDATE documents SET html=? WHERE page_id=?", `<p><img src="/api/files/${fid}"></p>`, doc);
  await until(() => objects.has(object(fid)), "uploaded");
  assert.ok(listed(owner).some((i) => i.id === fid && i.canDelete && !i.unused));

  assert.deepEqual(act(editor, { action: "file.delete", fileIds: [fid] }), { ok: true, files: 1 });
  const stored = one<{ deleted_at: string; deleted_by: string }>("SELECT deleted_at,deleted_by FROM files WHERE id=?", fid)!;
  assert.ok(stored.deleted_at);
  assert.equal(stored.deleted_by, editor.id);
  // Gone from the media library, the page's files, placeholders and downloads.
  assert.ok(!listed(owner).some((i) => i.id === fid));
  assert.ok(!pageFiles(doc, hiddenFileIds(owner, one("SELECT * FROM pages WHERE id=?", doc)!)).some((f) => f.id === fid));
  assert.equal(readableFileIds(owner, [fid]).size, 0);
  // In the trash, with the upload and the bucket copy kept for a restore.
  assert.deepEqual(
    listFileTrash(owner, wid).map((f) => [f.id, f.name, f.pageId]),
    [[fid, "bild.png", doc]],
  );
  assert.equal(trashCounts(owner, wid).files, 1);
  assert.ok(existsSync(join(uploads, fid)));
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(objects.has(object(fid)));
  // Only once; the audit log has it.
  assert.throws(() => act(editor, { action: "file.delete", fileIds: [fid] }), { status: 404 });
  assert.ok(one("SELECT 1 FROM audit WHERE action='file.trashed' AND resource_id=? AND actor_id=?", fid, editor.id));

  assert.deepEqual(act(owner, { action: "file.restore", fileId: fid }), { ok: true });
  assert.equal(one<{ deleted_at: string | null }>("SELECT deleted_at FROM files WHERE id=?", fid)!.deleted_at, null);
  assert.ok(listed(owner).some((i) => i.id === fid));
  assert.equal(readableFileIds(owner, [fid]).size, 1);
  assert.equal(listFileTrash(owner, wid).length, 0);
  assert.ok(one("SELECT 1 FROM audit WHERE action='file.restored' AND resource_id=?", fid));
});

test("deleting for good removes the upload, the bucket copy and everything derived from it", async () => {
  const doc = page("Akten");
  const fid = file(doc, "akte.pdf", "application/pdf"),
    other = file(doc, "bleibt.pdf", "application/pdf");
  run("INSERT INTO file_texts(file_id,text,status) VALUES(?,?,?)", fid, "Vertragstext Zebrafink", "ok");
  run("INSERT INTO file_ink(file_id,data,text,version,updated_at) VALUES(?,?,?,?,?)", fid, "{}", "", 1, Date.now());
  run("INSERT INTO file_ink_versions(file_id,version,data,created_at) VALUES(?,?,?,?)", fid, 1, "{}", Date.now());
  run("INSERT INTO share_uploads(file_id,token,created_at) VALUES(?,?,?)", fid, "token", Date.now());
  processSearchIndex(10_000);
  assert.ok(one("SELECT 1 FROM search_index WHERE page_id=? AND row_id=?", doc, `f:${fid}`));
  await until(() => objects.has(object(fid)) && objects.has(object(other)), "uploaded");

  // Only from the trash.
  assert.throws(() => act(owner, { action: "file.purge", fileId: fid }), { status: 404 });
  act(owner, { action: "file.delete", fileIds: [fid] });
  // In the trash, the file is no longer found by search.
  processSearchIndex(10_000);
  assert.equal(one("SELECT 1 FROM search_index WHERE page_id=? AND row_id=?", doc, `f:${fid}`), undefined);
  // A viewer cannot delete it for good.
  assert.throws(() => act(viewer, { action: "file.purge", fileId: fid }), { status: 403 });
  assert.deepEqual(act(owner, { action: "file.purge", fileId: fid }), { ok: true });

  assert.equal(one("SELECT 1 FROM files WHERE id=?", fid), undefined);
  assert.equal(existsSync(join(uploads, fid)), false);
  for (const table of ["file_texts", "file_ink", "file_ink_versions", "share_uploads"])
    assert.equal(one(`SELECT 1 FROM ${table} WHERE file_id=?`, fid), undefined, table);
  assert.equal(one("SELECT 1 FROM search_index WHERE row_id=?", `f:${fid}`), undefined);
  assert.equal(one("SELECT 1 FROM pending_file_deletions WHERE id=?", fid), undefined);
  // The bucket copy leaves uploads/ (moved aside for the kept backups, lib/deleted-uploads.ts).
  await until(() => !objects.has(object(fid)), "removed from the bucket");
  assert.ok(objects.has(object(other)));
  assert.ok(existsSync(join(uploads, other)));
  assert.ok(one("SELECT 1 FROM audit WHERE action='file.purged' AND resource_id=?", fid));

  // Emptying the trash takes trashed files along; the trash period too.
  const emptied = file(doc, "leer.png"),
    expired = file(doc, "alt.png"),
    recent = file(doc, "neu.png");
  act(owner, { action: "file.delete", fileIds: [emptied] });
  const result = act(owner, { action: "trash.empty", workspaceId: wid }) as { files: number };
  assert.equal(result.files, 1);
  assert.equal(one("SELECT 1 FROM files WHERE id=?", emptied), undefined);
  assert.equal(existsSync(join(uploads, emptied)), false);
  act(owner, { action: "file.delete", fileIds: [expired, recent] });
  run("UPDATE files SET deleted_at=datetime('now','-40 days') WHERE id=?", expired);
  saveInstanceSettings({ trashDays: 30 });
  assert.equal(expireTrash().files, 1);
  assert.equal(one("SELECT 1 FROM files WHERE id=?", expired), undefined);
  assert.equal(existsSync(join(uploads, expired)), false);
  assert.ok(one("SELECT 1 FROM files WHERE id=?", recent));
});

test("files no current content refers to are marked unused; version history does not count", () => {
  const doc = page("Verwendung"),
    table = page("Tabelle", "database"),
    board = page("Tafel", "whiteboard"),
    notebook = page("Heft", "notebook");
  const inDoc = file(doc, "im-text.png"),
    linked = file(doc, "verlinkt.pdf", "application/pdf"),
    shared = file(doc, "geteilt.png"),
    cover = file(doc, "cover.png"),
    inComment = file(doc, "kommentar.png"),
    inThread = file(doc, "textkommentar.png"),
    inRecord = file(table, "eintrag.png"),
    inRecordDoc = file(table, "eintragsdoku.png"),
    onBoard = file(board, "tafel.png"),
    background = file(notebook, "hintergrund.pdf", "application/pdf"),
    onlyInVersion = file(doc, "alt.png"),
    orphan = file(doc, "verwaist.png");
  run("UPDATE documents SET html=? WHERE page_id=?", `<p><img src="/api/files/${onlyInVersion}"></p>`, doc);
  command(owner, { action: "page.snapshot", pageId: doc });
  run(
    "UPDATE documents SET html=? WHERE page_id=?",
    `<p><img src="/api/files/${inDoc}"></p><p><a href="https://flowplan.example/api/files/${linked}">PDF</a> <a href="/api/share/abc/files/${shared}">x</a></p>`,
    doc,
  );
  run("UPDATE pages SET cover=? WHERE id=?", `/api/files/${cover}`, doc);
  command(owner, { action: "comment.create", pageId: doc, body: `Siehe /api/files/${inComment}` });
  const thread = id();
  run("INSERT INTO inline_threads(id,page_id,anchor) VALUES(?,?,?)", thread, doc, "{}");
  run("INSERT INTO inline_messages(id,thread_id,author_name,body) VALUES(?,?,?,?)", id(), thread, "O", `![](/api/files/${inThread})`);
  const row = act(owner, { action: "row.create", pageId: table, cells: { title: "Eintrag" } }) as { id: string };
  run("UPDATE rows SET icon=? WHERE id=?", `/api/files/${inRecord}`, row.id);
  run(
    "INSERT INTO row_documents(row_id,state,html,generation) VALUES(?,?,?,?)",
    row.id,
    new Uint8Array(),
    `<img src="/api/files/${inRecordDoc}">`,
    "1",
  );
  const doc_ = new Y.Doc();
  const item = new Y.Map<unknown>();
  item.set("type", "image");
  item.set("src", `/api/files/${onBoard}`);
  doc_.getMap("items").set("i1", item);
  run("INSERT OR REPLACE INTO whiteboards(page_id,state,generation) VALUES(?,?,?)", board, Y.encodeStateAsUpdate(doc_), "1");
  run(
    "INSERT INTO notebook_sheets(id,page_id,position,paper,background,created_at) VALUES(?,?,?,?,?,?)",
    id(),
    notebook,
    9,
    "{}",
    JSON.stringify({ file: background, page: 1, width: 595, height: 842 }),
    Date.now(),
  );

  const items = new Map(listed(owner).map((i) => [i.id, i]));
  for (const fid of [inDoc, linked, shared, cover, inComment, inThread, inRecord, inRecordDoc, onBoard, background])
    assert.equal(items.get(fid)?.unused, false, items.get(fid)?.name ?? fid);
  assert.equal(items.get(onlyInVersion)?.unused, true);
  assert.equal(items.get(orphan)?.unused, true);
  const unusedOnly = mediaLibrary(owner, wid, { usage: "unused" });
  assert.ok(unusedOnly.items.every((i) => i.unused));
  assert.ok(unusedOnly.items.some((i) => i.id === orphan));
  assert.equal(unusedOnly.total, unusedOnly.unused);
  // Removing an image from the document does not delete it: it becomes unused.
  run("UPDATE documents SET html='<p>leer</p>' WHERE page_id=?", doc);
  assert.equal(listed(owner).find((i) => i.id === inDoc)?.unused, true);
  assert.ok(one("SELECT 1 FROM files WHERE id=? AND deleted_at IS NULL", inDoc));

  // "Delete all unused" – of the current filter, into the trash.
  const before = mediaLibrary(owner, wid, { usage: "unused", query: "alt" });
  assert.deepEqual(before.items.map((i) => i.name), ["alt.png"]);
  assert.deepEqual(act(owner, { action: "files.deleteUnused", workspaceId: wid, query: "alt" }), { ok: true, files: 1 });
  assert.ok(one("SELECT 1 FROM files WHERE id=? AND deleted_at IS NOT NULL", onlyInVersion));
  const result = act(owner, { action: "files.deleteUnused", workspaceId: wid }) as { files: number };
  assert.ok(result.files >= 4);
  for (const fid of [inDoc, linked, shared, orphan]) assert.ok(one("SELECT 1 FROM files WHERE id=? AND deleted_at IS NOT NULL", fid));
  for (const fid of [cover, inComment, inThread, onBoard, background, inRecord, inRecordDoc])
    assert.ok(one("SELECT 1 FROM files WHERE id=? AND deleted_at IS NULL", fid));
  assert.equal(mediaLibrary(owner, wid, { usage: "unused" }).total, 0);

  // The old version still shows the file deleted for good: restoring it works,
  // the image is simply missing (and a purged cover is dropped).
  run("UPDATE pages SET cover=? WHERE id=?", `/api/files/${orphan}`, doc);
  command(owner, { action: "page.snapshot", pageId: doc });
  const snapshot = one<{ id: string }>("SELECT id FROM snapshots WHERE page_id=? ORDER BY rowid DESC LIMIT 1", doc)!;
  act(owner, { action: "trash.empty", workspaceId: wid });
  assert.equal(one("SELECT 1 FROM files WHERE id=?", onlyInVersion), undefined);
  assert.equal(one("SELECT 1 FROM files WHERE id=?", orphan), undefined);
  for (const s of all<{ id: string }>("SELECT id FROM snapshots WHERE page_id=?", doc))
    act(owner, { action: "snapshot.restore", pageId: doc, snapshotId: s.id });
  act(owner, { action: "snapshot.restore", pageId: doc, snapshotId: snapshot.id });
  assert.equal(one<{ cover: string }>("SELECT cover FROM pages WHERE id=?", doc)!.cover, "");
});

test("only people who may edit the page delete files; private files stay invisible", () => {
  const doc = page("Rechte");
  const fid = file(doc, "team.png");
  // Viewers and guests: no delete, not even with a share that lets the guest edit.
  run("INSERT INTO grants VALUES(?,?,?,?)", doc, guest.id, "", "editor");
  assert.equal(listed(viewer).find((i) => i.id === fid)?.canDelete, false);
  assert.throws(() => act(viewer, { action: "file.delete", fileIds: [fid] }), { status: 403 });
  assert.throws(() => act(guest, { action: "file.delete", fileIds: [fid] }), { status: 403 });
  assert.throws(() => act(guest, { action: "files.deleteUnused", workspaceId: wid }), { status: 403 });
  assert.equal(listed(guest).find((i) => i.id === fid)?.canDelete, false);
  // A read-only token neither.
  assert.throws(() => act({ ...owner, apiScope: "read" } as Identity, { action: "file.delete", fileIds: [fid] }), { status: 403 });
  assert.ok(one("SELECT 1 FROM files WHERE id=? AND deleted_at IS NULL", fid));
  // All or none: one file the person may not delete stops the whole batch.
  const mine = file(doc, "meins.png");
  const privateSpace = (command(owner, { action: "space.create", workspaceId: wid, name: "Privat", private: true }) as { id: string }).id;
  const secret = file(page("Geheim", "document", owner, privateSpace), "geheim.png");
  assert.ok(!listed(editor).some((i) => i.id === secret));
  assert.throws(() => act(editor, { action: "file.delete", fileIds: [mine, secret] }), { status: 404 });
  assert.ok(one("SELECT 1 FROM files WHERE id=? AND deleted_at IS NULL", mine));
  // In the trash, someone else's private file is not listed, restored or deleted.
  act(owner, { action: "file.delete", fileIds: [secret] });
  assert.ok(listFileTrash(owner, wid).some((f) => f.id === secret));
  assert.ok(!listFileTrash(editor, wid).some((f) => f.id === secret));
  assert.ok(!listFileTrash(viewer, wid).some((f) => f.id === secret));
  assert.throws(() => act(editor, { action: "file.restore", fileId: secret }), { status: 404 });
  assert.throws(() => act(editor, { action: "file.purge", fileId: secret }), { status: 404 });
  act(editor, { action: "trash.empty", workspaceId: wid });
  assert.ok(one("SELECT 1 FROM files WHERE id=?", secret), "emptying leaves others' private files");
  // Viewers see nothing to restore.
  act(editor, { action: "file.delete", fileIds: [mine] });
  assert.equal(listFileTrash(viewer, wid).length, 0);
  assert.throws(() => act(viewer, { action: "file.restore", fileId: mine }), { status: 403 });
  act(editor, { action: "file.restore", fileId: mine });
});
