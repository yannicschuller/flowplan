// Files in cluster mode (lib/storage.ts, lib/staging.ts): the bucket is the
// truth – a stored file is in it before the request answers, every reader
// goes through the storage layer, the parts of uploads that span several
// requests wait in the bucket, the local cache stays below its limit and a
// stopping instance drains its queue. One process plays "an instance";
// what another instance would see is the bucket without the local folder.
// Runs on SQLite and on PostgreSQL (DATABASE_URL), against an S3 stand-in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeS3 } from "./helpers/fake-s3";

const s3 = await startFakeS3();
const dir = mkdtempSync(join(tmpdir(), "flowplan-cluster-storage-"));
process.env.FLOWPLAN_DATA_DIR = dir;
process.env.FLOWPLAN_CLUSTER = "1";
process.env.S3_ENDPOINT = s3.endpoint;
process.env.S3_BUCKET = "bucket";
process.env.S3_ACCESS_KEY_ID = "key";
process.env.S3_SECRET_ACCESS_KEY = "secret";
process.env.FLOWPLAN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
const { run, id, one, all } = await import("../lib/db");
const storage = await import("../lib/storage");
const { staging } = await import("../lib/staging");
const { isEncrypted } = await import("../lib/encryption");
const { storeUpload } = await import("../lib/page-upload");
const { createWorkspace, createPage } = await import("../lib/seed");
const { command } = await import("../lib/api");
const audio = await import("../lib/notebook-audio");
const imports = await import("../lib/importers/upload");
import type { Identity } from "../lib/types";

