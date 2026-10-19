import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { DatabaseSync } from "node:sqlite";
import type { Identity } from "../lib/types";

// A minimal S3 stand-in: path-style objects in memory, with listing.
const objects = new Map<string, Buffer>();
const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const url = new URL(req.url || "", "http://x");
    const path = decodeURIComponent(url.pathname);
    if (req.method === "GET" && url.searchParams.get("list-type") === "2") {
      const prefix = `/bucket/${url.searchParams.get("prefix") || ""}`;
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).map((k) => `<Contents><Key>${k.slice("/bucket/".length)}</Key></Contents>`);
      return void res.writeHead(200).end(`<ListBucketResult>${keys.join("")}</ListBucketResult>`);
    }
    if (req.method === "PUT") objects.set(path, Buffer.concat(chunks));
    if (req.method === "DELETE") objects.delete(path);
    if (req.method === "GET") {
      const body = objects.get(path);
      return void (body ? res.writeHead(200).end(body) : res.writeHead(404).end());
    }
    res.writeHead(200).end();
  });
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
after(() => server.close());

const dir = mkdtempSync(join(tmpdir(), "flowplan-encryption-"));
process.env.FLOWPLAN_DATA_DIR = dir;
process.env.S3_ENDPOINT = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
process.env.S3_BUCKET = "bucket";
process.env.S3_ACCESS_KEY_ID = "key";
process.env.S3_SECRET_ACCESS_KEY = "secret";
delete process.env.FLOWPLAN_ENCRYPTION_KEY;
const { run, id, one } = await import("../lib/db");
const { seal, unseal, isEncrypted, sealStream, unsealFile, encryptionKeyStatus } = await import("../lib/encryption");
const { ensureLocal, storageEncryption, encryptExistingObjects } = await import("../lib/storage");
const { createWorkspace, createPage } = await import("../lib/seed");
const { runScheduledBackup } = await import("../lib/scheduled-backup");
const { instanceBackupStream, stageInstanceRestore } = await import("../lib/instance-backup");
const { setMarkdownExport, runMarkdownExports } = await import("../lib/scheduled-markdown-export");
const { encryptionOverview } = await import("../lib/encryption-status");

const first = randomBytes(32).toString("base64");
const second = randomBytes(32).toString("base64");
const useKey = (current?: string, previous?: string) => {
  if (current) process.env.FLOWPLAN_ENCRYPTION_KEY = current;
  else delete process.env.FLOWPLAN_ENCRYPTION_KEY;
  if (previous) process.env.FLOWPLAN_ENCRYPTION_KEY_PREVIOUS = previous;
  else delete process.env.FLOWPLAN_ENCRYPTION_KEY_PREVIOUS;
};

