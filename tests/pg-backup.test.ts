// Backups of a PostgreSQL instance with pg_dump (lib/pg-backup.ts): the
// scheduled backup is a custom-format dump (encrypted with the key), the
// restore brings back exactly that state with pg_restore – search index
// rebuilt, pgvector's table filled in, sequences and triggers working – and
// keeps the state before it. SQLite: not applicable (VACUUM INTO, tested
// elsewhere).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Identity } from "../lib/types";

const dir = mkdtempSync(join(tmpdir(), "flowplan-pg-backup-"));
process.env.FLOWPLAN_DATA_DIR = dir;
delete process.env.FLOWPLAN_ENCRYPTION_KEY;
const { onPostgres } = await import("./helpers/backend");
const { id, one, all, run, reopenDatabase, transaction } = await import("../lib/db");
const backup = await import("../lib/pg-backup");
const skip = !onPostgres ? "PostgreSQL only" : !(await backup.pgDumpAvailable()) ? "pg_dump/pg_restore are not installed" : false;

const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const { runScheduledBackup } = await import("../lib/scheduled-backup");
const { searchWorkspace, refreshSearchIndex } = await import("../lib/search-index");
const { toVector } = await import("../lib/ai/semantic");
const vectors = await import("../lib/ai/vector-store");
const { unseal, parseKey } = await import("../lib/encryption");

const uid = id();
await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, `local:${uid}`, "Bea", "bea@example.test");
const owner = { id: uid, name: "Bea", email: "bea@example.test", groups: [], isAdmin: true, disabled: 0, created_at: "" } as Identity;
const wid = await createWorkspace(owner.id, "Gesichert");
const space = (await bootstrap(owner, wid)).spaces[0].id;
const page = async (title: string, html: string) => {
  const pid = ((await command(owner, { action: "page.create", workspaceId: wid, spaceId: space, title })) as { id: string }).id;
  await run("INSERT INTO documents(page_id,html) VALUES(?,?) ON CONFLICT(page_id) DO UPDATE SET html=excluded.html", pid, html);
  return pid;
};
const kept = await page("Jahresplanung", "<p>Die Projektplanung für Zürich und 北京.</p>");
const vec = (seed: number) => toVector(Array.from({ length: 32 }, (_, i) => Math.cos(seed + i)));
await transaction(async () => {
  for (let i = 0; i < 20; i++)
    await run(
      "INSERT INTO ai_embeddings(page_id,row_id,chunk,workspace_id,hash,model,vector,created_at) VALUES(?,?,?,?,?,?,?,?)",
      kept,
      "",
      i,
      wid,
      `h${i}`,
      "embed",
      vec(i),
      Date.now(),
    );
});
await refreshSearchIndex();
const titles = async (q: string) => (await searchWorkspace(owner, wid, q)).map((h) => h.title).sort();

let dump = "";
const keep = mkdtempSync(join(tmpdir(), "flowplan-pg-backup-keep-"));
after(() => delete process.env.FLOWPLAN_ENCRYPTION_KEY);

test("the scheduled backup is a pg_dump archive of the instance's schema, without derived tables", { skip }, async () => {
  const result = await runScheduledBackup(Date.UTC(2026, 10, 7, 3, 0));
  assert.equal(result.error, null);
  assert.equal(result.name, "flowplan-2026-11-07-03-00.dump");
  dump = join(keep, result.name);
  copyFileSync(join(dir, "backups", result.name), dump);
  assert.equal(backup.isPgDump(dump), true);
  const entries = await backup.dumpEntries(dump);
  const tables = new Set(entries.filter((e) => e.type === "TABLE").map((e) => e.name));
  assert.ok(tables.has("pages") && tables.has("ai_embeddings") && tables.has("flowplan_meta"));
  assert.ok(!tables.has("search_index") && !tables.has("ai_embedding_vectors"), "derived tables are rebuilt, not backed up");
  assert.deepEqual([...new Set(entries.filter((e) => e.type === "TABLE").map((e) => e.schema))], [process.env.FLOWPLAN_PG_SCHEMA]);
  const summary = await backup.dumpSummary(dump);
  assert.equal(summary.users, 1);
  assert.equal(summary.workspaces, 1);
  assert.ok(summary.pages >= 2);
  assert.ok(summary.version > 90);
});

test("encrypted with FLOWPLAN_ENCRYPTION_KEY like every backup", { skip }, async () => {
  const key = randomBytes(32).toString("base64");
  process.env.FLOWPLAN_ENCRYPTION_KEY = key;
  try {
    const result = await runScheduledBackup(Date.UTC(2026, 10, 7, 4, 0));
    assert.equal(result.error, null);
    assert.equal(result.name, "flowplan-2026-11-07-04-00.dump.enc");
    const sealed = readFileSync(join(dir, "backups", result.name));
    assert.ok(!sealed.subarray(0, 5).equals(backup.PGDUMP_MAGIC));
    assert.ok(unseal(sealed, [parseKey(key, "key")]).subarray(0, 5).equals(backup.PGDUMP_MAGIC));
  } finally {
    delete process.env.FLOWPLAN_ENCRYPTION_KEY;
  }
  // Both formats count for the retention (flowplan-…).
  assert.deepEqual(readdirSync(join(dir, "backups")).sort(), ["flowplan-2026-11-07-03-00.dump", "flowplan-2026-11-07-04-00.dump.enc"]);
});

