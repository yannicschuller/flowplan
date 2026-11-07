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
const fid = id();
await run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", fid, kept, "anhang.txt", "text/plain", 24, uid);
await refreshSearchIndex();
const titles = async (q: string) => (await searchWorkspace(owner, wid, q)).map((h) => h.title).sort();

let dump = "";
// The offline change log when the dump was made: a restore loads it as it
// was (no trigger fires while the rows come in).
let offlineAtDump = 0;
const keep = mkdtempSync(join(tmpdir(), "flowplan-pg-backup-keep-"));
after(() => delete process.env.FLOWPLAN_ENCRYPTION_KEY);

test("the scheduled backup is a pg_dump archive of the instance's schema, without derived tables", { skip }, async () => {
  offlineAtDump = Number((await one<{ n: number }>("SELECT count(*) n FROM offline_changes"))!.n);
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
  assert.equal((await one<{ name: string }>("SELECT name FROM files WHERE id=?", fid))?.name, "anhang.txt");
  assert.equal(Number((await one<{ n: number }>("SELECT count(*) n FROM offline_changes"))!.n), offlineAtDump, "no trigger fired while the rows were loaded");
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
  assert.ok(await one("SELECT 1 FROM offline_changes WHERE page_id=?", next), "the offline change log's triggers fire");
  const seqs = await all<{ seq: number }>("SELECT seq FROM pages ORDER BY seq DESC LIMIT 2");
  assert.ok(Number(seqs[0].seq) > Number(seqs[1].seq));
  // Identity sequences continue after the restored keys.
  const restoredSeq = Number((await one<{ seq: number }>("SELECT seq FROM files WHERE id=?", fid))!.seq);
  const other = id();
  await run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", other, next, "neu.txt", "text/plain", 3, uid);
  assert.ok(Number((await one<{ seq: number }>("SELECT seq FROM files WHERE id=?", other))!.seq) > restoredSeq);
  // The schema is this version's, complete.
  assert.ok(await one("SELECT 1 FROM flowplan_meta WHERE key='schema_hash'"));
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

// ---- A dump is an upload: nothing of it but its rows runs ----

// Objects a crafted archive could carry, each with a side effect on a
// marker table outside the instance's schema: a function, a trigger on
// users, a rule, a CHECK and a DEFAULT calling a function, a view.
const marker = `${process.env.FLOWPLAN_PG_SCHEMA}_marker`;
const markers = async () => (await all<{ what: string }>(`SELECT what FROM ${marker}.hits ORDER BY what`)).map((r) => r.what);
async function withForeignObjects(make: () => Promise<void>) {
  await run(`CREATE SCHEMA IF NOT EXISTS ${marker}`);
  await run(`CREATE TABLE IF NOT EXISTS ${marker}.hits(what text)`);
  const fn = (name: string, returns: string, body: string, args = "") =>
    run(`CREATE FUNCTION ${name}(${args}) RETURNS ${returns} LANGUAGE plpgsql AS $f$ BEGIN INSERT INTO ${marker}.hits VALUES('${name}'); ${body} END $f$`);
  await fn("evil_trigger", "trigger", "RETURN NULL;");
  await fn("evil_check", "boolean", "RETURN true;", "v text");
  await fn("evil_default", "text", "RETURN 'x';");
  await run("CREATE TRIGGER evil_users AFTER INSERT ON users FOR EACH ROW EXECUTE FUNCTION evil_trigger()");
  await run(`CREATE RULE evil_rule AS ON INSERT TO workspaces DO ALSO INSERT INTO ${marker}.hits VALUES('evil_rule')`);
  await run("ALTER TABLE users ADD CONSTRAINT evil_chk CHECK (evil_check(id)) NOT VALID");
  await run("ALTER TABLE users ALTER COLUMN language SET DEFAULT evil_default()");
  await run("CREATE VIEW evil_view AS SELECT evil_default() AS x");
  try {
    await make();
  } finally {
    await run("DROP VIEW evil_view");
    await run("ALTER TABLE users ALTER COLUMN language DROP DEFAULT");
    await run("ALTER TABLE users DROP CONSTRAINT evil_chk");
    await run("DROP RULE evil_rule ON workspaces");
    await run("DROP TRIGGER evil_users ON users");
    await run("DROP FUNCTION evil_trigger(), evil_check(text), evil_default()");
    await run(`DELETE FROM ${marker}.hits`);
  }
}
const foreignDump = join(keep, "fremd.dump");
after(async () => {
  if (onPostgres) await run(`DROP SCHEMA IF EXISTS ${marker} CASCADE`).catch(() => {});
});

test("a dump with objects Flowplan does not make is refused before it is staged, and by the restore itself", { skip }, async () => {
  await withForeignObjects(() => backup.dumpDatabase(foreignDump));
  const kinds = new Set((await backup.dumpEntries(foreignDump)).map((e) => `${e.type} ${e.name}`));
  assert.ok(kinds.has("FUNCTION evil_trigger()") && kinds.has("TRIGGER users") && kinds.has("RULE workspaces"), [...kinds].join(", "));
  // Administration's restore and the setup screen (checkDumpBackup): refused, nothing staged.
  const { stageDumpRestore, checkDumpBackup, pendingRestore } = await import("../lib/instance-backup");
  await assert.rejects(checkDumpBackup(foreignDump), /Datenbankobjekte, die Flowplan nicht selbst anlegt/);
  const upload = join(dir, "fremd-upload.dump");
  copyFileSync(foreignDump, upload);
  await assert.rejects(stageDumpRestore(upload), /Datenbankobjekte, die Flowplan nicht selbst anlegt/);
  assert.equal(pendingRestore(), null);
  // The restore refuses it too (a dump staged by an older version).
  const { SCHEMA_VERSION } = await import("../lib/db");
  await assert.rejects(backup.restoreDump(foreignDump, { newestVersion: SCHEMA_VERSION }), (e: Error) => e instanceof backup.ForeignObjectsError && /evil_trigger/.test(e.message));
  assert.equal((await one<{ title: string }>("SELECT title FROM pages WHERE id=?", kept))?.title, "Jahresplanung");
  // Nothing of it ran or exists.
  const u = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", u, `local:${u}`, "Cem", "cem@example.test");
  await createWorkspace(u, "Danach");
  assert.deepEqual(await markers(), []);
});

test("without the check (the state saved before a restore) only the rows of such a dump come back", { skip }, async () => {
  const { SCHEMA_VERSION } = await import("../lib/db");
  await backup.restoreDump(foreignDump, { newestVersion: SCHEMA_VERSION, strict: false });
  assert.equal((await one<{ title: string }>("SELECT title FROM pages WHERE id=?", kept))?.title, "Jahresplanung");
  assert.deepEqual(
    await all("SELECT proname FROM pg_proc WHERE pronamespace=current_schema()::regnamespace AND proname LIKE 'evil%'"),
    [],
    "no function of the dump",
  );
  assert.deepEqual(await all("SELECT tgname FROM pg_trigger WHERE tgname LIKE 'evil%'"), []);
  assert.deepEqual(await all("SELECT rulename FROM pg_rules WHERE schemaname=current_schema()"), []);
  assert.deepEqual(await all("SELECT conname FROM pg_constraint WHERE connamespace=current_schema()::regnamespace AND conname LIKE 'evil%'"), []);
  assert.equal(await one("SELECT to_regclass('evil_view') AS v WHERE to_regclass('evil_view') IS NOT NULL"), undefined);
  // Flowplan's own triggers are there (from this code), the rows inserted
  // afterwards meet no function of the dump.
  const u = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", u, `local:${u}`, "Dora", "dora@example.test");
  await createWorkspace(u, "Neu");
  const pid = await page("Nach dem Laden", "<p>neu</p>");
  assert.ok(await one("SELECT 1 FROM search_dirty WHERE page_id=?", pid));
  assert.equal((await one<{ language: string | null }>("SELECT language FROM users WHERE id=?", u))?.language ?? null, null);
  assert.deepEqual(await markers(), []);
});

test("SQL after the end of a dump's rows is not run, and nothing of the restore stays", { skip }, async () => {
  // A dump without compression, a page title as a placeholder; then the
  // placeholder's bytes (same length) replaced: the row ends, SQL follows.
  const placeholder = `PLATZHALTER${"Q".repeat(80)}`;
  const pid = await page(placeholder, "<p>x</p>");
  const raw = join(keep, "roh.dump");
  const { dbname, env } = backup.libpqConnection();
  const pgDump = await backup.requireTool("pg_dump");
  const { execFileSync } = await import("node:child_process");
  execFileSync(pgDump, ["--format=custom", "--compress=0", "--no-owner", "--no-privileges", `--schema=${process.env.FLOWPLAN_PG_SCHEMA}`, "--exclude-table=*.search_index", "--exclude-table=*.ai_embedding_vectors", `--file=${raw}`, `--dbname=${dbname}`], { env });
  await run(`CREATE SCHEMA IF NOT EXISTS ${marker}`);
  await run(`CREATE TABLE IF NOT EXISTS ${marker}.hits(what text)`);
  const injected = `\n\\.\nINSERT INTO ${marker}.hits VALUES('copy');\n--`;
  const bytes = readFileSync(raw);
  const at = bytes.indexOf(Buffer.from(placeholder));
  assert.ok(at > 0, "the title is in the uncompressed archive");
  Buffer.from(injected.padEnd(placeholder.length, "-")).copy(bytes, at);
  writeFileSync(raw, bytes);
  await run("UPDATE pages SET title='Vor dem Versuch' WHERE id=?", pid);
  const { SCHEMA_VERSION } = await import("../lib/db");
  // The check of the objects passes (it is a Flowplan dump); the rows are not.
  await (await import("../lib/instance-backup")).checkDumpBackup(raw);
  // Refused at the first line that is neither a row nor one of the dump's
  // own statements (or, should psql be quicker, by the server for the cut row).
  await assert.rejects(backup.restoreDump(raw, { newestVersion: SCHEMA_VERSION }), (e: Error) =>
    e instanceof backup.ForeignObjectsError ? /statement Flowplan does not write/.test(e.message) : /pg_restore\/psql/.test(e.message),
  );
  assert.deepEqual(await markers(), []);
  // One transaction: the data is as it was.
  assert.equal((await one<{ title: string }>("SELECT title FROM pages WHERE id=?", pid))?.title, "Vor dem Versuch");
  assert.ok(await one("SELECT 1 FROM flowplan_meta WHERE key='schema_hash'"));
});

test("a dump of an older schema (a table or column missing) or with a column this version lacks loads into this version's schema", { skip }, async () => {
  const older = join(keep, "aelter.dump");
  await run("ALTER TABLE users DROP COLUMN last_active_at");
  await run("ALTER TABLE pages ADD COLUMN legacy_note text DEFAULT 'alt'");
  await run("DROP TABLE ai_auto_dirty CASCADE");
  await backup.dumpDatabase(older);
  const { SCHEMA_VERSION } = await import("../lib/db");
  // The restore makes the schema anew: the dropped table and column are back.
  await backup.restoreDump(older, { newestVersion: SCHEMA_VERSION });
  assert.equal((await one<{ title: string }>("SELECT title FROM pages WHERE id=?", kept))?.title, "Jahresplanung");
  assert.ok(await one("SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='users' AND column_name='last_active_at'"));
  assert.equal(await one("SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='pages' AND column_name='legacy_note'"), undefined);
  assert.equal(Number((await one<{ n: number }>("SELECT count(*) n FROM ai_auto_dirty"))!.n), 0);
  assert.equal((await one<{ name: string }>("SELECT name FROM users WHERE id=?", uid))?.name, "Bea");
});

test("the TOC check: only Flowplan's own objects, in the instance's schema", () => {
  const line = (n: number, type: string, schema: string, tag: string) => `${n}; 1 2 ${type} ${schema} ${tag} postgres`;
  const own = [line(1, "SCHEMA", "-", "inst"), line(2, "TABLE", "inst", "flowplan_meta"), line(3, "TABLE", "inst", "users"), line(4, "TABLE DATA", "inst", "users")];
  const ok = [
    ...own,
    line(5, "FUNCTION", "inst", "trg_search_page_insert()"),
    line(6, "TRIGGER", "inst", "pages search_page_insert"),
    line(7, "FK CONSTRAINT", "inst", "pages pages_fk0"),
    line(8, "SEQUENCE", "inst", "pages_seq_seq"),
    line(9, "SEQUENCE SET", "inst", "pages_seq_seq"),
    line(10, "INDEX", "inst", "pages_parent"),
    line(11, "EXTENSION", "-", "pg_trgm"),
    line(12, "COMMENT", "-", "EXTENSION pg_trgm"),
    line(13, "FUNCTION", "inst", "flowplan_floats(bytea)"),
    line(14, "TRIGGER", "inst", "ai_embeddings ai_embeddings_vector_sync"),
  ];
  assert.equal(backup.checkTocList(ok.join("\n")), "inst");
  for (const bad of [
    line(20, "FUNCTION", "inst", "evil()"),
    line(20, "FUNCTION", "inst", "trg_search_page_insert(text)"),
    line(20, "TRIGGER", "inst", "users evil"),
    line(20, "EVENT TRIGGER", "-", "evil"),
    line(20, "RULE", "inst", "users evil_rule"),
    line(20, "VIEW", "inst", "evil_view"),
    line(20, "TYPE", "inst", "evil_type"),
    line(20, "OPERATOR", "inst", "+(text,text)"),
    line(20, "CAST", "-", "CAST (text AS integer)"),
    line(20, "DEFAULT ACL", "inst", "DEFAULT PRIVILEGES FOR TABLES"),
    line(20, "POLICY", "inst", "users evil"),
    line(20, "TABLE ATTACH", "inst", "users"),
    line(20, "EXTENSION", "-", "plpython3u"),
    line(20, "SCHEMA", "-", "other"),
    line(20, "FUNCTION", "other", "trg_search_page_insert()"),
    line(20, "TABLE DATA", "inst", "not_flowplan"),
    line(20, "COMMENT", "inst", "TABLE not_flowplan"),
  ])
    assert.throws(() => backup.checkTocList([...own, bad].join("\n")), backup.ForeignObjectsError, bad);
  // A second schema: not a Flowplan dump at all.
  assert.throws(() => backup.checkTocList([...own, line(30, "TABLE", "other", "users")].join("\n")), /not a Flowplan database dump/);
});
