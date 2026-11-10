// Audio recordings of notebooks (lib/notebook-audio.ts, lib/ink/audio-sync.ts,
// lib/webm-duration.ts): time marks on ink, the format a browser records,
// chunked uploads with resume, limits (three hours, size, quota), rights,
// rename/delete via the trash, copies, archives, exports, and serving the
// audio with range requests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Identity, Page } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-nb-audio-"));
const { run, id, one } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const audio = await import("../lib/notebook-audio");
const sync = await import("../lib/ink/audio-sync");
const { webmDurationPatch, webmDurationMs } = await import("../lib/webm-duration");
const { recordingMime } = await import("../lib/upload-safety");
const { cleanItem, emptyInk, parseInk, serializeInk, withPage } = await import("../lib/ink/model");
const { notebookArchive, importNotebook, notebookSheets } = await import("../lib/notebook");
const { duplicatePageTree } = await import("../lib/page-tree");
const { usedFileIds } = await import("../lib/file-usage");
const { setWorkspaceQuota } = await import("../lib/instance-ops");
const { fileResponse } = await import("../lib/file-response");
const { exportMarkdown } = await import("../lib/markdown-export");
const { readExportZip } = await import("./helpers/read-export-zip");
const store = await import("../lib/page-ink-store");

async function account(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const owner = await account("au-owner"),
  editor = await account("au-editor"),
  viewer = await account("au-viewer"),
  stranger = await account("au-stranger");
const wid = await createWorkspace(owner.id, "Vorlesungen");
await run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const team = (await bootstrap(owner, wid)).spaces[0].id;
const create = async (title: string, kind = "notebook") =>
  ((await command(owner, { action: "page.create", workspaceId: wid, spaceId: team, title, kind })) as { id: string }).id;

// ---- A WebM file as MediaRecorder writes it ----
const vint8 = (n: number) => {
  const b = Buffer.alloc(8);
  b[0] = 0x01;
  b.writeUIntBE(n, 2, 6);
  return b;
};
const el = (idHex: string, content: Buffer, size?: Buffer) => Buffer.concat([Buffer.from(idHex, "hex"), size ?? Buffer.from([0x80 | content.length]), content]);
function webm({ seekHead = false, segmentSize }: { seekHead?: boolean; segmentSize?: number } = {}) {
  const header = el("1a45dfa3", Buffer.concat([el("4282", Buffer.from("webm")), el("4287", Buffer.from([4]))]));
  const info = el("1549a966", Buffer.concat([el("2ad7b1", Buffer.from([0x0f, 0x42, 0x40])), el("4d80", Buffer.from("Chrome")), el("5741", Buffer.from("Chrome"))]));
  const tracks = el("1654ae6b", el("ae", el("d7", Buffer.from([1]))));
  const cluster = Buffer.concat([Buffer.from("1f43b675", "hex"), Buffer.from("01ffffffffffffff", "hex"), el("e7", Buffer.from([0])), Buffer.alloc(300, 7)]);
  const body = Buffer.concat([seekHead ? el("114d9b74", Buffer.alloc(4)) : Buffer.alloc(0), info, tracks, cluster]);
  const size = segmentSize === undefined ? Buffer.from("01ffffffffffffff", "hex") : vint8(segmentSize === -1 ? body.length : segmentSize);
  return Buffer.concat([header, Buffer.from("18538067", "hex"), size, body]);
}

test("WebM: the duration is written into Info, the rest of the file stays", () => {
  const file = webm();
  assert.equal(webmDurationMs(file), null);
  const patch = webmDurationPatch(file, 12_345)!;
  assert.ok(patch);
  const out = Buffer.concat([patch.head, file.subarray(patch.skip)]);
  assert.equal(Math.round(webmDurationMs(out)!), 12_345);
  // Tracks and clusters unchanged after the new Info.
  assert.ok(out.subarray(out.length - 300).equals(Buffer.alloc(300, 7)));
  assert.ok(out.includes(Buffer.from("1654ae6b", "hex")));
  // A second patch overwrites the duration in place.
  const again = webmDurationPatch(out, 20_000)!;
  assert.equal(again.head.length, again.skip);
  assert.equal(Math.round(webmDurationMs(Buffer.concat([again.head, out.subarray(again.skip)]))!), 20_000);
  // A Segment of known size grows with Info.
  const known = webm({ segmentSize: -1 });
  const grown = webmDurationPatch(known, 1000)!;
  const knownOut = Buffer.concat([grown.head, known.subarray(grown.skip)]);
  const headerLength = knownOut.indexOf(Buffer.from("18538067", "hex"));
  assert.equal(knownOut.readUIntBE(headerLength + 6, 6), knownOut.length - headerLength - 12);
  // Byte positions (SeekHead) would break: left alone. Not WebM: nothing.
  assert.equal(webmDurationPatch(webm({ seekHead: true }), 1000), null);
  assert.equal(webmDurationPatch(Buffer.from("OggS0000"), 1000), null);
  assert.equal(webmDurationPatch(file, 0), null);
});

test("recording types: only Opus/AAC containers whose content matches", () => {
  const head = webm().subarray(0, 64);
  assert.equal(recordingMime("audio/webm;codecs=opus", head), "audio/webm");
  assert.equal(recordingMime("AUDIO/WEBM", head), "audio/webm");
  assert.equal(recordingMime("audio/ogg;codecs=opus", Buffer.from("OggS\0\0\0\0")), "audio/ogg");
  assert.equal(recordingMime("audio/mp4", Buffer.from("\0\0\0\x18ftypM4A ", "latin1")), "audio/mp4");
  assert.equal(recordingMime("audio/ogg", head), null);
  assert.equal(recordingMime("video/webm", head), null);
  assert.equal(recordingMime("text/html", Buffer.from("<html>")), null);
  // The browser's choice: Opus first, AAC first on Apple's WebKit.
  const supports = (list: string[]) => (m: string) => list.includes(m);
  assert.equal(sync.pickRecordingFormat(supports(["audio/webm;codecs=opus", "audio/mp4"]))?.base, "audio/webm");
  assert.equal(sync.pickRecordingFormat(supports(["audio/webm;codecs=opus", "audio/mp4"]), true)?.base, "audio/mp4");
  assert.equal(sync.pickRecordingFormat(supports(["audio/ogg;codecs=opus"]))?.ext, "ogg");
  assert.equal(sync.pickRecordingFormat(supports([])), null);
  assert.equal(
    sync.pickRecordingFormat(() => {
      throw new Error("no");
    }),
    null,
  );
});

test("time marks: new items get the recording's moment; older clients' data stays readable", () => {
  const stroke = { id: "a1", type: "pen", color: "#1f1f1f", width: 1.6, points: [1, 1, 0.5, 2, 2, 0.5] };
  // Stored and read back.
  const marked = cleanItem({ ...stroke, rec: { id: "r-1", t: 1234.6 } })!;
  assert.deepEqual(marked.rec, { id: "r-1", t: 1235 });
  assert.equal(cleanItem({ ...stroke, rec: { id: "bad id!", t: 1 } })!.rec, undefined);
  assert.equal(cleanItem({ ...stroke, rec: { id: "r", t: "5" } })!.rec, undefined);
  assert.equal(cleanItem({ ...stroke, rec: { id: "r", t: 1e12 } })!.rec!.t, 3 * 3600_000 + 60_000);
  assert.equal(cleanItem(stroke)!.rec, undefined);
  const text = cleanItem({ id: "t1", type: "text", color: "#1f1f1f", size: 12, x: 1, y: 1, text: "Hi", rec: { id: "r-1", t: 5 } })!;
  assert.deepEqual(text.rec, { id: "r-1", t: 5 });
  const doc = withPage(emptyInk(), "s", [marked, text]);
  assert.deepEqual(parseInk(serializeInk(doc)), doc);

  // Stamping: only what is new and unmarked.
  const before = withPage(emptyInk(), "s", [cleanItem(stroke)!]);
  const piece = { ...marked, id: "a2" };
  const fresh = cleanItem({ ...stroke, id: "b1" })!;
  const next = withPage(before, "s", [...before.pages.s, piece, fresh]);
  const stamped = sync.stampNewItems(before, next, { id: "r-2", t: 4000.4 });
  assert.equal(stamped.pages.s[0].rec, undefined, "existing items keep no mark");
  assert.deepEqual(stamped.pages.s[1].rec, { id: "r-1", t: 1235 }, "a piece keeps its original's moment");
  assert.deepEqual(stamped.pages.s[2].rec, { id: "r-2", t: 4000 });
  assert.equal(sync.stampNewItems(before, before, { id: "r", t: 1 }), before);
  // Playback: dimmed while not reached.
  assert.equal(sync.isUnspoken(stamped.pages.s[2], { id: "r-2", t: 3999 }), true);
  assert.equal(sync.isUnspoken(stamped.pages.s[2], { id: "r-2", t: 4000 }), false);
  assert.equal(sync.isUnspoken(stamped.pages.s[2], { id: "r-1", t: 0 }), false);
  assert.equal(sync.isUnspoken(stamped.pages.s[0], { id: "r-2", t: 0 }), false);
  assert.equal(sync.isUnspoken(stamped.pages.s[2], null), false);
  assert.deepEqual(sync.seekTimeOf(stamped.pages.s[2]), { id: "r-2", t: 3000 });
  assert.equal(sync.itemsOfRecording(stamped, "r-2"), 1);
});

test("limits: three hours, less when the storage is short; clock and upload ranges", () => {
  assert.equal(sync.recordingLimitMs(null, 32_000), sync.RECORDING_MAX_MS);
  // 10 MB left at 32 kbit/s: about 40 minutes.
  const ms = sync.recordingLimitMs(10 * 1024 * 1024, 32_000);
  assert.ok(ms > 35 * 60_000 && ms < 45 * 60_000, String(ms));
  assert.equal(sync.roomTooSmall(100_000, 32_000), true);
  assert.equal(sync.roomTooSmall(null, 32_000), false);
  assert.equal(sync.formatClock(7_900), "0:07");
  assert.equal(sync.formatClock(754_000), "12:34");
  assert.equal(sync.formatClock(3_723_000), "1:02:03");
  assert.deepEqual(sync.nextUploadRange(0, 10, 4), { start: 0, end: 4 });
  assert.deepEqual(sync.nextUploadRange(8, 10, 4), { start: 8, end: 10 });
  assert.equal(sync.nextUploadRange(10, 10, 4), null);
  assert.equal(sync.cleanRecordingName("  a/b\u0000c ", "x"), "abc");
  assert.equal(sync.cleanRecordingName("", "Aufnahme"), "Aufnahme");
  // Three hours at the bit rate Safari may use fit; the server's ceiling holds.
  assert.ok(sync.RECORDING_MAX_BYTES > (3 * 3600 * 128_000) / 8);
});

test("upload in chunks, resumed and repeated, then stored as a file of the notebook", async () => {
  const pid = await create("Physik I");
  const rec = crypto.randomUUID();
  const file = webm();
  const [a, b] = [file.subarray(0, 100), file.subarray(100)];
  // Readers may not record.
  await assert.rejects(() => audio.storeRecordingChunk(viewer, pid, { recId: rec, offset: 0, type: "audio/webm" }, a), { status: 403 });
  await assert.rejects(() => audio.listRecordings(stranger, pid), (e: { status: number }) => e.status === 403 || e.status === 404);
  // Only audio that is what it claims to be.
  await assert.rejects(() => audio.storeRecordingChunk(editor, pid, { recId: rec, offset: 0, type: "audio/ogg" }, a), { status: 415 });
  await assert.rejects(() => audio.storeRecordingChunk(editor, pid, { recId: rec, offset: 0, type: "text/html" }, Buffer.from("<html>")), { status: 415 });
  // Not a notebook.
  const doc = await create("Text", "document");
  await assert.rejects(() => audio.storeRecordingChunk(editor, doc, { recId: rec, offset: 0, type: "audio/webm" }, a), { status: 400 });

  assert.deepEqual(await audio.storeRecordingChunk(editor, pid, { recId: rec, offset: 0, type: "audio/webm;codecs=opus" }, a), { size: 100 });
  // A retry of the same chunk changes nothing; a gap is refused.
  assert.deepEqual(await audio.storeRecordingChunk(editor, pid, { recId: rec, offset: 0, type: "audio/webm" }, a), { size: 100 });
  await assert.rejects(() => audio.storeRecordingChunk(editor, pid, { recId: rec, offset: 150, type: "audio/webm" }, b), { status: 409 });
  // Someone else cannot write into this upload.
  await assert.rejects(() => audio.storeRecordingChunk(owner, pid, { recId: rec, offset: 100, type: "audio/webm" }, b), { status: 403 });
  // After a reload: ask, go on from there.
  assert.equal((await audio.recordingUploadStatus(editor, pid, rec)).size, 100);
  assert.deepEqual(await audio.storeRecordingChunk(editor, pid, { recId: rec, offset: 100, type: "audio/webm" }, b), { size: file.length });

  // Length checks.
  await assert.rejects(() => audio.finishRecording(editor, pid, { recId: rec, name: "VL 1", durationMs: sync.RECORDING_MAX_MS + 60_000 }), { status: 413 });
  await assert.rejects(() => audio.finishRecording(editor, pid, { recId: rec, name: "VL 1", durationMs: 100 }), { status: 400 });
  const { recording } = await audio.finishRecording(editor, pid, { recId: rec, name: "Vorlesung 1", durationMs: 61_500 });
  assert.equal(recording.id, rec);
  assert.equal(recording.mime, "audio/webm");
  assert.equal(recording.durationMs, 61_500);
  assert.equal(recording.createdByName, "au-editor");
  const stored = readFileSync(resolve(process.env.FLOWPLAN_DATA_DIR!, "uploads", recording.fileId));
  assert.equal(Math.round(webmDurationMs(stored)!), 61_500, "the file knows its length");
  assert.equal(recording.size, stored.length);
  const row = await one<{ name: string; page_id: string; created_by: string }>("SELECT name,page_id,created_by FROM files WHERE id=?", recording.fileId);
  assert.deepEqual(row, { name: "Vorlesung 1.webm", page_id: pid, created_by: editor.id });
  // The staging is gone; a repeated "finish" answers the same.
  assert.equal(existsSync(resolve(process.env.FLOWPLAN_DATA_DIR!, "tmp", "notebook-audio", rec)), false);
  assert.equal((await audio.finishRecording(editor, pid, { recId: rec, name: "x", durationMs: 61_500 })).recording.fileId, recording.fileId);
  assert.equal((await audio.recordingUploadStatus(editor, pid, rec)).finished, true);
  await assert.rejects(() => audio.storeRecordingChunk(editor, pid, { recId: rec, offset: 0, type: "audio/webm" }, a), { status: 409 });

  // Readers list and play it.
  const listed = await audio.listRecordings(viewer, pid);
  assert.equal(listed.canEdit, false);
  assert.deepEqual(listed.recordings.map((r) => r.name), ["Vorlesung 1"]);
  assert.equal((await audio.listRecordings(editor, pid)).canEdit, true);
  const page = (await one<Page>("SELECT * FROM pages WHERE id=?", pid))!;
  const ranged = await fileResponse(new Request("http://localhost", { headers: { range: "bytes=10-19" } }), { id: recording.fileId, name: "a.webm", mime: "audio/webm" });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get("content-type"), "audio/webm");
  assert.equal(ranged.headers.get("content-range"), `bytes 10-19/${stored.length}`);
  assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), stored.subarray(10, 20));
  const whole = await fileResponse(new Request("http://localhost", { headers: { range: "bytes=0-" } }), { id: recording.fileId, name: "a.webm", mime: "audio/webm" });
  assert.equal(whole.status, 206);
  assert.deepEqual(Buffer.from(await whole.arrayBuffer()), stored);
  // The file counts as used (not "unused" in the media library).
  assert.ok((await usedFileIds(page.workspace_id, [recording.fileId])).has(recording.fileId));

  // Rename: the file's name follows.
  const renamed = await audio.renameRecording(editor, pid, rec, "  Vorlesung 1 – Mechanik ");
  assert.equal(renamed.recording.name, "Vorlesung 1 – Mechanik");
  assert.equal((await one<{ name: string }>("SELECT name FROM files WHERE id=?", recording.fileId))?.name, "Vorlesung 1 – Mechanik.webm");
  await assert.rejects(() => audio.renameRecording(viewer, pid, rec, "x"), { status: 403 });

  // Locked pages and encrypted spaces take no recordings.
  await run("UPDATE pages SET locked=1 WHERE id=?", pid);
  await assert.rejects(() => audio.storeRecordingChunk(editor, pid, { recId: crypto.randomUUID(), offset: 0, type: "audio/webm" }, a), { status: 409 });
  assert.equal((await audio.listRecordings(editor, pid)).canEdit, false);
  await run("UPDATE pages SET locked=0 WHERE id=?", pid);

  // Delete: into the trash with the file; restoring the file brings it back.
  await assert.rejects(() => audio.deleteRecording(viewer, pid, rec), { status: 403 });
  await audio.deleteRecording(editor, pid, rec);
  assert.equal((await audio.listRecordings(viewer, pid)).recordings.length, 0);
  assert.ok((await one<{ deleted_at: string | null }>("SELECT deleted_at FROM files WHERE id=?", recording.fileId))?.deleted_at);
  await run("UPDATE files SET deleted_at=NULL,deleted_by=NULL WHERE id=?", recording.fileId);
  assert.equal((await audio.listRecordings(viewer, pid)).recordings.length, 1);
  // Deleted for good: the recording goes with its file.
  await run("DELETE FROM files WHERE id=?", recording.fileId);
  assert.equal(await one("SELECT 1 FROM notebook_recordings WHERE id=?", rec), undefined);
});

