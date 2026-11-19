// S3_LOCAL_CACHE (#389, lib/storage.ts): with S3 on, the uploads folder is a
// bounded cache – the least recently used files confirmed in the bucket
// leave it, every reader fetches them back on demand, the background
// restore does not refill them, and whole-instance copies (instance backup,
// SFTP mirror, move) read them from the bucket without caching them.
// Runs on SQLite and on PostgreSQL (DATABASE_URL), against an S3 stand-in.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createWriteStream, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import { startFakeS3 } from "./helpers/fake-s3";
import { startSftpServer } from "./helpers/sftp-server";

const s3 = await startFakeS3();
const dir = mkdtempSync(join(tmpdir(), "flowplan-local-cache-"));
process.env.FLOWPLAN_DATA_DIR = dir;
process.env.S3_ENDPOINT = s3.endpoint;
process.env.S3_BUCKET = "bucket";
process.env.S3_ACCESS_KEY_ID = "key";
process.env.S3_SECRET_ACCESS_KEY = "secret";
// Large enough that the automatic rounds leave the test alone; the tests
// call the round with their own limit.
process.env.S3_LOCAL_CACHE = "1GB";
process.env.FLOWPLAN_OCR = "0";
process.env.FLOWPLAN_BACKUP_FORMAT = "sqlite";
process.env.FLOWPLAN_METRICS_TOKEN = "metrics-token-0123456789";
delete process.env.FLOWPLAN_CLUSTER;
delete process.env.FLOWPLAN_ENCRYPTION_KEY;
const { run, id, one } = await import("../lib/db");
const storage = await import("../lib/storage");
const { storeUpload } = await import("../lib/page-upload");
const { createWorkspace, createPage } = await import("../lib/seed");
const { fileResponse } = await import("../lib/file-response");
const { backfillPlaceholder } = await import("../lib/image-placeholders");
const { extractPendingFileTexts } = await import("../lib/file-text");
const { instanceBackupStream } = await import("../lib/instance-backup");
const { serveMoveUpload } = await import("../lib/instance-move");
const sftp = await import("../lib/sftp-backup");
const { storageOverview } = await import("../lib/storage-overview");
const healthRoute = await import("../app/api/health/handler");
import type { Identity } from "../lib/types";

