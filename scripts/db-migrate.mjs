// Moves a Flowplan database between SQLite and PostgreSQL, both ways
// (docs/architecture/database.md, §6 "Migration tool": the whole procedure
// with downtime, files and checks). Every table by default; --tables slice
// (the spike's sign-in/tags tables) or a list for tests.
//
//   node scripts/db-migrate.mjs --from sqlite:./data/flowplan.sqlite --to postgres://user@host:5432/flowplan
//   node scripts/db-migrate.mjs --from postgres://user@host:5432/flowplan --to sqlite:./new/flowplan.sqlite
//
// Options: --tables all|slice|a,b,c   --batch 1000   --schema public (Postgres)
//          --verify-only (compare counts and checksums, copy nothing)
//          --quiet (no progress lines)
//
// Stop Flowplan first (or use a copy of the database): the tool reads a
// consistent state only when nothing writes. The schema comes from
// lib/db-driver/postgres-schema.json (the version that wrote the source
// must be this one: PRAGMA user_version / flowplan_meta). Into Postgres the
// target tables must be empty; into SQLite the file must not exist yet.
// Each table is copied in batches in the order of its primary key (seq
// columns – the order of insertion, schema 94 – keep their values), foreign
// keys are checked after the copy, triggers created after it (they would
// fire for every copied row), identity sequences moved on, and every table
// is compared by row count and an order-independent checksum of its
// canonical values. Derived data is not copied but rebuilt by Flowplan at
// its first start: the search index (FTS5 / the trigram table), pgvector's
// table (from ai_embeddings, lib/ai/vector-store.ts).
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import pg from "pg";
import { ensurePostgresSchema, ensurePostgresTriggers, quoteIdent } from "../lib/db-driver/pg-ddl.mjs";

const SLICE = ["users", "sessions", "local_accounts", "api_tokens", "auth_tokens", "login_failures", "passkeys", "workspaces", "spaces", "members", "page_tags"];

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const from = option("from");
const to = option("to");
if (!from || !to) {
  console.error("usage: node scripts/db-migrate.mjs --from sqlite:<file>|postgres://… --to postgres://…|sqlite:<file> [--tables slice|all|a,b] [--batch 1000] [--schema public] [--verify-only]");
  process.exit(2);
}
const batchSize = Number(option("batch", "1000"));
const pgSchemaName = option("schema", "public");
const verifyOnly = args.includes("--verify-only");
const schema = JSON.parse(readFileSync(new URL("../lib/db-driver/postgres-schema.json", import.meta.url), "utf8"));
const tablesOption = option("tables", "all");
const quiet = args.includes("--quiet");
// The search index (FTS5 in SQLite, a plain table in Postgres) is rebuilt.
const wanted = (tablesOption === "all" ? schema.tables.map((t) => t.name) : tablesOption === "slice" ? SLICE : tablesOption.split(",")).filter((n) => n !== "search_index");
const tables = schema.tables.filter((t) => wanted.includes(t.name));
for (const name of wanted) if (!tables.some((t) => t.name === name)) throw new Error(`unknown table ${name}`);

const isPg = (s) => /^postgres(ql)?:\/\//i.test(s);
const sqlitePath = (s) => (s.startsWith("sqlite:") ? s.slice(7) : null);
if (isPg(from) === isPg(to)) throw new Error("one side SQLite (sqlite:<file>), the other Postgres (postgres://…)");

// ---- Postgres ----