test("limits on the server: size for the length, quota before and at the end, discard", async () => {
  const pid = await create("Seminar");
  const rec = crypto.randomUUID();
  const file = Buffer.concat([webm(), Buffer.alloc(3 * 1024 * 1024, 1)]);
  await audio.storeRecordingChunk(owner, pid, { recId: rec, offset: 0, type: "audio/webm" }, file);
  // 3 MB for one second is not a recording of that length.
  await assert.rejects(() => audio.finishRecording(owner, pid, { recId: rec, durationMs: 1000 }), { status: 413 });
  // Quota too small: refused, the upload stays for a later try.
  await setWorkspaceQuota(wid, 1);
  await assert.rejects(() => audio.finishRecording(owner, pid, { recId: rec, durationMs: 600_000 }), { status: 413 });
  assert.equal((await audio.recordingUploadStatus(owner, pid, rec)).size, file.length);
  // New chunks beyond the room are refused at once.
  const other = crypto.randomUUID();
  await assert.rejects(() => audio.storeRecordingChunk(owner, pid, { recId: other, offset: 0, type: "audio/webm" }, file), { status: 413 });
  assert.ok((await audio.listRecordings(owner, pid)).room! <= 1024 * 1024);
  await setWorkspaceQuota(wid, null);
  assert.equal((await audio.listRecordings(owner, pid)).room, null);
  const done = await audio.finishRecording(owner, pid, { recId: rec, durationMs: 600_000, name: "" });
  assert.equal(done.recording.name, "Aufnahme");
  // Discarding an upload removes it.
  const dropped = crypto.randomUUID();
  await audio.storeRecordingChunk(owner, pid, { recId: dropped, offset: 0, type: "audio/webm" }, webm());
  await audio.discardRecordingUpload(owner, pid, dropped);
  assert.equal((await audio.recordingUploadStatus(owner, pid, dropped)).size, 0);
  // Old staging goes after a week.
  const old = crypto.randomUUID();
  await audio.storeRecordingChunk(owner, pid, { recId: old, offset: 0, type: "audio/webm" }, webm());
  await audio.sweepRecordingUploads(Date.now() + audio.STAGING_TTL_MS + 60_000, true);
  assert.equal(existsSync(resolve(process.env.FLOWPLAN_DATA_DIR!, "tmp", "notebook-audio", old)), false);
});

