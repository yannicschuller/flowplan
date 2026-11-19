// Deleting files from the media library (#164): into the trash, restored,
// deleted for good with everything derived from them; unused files; rights.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import type { Identity, Page } from "../lib/types";

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

const { all, one, run, id, daysAgoText } = await import("../lib/db");
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

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}-${uid}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, disabled: 0, created_at: "", groups: [], isAdmin: false };
}
const owner = await user("Owner"),
  editor = await user("Editor"),
  viewer = await user("Viewer"),
  guest = await user("Guest");
const wid = await createWorkspace(owner.id, "Files");
await run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
await run("INSERT INTO members VALUES(?,?,?)", wid, guest.id, "editor");
await run("INSERT INTO workspace_guests(workspace_id,user_id) VALUES(?,?)", wid, guest.id);
const team = (await bootstrap(owner, wid)).spaces[0].id;
const page = async (title: string, kind = "document", actor = owner, spaceId = team) =>
  ((await command(actor, { action: "page.create", workspaceId: wid, spaceId, title, kind })) as { id: string }).id;
const uploads = join(dir, "uploads");
mkdirSync(uploads, { recursive: true });
async function file(pageId: string, name = "bild.png", mime = "image/png", actor = owner) {
  const fid = id();
  writeFileSync(join(uploads, fid), `bytes of ${name}`);
  await run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", fid, pageId, name, mime, 20, actor.id);
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
const listed = async (as: Identity, options = {}) => (await mediaLibrary(as, wid, options)).items;
const act = async (as: Identity, input: Record<string, unknown>) => (await command(as, input)) as Record<string, unknown>;

test("a deleted file goes to the trash, is no longer served, and comes back unchanged", async () => {
  const doc = await page("Bilder");
  const fid = await file(doc);
  await run("UPDATE documents SET html=? WHERE page_id=?", `<p><img src="/api/files/${fid}"></p>`, doc);
  await until(() => objects.has(object(fid)), "uploaded");
  assert.ok((await listed(owner)).some((i) => i.id === fid && i.canDelete && !i.unused));

  assert.deepEqual(await act(editor, { action: "file.delete", fileIds: [fid] }), { ok: true, files: 1 });
  const stored = (await one<{ deleted_at: string; deleted_by: string }>("SELECT deleted_at,deleted_by FROM files WHERE id=?", fid))!;
  assert.ok(stored.deleted_at);
  assert.equal(stored.deleted_by, editor.id);
  // Gone from the media library, the page's files, placeholders and downloads.
  assert.ok(!(await listed(owner)).some((i) => i.id === fid));
  const docPage = (await one<Page>("SELECT * FROM pages WHERE id=?", doc))!;
  assert.ok(!(await pageFiles(doc, await hiddenFileIds(owner, docPage))).some((f) => f.id === fid));
  assert.equal((await readableFileIds(owner, [fid])).size, 0);
  // In the trash, with the upload and the bucket copy kept for a restore.
  assert.deepEqual(
    (await listFileTrash(owner, wid)).map((f) => [f.id, f.name, f.pageId]),
    [[fid, "bild.png", doc]],
  );
  assert.equal((await trashCounts(owner, wid)).files, 1);
  assert.ok(existsSync(join(uploads, fid)));
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(objects.has(object(fid)));
  // Only once; the audit log has it.
  await assert.rejects(act(editor, { action: "file.delete", fileIds: [fid] }), { status: 404 });
  assert.ok(await one("SELECT 1 FROM audit WHERE action='file.trashed' AND resource_id=? AND actor_id=?", fid, editor.id));

  assert.deepEqual(await act(owner, { action: "file.restore", fileId: fid }), { ok: true });
  assert.equal((await one<{ deleted_at: string | null }>("SELECT deleted_at FROM files WHERE id=?", fid))!.deleted_at, null);
  assert.ok((await listed(owner)).some((i) => i.id === fid));
  assert.equal((await readableFileIds(owner, [fid])).size, 1);
  assert.equal((await listFileTrash(owner, wid)).length, 0);
  assert.ok(await one("SELECT 1 FROM audit WHERE action='file.restored' AND resource_id=?", fid));
});

test("deleting for good removes the upload, the bucket copy and everything derived from it", async () => {
  const doc = await page("Akten");
  const fid = await file(doc, "akte.pdf", "application/pdf"),
    other = await file(doc, "bleibt.pdf", "application/pdf");
  await run("INSERT INTO file_texts(file_id,text,status) VALUES(?,?,?)", fid, "Vertragstext Zebrafink", "ok");
  await run("INSERT INTO file_ink(file_id,data,text,version,updated_at) VALUES(?,?,?,?,?)", fid, "{}", "", 1, Date.now());
  await run("INSERT INTO file_ink_versions(file_id,version,data,created_at) VALUES(?,?,?,?)", fid, 1, "{}", Date.now());
  await run("INSERT INTO share_uploads(file_id,token,created_at) VALUES(?,?,?)", fid, "token", Date.now());
  await processSearchIndex(10_000);
  assert.ok(await one("SELECT 1 FROM search_index WHERE page_id=? AND row_id=?", doc, `f:${fid}`));
  await until(() => objects.has(object(fid)) && objects.has(object(other)), "uploaded");

  // Only from the trash.
  await assert.rejects(act(owner, { action: "file.purge", fileId: fid }), { status: 404 });
  await act(owner, { action: "file.delete", fileIds: [fid] });
  // In the trash, the file is no longer found by search.
  await processSearchIndex(10_000);
  assert.equal(await one("SELECT 1 FROM search_index WHERE page_id=? AND row_id=?", doc, `f:${fid}`), undefined);
  // A viewer cannot delete it for good.
  await assert.rejects(act(viewer, { action: "file.purge", fileId: fid }), { status: 403 });
  assert.deepEqual(await act(owner, { action: "file.purge", fileId: fid }), { ok: true });

  assert.equal(await one("SELECT 1 FROM files WHERE id=?", fid), undefined);
  await until(() => !existsSync(join(uploads, fid)), "upload removed");
  for (const table of ["file_texts", "file_ink", "file_ink_versions", "share_uploads"])
    assert.equal(await one(`SELECT 1 FROM ${table} WHERE file_id=?`, fid), undefined, table);
  assert.equal(await one("SELECT 1 FROM search_index WHERE row_id=?", `f:${fid}`), undefined);
  assert.equal(await one("SELECT 1 FROM pending_file_deletions WHERE id=?", fid), undefined);
  // The bucket copy leaves uploads/ (moved aside for the kept backups, lib/deleted-uploads.ts).
  await until(() => !objects.has(object(fid)), "removed from the bucket");
  assert.ok(objects.has(object(other)));
  assert.ok(existsSync(join(uploads, other)));
  assert.ok(await one("SELECT 1 FROM audit WHERE action='file.purged' AND resource_id=?", fid));

  // Emptying the trash takes trashed files along; the trash period too.
  const emptied = await file(doc, "leer.png"),
    expired = await file(doc, "alt.png"),
    recent = await file(doc, "neu.png");
  await act(owner, { action: "file.delete", fileIds: [emptied] });
  const result = (await act(owner, { action: "trash.empty", workspaceId: wid })) as { files: number };
  assert.equal(result.files, 1);
  assert.equal(await one("SELECT 1 FROM files WHERE id=?", emptied), undefined);
  await until(() => !existsSync(join(uploads, emptied)), "emptied upload removed");
  await act(owner, { action: "file.delete", fileIds: [expired, recent] });
  await run("UPDATE files SET deleted_at=? WHERE id=?", daysAgoText(40), expired);
  await saveInstanceSettings({ trashDays: 30 });
  assert.equal((await expireTrash()).files, 1);
  assert.equal(await one("SELECT 1 FROM files WHERE id=?", expired), undefined);
  await until(() => !existsSync(join(uploads, expired)), "expired upload removed");
  assert.ok(await one("SELECT 1 FROM files WHERE id=?", recent));
});

test("files no current content refers to are marked unused; version history does not count", async () => {
  const doc = await page("Verwendung"),
    table = await page("Tabelle", "database"),
    board = await page("Tafel", "whiteboard"),
    notebook = await page("Heft", "notebook");
  const inDoc = await file(doc, "im-text.png"),
    linked = await file(doc, "verlinkt.pdf", "application/pdf"),
    shared = await file(doc, "geteilt.png"),
    cover = await file(doc, "cover.png"),
    inComment = await file(doc, "kommentar.png"),
    inThread = await file(doc, "textkommentar.png"),
    inRecord = await file(table, "eintrag.png"),
    inRecordDoc = await file(table, "eintragsdoku.png"),
    onBoard = await file(board, "tafel.png"),
    background = await file(notebook, "hintergrund.pdf", "application/pdf"),
    onlyInVersion = await file(doc, "alt.png"),
    orphan = await file(doc, "verwaist.png");
  await run("UPDATE documents SET html=? WHERE page_id=?", `<p><img src="/api/files/${onlyInVersion}"></p>`, doc);
  await command(owner, { action: "page.snapshot", pageId: doc });
  await run(
    "UPDATE documents SET html=? WHERE page_id=?",
    `<p><img src="/api/files/${inDoc}"></p><p><a href="https://flowplan.example/api/files/${linked}">PDF</a> <a href="/api/share/abc/files/${shared}">x</a></p>`,
    doc,
  );
  await run("UPDATE pages SET cover=? WHERE id=?", `/api/files/${cover}`, doc);
  await command(owner, { action: "comment.create", pageId: doc, body: `Siehe /api/files/${inComment}` });
  const thread = id();
  await run("INSERT INTO inline_threads(id,page_id,anchor) VALUES(?,?,?)", thread, doc, "{}");
  await run("INSERT INTO inline_messages(id,thread_id,author_name,body) VALUES(?,?,?,?)", id(), thread, "O", `![](/api/files/${inThread})`);
  const row = (await act(owner, { action: "row.create", pageId: table, cells: { title: "Eintrag" } })) as { id: string };
  await run("UPDATE rows SET icon=? WHERE id=?", `/api/files/${inRecord}`, row.id);
  await run(
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
  await run(
    "INSERT INTO whiteboards(page_id,state,generation) VALUES(?,?,?) ON CONFLICT(page_id) DO UPDATE SET state=excluded.state,generation=excluded.generation",
    board,
    Y.encodeStateAsUpdate(doc_),
    "1",
  );
  await run(
    "INSERT INTO notebook_sheets(id,page_id,position,paper,background,created_at) VALUES(?,?,?,?,?,?)",
    id(),
    notebook,
    9,
    "{}",
    JSON.stringify({ file: background, page: 1, width: 595, height: 842 }),
    Date.now(),
  );

  const items = new Map((await listed(owner)).map((i) => [i.id, i]));
  for (const fid of [inDoc, linked, shared, cover, inComment, inThread, inRecord, inRecordDoc, onBoard, background])
    assert.equal(items.get(fid)?.unused, false, items.get(fid)?.name ?? fid);
  assert.equal(items.get(onlyInVersion)?.unused, true);
  assert.equal(items.get(orphan)?.unused, true);
  const unusedOnly = await mediaLibrary(owner, wid, { usage: "unused" });
  assert.ok(unusedOnly.items.every((i) => i.unused));
  assert.ok(unusedOnly.items.some((i) => i.id === orphan));
  assert.equal(unusedOnly.total, unusedOnly.unused);
  // Removing an image from the document does not delete it: it becomes unused.
  await run("UPDATE documents SET html='<p>leer</p>' WHERE page_id=?", doc);
  assert.equal((await listed(owner)).find((i) => i.id === inDoc)?.unused, true);
  assert.ok(await one("SELECT 1 FROM files WHERE id=? AND deleted_at IS NULL", inDoc));

  // "Delete all unused" – of the current filter, into the trash.
  const before = await mediaLibrary(owner, wid, { usage: "unused", query: "alt" });
  assert.deepEqual(before.items.map((i) => i.name), ["alt.png"]);
  assert.deepEqual(await act(owner, { action: "files.deleteUnused", workspaceId: wid, query: "alt" }), { ok: true, files: 1 });
  assert.ok(await one("SELECT 1 FROM files WHERE id=? AND deleted_at IS NOT NULL", onlyInVersion));
  const result = (await act(owner, { action: "files.deleteUnused", workspaceId: wid })) as { files: number };
  assert.ok(result.files >= 4);
  for (const fid of [inDoc, linked, shared, orphan]) assert.ok(await one("SELECT 1 FROM files WHERE id=? AND deleted_at IS NOT NULL", fid));
  for (const fid of [cover, inComment, inThread, onBoard, background, inRecord, inRecordDoc])
    assert.ok(await one("SELECT 1 FROM files WHERE id=? AND deleted_at IS NULL", fid));
  assert.equal((await mediaLibrary(owner, wid, { usage: "unused" })).total, 0);

  // The old version still shows the file deleted for good: restoring it works,
  // the image is simply missing (and a purged cover is dropped).
  await run("UPDATE pages SET cover=? WHERE id=?", `/api/files/${orphan}`, doc);
  await command(owner, { action: "page.snapshot", pageId: doc });
  const snapshot = (await one<{ id: string }>("SELECT id FROM snapshots WHERE page_id=? ORDER BY seq DESC LIMIT 1", doc))!;
  await act(owner, { action: "trash.empty", workspaceId: wid });
  assert.equal(await one("SELECT 1 FROM files WHERE id=?", onlyInVersion), undefined);
  assert.equal(await one("SELECT 1 FROM files WHERE id=?", orphan), undefined);
  for (const s of await all<{ id: string }>("SELECT id FROM snapshots WHERE page_id=?", doc))
    await act(owner, { action: "snapshot.restore", pageId: doc, snapshotId: s.id });
  await act(owner, { action: "snapshot.restore", pageId: doc, snapshotId: snapshot.id });
  assert.equal((await one<{ cover: string }>("SELECT cover FROM pages WHERE id=?", doc))!.cover, "");
});

test("only people who may edit the page delete files; private files stay invisible", async () => {
  const doc = await page("Rechte");
  const fid = await file(doc, "team.png");
  // Viewers and guests: no delete, not even with a share that lets the guest edit.
  await run("INSERT INTO grants(resource_id,user_id,group_id,role) VALUES(?,?,?,?)", doc, guest.id, "", "editor");
  assert.equal((await listed(viewer)).find((i) => i.id === fid)?.canDelete, false);
  await assert.rejects(act(viewer, { action: "file.delete", fileIds: [fid] }), { status: 403 });
  await assert.rejects(act(guest, { action: "file.delete", fileIds: [fid] }), { status: 403 });
  await assert.rejects(act(guest, { action: "files.deleteUnused", workspaceId: wid }), { status: 403 });
  assert.equal((await listed(guest)).find((i) => i.id === fid)?.canDelete, false);
  // A read-only token neither.
  await assert.rejects(act({ ...owner, apiScope: "read" } as Identity, { action: "file.delete", fileIds: [fid] }), { status: 403 });
  assert.ok(await one("SELECT 1 FROM files WHERE id=? AND deleted_at IS NULL", fid));
  // All or none: one file the person may not delete stops the whole batch.
  const mine = await file(doc, "meins.png");
  const privateSpace = ((await command(owner, { action: "space.create", workspaceId: wid, name: "Privat", private: true })) as { id: string }).id;
  const secret = await file(await page("Geheim", "document", owner, privateSpace), "geheim.png");
  assert.ok(!(await listed(editor)).some((i) => i.id === secret));
  await assert.rejects(act(editor, { action: "file.delete", fileIds: [mine, secret] }), { status: 404 });
  assert.ok(await one("SELECT 1 FROM files WHERE id=? AND deleted_at IS NULL", mine));
  // In the trash, someone else's private file is not listed, restored or deleted.
  await act(owner, { action: "file.delete", fileIds: [secret] });
  assert.ok((await listFileTrash(owner, wid)).some((f) => f.id === secret));
  assert.ok(!(await listFileTrash(editor, wid)).some((f) => f.id === secret));
  assert.ok(!(await listFileTrash(viewer, wid)).some((f) => f.id === secret));
  await assert.rejects(act(editor, { action: "file.restore", fileId: secret }), { status: 404 });
  await assert.rejects(act(editor, { action: "file.purge", fileId: secret }), { status: 404 });
  await act(editor, { action: "trash.empty", workspaceId: wid });
  assert.ok(await one("SELECT 1 FROM files WHERE id=?", secret), "emptying leaves others' private files");
  // Viewers see nothing to restore.
  await act(editor, { action: "file.delete", fileIds: [mine] });
  assert.equal((await listFileTrash(viewer, wid)).length, 0);
  await assert.rejects(act(viewer, { action: "file.restore", fileId: mine }), { status: 403 });
  await act(editor, { action: "file.restore", fileId: mine });
});

test("a replaced cover is unused in the cover dialog's list and goes to the trash; one in use stays (#396)", async () => {
  const doc = await page("Cover-Wechsel");
  const a = await file(doc, "cover-a.png"),
    b = await file(doc, "cover-b.png"),
    elsewhere = await file(await page("Andere Seite"), "fremd.png");
  const setCover = async (fid: string) => {
    const current = (await one<{ cover: string; cover_position: number }>("SELECT cover,cover_position FROM pages WHERE id=?", doc))!;
    await act(owner, {
      action: "page.update",
      pageId: doc,
      coverBase: { cover: current.cover, coverPosition: current.cover_position ?? 50 },
      patch: { cover: `/api/files/${fid}`, cover_position: 50 },
    });
  };
  await setCover(a);
  await setCover(b);
  // The page's images only (GET /api/media?page=…), usage across the workspace.
  const ofPage = await mediaLibrary(owner, wid, { pageId: doc, kind: "image" });
  assert.deepEqual(new Set(ofPage.items.map((i) => i.id)), new Set([a, b]));
  const usage = new Map(ofPage.items.map((i) => [i.id, i]));
  assert.equal(usage.get(a)?.unused, true);
  assert.equal(usage.get(a)?.canDelete, true);
  assert.equal(usage.get(b)?.unused, false);
  assert.ok(!ofPage.items.some((i) => i.id === elsewhere));

  // The dialog's "Entfernen" (file.delete with unusedOnly): refused for the
  // current cover, all or none, with nothing moved.
  await assert.rejects(act(owner, { action: "file.delete", fileIds: [b], unusedOnly: true }), { status: 409 });
  await assert.rejects(act(owner, { action: "file.delete", fileIds: [a, b], unusedOnly: true }), { status: 409 });
  for (const fid of [a, b]) assert.ok(await one("SELECT 1 FROM files WHERE id=? AND deleted_at IS NULL", fid));
  // The same rights as the media library: viewers never.
  await assert.rejects(act(viewer, { action: "file.delete", fileIds: [a], unusedOnly: true }), { status: 403 });

  assert.deepEqual(await act(editor, { action: "file.delete", fileIds: [a], unusedOnly: true }), { ok: true, files: 1 });
  assert.ok(await one("SELECT 1 FROM files WHERE id=? AND deleted_at IS NOT NULL", a));
  assert.ok(await one("SELECT 1 FROM files WHERE id=? AND deleted_at IS NULL", b));
  assert.equal((await one<{ cover: string }>("SELECT cover FROM pages WHERE id=?", doc))!.cover, `/api/files/${b}`);
  assert.deepEqual((await mediaLibrary(owner, wid, { pageId: doc, kind: "image" })).items.map((i) => i.id), [b]);
  assert.ok((await listFileTrash(owner, wid)).some((f) => f.id === a));
  // Restored from the trash, unchanged and unused again.
  await act(owner, { action: "file.restore", fileId: a });
  assert.equal((await mediaLibrary(owner, wid, { pageId: doc })).items.find((i) => i.id === a)?.unused, true);

  // In use again meanwhile (e.g. set as cover on another device): refused.
  await setCover(a);
  await assert.rejects(act(owner, { action: "file.delete", fileIds: [a], unusedOnly: true }), { status: 409 });
  // Used anywhere else in the workspace counts too.
  await run("UPDATE documents SET html=? WHERE page_id=?", `<p><img src="/api/files/${b}"></p>`, doc);
  await assert.rejects(act(owner, { action: "file.delete", fileIds: [b], unusedOnly: true }), { status: 409 });
});

test("end-to-end encrypted spaces: never marked unused, never removed as unused (#396)", async () => {
  const space = ((await command(owner, { action: "space.create", workspaceId: wid, name: "Tresor" })) as { id: string }).id;
  const doc = await page("Verschlüsselt", "document", owner, space);
  const fid = await file(doc, "alt.png");
  await run("UPDATE spaces SET encrypted=1 WHERE id=?", space);
  // Not in the media library (lockedPageIds): the cover dialog offers nothing.
  assert.ok(!(await mediaLibrary(owner, wid, { pageId: doc })).items.some((i) => i.id === fid));
  await assert.rejects(act(owner, { action: "file.delete", fileIds: [fid], unusedOnly: true }), { status: 409 });
  assert.ok(await one("SELECT 1 FROM files WHERE id=? AND deleted_at IS NULL", fid));
});