// 64-bit integers as BigInt, booleans as 1/0: exact both ways.
const types = {
  getTypeParser(oid, format) {
    if (oid === 20) return (v) => BigInt(v);
    if (oid === 16) return (v) => (v === "t" ? 1 : 0);
    return pg.types.getTypeParser(oid, format);
  },
};
// `?` → $n for the few statements of ensurePostgresSchema.
const numbered = (sql) => {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
};
async function postgres(url) {
  const client = new pg.Client({ connectionString: url, types, options: `-c search_path=${pgSchemaName}` });
  await client.connect();
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(pgSchemaName)}`);
  return {
    client,
    // The small interface ensurePostgresSchema needs.
    exec: (sql) => client.query(sql).then(() => {}),
    all: (sql, ...params) => client.query(numbered(sql), params).then((r) => r.rows),
    run: (sql, ...params) => client.query(numbered(sql), params),
    columns: async (table) =>
      (await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1", [table])).rows.map((r) => r.column_name),
  };
}

// ---- Values ----

// A value as the Postgres column type expects it (into Postgres), and its
// canonical text for the checksum (both sides).
function toPg(value, type, where) {
  if (value === null || value === undefined) return null;
  if (type === "bigint") {
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "number" && Number.isInteger(value)) return String(value);
    if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return value.trim();
    throw new Error(`${where}: ${JSON.stringify(String(value)).slice(0, 80)} is not an integer (SQLite keeps any value in any column)`);
  }
  if (type === "double precision") {
    const n = typeof value === "string" ? Number(value) : Number(value);
    if (Number.isNaN(n)) throw new Error(`${where}: ${JSON.stringify(String(value)).slice(0, 80)} is not a number`);
    return n;
  }
  if (type === "bytea") return value instanceof Uint8Array ? Buffer.from(value.buffer, value.byteOffset, value.byteLength) : Buffer.from(String(value));
  const text = value instanceof Uint8Array ? Buffer.from(value).toString("utf8") : String(value);
  if (text.includes("\u0000")) throw new Error(`${where}: text with a NUL character (Postgres text cannot hold it)`);
  return text;
}
function canonical(value, type) {
  if (value === null || value === undefined) return null;
  if (type === "bigint") return BigInt(typeof value === "number" ? Math.trunc(value) : value).toString();
  if (type === "double precision") return String(Number(value));
  if (type === "bytea") return Buffer.from(value instanceof Uint8Array ? value : Buffer.from(String(value))).toString("hex");
  return value instanceof Uint8Array ? Buffer.from(value).toString("utf8") : String(value);
}
// Order-independent: the sum of the rows' 64-bit hashes.
function checksumOf(rows, columns) {
  let sum = 0n;
  for (const row of rows) {
    const text = JSON.stringify(columns.map((c) => canonical(row[c.name], c.type)));
    sum = (sum + createHash("sha256").update(text).digest().readBigUInt64BE(0)) & 0xffffffffffffffffn;
  }
  return sum.toString(16).padStart(16, "0");
}
const dataColumns = (t) => t.columns;

// ---- Reading in batches, in key order ----

// Keyset pagination by the primary key; a table without one (a few small
// link tables) in pages by offset over all its columns.
function pageQuery(t, quote, placeholder) {
  const cols = dataColumns(t).map((c) => quote(c.name));
  const key = (t.primaryKey.length ? t.primaryKey : dataColumns(t).map((c) => c.name)).map(quote);
  const order = key.join(",");
  return (after, offset) =>
    t.primaryKey.length
      ? `SELECT ${cols.join(",")} FROM ${quote(t.name)}${after ? ` WHERE (${order})>(${key.map((_, i) => placeholder(i + 1)).join(",")})` : ""} ORDER BY ${order} LIMIT ${batchSize}`
      : `SELECT ${cols.join(",")} FROM ${quote(t.name)} ORDER BY ${order} LIMIT ${batchSize} OFFSET ${offset}`;
}
const lastKey = (t, rows) => (t.primaryKey.length ? t.primaryKey.map((k) => rows[rows.length - 1][k]) : null);
async function* sqliteBatches(d, t) {
  const query = pageQuery(t, (n) => `"${n}"`, () => "?");
  let after = null;
  for (let offset = 0; ; ) {
    const select = d.prepare(query(after, offset));
    select.setReadBigInts(true);
    const rows = select.all(...(after ?? []));
    if (!rows.length) return;
    yield rows;
    if (rows.length < batchSize) return;
    after = lastKey(t, rows);
    offset += rows.length;
  }
}
async function* pgBatches(p, t) {
  const query = pageQuery(t, quoteIdent, (i) => `$${i}`);
  let after = null;
  for (let offset = 0; ; ) {
    const { rows } = await p.client.query(query(after, offset), (after ?? []).map((v) => (typeof v === "bigint" ? v.toString() : v)));
    if (!rows.length) return;
    yield rows;
    if (rows.length < batchSize) return;
    after = lastKey(t, rows);
    offset += rows.length;
  }
}
// Count and checksum batch by batch: memory stays bounded for large tables.
async function summarise(batches, cols) {
  let rows = 0,
    sum = 0n;
  for await (const batch of batches) {
    rows += batch.length;
    sum = (sum + BigInt(`0x${checksumOf(batch, cols)}`)) & 0xffffffffffffffffn;
  }
  return { rows, checksum: sum.toString(16).padStart(16, "0") };
}
async function compare(readSource, readTarget) {
  let ok = true;
  console.log(`\n${"table".padEnd(26)} ${"rows".padStart(8)} ${"source checksum".padStart(17)} ${"target checksum".padStart(17)}`);
  // search_state is emptied on the target on purpose (the index is rebuilt).
  for (const t of tables.filter((x) => verifyOnly || x.name !== "search_state")) {
    const cols = dataColumns(t);
    const [a, b] = [await summarise(readSource(t), cols), await summarise(readTarget(t), cols)];
    const same = a.rows === b.rows && a.checksum === b.checksum;
    ok &&= same;
    if (!quiet || !same)
      console.log(`${t.name.padEnd(26)} ${String(a.rows).padStart(8)} ${a.checksum.padStart(17)} ${b.checksum.padStart(17)}${same ? "" : `  DIFFERENT (target ${b.rows} rows)`}`);
  }
  return ok;
}
const progress = (t, copied) => {
  if (!quiet && process.stdout.isTTY) process.stdout.write(`\r${t.name.padEnd(26)} ${String(copied).padStart(8)} rows …`);
};

// ---- SQLite → Postgres ----

async function sqliteToPostgres(file, url) {
  if (!existsSync(file)) throw new Error(`${file} does not exist`);
  const d = new DatabaseSync(file, { readOnly: true });
  const version = Number(d.prepare("PRAGMA user_version").get().user_version);
  if (version !== schema.sqliteVersion)
    throw new Error(`${file} has schema ${version}, this version writes ${schema.sqliteVersion}: start this Flowplan version on it once (or use the matching version of the tool).`);
  const p = await postgres(url);
  const readSqlite = (t) => sqliteBatches(d, t);
  const readPg = (t) => pgBatches(p, t);
  if (!verifyOnly) {
    await ensurePostgresSchema(p, schema, wanted, { triggers: false, seed: false });
    for (const t of tables) {
      const { rows } = await p.client.query(`SELECT 1 FROM ${quoteIdent(t.name)} LIMIT 1`);
      if (rows.length) throw new Error(`${t.name} in Postgres is not empty: migrate into an empty database or schema.`);
    }
    // Foreign keys go while copying (parents and children in any order, no
    // superuser needed) and come back afterwards, checked against the data.
    const fks = (
      await p.client.query(
        "SELECT conrelid::regclass::text tbl,conname FROM pg_constraint WHERE connamespace=current_schema()::regnamespace AND contype='f' AND conrelid::regclass::text = ANY($1)",
        [tables.map((t) => quoteIdent(t.name))],
      )
    ).rows;
    for (const fk of fks) await p.client.query(`ALTER TABLE ${fk.tbl} DROP CONSTRAINT ${quoteIdent(fk.conname)}`);
    const started = Date.now();
    for (const t of tables) {
      const cols = dataColumns(t);
      const perBatch = Math.max(1, Math.min(batchSize, Math.floor(60_000 / cols.length)));
      let copied = 0;
      await p.client.query("BEGIN");
      for await (const rows of readSqlite(t))
        for (let i = 0; i < rows.length; i += perBatch) {
          const part = rows.slice(i, i + perBatch);
          const values = [];
          const tuples = part.map((row, r) => `(${cols.map((c, k) => (values.push(toPg(row[c.name], c.type, `${t.name} ${JSON.stringify(t.primaryKey.map((k) => String(row[k])))}, ${c.name}`)), `$${r * cols.length + k + 1}`)).join(",")})`);
          await p.client.query(`INSERT INTO ${quoteIdent(t.name)}(${cols.map((c) => quoteIdent(c.name)).join(",")}) VALUES ${tuples.join(",")}`, values);
          copied += part.length;
          progress(t, copied);
        }
      // Identity columns continue after the copied values.
      for (const c of t.columns.filter((c) => c.identity))
        await p.client.query(
          `SELECT setval(pg_get_serial_sequence($1,$2), COALESCE((SELECT max(${quoteIdent(c.name)}) FROM ${quoteIdent(t.name)}),0)+1, false)`,
          [quoteIdent(t.name), c.name],
        );
      await p.client.query("COMMIT");
      if (!quiet) console.log(`\r${t.name.padEnd(26)} ${String(copied).padStart(8)} rows  `);
    }
    // The search index's table (empty: Flowplan fills it) besides the copy.
    await ensurePostgresSchema(p, schema, [...wanted, "search_index"], { triggers: false, seed: false });
    // Triggers last: they would have fired for every copied row.
    await ensurePostgresTriggers(p, schema, wanted);
    // The search index is built anew from the data.
    if (wanted.includes("search_state")) await p.client.query("DELETE FROM search_state");
    await p.client.query("INSERT INTO flowplan_meta(key,value) VALUES('migrated_from',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [
      JSON.stringify({ from: "sqlite", at: new Date().toISOString(), tables: wanted.length }),
    ]);
    // Statistics for the planner, of the copied tables (not the whole database).
    for (const t of tables) await p.client.query(`ANALYZE ${quoteIdent(t.name)}`);
    console.log(`copied in ${((Date.now() - started) / 1000).toFixed(1)} s; foreign keys checked`);
  }
  const ok = await compare(readSqlite, readPg);
  await p.client.end();
  d.close();
  return ok;
}

// ---- Postgres → SQLite ----

async function postgresToSqlite(url, file) {
  const p = await postgres(url);
  const stored = (await p.client.query("SELECT value FROM flowplan_meta WHERE key='sqlite_schema'").catch(() => ({ rows: [] }))).rows[0]?.value;
  if (stored && Number(stored) !== schema.sqliteVersion) throw new Error(`the Postgres database has schema ${stored}, this version ${schema.sqliteVersion}`);
  if (!verifyOnly && existsSync(file)) throw new Error(`${file} exists already: the way back writes a new file.`);
  if (!verifyOnly) mkdirSync(dirname(file), { recursive: true });
  const d = new DatabaseSync(file);
  const readPg = (t) => pgBatches(p, t);
  const readSqlite = (t) => sqliteBatches(d, t);
  if (!verifyOnly) {
    d.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=OFF;");
    // The schema exactly as SQLite had it: tables first, then (after the
    // copy, faster and without triggers firing) indexes and triggers.
    for (const o of schema.sqlite.filter((x) => x.type === "table")) d.exec(o.sql);
    const started = Date.now();
    for (const t of tables) {
      const cols = dataColumns(t);
      const insert = d.prepare(`INSERT INTO "${t.name}"(${cols.map((c) => `"${c.name}"`).join(",")}) VALUES(${cols.map(() => "?").join(",")})`);
      let copied = 0;
      for await (const rows of readPg(t)) {
        d.exec("BEGIN");
        for (const row of rows) insert.run(...cols.map((c) => (row[c.name] instanceof Buffer ? new Uint8Array(row[c.name]) : row[c.name] ?? null)));
        d.exec("COMMIT");
        copied += rows.length;
        progress(t, copied);
      }
      if (!quiet) console.log(`\r${t.name.padEnd(26)} ${String(copied).padStart(8)} rows  `);
    }
    for (const o of schema.sqlite.filter((x) => x.type !== "table")) d.exec(o.sql);
    // The search index is not in Postgres: Flowplan rebuilds it on start.
    d.exec("DELETE FROM search_state");
    d.exec(`PRAGMA user_version=${schema.sqliteVersion}`);
    d.exec("PRAGMA foreign_keys=ON");
    const broken = d.prepare("PRAGMA foreign_key_check").all();
    const own = broken.filter((b) => wanted.includes(b.table));
    if (own.length) throw new Error(`foreign keys broken after the copy: ${JSON.stringify(own.slice(0, 5))}`);
    console.log(`copied in ${((Date.now() - started) / 1000).toFixed(1)} s; foreign keys checked${broken.length ? ` (${broken.length} rows point to tables not copied)` : ""}`);
  }
  const ok = await compare(readPg, readSqlite);
  await p.client.end();
  d.close();
  return ok;
}

const ok = isPg(to) ? await sqliteToPostgres(sqlitePath(from) ?? from, to) : await postgresToSqlite(from, sqlitePath(to) ?? to);
console.log(ok ? "\nverified: every table has the same rows" : "\nDIFFERENCES found");
process.exit(ok ? 0 : 1);
