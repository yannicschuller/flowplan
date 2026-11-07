// Restore from a backup on the setup screen of a new instance (#128): an
// uploaded scheduled backup or instance download, or the newest backup on
// an SFTP server or in a bucket – into a fresh data folder, while no account
// exists.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { Identity } from "../lib/types";
import { startSftpServer } from "./helpers/sftp-server";

const old = mkdtempSync(join(tmpdir(), "flowplan-setup-restore-old-"));
process.env.FLOWPLAN_DATA_DIR = old;
const { SCHEMA_VERSION, id, one, reopenDatabase, run } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const { runScheduledBackup, startBackupWorker } = await import("../lib/scheduled-backup");
const { databaseCopy } = await import("../lib/backup-copy");
const { instanceBackupStream } = await import("../lib/instance-backup");
const { sealStream } = await import("../lib/encryption");
const sftpBackup = await import("../lib/sftp-backup");
const restore = await import("../lib/setup-restore");
const { firstAccount } = await import("../lib/local-auth");
const { ensureLocal } = await import("../lib/storage");

// The old instance: an account, a page and a file.
const uid = id();
run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, `local:${uid}`, "Ana", "ana@example.test");
const owner = { id: uid, name: "Ana", email: "ana@example.test", groups: [], isAdmin: true, disabled: 0, created_at: "" } as Identity;
const wid = createWorkspace(owner.id, "Alt");
const page = (command(owner, { action: "page.create", workspaceId: wid, spaceId: bootstrap(owner, wid).spaces[0].id, title: "Aus der Sicherung" }) as { id: string }).id;
const fid = id();
mkdirSync(join(old, "uploads"), { recursive: true });
writeFileSync(join(old, "uploads", fid), "Anhang der alten Instanz");
run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", fid, page, "anhang.txt", "text/plain", 24, uid);
const keep = mkdtempSync(join(tmpdir(), "flowplan-setup-restore-files-"));
after(() => (process.env.FLOWPLAN_DATA_DIR = old));

// Every scenario starts on a fresh, empty instance.
async function freshInstance() {
  delete process.env.FLOWPLAN_ENCRYPTION_KEY;
  const dir = mkdtempSync(join(tmpdir(), "flowplan-setup-restore-new-"));
  process.env.FLOWPLAN_DATA_DIR = dir;
  reopenDatabase();
  assert.equal(await firstAccount(), true);
  return dir;
}
function backOnOld() {
  process.env.FLOWPLAN_DATA_DIR = old;
  reopenDatabase();
}
async function restoredPage(dir: string) {
  assert.equal(await firstAccount(), false, "the accounts came back");
  assert.equal(one<{ title: string }>("SELECT title FROM pages WHERE id=?", page)?.title, "Aus der Sicherung");
  return existsSync(join(dir, "uploads", fid)) ? readFileSync(join(dir, "uploads", fid), "utf8") : null;
}