test("restore: the state of the dump comes back, the state before is kept", { skip }, async () => {
  // Changes after the backup.
  await command(owner, { action: "page.delete", pageId: kept });
  await run("DELETE FROM pages WHERE id=?", kept);
  const later = await page("Später angelegt", "<p>Nach der Sicherung</p>");
  await refreshSearchIndex();
  assert.deepEqual(await titles("planung"), []);
  // Staged as the setup restore does (lib/setup-restore.ts), loaded when the
  // database opens next.
  mkdirSync(join(dir, "restore-pending", "uploads"), { recursive: true });
  copyFileSync(dump, join(dir, "restore-pending", "flowplan.dump"));
  writeFileSync(join(dir, "restore-pending", "READY"), JSON.stringify({ createdAt: "", users: 1, workspaces: 1, pages: 2, files: 0 }));
  await reopenDatabase();
  assert.equal((await one<{ title: string }>("SELECT title FROM pages WHERE id=?", kept))?.title, "Jahresplanung");
  assert.equal(await one("SELECT 1 FROM pages WHERE id=?", later), undefined);
  // The search index is rebuilt from the restored data.
  await refreshSearchIndex();
  assert.deepEqual(await titles("planung"), ["Jahresplanung"]);
  assert.deepEqual(await titles("zurich"), ["Jahresplanung"]);
  // pgvector's table is filled in again (when the server has pgvector).
  if (vectors.vectorStoreActive()) {
    await vectors.syncVectors();
    const status = await vectors.vectorStoreStatus();
    assert.equal(status.complete, true);
    assert.equal((await one<{ n: number }>("SELECT count(*) n FROM ai_embedding_vectors"))!.n, 20);
  }
  // Triggers and identities work after the restore.
  const next = await page("Nach der Wiederherstellung", "<p>neu</p>");
  assert.ok(await one("SELECT 1 FROM search_dirty WHERE page_id=?", next), "search triggers fire");
  const seqs = await all<{ seq: number }>("SELECT seq FROM pages ORDER BY seq DESC LIMIT 2");
  assert.ok(Number(seqs[0].seq) > Number(seqs[1].seq));
  // The state before the restore, as a dump.
  const previous = readdirSync(dir).filter((n) => n.startsWith("pre-restore-"));
  assert.equal(previous.length, 1);
  assert.ok(backup.isPgDump(join(dir, previous[0], "flowplan.dump")));
  assert.ok(!existsSync(join(dir, "flowplan.dump")) && !existsSync(join(dir, "restore-pending")));
});

test("Administration's restore takes a scheduled backup (.dump): only the database, the files stay", { skip }, async () => {
  const { stageDumpRestore, pendingRestore } = await import("../lib/instance-backup");
  await run("UPDATE pages SET title='Umbenannt' WHERE id=?", kept);
  mkdirSync(join(dir, "uploads"), { recursive: true });
  writeFileSync(join(dir, "uploads", "datei-bleibt"), "Inhalt");
  // The upload is moved into the staging (as the route does with its temporary file).
  const upload = join(dir, "upload.dump");
  copyFileSync(dump, upload);
  const summary = await stageDumpRestore(upload, "2026-11-07T03:00:00.000Z");
  assert.equal(summary.createdAt, "2026-11-07T03:00:00.000Z");
  assert.ok(summary.pages >= 1 && summary.users >= 1);
  assert.equal(summary.files, 0);
  assert.ok(!existsSync(upload));
  assert.deepEqual(pendingRestore(), summary);
  assert.ok(!existsSync(join(dir, "restore-pending", "uploads")), "no files staged");
  await reopenDatabase();
  assert.equal((await one<{ title: string }>("SELECT title FROM pages WHERE id=?", kept))?.title, "Jahresplanung");
  assert.equal(readFileSync(join(dir, "uploads", "datei-bleibt"), "utf8"), "Inhalt", "the files stay");
  assert.equal(pendingRestore(), null);
  // Not a Flowplan dump: refused, nothing staged.
  const other = join(dir, "other.dump");
  writeFileSync(other, "PGDMP kaputt");
  await assert.rejects(stageDumpRestore(other), /keine gültige Flowplan-Datenbank/);
  assert.equal(pendingRestore(), null);
});

test("a dump of a newer Flowplan version is refused, the data stays", { skip }, async () => {
  const { SCHEMA_VERSION } = await import("../lib/db");
  await assert.rejects(backup.restoreDump(dump, { newestVersion: SCHEMA_VERSION - 1 }), /newer Flowplan version/);
  assert.equal((await one<{ title: string }>("SELECT title FROM pages WHERE id=?", kept))?.title, "Jahresplanung");
});

test("on SQLite a pg_dump backup is refused before anything is staged", { skip: onPostgres && "SQLite only" }, async () => {
  const { stageDumpRestore, pendingRestore } = await import("../lib/instance-backup");
  const file = join(dir, "geplant.dump");
  writeFileSync(file, "PGDMP");
  await assert.rejects(stageDumpRestore(file), /nur in einer Instanz mit PostgreSQL/);
  assert.equal(pendingRestore(), null);
});

test("newer client tools than the server: settings the server does not know are left out of the script", () => {
  // pg_restore 17+ writes SET transaction_timeout, which PostgreSQL 16 refuses
  // (the image's client tools are 18; CI's runner has 18 against a 16 server).
  assert.equal(backup.unknownSettings(16).test("SET transaction_timeout = 0;"), true);
  assert.equal(backup.unknownSettings(16).test("SET statement_timeout = 0;"), false);
  assert.equal(backup.unknownSettings(17).test("SET transaction_timeout = 0;"), false);
  assert.equal(backup.unknownSettings(18).test("COPY x FROM stdin;"), false);
});
