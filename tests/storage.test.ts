import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A minimal S3 stand-in: path-style objects in memory.
const objects = new Map<string, Buffer>();
const requests: string[] = [];
const failing = new Set<string>();
const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const path = decodeURIComponent(req.url || "");
    requests.push(`${req.method} ${path}`);
    assert.match(String(req.headers.authorization), /^AWS4-HMAC-SHA256 /);
    if ([...failing].some((key) => path.endsWith(key))) {
      res.writeHead(500).end();
      return;
    }
    const url = new URL(req.url || "", "http://x");
    if (req.method === "GET" && url.searchParams.get("list-type") === "2") {
      const prefix = `/bucket/${url.searchParams.get("prefix") || ""}`;
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).map((k) => `<Contents><Key>${k.slice("/bucket/".length)}</Key></Contents>`);
      return void res.writeHead(200).end(`<ListBucketResult><IsTruncated>false</IsTruncated>${keys.join("")}</ListBucketResult>`);
    }
    // CopyObject.
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
      const body = objects.get(path);
      if (!body) return void res.writeHead(404).end();
      return void res.writeHead(200).end(body);
    }
    res.writeHead(200).end();
  });
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const port = (server.address() as { port: number }).port;
// Not closed in an after() hook: node:test may run a top-level hook while
// the file still awaits between tests, and later tests would find the
// server gone. unref() lets the process end without it.
server.unref();

const dir = mkdtempSync(join(tmpdir(), "flowplan-storage-"));
process.env.FLOWPLAN_DATA_DIR = dir;
process.env.S3_ENDPOINT = `http://127.0.0.1:${port}`;
process.env.S3_BUCKET = "bucket";
process.env.S3_ACCESS_KEY_ID = "key";
process.env.S3_SECRET_ACCESS_KEY = "secret";
const { run, id, one, transaction } = await import("../lib/db");
const { ensureLocal, storageStatus, kickStorage } = await import("../lib/storage");
const { createWorkspace, createPage } = await import("../lib/seed");
const user = id();
run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", user, user, "S", "s@example.test");
const workspace = createWorkspace(user, "Speicher");
const space = String(one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", workspace)!.id);
const page = createPage(workspace, space, user, "Dateien");

const uploads = join(dir, "uploads");
mkdirSync(uploads, { recursive: true });
const object = (key: string) => `/bucket/flowplan/uploads/${key}`;
const until = async (check: () => boolean, label: string) => {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail(`timed out: ${label}`);
};
function addFile(content: string) {
  const fid = id();
  writeFileSync(join(uploads, fid), content);
  run(
    "INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)",
    fid,
    page,
    "a.txt",
    "text/plain",
    content.length,
    "u",
  );
  return fid;
}

test("new files are uploaded, deleted files removed, rolled back files never sent", async () => {
  const fid = addFile("hallo");
  await until(() => objects.has(object(fid)), "upload");
  assert.equal(objects.get(object(fid))!.toString(), "hallo");
  await until(() => storageStatus().enabled && storageStatus().pending === 0, "queue empty");

  const ghost = id();
  assert.throws(() =>
    transaction(() => {
      writeFileSync(join(uploads, ghost), "weg");
      run("INSERT INTO files(id,page_id,name,mime,size) VALUES(?,?,?,?,?)", ghost, page, "b", "text/plain", 3);
      throw new Error("abort");
    }),
  );
  assert.equal(one("SELECT 1 FROM storage_queue WHERE key=?", ghost), undefined);

  run("DELETE FROM files WHERE id=?", fid);
  await until(() => !objects.has(object(fid)), "delete");
  // Moved aside, not lost: the scheduled backups may still refer to it.
  const moved = [...objects.keys()].filter((k) => k.startsWith(`/bucket/flowplan/.deleted/uploads/${fid}.`));
  assert.equal(moved.length, 1);
  assert.equal(objects.get(moved[0])!.toString(), "hallo");
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(!requests.some((r) => r.includes(ghost)), "rolled back file stays local");
});

test("a container without the local file fetches it from the bucket", async () => {
  const fid = addFile("aus dem Bucket");
  await until(() => objects.has(object(fid)), "upload");
  rmSync(join(uploads, fid));
  assert.equal(await ensureLocal(fid), true);
  assert.equal(readFileSync(join(uploads, fid), "utf8"), "aus dem Bucket");
  assert.equal(await ensureLocal("../etc"), false, "keys stay inside uploads");
  assert.equal(await ensureLocal(id()), false);
});

test("failed uploads are retried with backoff instead of lost", async () => {
  const fid = id();
  failing.add(fid);
  writeFileSync(join(uploads, fid), "später");
  run("INSERT INTO files(id,page_id,name,mime,size) VALUES(?,?,?,?,?)", fid, page, "c", "text/plain", 6);
  await until(
    () => Number(one<{ attempts: number }>("SELECT attempts FROM storage_queue WHERE key=?", fid)?.attempts) > 0,
    "retry scheduled",
  );
  assert.equal(storageStatus().enabled && storageStatus().failing, true);
  failing.delete(fid);
  run("UPDATE storage_queue SET next_at=0 WHERE key=?", fid);
  kickStorage();
  await until(() => objects.has(object(fid)), "retried upload");
  assert.ok(existsSync(join(uploads, fid)));
});

test("deleted files leave the bucket once no kept backup refers to them", async () => {
  const { runScheduledBackup } = await import("../lib/scheduled-backup");
  const now = Date.now();
  const trash = (fid: string, at: number) => `/bucket/flowplan/.deleted/uploads/${fid}.${at}`;
  // Moved before the oldest kept backup: goes.
  const longAgo = trash(id(), now - 30 * 86_400_000);
  // Moved since: a kept backup may refer to it.
  const recent = trash(id(), now - 3 * 86_400_000);
  // Moved before, but the instance has it again: goes.
  const back = addFile("wieder da");
  await until(() => objects.has(object(back)), "upload");
  await until(() => !one("SELECT 1 FROM storage_queue WHERE key=?", back), "queue empty");
  const again = trash(back, now - 60_000);
  for (const key of [longAgo, recent, again]) objects.set(key, Buffer.from("alt"));
  // The oldest kept backup is from 5 days ago.
  objects.set(`/bucket/flowplan/backups/flowplan-${new Date(now - 5 * 86_400_000).toISOString().slice(0, 16).replace(/[:T]/g, "-")}.sqlite`, Buffer.from("x"));
  const result = await runScheduledBackup(now);
  assert.equal(result.error, null);
  assert.ok(!objects.has(longAgo));
  assert.ok(objects.has(recent), "a kept backup may still need it");
  assert.ok(!objects.has(again), "the file is in uploads/ again");

  // Without scheduled backups nothing would remove it: deleted right away.
  run("INSERT INTO instance_settings(key,value) VALUES('backupSchedule','false') ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  run("DELETE FROM files WHERE id=?", back);
  await until(() => !objects.has(object(back)), "delete");
  assert.equal([...objects.keys()].filter((k) => k.includes(`/.deleted/uploads/${back}.`)).length, 0);
  run("DELETE FROM instance_settings WHERE key='backupSchedule'");
});