const uid = id();
await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, "Kim", "kim@example.test");
const user = { id: uid, name: "Kim", email: "kim@example.test", groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
const workspace = await createWorkspace(uid, "Cluster");
const space = String((await one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", workspace))!.id);
const pageId = await createPage(workspace, space, uid, "Dateien");
const page = { id: pageId, workspace_id: workspace };
const uploads = join(dir, "uploads");
const object = (key: string) => `/bucket/flowplan/uploads/${key}`;
const puts = (key: string) => s3.requests.filter((r) => r === `PUT ${object(key)}`).length;
const until = async (check: () => boolean | Promise<boolean>, label: string) => {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail(`timed out: ${label}`);
};

test("a stored file is in the bucket when the upload answers – sealed, and uploaded once", async () => {
  const fid = id();
  await storeUpload(user, page, { id: fid, name: "a.txt", mime: "text/plain", content: Buffer.from("im Bucket") });
  // No waiting: the request answered only once the object was there.
  const stored = s3.objects.get(object(fid));
  assert.ok(stored, "in the bucket before the answer");
  assert.ok(isEncrypted(stored.body), "sealed with FLOWPLAN_ENCRYPTION_KEY");
  assert.ok(await one("SELECT 1 FROM storage_sealed WHERE key=?", fid));
  // The queue's job (from the files trigger) finds it sealed and only goes.
  storage.kickStorage();
  await until(async () => !(await one("SELECT 1 FROM storage_queue WHERE key=?", fid)), "queue job done");
  assert.equal(puts(fid), 1, "not uploaded a second time by the queue");
});

test("the bucket away: the upload fails with 503 and leaves no file and no row", async () => {
  const fid = id();
  s3.down.value = true;
  try {
    await assert.rejects(storeUpload(user, page, { id: fid, name: "b.txt", mime: "text/plain", content: Buffer.from("weg") }), { status: 503 });
  } finally {
    s3.down.value = false;
  }
  assert.equal(await one("SELECT 1 FROM files WHERE id=?", fid), undefined);
  assert.equal(existsSync(join(uploads, fid)), false);
});

test("an instance without the file reads it through the storage layer", async () => {
  const fid = id();
  await storeUpload(user, page, { id: fid, name: "c.txt", mime: "text/plain", content: Buffer.from("von nebenan") });
  // Another instance: the same bucket, not this cache.
  rmSync(join(uploads, fid));
  assert.equal((await storage.readUpload(fid))?.toString(), "von nebenan");
  rmSync(join(uploads, fid));
  assert.equal(existsSync(await storage.uploadSource(fid)), true);
  // Copies take their source from the bucket too.
  rmSync(join(uploads, fid));
  const copy = id();
  assert.equal(await storage.copyUpload(fid, copy), true);
  assert.ok(s3.objects.has(object(copy)), "the copy is published at once");
  assert.equal(await storage.readUpload(id()), null);
  // Whole-instance copies (backup, move) list every file of the table.
  rmSync(join(uploads, fid));
  assert.ok((await storage.localUploadNames()).includes(fid));
  assert.equal(existsSync(join(uploads, fid)), true);
});

test("the cache is kept below FLOWPLAN_CACHE_MAX_MB: least recently used first, recent and pending files stay", async () => {
  const old = Date.now() - 3 * 3600_000;
  const files: string[] = [];
  for (let i = 0; i < 4; i++) {
    const fid = id();
    await storeUpload(user, page, { id: fid, name: `${i}.bin`, mime: "application/octet-stream", content: randomBytes(100_000) });
    utimesSync(join(uploads, fid), (old + i * 1000) / 1000, (old + i * 1000) / 1000);
    files.push(fid);
  }
  const recent = id();
  await storeUpload(user, page, { id: recent, name: "neu.bin", mime: "application/octet-stream", content: randomBytes(100_000) });
  // A file only this instance has (its job still due) stays as well.
  const pending = id();
  writeFileSync(join(uploads, pending), randomBytes(100_000));
  utimesSync(join(uploads, pending), old / 1000, old / 1000);
  await run("INSERT INTO storage_queue(key,op,next_at) VALUES(?,?,?) ON CONFLICT(key) DO NOTHING", pending, "put", Date.now() + 3600_000);
  const total = readdirSync(uploads).reduce((sum, name) => sum + statSync(join(uploads, name)).size, 0);
  const limit = total - 150_000;
  const pruned = await storage.pruneUploadCache(Date.now(), limit);
  assert.ok(pruned.removed >= 2, `removed ${pruned.removed}`);
  assert.equal(existsSync(join(uploads, files[0])), false, "the oldest went");
  assert.equal(existsSync(join(uploads, recent)), true, "used in the last 30 minutes");
  assert.equal(existsSync(join(uploads, pending)), true, "not yet in the bucket");
  // Gone from the cache, not from the installation.
  assert.equal((await storage.readUpload(files[0]))?.length, 100_000);
  await run("DELETE FROM storage_queue WHERE key=?", pending);
  rmSync(join(uploads, pending));
});

test("a stopping instance drains the due queue before it ends", async () => {
  // Written outside the storage layer (an older code path): only the queue
  // would upload it, in the background.
  const fid = id();
  s3.failing.add(fid);
  writeFileSync(join(uploads, fid), "zum Schluss");
  await run("INSERT INTO files(id,page_id,name,mime,size) VALUES(?,?,?,?,?)", fid, pageId, "d.txt", "text/plain", 11);
  storage.kickStorage();
  await until(async () => Number((await one<{ attempts: number }>("SELECT attempts FROM storage_queue WHERE key=?", fid))?.attempts) > 0, "first try failed");
  s3.failing.delete(fid);
  await run("UPDATE storage_queue SET next_at=0 WHERE key=?", fid);
  await storage.flushStorage(Date.now() + 5000);
  assert.ok(s3.objects.has(object(fid)), "uploaded during the shutdown");
  assert.equal(await one("SELECT 1 FROM storage_queue WHERE key=?", fid), undefined);
});

test("staging in the bucket: parts sealed, listed with their plain size, removed by folder", async () => {
  const parts = staging("probe");
  assert.equal(parts.where, "bucket");
  await parts.put("a/0", Buffer.from("eins"));
  await parts.put("a/1", Buffer.from("zwei!"));
  await parts.put("a/sub/x", Buffer.from("x"));
  await parts.put("b/0", Buffer.from("drei"));
  const raw = s3.objects.get("/bucket/flowplan/tmp/probe/a/0")!;
  assert.ok(isEncrypted(raw.body), "sealed in the bucket");
  assert.equal((await parts.get("a/1"))?.toString(), "zwei!");
  assert.deepEqual((await parts.list("a")).map((o) => [o.name, o.size]), [["0", 4], ["1", 5]]);
  assert.deepEqual((await parts.folders("")).map((f) => [f.name, f.size]).sort(), [["a", 10], ["b", 4]]);
  assert.equal((await parts.walk("a")).length, 3);
  await parts.remove("a");
  assert.deepEqual((await parts.folders("")).map((f) => f.name), ["b"]);
  assert.equal(await parts.get("a/0"), null);
  assert.throws(() => staging("../x"), /Ungültiger Pfad/);
  await assert.rejects(parts.put("../../uploads/x", Buffer.from("x")), /Ungültiger Pfad/);
  await parts.remove("");
  // Nothing of it in the data folder.
  assert.equal(existsSync(join(dir, "tmp", "probe")), false);
});

test("a notebook recording in chunks across instances: every chunk in the bucket, the file published when finished", async () => {
  const notebook = ((await command(user, { action: "page.create", workspaceId: workspace, spaceId: space, title: "Heft", kind: "notebook" })) as { id: string }).id;
  const rec = randomUUID();
  const head = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypM4A "), Buffer.alloc(12)]);
  const file = Buffer.concat([head, randomBytes(4000)]);
  await audio.storeRecordingChunk(user, notebook, { recId: rec, offset: 0, type: "audio/mp4" }, file.subarray(0, 1500));
  // A retry from inside the first chunk (the answer was lost) …
  await audio.storeRecordingChunk(user, notebook, { recId: rec, offset: 1000, type: "audio/mp4" }, file.subarray(1000, 3000));
  // … and the rest, as if on another instance: nothing local holds state.
  assert.equal(existsSync(join(dir, "tmp", "notebook-audio", rec)), false, "no local staging in cluster mode");
  await audio.storeRecordingChunk(user, notebook, { recId: rec, offset: 3000, type: "audio/mp4" }, file.subarray(3000));
  assert.equal((await audio.recordingUploadStatus(user, notebook, rec)).size, file.length);
  const done = await audio.finishRecording(user, notebook, { recId: rec, durationMs: 2000 });
  const stored = s3.objects.get(object(done.recording.fileId));
  assert.ok(stored, "the recording's file is in the bucket at once");
  rmSync(join(uploads, done.recording.fileId));
  assert.deepEqual(await storage.readUpload(done.recording.fileId), file, "put together in order, the retry's overlap once");
  assert.deepEqual((await staging("notebook-audio").folders("")).map((f) => f.name).includes(rec), false, "staging removed");
});

test("an import kept between preview and import: another instance fetches it from the bucket", async () => {
  const bytes = randomBytes(200_000);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
  const saved = await imports.saveImportUpload(uid, body, bytes.length, () => imports.importTooLarge(1, null));
  // The other instance has no local copy.
  rmSync(join(dir, "tmp", "imports"), { recursive: true, force: true });
  const path = await imports.importUploadFile(uid, saved.id);
  assert.deepEqual(await import("node:fs").then((fs) => fs.readFileSync(path)), bytes);
  await assert.rejects(imports.importUploadFile(uid, randomUUID()), { status: 410 });
  imports.discardImportUpload(uid, saved.id);
  await until(async () => !(await staging("imports").folders("")).length, "staged import removed");
});

test("every file that is read goes through the storage layer (no direct reads of the uploads folder)", async () => {
  // Paths into data/uploads may only be built for writing or by the
  // storage layer itself; readers use localUpload/readUpload/uploadSource.
  const { readFileSync } = await import("node:fs");
  const root = join(import.meta.dirname, "..");
  const offenders: string[] = [];
  const walk = (folder: string) => {
    for (const entry of readdirSync(join(root, folder), { withFileTypes: true })) {
      const rel = `${folder}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(entry.name)) {
        const text = readFileSync(join(root, rel), "utf8");
        // A read of a file below "uploads" built from FLOWPLAN_DATA_DIR in one expression.
        if (/(readFileSync|readFile|createReadStream|open)\(\s*resolve\(\s*(process\.env\.FLOWPLAN_DATA_DIR[^,]*|dataDir\(\)),\s*"uploads"/.test(text)) offenders.push(rel);
      }
    }
  };
  walk("lib");
  walk("app");
  assert.deepEqual(offenders, []);
  assert.ok((await all("SELECT id FROM files")).length > 0);
});