const uid = id();
await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, "Kim", "kim@example.test");
const user = { id: uid, name: "Kim", email: "kim@example.test", groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
const workspace = await createWorkspace(uid, "Cache");
const space = String((await one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", workspace))!.id);
const pageId = await createPage(workspace, space, uid, "Dateien");
const page = { id: pageId, workspace_id: workspace };
const uploads = join(dir, "uploads");
const object = (key: string) => `/bucket/flowplan/uploads/${key}`;
const here = (key: string) => existsSync(join(uploads, key));
const until = async (check: () => boolean | Promise<boolean>, label: string) => {
  for (let i = 0; i < 500; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail(`timed out: ${label}`);
};
const remote = mkdtempSync(join(tmpdir(), "flowplan-local-cache-sftp-"));
const server = await startSftpServer(remote, { user: "backup", password: "richtig-geheim" });
after(() => server.close());
const HOUR = 3_600_000;
const old = Date.now() - 5 * HOUR;
const age = (key: string, at: number) => utimesSync(join(uploads, key), at / 1000, at / 1000);
// Stored as a request does; returns once the queue has it in the bucket.
const stored = async (content: Buffer, name = "f.bin", mime = "application/octet-stream") => {
  const fid = id();
  await storeUpload(user, page, { id: fid, name, mime, content });
  await until(async () => !!(await one("SELECT 1 FROM storage_sealed WHERE key=?", fid)) && !(await one("SELECT 1 FROM storage_queue WHERE key=?", fid)), `${name} uploaded`);
  return fid;
};
const localBytes = () => readdirSync(uploads).filter(storage.validKey).reduce((sum, name) => sum + statSync(join(uploads, name)).size, 0);
// Leaves exactly this file to the round: the others count as just used.
const evictOnly = async (key: string) => {
  const now = Date.now();
  for (const name of readdirSync(uploads).filter(storage.validKey)) age(name, name === key ? old : now);
  const result = await storage.pruneUploadCache(now, 1);
  assert.equal(here(key), false, "evicted");
  return result;
};

test("S3_LOCAL_CACHE: sizes, the cluster's limit as fallback, only with a bucket", () => {
  assert.equal(storage.parseCacheSize("2GB"), 2 * 1024 ** 3);
  assert.equal(storage.parseCacheSize("500MB"), 500 * 1024 ** 2);
  assert.equal(storage.parseCacheSize(" 1.5 GiB "), 1.5 * 1024 ** 3);
  assert.equal(storage.parseCacheSize("750kb"), 750 * 1024);
  assert.equal(storage.parseCacheSize("1t"), 1024 ** 4);
  assert.equal(storage.parseCacheSize(""), 0);
  assert.equal(storage.parseCacheSize(undefined), 0);
  assert.equal(storage.parseCacheSize("0"), 0);
  for (const wrong of ["12", "zwei GB", "-1GB", "1 PB", "1KiBB"]) assert.equal(storage.parseCacheSize(wrong), null, wrong);
  assert.equal(storage.cacheLimitBytes({ S3_LOCAL_CACHE: "2GB" }), 2 * 1024 ** 3);
  assert.equal(storage.cacheLimitBytes({ S3_LOCAL_CACHE: "" }), 0);
  assert.equal(storage.cacheLimitBytes({ FLOWPLAN_CACHE_MAX_MB: "100" }), 0, "FLOWPLAN_CACHE_MAX_MB only in cluster mode");
  assert.equal(storage.cacheLimitBytes({ FLOWPLAN_CLUSTER: "1", FLOWPLAN_CACHE_MAX_MB: "100" }), 100 * 1024 ** 2);
  assert.equal(storage.cacheLimitBytes({ FLOWPLAN_CLUSTER: "1", FLOWPLAN_CACHE_MAX_MB: "100", S3_LOCAL_CACHE: "1GB" }), 1024 ** 3);
  assert.equal(storage.localCacheMode({ S3_LOCAL_CACHE: "2GB" }), false, "ignored without S3");
  assert.equal(storage.localCacheMode({ S3_BUCKET: "b" }), false, "everything stays local");
  assert.equal(storage.localCacheMode({ S3_BUCKET: "b", S3_LOCAL_CACHE: "2GB" }), true);
  assert.equal(storage.localCacheMode({ S3_BUCKET: "b", S3_LOCAL_CACHE: "viel" }), false, "not understood: ignored");
  assert.equal(storage.localCacheMode({ S3_BUCKET: "b", FLOWPLAN_CLUSTER: "1" }), true);
});

const files: Record<string, string> = {};
test("least recently used first – and only files confirmed in the bucket", async () => {
  for (const name of ["a", "b", "c", "d", "unconfirmed", "wrongSize", "vanished", "queued"]) files[name] = await stored(randomBytes(100_000), `${name}.bin`);
  // Not confirmed: no upload record (as if the upload never finished).
  await run("DELETE FROM storage_sealed WHERE key=?", files.unconfirmed);
  // The object in the bucket is not this file.
  s3.objects.get(object(files.wrongSize))!.body = randomBytes(99_000);
  // Gone from the bucket although uploaded: queued again, kept here.
  s3.objects.delete(object(files.vanished));
  // A job of the queue still due for it.
  await run("INSERT INTO storage_queue(key,op,next_at) VALUES(?,?,?)", files.queued, "put", Date.now() + HOUR);
  const recent = await stored(randomBytes(100_000), "neu.bin");
  ["unconfirmed", "wrongSize", "vanished", "queued", "a", "b", "c", "d"].forEach((name, i) => age(files[name], old + i * 1000));
  age(recent, Date.now());
  const total = localBytes();
  // 0.8 of the limit is the goal: two files have to go.
  const limit = Math.ceil((total - 200_000) / 0.8);
  const pruned = await storage.pruneUploadCache(Date.now(), limit);
  assert.deepEqual(pruned, { removed: 2, bytes: 200_000 });
  assert.equal(here(files.a), false, "the least recently used went");
  assert.equal(here(files.b), false);
  for (const name of ["c", "d", "unconfirmed", "wrongSize", "vanished", "queued"]) assert.equal(here(files[name]), true, name);
  assert.equal(here(recent), true, "used just now");
  // The vanished one is uploaded again.
  await until(() => s3.objects.has(object(files.vanished)) && s3.requests.filter((r) => r === `PUT ${object(files.vanished)}`).length === 2, "vanished file uploaded again");
  await run("DELETE FROM storage_queue WHERE key=?", files.queued);
  // Kept out of the next test's order.
  age(files.queued, Date.now());
  age(files.vanished, Date.now());
  // Never the database.
  assert.ok(readdirSync(dir).includes("flowplan.sqlite") || !!process.env.DATABASE_URL);
});

test("reading a file moves it to the end of the order (kept across restarts as mtime)", async () => {
  assert.equal((await storage.readUpload(files.c))?.length, 100_000);
  // A temporary download left by a process that ended while reading.
  const leftover = join(uploads, `${files.c}.0123456789ab.read`);
  writeFileSync(leftover, "halb");
  utimesSync(leftover, old / 1000, old / 1000);
  // Over the limit with c and d the only candidates (the rest is recent or
  // not confirmed): c was just read, so d goes.
  const pruned = await storage.pruneUploadCache(Date.now(), 1);
  assert.equal(pruned.removed, 1);
  assert.equal(here(files.c), true, "just read");
  assert.equal(here(files.d), false, "not read since – it went instead");
  assert.ok(Date.now() - statSync(join(uploads, files.c)).mtimeMs < 60_000, "the use was written as mtime");
  assert.equal(existsSync(leftover), false, "leftover temporary file removed");
});

test("evicted files come back on demand: download, image placeholder, PDF text", async () => {
  // Read again: from the bucket, into the cache.
  assert.equal((await storage.readUpload(files.a))?.length, 100_000);
  assert.equal(here(files.a), true);
  // A download (GET /api/files/…).
  const response = await fileResponse(new Request("https://flowplan.example.test/api/files/x"), { id: files.b, name: "b.bin", mime: "application/octet-stream" });
  assert.equal(response.status, 200);
  assert.equal(Buffer.from(await response.arrayBuffer()).length, 100_000);
  // The placeholder of an image computed after it left the cache.
  const photo = await stored(readFileSync(join(import.meta.dirname, "fixtures", "images", "photo.png")), "photo.png", "image/png");
  await run("UPDATE files SET thumbhash=NULL WHERE id=?", photo);
  await evictOnly(photo);
  await backfillPlaceholder(photo);
  assert.ok((await one<{ thumbhash: string | null }>("SELECT thumbhash FROM files WHERE id=?", photo))?.thumbhash, "placeholder computed");
  // The search text of a PDF extracted after it left the cache.
  const pdf = await stored(minimalPdf("Lieferschein Nummer 4711 vom Lager"), "lieferschein.pdf", "application/pdf");
  await evictOnly(pdf);
  await extractPendingFileTexts(20);
  assert.match(String((await one<{ text: string }>("SELECT text FROM file_texts WHERE file_id=?", pdf))?.text), /Lieferschein Nummer 4711/);
});

test("the background restore at startup does not refill evicted files", async () => {
  const fid = await stored(randomBytes(50_000), "später.bin");
  await evictOnly(fid);
  storage.stopStorage();
  await storage.setupStorage();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(here(fid), false, "stays in the bucket only");
  // Without the cache limit everything comes back (as before #389).
  delete process.env.S3_LOCAL_CACHE;
  try {
    storage.stopStorage();
    await storage.setupStorage();
    await until(() => here(fid), "restored without S3_LOCAL_CACHE");
  } finally {
    process.env.S3_LOCAL_CACHE = "1GB";
    storage.stopStorage();
    await storage.setupStorage();
  }
});

test("whole-instance copies read evicted files from the bucket, without caching them", async () => {
  const fid = await stored(Buffer.from("nur im Bucket"), "bucket.txt", "text/plain");
  await evictOnly(fid);
  assert.ok((await storage.localUploadNames()).includes(fid), "listed for backups");
  // The instance backup (ZIP).
  const zip = join(dir, `backup-${id()}.zip`);
  await pipeline(await instanceBackupStream(), createWriteStream(zip));
  assert.equal((await zipEntries(zip)).get(`uploads/${fid}`), "nur im Bucket");
  assert.equal(here(fid), false, "not put back into the cache");
  // The instance move serves it to the target.
  const served = (await serveMoveUpload(fid, null))!;
  assert.equal(await served.text(), "nur im Bucket");
  const ranged = (await serveMoveUpload(fid, "bytes=4-"))!;
  assert.equal(ranged.status, 206);
  assert.equal(await ranged.text(), "im Bucket");
  // The SFTP mirror: no "uploads folder empty" error, the file sent.
  await sftp.saveSftpBackup(uid, { enabled: true, host: "127.0.0.1", port: server.port, username: "backup", auth: "password", password: "richtig-geheim", directory: "sicherung", keep: 2, uploads: true });
  await sftp.trustSftpHostKey(uid, (await sftp.testSftpBackup()).fingerprint);
  const result = await sftp.runSftpBackup();
  assert.equal(result.error, null);
  assert.equal(readFileSync(join(remote, "sicherung/uploads", fid), "utf8"), "nur im Bucket");
  assert.equal(here(fid), false, "still only in the bucket");
  assert.deepEqual(readdirSync(uploads).filter((name) => !storage.validKey(name)), [], "no temporary files left");
});

test("Admin → Storage & backup and /api/health show the cache", async () => {
  await storage.pruneUploadCache(Date.now(), 1024 ** 3);
  const sealed = (await one<{ n: number }>("SELECT COUNT(*) n FROM files f JOIN storage_sealed s ON s.key=f.id"))!;
  const onlyThere = (await import("../lib/db")).all<{ id: string; size: number }>("SELECT f.id,f.size FROM files f JOIN storage_sealed s ON s.key=f.id");
  const missing = (await onlyThere).filter((f) => !here(String(f.id)));
  assert.ok(missing.length >= 1 && missing.length < Number(sealed.n), JSON.stringify([missing.length, sealed.n]));
  const overview = await storageOverview();
  assert.ok(overview.objectStorage.enabled);
  const cache = overview.objectStorage.enabled ? overview.objectStorage.cache : null;
  assert.deepEqual(
    { limit: cache?.limitBytes, bytes: cache?.bytes, files: cache?.onlyInBucketFiles, remote: cache?.onlyInBucketBytes },
    { limit: 1024 ** 3, bytes: localBytes(), files: missing.length, remote: missing.reduce((sum, f) => sum + Number(f.size), 0) },
  );
  const health = await healthRoute.GET(new Request("https://flowplan.example.test/api/health", { headers: { authorization: "Bearer metrics-token-0123456789" } }));
  const body = (await health.json()) as { objectStorage: { localCache?: { limitBytes: number; onlyInBucketFiles: number; bytes: number } } };
  assert.deepEqual(
    [body.objectStorage.localCache?.limitBytes, body.objectStorage.localCache?.onlyInBucketFiles, body.objectStorage.localCache?.bytes],
    [1024 ** 3, missing.length, localBytes()],
  );
});

// ---- helpers ----

// A one-page PDF with a line of text (valid cross-reference table).
function minimalPdf(text: string) {
  const content = `BT /F1 18 Tf 50 700 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
function zipEntries(path: string) {
  return new Promise<Map<string, string>>((resolve, reject) => {
    const entries = new Map<string, string>();
    yauzl.open(path, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(error);
      zip.on("entry", (entry: yauzl.Entry) => {
        if (!entry.fileName.startsWith("uploads/")) return zip.readEntry();
        zip.openReadStream(entry, (err, stream) => {
          if (err || !stream) return reject(err);
          const chunks: Buffer[] = [];
          stream.on("data", (c: Buffer) => chunks.push(c));
          stream.on("end", () => {
            entries.set(entry.fileName, Buffer.concat(chunks).toString());
            zip.readEntry();
          });
        });
      });
      zip.on("end", () => resolve(entries));
      zip.on("error", reject);
      zip.readEntry();
    });
  });
}