test("a notebook in a journal behind a PIN: recordings only once unlocked", async () => {
  const journal = ((await command(owner, { action: "page.create", workspaceId: wid, spaceId: team, title: "Tagebuch", kind: "journal" })) as { id: string }).id;
  const pid = ((await command(owner, { action: "page.create", workspaceId: wid, spaceId: team, title: "Heft im Journal", kind: "notebook", parentId: journal })) as { id: string }).id;
  assert.ok(await audio.listRecordings(owner, pid));
  await command(owner, { action: "journal.lock", pageId: journal, pin: "471108" });
  await command(owner, { action: "journal.relock", pageId: journal });
  await assert.rejects(() => audio.listRecordings(owner, pid), { status: 423 });
  await assert.rejects(() => audio.storeRecordingChunk(owner, pid, { recId: crypto.randomUUID(), offset: 0, type: "audio/webm" }, webm()), { status: 423 });
});

test("copies, archives and exports carry the recordings; ink keeps pointing at them", async () => {
  const pid = await create("Labor");
  const rec = crypto.randomUUID();
  await audio.storeRecordingChunk(owner, pid, { recId: rec, offset: 0, type: "audio/webm" }, webm());
  const { recording } = await audio.finishRecording(owner, pid, { recId: rec, name: "Messung", durationMs: 30_000 });
  const [sheet] = await notebookSheets(pid);
  const marked = { id: "m1", type: "pen" as const, color: "#1f1f1f", width: 1.6, points: [1, 1, 0.5, 5, 5, 0.5], rec: { id: rec, t: 12_000 } };
  await store.writeSurface(pid, sheet.id, withPage(emptyInk(), sheet.id, [marked]), "", owner.id);
  assert.deepEqual((await store.readPageInk(owner, pid, sheet.id)).doc.pages[sheet.id][0].rec, { id: rec, t: 12_000 });

  // Duplicate: the copy has its own file, the same recording id.
  const page = (await one<Page>("SELECT * FROM pages WHERE id=?", pid))!;
  const copy = ((await command(owner, { action: "page.duplicate", pageId: pid })) as { id?: string }).id ?? (await duplicatePageTree(owner, page)).id;
  const copied = (await audio.listRecordings(owner, copy)).recordings;
  assert.equal(copied.length, 1);
  assert.equal(copied[0].id, rec);
  assert.notEqual(copied[0].fileId, recording.fileId);
  const [copySheet] = await notebookSheets(copy);
  assert.equal((await store.readPageInk(owner, copy, copySheet.id)).doc.pages[copySheet.id][0].rec?.id, rec);

  // Archive: the recording names its file; restored with the file map.
  const archive = await notebookArchive(pid);
  assert.deepEqual(archive.recordings?.map((r) => [r.id, r.file, r.name, r.durationMs]), [[rec, recording.fileId, "Messung", 30_000]]);
  const target = await create("Import");
  const fid = id();
  await run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", fid, target, "Messung.webm", "audio/webm", 10, owner.id);
  await importNotebook(target, JSON.parse(JSON.stringify(archive)), new Map([[recording.fileId, fid]]), owner.id);
  assert.deepEqual((await audio.listRecordings(owner, target)).recordings.map((r) => [r.id, r.fileId]), [[rec, fid]]);
  // Without the file (a template): no recording.
  const bare = await create("Vorlage");
  await importNotebook(bare, JSON.parse(JSON.stringify(archive)), new Map(), owner.id);
  assert.equal((await audio.listRecordings(owner, bare)).recordings.length, 0);

  // Markdown ZIP: the audio next to the notebook, linked from it.
  const exported = await exportMarkdown(owner, { pageId: pid, format: "zip", includeSubpages: false });
  const zip = await readExportZip(exported.bytes);
  const index = zip.get("index.md")!.toString();
  assert.match(index, /## (Aufnahmen|Recordings)/);
  assert.match(index, /Messung \(0:30\)/);
  assert.ok([...zip.keys()].some((k) => k.startsWith("assets/") && k.endsWith("Messung.webm")));
});

test("a workspace archive brings notebooks back with their recordings", async () => {
  const { exportArchive, importArchive } = await import("../lib/archive");
  const space = await createWorkspace(owner.id, "Archiv-Hefte");
  const spaceId = (await bootstrap(owner, space)).spaces[0].id;
  const pid = ((await command(owner, { action: "page.create", workspaceId: space, spaceId, title: "Kurs", kind: "notebook" })) as { id: string }).id;
  const rec = crypto.randomUUID();
  await audio.storeRecordingChunk(owner, pid, { recId: rec, offset: 0, type: "audio/webm" }, webm());
  await audio.finishRecording(owner, pid, { recId: rec, name: "Kurs 1", durationMs: 5000 });
  const destination = await createWorkspace(owner.id, "Wiederhergestellt");
  await importArchive(owner, destination, await exportArchive(owner, space));
  const restored = await one<{ id: string }>("SELECT id FROM pages WHERE workspace_id=? AND kind='notebook' AND title='Kurs'", destination);
  const list = (await audio.listRecordings(owner, restored!.id)).recordings;
  assert.deepEqual(list.map((r) => [r.id, r.name, r.durationMs]), [[rec, "Kurs 1", 5000]]);
  assert.equal(Math.round(webmDurationMs(readFileSync(resolve(process.env.FLOWPLAN_DATA_DIR!, "uploads", list[0].fileId)))!), 5000);
});

test("marks on every kind of item; copies into another notebook and stickers drop them, deleting a sheet keeps the recording", async () => {
  // Shapes, turned text and pictures keep their mark when stored.
  const rec = { id: "r-9", t: 2500 };
  const shape = cleanItem({ id: "sh", type: "pen", color: "#1f1f1f", width: 1.6, points: [0, 0, 0.5, 10, 10, 0.5], shape: { kind: "rect", box: [5, 5, 10, 10, 0] }, rec })!;
  assert.equal(shape.type === "pen" && !!shape.shape, true);
  assert.deepEqual(shape.rec, rec);
  const turned = cleanItem({ id: "tx", type: "text", color: "#1f1f1f", size: 12, x: 1, y: 1, text: "Hi", rotation: 30, rec })!;
  assert.equal(turned.type === "text" && turned.rotation, 30);
  assert.deepEqual(turned.rec, rec);
  const picture = cleanItem({ id: "im", type: "image", x: 1, y: 1, w: 20, h: 20, sticker: "heart", rec })!;
  assert.deepEqual(picture.rec, rec);
  // A picture inserted while recording is stamped like a stroke.
  const before = withPage(emptyInk(), "s", []);
  const stamped = sync.stampNewItems(before, withPage(before, "s", [{ ...picture, rec: undefined }]), { id: "r-10", t: 900 });
  assert.deepEqual(stamped.pages.s[0].rec, { id: "r-10", t: 900 });
  // Helpers: dropping marks, the first mark for converted handwriting.
  const plain = sync.withoutRec([shape, turned, picture]);
  assert.ok(plain.every((i) => !("rec" in i)));
  assert.deepEqual(sync.firstRec([cleanItem({ id: "x", type: "pen", color: "#1f1f1f", width: 1, points: [1, 1, 0.5] })!, shape]), { rec });
  assert.deepEqual(sync.firstRec([]), {});

  // A notebook with a recording and marked ink on two sheets.
  const pid = await create("Seminar");
  const recId = crypto.randomUUID();
  await audio.storeRecordingChunk(owner, pid, { recId, offset: 0, type: "audio/webm" }, webm());
  await audio.finishRecording(owner, pid, { recId, name: "Sitzung", durationMs: 20_000 });
  await command(owner, { action: "notebook.sheet.add", pageId: pid });
  const sheets = await notebookSheets(pid);
  assert.equal(sheets.length, 2);
  for (const s of sheets) await store.writeSurface(pid, s.id, withPage(emptyInk(), s.id, [{ ...shape, id: `m-${s.id.slice(0, 4)}`, rec: { id: recId, t: 3000 } }]), "", owner.id);
  // Copied into another notebook: the ink comes, its marks do not.
  const other = await create("Anderes");
  await command(owner, { action: "notebook.sheets.transfer", pageId: pid, targetPageId: other, sheetIds: [sheets[1].id], mode: "copy", after: null });
  const otherSheets = await notebookSheets(other);
  const copiedItems = (await store.readPageInk(owner, other, otherSheets[otherSheets.length - 1].id)).doc.pages[otherSheets[otherSheets.length - 1].id];
  assert.equal(copiedItems.length, 1);
  assert.equal(copiedItems[0].rec, undefined);
  assert.equal((await audio.listRecordings(owner, other)).recordings.length, 0);
  // The source keeps its marks and the recording.
  assert.equal((await store.readPageInk(owner, pid, sheets[1].id)).doc.pages[sheets[1].id][0].rec?.id, recId);
  // Deleting a sheet (into the notebook's trash) leaves the recording.
  await command(owner, { action: "notebook.sheets.delete", pageId: pid, sheetIds: [sheets[1].id] });
  assert.equal((await audio.listRecordings(owner, pid)).recordings.length, 1);
  // A selection saved as a sticker carries no marks.
  const { stickerInk } = await import("../lib/notebook-library");
  assert.ok(stickerInk([shape, turned]).items.every((i) => !i.rec));
});