test("round trip: scheduled backup → fresh instance → restore → data present", async () => {
  const result = await runScheduledBackup(Date.UTC(2026, 10, 6, 3, 0));
  assert.equal(result.error, null);
  const file = join(keep, result.name);
  copyFileSync(join(old, "backups", result.name), file);
  // The schema version travels with the copy.
  const copy = new DatabaseSync(file, { readOnly: true });
  assert.equal((copy.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, SCHEMA_VERSION);
  copy.close();
  const dir = await freshInstance();
  const restored = await restore.restoreUpload(file, "", result.name);
  assert.equal(restored.restart, false);
  assert.equal(restored.createdAt, "2026-11-06T03:00:00.000Z");
  assert.ok(restored.users >= 1 && restored.pages >= 1);
  // A database-only backup brings no files (they come from S3 or SFTP): the
  // setup screen says how many are missing.
  assert.equal(await restoredPage(dir), null);
  assert.deepEqual([restored.files, restored.missingFiles], [0, 1]);
  assert.ok(readdirSync(dir).some((n) => n.startsWith("pre-restore-")), "the empty start is kept");
  // Now that an account exists, nobody may restore here any more.
  assert.equal(await restore.setupRestoreOpen(), false);
  await assert.rejects(async () => restore.requireSetupRestore(""), /schon eingerichtet/);
  backOnOld();
});

test("an encrypted instance download needs the key and brings the files", async () => {
  const key = randomBytes(32).toString("base64");
  process.env.FLOWPLAN_ENCRYPTION_KEY = key;
  const file = join(keep, "flowplan-instanz.zip.enc");
  await pipeline(instanceBackupStream().pipe(sealStream()), createWriteStream(file));
  const dir = await freshInstance();
  await assert.rejects(restore.restoreUpload(file, ""), (e: Error & { needsKey?: boolean }) => e.needsKey === true && /verschlüsselt/.test(e.message));
  await assert.rejects(restore.restoreUpload(file, randomBytes(32).toString("base64")), /Schlüssel passt nicht/);
  await assert.rejects(restore.restoreUpload(file, "zu-kurz"), /32 Bytes/);
  assert.equal(await firstAccount(), true, "nothing was replaced");
  const restored = await restore.restoreUpload(file, key);
  assert.equal(restored.files, 1);
  // The key was entered, not configured: a hint to set it.
  assert.equal(restored.keyHint, true);
  assert.equal(await restoredPage(dir), "Anhang der alten Instanz");
  backOnOld();
});

test("refuses while an account exists, and backups from a newer version", async () => {
  const result = await runScheduledBackup(Date.UTC(2026, 10, 6, 4, 0));
  const file = join(keep, result.name);
  copyFileSync(join(old, "backups", result.name), file);
  // On the old instance (it has accounts) the setup restore is closed.
  assert.equal(await restore.setupRestoreOpen(), false);
  await assert.rejects(restore.restoreUpload(file, ""), /schon eingerichtet/);
  // A database from a newer Flowplan.
  const newer = join(keep, "flowplan-2099-01-01-00-00.sqlite");
  copyFileSync(file, newer);
  const db = new DatabaseSync(newer);
  db.exec(`PRAGMA user_version=${SCHEMA_VERSION + 1}`);
  db.close();
  await freshInstance();
  await assert.rejects(restore.restoreUpload(newer, ""), /neueren Flowplan-Version/);
  // Neither SQLite nor ZIP.
  const junk = join(keep, "junk.bin");
  writeFileSync(junk, "kein Backup");
  await assert.rejects(restore.restoreUpload(junk, ""), /keine Flowplan-Sicherung/);
  assert.equal(await firstAccount(), true);
  backOnOld();
});

test("with FLOWPLAN_SETUP_TOKEN only with the token", async () => {
  const dir = await freshInstance();
  process.env.FLOWPLAN_SETUP_TOKEN = "einrichten";
  try {
    assert.equal(await restore.setupRestoreOpen(""), false);
    await assert.rejects(async () => restore.requireSetupRestore("falsch"), /Einrichtungslink/);
    assert.equal(await restore.setupRestoreOpen("einrichten"), true);
  } finally {
    delete process.env.FLOWPLAN_SETUP_TOKEN;
  }
  assert.ok(dir);
  backOnOld();
});

test("an archive with an entry outside its folders is refused", async () => {
  const { ZipFile } = await import("yazl");
  const zip = new ZipFile();
  zip.addBuffer(Buffer.from(JSON.stringify({ format: "flowplan-instance-1" })), "manifest.json");
  // yazl refuses such a name: written with a placeholder of the same
  // length, swapped in the finished bytes (local header and directory).
  const evil = "uploads/a/../../../evil",
    placeholder = "uploads/aXXXXXXXXXXevil";
  zip.addBuffer(Buffer.from("x"), placeholder);
  zip.end();
  const file = join(keep, "evil.zip");
  await pipeline(zip.outputStream, createWriteStream(file));
  writeFileSync(file, Buffer.from(readFileSync(file).toString("latin1").replaceAll(placeholder, evil), "latin1"));
  const dir = await freshInstance();
  await assert.rejects(restore.restoreUpload(file, ""), /unbekannte Einträge|Ungültige ZIP|Beschädigte Sicherung/);
  assert.ok(!existsSync(join(dir, "..", "evil")));
  assert.equal(await firstAccount(), true);
  backOnOld();
});

test("the newest backup from an SFTP server, with its files, encrypted", async () => {
  const key = randomBytes(32).toString("base64");
  process.env.FLOWPLAN_ENCRYPTION_KEY = key;
  const remote = mkdtempSync(join(tmpdir(), "flowplan-setup-restore-sftp-"));
  const server = await startSftpServer(remote, { user: "backup", password: "geheim-genug" });
  try {
    const target = { host: "127.0.0.1", port: server.port, username: "backup", password: "geheim-genug", directory: "flowplan" };
    sftpBackup.saveSftpBackup(uid, { ...target, enabled: true, auth: "password", keep: 5, uploads: true });
    sftpBackup.trustSftpHostKey(uid, (await sftpBackup.testSftpBackup()).fingerprint);
    assert.equal((await sftpBackup.runSftpBackup(Date.UTC(2026, 10, 6, 5, 0))).error, null);
    assert.equal((await sftpBackup.runSftpBackup(Date.UTC(2026, 10, 6, 6, 0))).error, null);
    // On the server everything is encrypted.
    assert.equal(readFileSync(join(remote, "flowplan/uploads", fid)).subarray(0, 4).toString(), "FPE1");
    const dir = await freshInstance();
    // The host key is looked at first, without the password.
    const before = server.logins;
    const { fingerprint } = await restore.probeSftp(target);
    assert.equal(fingerprint, server.hostKey);
    assert.equal(server.logins, before);
    assert.throws(() => restore.startRemoteRestore("sftp", target, key), /Hostschlüssel/);
    // Without the key: asked for.
    restore.startRemoteRestore("sftp", { ...target, fingerprint }, "");
    const missing = await restore.setupRestoreSettled();
    assert.equal(missing?.phase, "error");
    assert.equal(missing?.needsKey, true);
    restore.startRemoteRestore("sftp", { ...target, fingerprint }, key);
    const done = await restore.setupRestoreSettled();
    assert.equal(done?.error, null);
    assert.equal(done?.phase, "done");
    assert.equal(done?.result?.createdAt, "2026-11-06T06:00:00.000Z");
    assert.deepEqual([done?.result?.files, done?.result?.missingFiles], [1, 0]);
    assert.equal(await restoredPage(dir), "Anhang der alten Instanz");
  } finally {
    await server.close();
    delete process.env.FLOWPLAN_ENCRYPTION_KEY;
  }
  backOnOld();
});

test("an older SFTP backup finds a file deleted since then in .deleted/", async () => {
  const remote = mkdtempSync(join(tmpdir(), "flowplan-setup-restore-sftp-deleted-"));
  const server = await startSftpServer(remote, { user: "backup", password: "geheim-genug" });
  try {
    const target = { host: "127.0.0.1", port: server.port, username: "backup", password: "geheim-genug", directory: "flowplan" };
    sftpBackup.saveSftpBackup(uid, { ...target, enabled: true, auth: "password", keep: 5, uploads: true });
    sftpBackup.trustSftpHostKey(uid, (await sftpBackup.testSftpBackup()).fingerprint);
    assert.equal((await sftpBackup.runSftpBackup(Date.UTC(2026, 10, 7, 3, 0))).error, null);
    // Deleted here after the 03:00 backup: moved aside by the next one.
    const content = readFileSync(join(old, "uploads", fid));
    run("DELETE FROM files WHERE id=?", fid);
    rmSync(join(old, "uploads", fid));
    const next = await sftpBackup.runSftpBackup(Date.UTC(2026, 10, 7, 4, 0));
    writeFileSync(join(old, "uploads", fid), content);
    run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", fid, page, "anhang.txt", "text/plain", 24, uid);
    assert.deepEqual([next.error, next.removed], [null, 1]);
    assert.ok(!existsSync(join(remote, "flowplan/uploads", fid)));
    assert.equal(readdirSync(join(remote, "flowplan/.deleted/uploads")).length, 1);
    // The 03:00 backup is the one restored (the newer one set aside).
    rmSync(join(remote, "flowplan/flowplan-2026-11-07-04-00.sqlite"));
    const dir = await freshInstance();
    restore.startRemoteRestore("sftp", { ...target, fingerprint: server.hostKey }, "");
    const done = await restore.setupRestoreSettled();
    assert.equal(done?.error, null);
    assert.equal(done?.result?.createdAt, "2026-11-07T03:00:00.000Z");
    assert.deepEqual([done?.result?.files, done?.result?.missingFiles], [1, 0]);
    assert.equal(await restoredPage(dir), "Anhang der alten Instanz");
  } finally {
    await server.close();
  }
  backOnOld();
});

test("from S3: a file deleted after the backup comes from .deleted/", async () => {
  // A minimal S3 stand-in: objects in memory, with listing.
  const objects = new Map<string, Buffer>();
  const s3 = createServer((req, res) => {
    const url = new URL(req.url || "", "http://x");
    if (url.searchParams.get("list-type") === "2") {
      const prefix = `/bucket/${url.searchParams.get("prefix") || ""}`;
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).map((k) => `<Contents><Key>${k.slice("/bucket/".length)}</Key></Contents>`);
      return void res.writeHead(200).end(`<ListBucketResult><IsTruncated>false</IsTruncated>${keys.join("")}</ListBucketResult>`);
    }
    const body = objects.get(decodeURIComponent(url.pathname));
    return void (body ? res.writeHead(200, { "content-length": body.length }).end(body) : res.writeHead(404).end());
  });
  await new Promise<void>((done) => s3.listen(0, "127.0.0.1", done));
  try {
    const copy = join(old, "tmp", "s3-copy.sqlite");
    const made = databaseCopy(Date.UTC(2026, 10, 8, 3, 0), copy);
    objects.set(`/bucket/flowplan/backups/${made.name}`, readFileSync(copy));
    rmSync(copy);
    // Deleted after that backup: lib/storage.ts moved it aside.
    objects.set(`/bucket/flowplan/.deleted/uploads/${fid}.${Date.UTC(2026, 10, 8, 9, 0)}`, readFileSync(join(old, "uploads", fid)));
    const dir = await freshInstance();
    const input = { endpoint: `http://127.0.0.1:${(s3.address() as { port: number }).port}`, bucket: "bucket", accessKeyId: "a", secretAccessKey: "b" };
    restore.startRemoteRestore("s3", input, "");
    const done = await restore.setupRestoreSettled();
    assert.equal(done?.error, null);
    assert.deepEqual([done?.result?.files, done?.result?.missingFiles], [1, 0]);
    assert.equal(await restoredPage(dir), "Anhang der alten Instanz");
  } finally {
    s3.close();
  }
  backOnOld();
});