const uid = id();
run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, "Ada", "ada@example.test");
const admin = { id: uid, name: "Ada", email: "ada@example.test", groups: [], isAdmin: true, disabled: 0, created_at: "" } as unknown as Identity;
const workspace = createWorkspace(uid, "Tresor");
const space = String(one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", workspace)!.id);
const page = createPage(workspace, space, uid, "Unterlagen");
const uploads = join(dir, "uploads");
mkdirSync(uploads, { recursive: true });
const object = (key: string) => `/bucket/flowplan/uploads/${key}`;
const until = async (check: () => boolean, label: string) => {
  for (let i = 0; i < 250; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail(`timed out: ${label}`);
};
function addFile(content: string) {
  const fid = id();
  writeFileSync(join(uploads, fid), content);
  run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", fid, page, "a.txt", "text/plain", content.length, uid);
  return fid;
}

test("encrypt and decrypt: round trip, plain data passes, wrong or earlier keys", () => {
  useKey(first);
  const sealed = seal(Buffer.from("Kontoauszug"));
  assert.ok(isEncrypted(sealed));
  assert.ok(!sealed.includes(Buffer.from("Kontoauszug")));
  assert.equal(unseal(sealed).toString(), "Kontoauszug");
  // Plain data (from before encryption) comes back as it is.
  assert.equal(unseal(Buffer.from("alt")).toString(), "alt");
  // Another key: a clear message naming the key the data needs.
  useKey(second);
  assert.throws(() => unseal(sealed), /Verschlüsselt mit dem Schlüssel [0-9a-f]{16}, der hier nicht eingerichtet ist/);
  // After a rotation the earlier key still reads.
  useKey(second, first);
  assert.equal(unseal(sealed).toString(), "Kontoauszug");
  // A changed byte is noticed.
  const tampered = Buffer.from(sealed);
  tampered[tampered.length - 20] ^= 1;
  assert.throws(() => unseal(tampered), /Entschlüsseln fehlgeschlagen/);
  // Without a key nothing changes.
  useKey();
  assert.equal(seal(Buffer.from("klar")).toString(), "klar");
  process.env.FLOWPLAN_ENCRYPTION_KEY = "zu-kurz";
  assert.match(String(encryptionKeyStatus().problem), /32 Bytes/);
  useKey();
});

test("objects in the bucket: plain ones stay readable, new ones are encrypted, existing ones catch up", async () => {
  useKey();
  const old = addFile("vorher");
  await until(() => objects.has(object(old)), "plain upload");
  assert.equal(objects.get(object(old))!.toString(), "vorher");

  useKey(first);
  const fresh = addFile("nachher");
  await until(() => objects.has(object(fresh)), "encrypted upload");
  assert.ok(isEncrypted(objects.get(object(fresh))!));
  // The upload is recorded once the bucket has answered, a moment after the
  // object arrived there.
  await until(() => storageEncryption()?.behind === 1, "upload recorded");
  assert.deepEqual(storageEncryption(), { files: 2, behind: 1 });
  // A new host without local files reads both kinds.
  rmSync(join(uploads, old));
  rmSync(join(uploads, fresh));
  assert.equal(await ensureLocal(old), true);
  assert.equal(await ensureLocal(fresh), true);
  assert.equal(readFileSync(join(uploads, fresh), "utf8"), "nachher");

  assert.equal(encryptExistingObjects(), 1);
  await until(() => isEncrypted(objects.get(object(old)) || Buffer.alloc(0)), "existing object encrypted");
  await until(() => storageEncryption()?.behind === 0, "nothing behind");

  // Rotation: everything is behind the new key, the earlier one still reads.
  useKey(second, first);
  assert.equal(storageEncryption()?.behind, 2);
  rmSync(join(uploads, old));
  assert.equal(await ensureLocal(old), true);
  assert.equal(encryptExistingObjects(), 2);
  await until(() => storageEncryption()?.behind === 0, "re-encrypted with the new key");
  // Without the right key the file is not written (and no garbage is).
  useKey(randomBytes(32).toString("base64"));
  rmSync(join(uploads, fresh));
  assert.equal(await ensureLocal(fresh), false);
  assert.throws(() => readFileSync(join(uploads, fresh)));
  const overview = encryptionOverview();
  assert.equal(overview.enabled, true);
  assert.equal(overview.git, false);
});

test("scheduled backups and Markdown exports are encrypted; the emergency script reads them", async () => {
  useKey(first);
  const result = await runScheduledBackup(Date.UTC(2026, 9, 1, 3));
  assert.equal(result.error, null);
  assert.match(result.name, /^flowplan-2026-10-01-03-00\.sqlite\.enc$/);
  const stored = objects.get(`/bucket/flowplan/backups/${result.name}`)!;
  assert.ok(isEncrypted(stored));
  // Old plain and new encrypted copies count together when cleaning up.
  run("INSERT INTO instance_settings(key,value) VALUES('backupKeep','2') ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  objects.set("/bucket/flowplan/backups/flowplan-2026-09-01-03-00.sqlite", Buffer.from("alt"));
  await runScheduledBackup(Date.UTC(2026, 9, 2, 3));
  assert.deepEqual(
    [...objects.keys()].filter((k) => k.includes("/backups/")).sort(),
    ["/bucket/flowplan/backups/flowplan-2026-10-01-03-00.sqlite.enc", "/bucket/flowplan/backups/flowplan-2026-10-02-03-00.sqlite.enc"],
  );

  // Without a running instance: node scripts/decrypt.mjs.
  const file = join(dir, result.name);
  writeFileSync(file, stored);
  const script = join(import.meta.dirname, "..", "scripts", "decrypt.mjs");
  const out = execFileSync(process.execPath, [script, file], { env: { ...process.env, FLOWPLAN_ENCRYPTION_KEY: "", FLOWPLAN_ENCRYPTION_KEY_PREVIOUS: `${second},${first}` } });
  assert.equal(String(out).trim(), file.slice(0, -4));
  const db = new DatabaseSync(file.slice(0, -4), { readOnly: true });
  assert.equal((db.prepare("SELECT name FROM users WHERE id=?").get(uid) as { name: string }).name, "Ada");
  db.close();
  const wrong = spawnSync(process.execPath, [script, file, join(dir, "wrong.sqlite")], { env: { ...process.env, FLOWPLAN_ENCRYPTION_KEY: second } });
  assert.equal(wrong.status, 1);
  assert.match(String(wrong.stderr), /mit dem Schlüssel [0-9a-f]{16}/);

  setMarkdownExport(admin, [page]);
  const [exported] = await runMarkdownExports(Date.UTC(2026, 9, 2, 3));
  assert.equal(exported.error, null);
  assert.match(exported.name, /\.zip\.enc$/);
  const zip = objects.get(`/bucket/flowplan/exports/${exported.name}`)!;
  assert.equal(unseal(zip).subarray(0, 2).toString(), "PK");
});

test("an encrypted instance backup restores with the key", async () => {
  useKey(first);
  const file = join(dir, "tmp", "instance.zip.enc");
  mkdirSync(join(dir, "tmp"), { recursive: true });
  await pipeline(instanceBackupStream().pipe(sealStream()), createWriteStream(file));
  assert.ok(isEncrypted(readFileSync(file).subarray(0, 40)));
  // The ZIP itself is not recognised without decrypting.
  await assert.rejects(stageInstanceRestore(file), /ZIP/);
  useKey(second);
  await assert.rejects(unsealFile(file, join(dir, "tmp", "nope.zip")), /nicht eingerichtet/);
  useKey(second, first);
  const plain = join(dir, "tmp", "instance.zip");
  await unsealFile(file, plain);
  const summary = await stageInstanceRestore(plain);
  assert.equal(summary.workspaces, 1);
  useKey();
});
