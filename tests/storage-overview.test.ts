import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// S3 stand-in that answers ListObjectsV2 with a fixed listing.
let listing: { key: string; size: number; modified: string }[] = [];
let broken = false;
const server = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    if (broken) return void res.writeHead(403).end("<Error><Code>AccessDenied</Code></Error>");
    if (req.method === "GET" && req.url?.includes("list-type=2")) {
      const contents = listing
        .map((o) => `<Contents><Key>${o.key}</Key><LastModified>${o.modified}</LastModified><Size>${o.size}</Size></Contents>`)
        .join("");
      return void res
        .writeHead(200, { "Content-Type": "application/xml" })
        .end(`<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`);
    }
    res.writeHead(200).end();
  });
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
after(() => server.close());

const dir = mkdtempSync(join(tmpdir(), "flowplan-overview-"));
process.env.FLOWPLAN_DATA_DIR = dir;
process.env.S3_ENDPOINT = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
process.env.S3_BUCKET = "bucket";
process.env.S3_ACCESS_KEY_ID = "key";
process.env.S3_SECRET_ACCESS_KEY = "secret";
const { run, id, one } = await import("../lib/db");
const { createWorkspace, createPage } = await import("../lib/seed");
const { storageOverview } = await import("../lib/storage-overview");

const user = id();
run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", user, user, "A", "a@example.test");
const wid = createWorkspace(user, "Übersicht");
const space = String(one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", wid)!.id);
const doc = createPage(wid, space, user, "Notizen");
createPage(wid, space, user, "Tabelle", "database");
createPage(wid, space, user, "Board", "whiteboard");
mkdirSync(join(dir, "uploads"), { recursive: true });
const file = (mime: string, size: number) => {
  const fid = id();
  writeFileSync(join(dir, "uploads", fid), Buffer.alloc(size));
  run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", fid, doc, "f", mime, size, user);
  return fid;
};
const photo = file("image/png", 3000),
  clip = file("video/mp4", 9000),
  pdf = file("application/pdf", 500);

test("counts, local breakdown and the bucket by media type", async () => {
  listing = [
    { key: `flowplan/uploads/${photo}`, size: 3000, modified: "2026-09-26T10:00:00Z" },
    { key: `flowplan/uploads/${clip}`, size: 9000, modified: "2026-09-26T10:00:00Z" },
    { key: "flowplan/uploads/verwaist", size: 10, modified: "2026-09-26T10:00:00Z" },
    { key: "flowplan/db/0000/snapshot.ltx", size: 40000, modified: "2026-09-26T11:00:00Z" },
    { key: "flowplan/db/0000/wal.ltx", size: 800, modified: "2026-09-26T12:30:00Z" },
  ];
  const o = await storageOverview();
  assert.equal(o.counts.workspaces, 1);
  assert.ok(o.counts.documents >= 1);
  assert.equal(o.counts.databases, 1);
  assert.equal(o.counts.whiteboards, 1);
  assert.equal(o.counts.files, 3);
  assert.ok(o.local.databaseBytes > 0);
  assert.ok(o.local.database.length > 0, "breakdown of the SQLite file");
  const local = Object.fromEntries(o.local.uploads.byType.map((m) => [m.key, m]));
  assert.equal(local.images.bytes, 3000);
  assert.equal(local.video.bytes, 9000);
  assert.equal(local.documents.files, 1);
  assert.equal(o.objectStorage.enabled && o.objectStorage.reachable, true);
  if (!o.objectStorage.enabled || !o.objectStorage.reachable) return;
  assert.equal(o.objectStorage.uploads!.objects, 3);
  assert.equal(o.objectStorage.missing, 1, "the PDF is not in the bucket yet");
  assert.equal(o.objectStorage.orphans, 1);
  assert.equal(o.objectStorage.backup!.bytes, 40800);
  assert.equal(o.objectStorage.backup!.lastModified, "2026-09-26T12:30:00Z");
  void pdf;
});

test("an unreachable bucket is reported with its reason", async () => {
  broken = true;
  const o = await storageOverview();
  assert.equal(o.objectStorage.enabled, true);
  if (!o.objectStorage.enabled) return;
  assert.equal(o.objectStorage.reachable, false);
  assert.match(String(o.objectStorage.error), /403 AccessDenied/);
  broken = false;
});