test("an uploaded database-only backup counts the files this instance's own bucket has", async () => {
  const objects = new Map<string, Buffer>();
  const s3 = createServer((req, res) => {
    const url = new URL(req.url || "", "http://x");
    if (url.searchParams.get("list-type") === "2") {
      const prefix = `/bucket/${url.searchParams.get("prefix") || ""}`;
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).map((k) => `<Contents><Key>${k.slice("/bucket/".length)}</Key></Contents>`);
      return void res.writeHead(200).end(`<ListBucketResult><IsTruncated>false</IsTruncated>${keys.join("")}</ListBucketResult>`);
    }
    if (req.method !== "GET") return void req.resume().on("end", () => res.writeHead(200).end());
    const body = objects.get(decodeURIComponent(url.pathname));
    return void (body ? res.writeHead(200, { "content-length": body.length }).end(body) : res.writeHead(404).end());
  });
  await new Promise<void>((done) => s3.listen(0, "127.0.0.1", done));
  const result = await runScheduledBackup(Date.UTC(2026, 10, 9, 3, 0));
  const file = join(keep, result.name);
  copyFileSync(join(old, "backups", result.name), file);
  const bucket = { S3_ENDPOINT: `http://127.0.0.1:${(s3.address() as { port: number }).port}`, S3_BUCKET: "bucket", S3_ACCESS_KEY_ID: "a", S3_SECRET_ACCESS_KEY: "b" };
  try {
    // The old instance mirrored its files to the bucket this one uses too.
    objects.set(`/bucket/flowplan/uploads/${fid}`, readFileSync(join(old, "uploads", fid)));
    Object.assign(process.env, bucket);
    const dir = await freshInstance();
    const restored = await restore.restoreUpload(file, "", result.name);
    assert.deepEqual([restored.files, restored.missingFiles], [0, 0]);
    // It comes from there when it is needed.
    assert.equal(await ensureLocal(fid), true);
    assert.equal(await restoredPage(dir), "Anhang der alten Instanz");
    // Not in the bucket: missing.
    objects.clear();
    await freshInstance();
    assert.equal((await restore.restoreUpload(file, "", result.name)).missingFiles, 1);
  } finally {
    for (const name of Object.keys(bucket)) delete process.env[name];
    s3.close();
  }
  backOnOld();
});

test("a new instance makes no scheduled backup before its first account", async (t) => {
  const dir = await freshInstance();
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  startBackupWorker();
  // The first check a minute after the start: nothing to back up yet – an
  // empty copy would become the newest backup next to an old instance's.
  t.mock.timers.tick(60_000);
  for (let i = 0; i < 50; i++) await new Promise((done) => setImmediate(done));
  assert.equal(existsSync(join(dir, "backups")), false);
  // Set up: the next check makes the backup.
  const user = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", user, `local:${user}`, "Neu", "neu@example.test");
  t.mock.timers.tick(10 * 60_000);
  for (let i = 0; i < 500 && !existsSync(join(dir, "backups")); i++) await new Promise((done) => setImmediate(done));
  assert.equal(readdirSync(join(dir, "backups")).length, 1);
  backOnOld();
});
