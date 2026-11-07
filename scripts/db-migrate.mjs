// Moves a Flowplan database between SQLite and PostgreSQL, both ways
// (docs/architecture/database.md, "Migration tool"). Skeleton of the spike:
// the tables of the sign-in/tags slice by default, every table with
// --tables all.
//
//   node scripts/db-migrate.mjs --from sqlite:./data/flowplan.sqlite --to postgres://user@host:5432/flowplan
//   node scripts/db-migrate.mjs --from postgres://user@host:5432/flowplan --to sqlite:./new/flowplan.sqlite
//
// Options: --tables slice|all|a,b,c   --batch 1000   --schema public (Postgres)
//          --verify-only (compare counts and checksums, copy nothing)
//
// Stop Flowplan first (or use a copy of the database): the tool reads a
// consistent state only when nothing writes. The schema comes from
// lib/db-driver/postgres-schema.json (the version that wrote the source
// must be this one: PRAGMA user_version / flowplan_meta). Into Postgres the
// target tables must be empty; into SQLite the file must not exist yet.
// Each table is copied in batches ordered by rowid (kept on both sides),
// foreign keys are checked after the copy, identity sequences moved on,
// and every table is compared by row count and an order-independent
// checksum of its canonical values.
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import pg from "pg";
import { ensurePostgresSchema, quoteIdent } from "../lib/db-driver/pg-ddl.mjs";

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
const tablesOption = option("tables", "slice");
const wanted = tablesOption === "all" ? schema.tables.map((t) => t.name) : tablesOption === "slice" ? SLICE : tablesOption.split(",");
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
// The emulated rowid is part of the comparison, except where SQLite's rowid
// is the INTEGER PRIMARY KEY itself.
const rowidIsKey = (t) => t.primaryKey.length === 1 && t.columns.find((c) => c.name === t.primaryKey[0])?.type === "bigint";
const dataColumns = (t) => t.columns.filter((c) => c.name !== "rowid");

// ---- Reading in batches, ordered by rowid ----

async function* sqliteBatches(d, t) {
  const cols = dataColumns(t);
  const select = d.prepare(`SELECT rowid AS "__rowid",${cols.map((c) => `"${c.name}"`).join(",")} FROM "${t.name}" WHERE rowid>? ORDER BY rowid LIMIT ?`);
  select.setReadBigInts(true);
  let last = -(2n ** 63n);
  for (;;) {
    const rows = select.all(last, batchSize);
    if (!rows.length) return;
    last = rows[rows.length - 1].__rowid;
    yield rows.map((r) => ({ ...r, rowid: r.__rowid }));
  }
}
async function* pgBatches(p, t) {
  const cols = dataColumns(t);
  let last = -(2n ** 63n);
  for (;;) {
    const { rows } = await p.client.query(
      `SELECT rowid AS "__rowid",${cols.map((c) => quoteIdent(c.name)).join(",")} FROM ${quoteIdent(t.name)} WHERE rowid>$1 ORDER BY rowid LIMIT $2`,
      [last.toString(), batchSize],
    );
    if (!rows.length) return;
    last = rows[rows.length - 1].__rowid;
    yield rows.map((r) => ({ ...r, rowid: r.__rowid }));
  }
}
async function collect(batches) {
  const rows = [];
  for await (const batch of batches) rows.push(...batch);
  return rows;
}
async function compare(readSource, readTarget) {
  let ok = true;
  console.log(`\n${"table".padEnd(26)} ${"rows".padStart(8)} ${"source checksum".padStart(17)} ${"target checksum".padStart(17)}`);
  for (const t of tables) {
    const cols = [...dataColumns(t), ...(rowidIsKey(t) ? [] : [{ name: "rowid", type: "bigint" }])];
    const [a, b] = [await collect(readSource(t)), await collect(readTarget(t))];
    const [ca, cb] = [checksumOf(a, cols), checksumOf(b, cols)];
    const same = a.length === b.length && ca === cb;
    ok &&= same;
    console.log(`${t.name.padEnd(26)} ${String(a.length).padStart(8)} ${ca.padStart(17)} ${cb.padStart(17)}${same ? "" : `  DIFFERENT (target ${b.length} rows)`}`);
  }
  return ok;
}

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
    await ensurePostgresSchema(p, schema, wanted);
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
      const cols = [...dataColumns(t), ...(rowidIsKey(t) ? [] : [{ name: "rowid", type: "bigint" }])];
      const perBatch = Math.max(1, Math.min(batchSize, Math.floor(60_000 / cols.length)));
      let copied = 0;
      await p.client.query("BEGIN");
      for await (const rows of readSqlite(t))
        for (let i = 0; i < rows.length; i += perBatch) {
          const part = rows.slice(i, i + perBatch);
          const values = [];
          const tuples = part.map((row, r) => `(${cols.map((c, k) => (values.push(toPg(row[c.name], c.type, `${t.name} rowid ${row.rowid}, ${c.name}`)), `$${r * cols.length + k + 1}`)).join(",")})`);
          await p.client.query(`INSERT INTO ${quoteIdent(t.name)}(${cols.map((c) => quoteIdent(c.name)).join(",")}) VALUES ${tuples.join(",")}`, values);
          copied += part.length;
        }
      // Identity columns continue after the copied values.
      for (const c of t.columns.filter((c) => c.identity))
        await p.client.query(
          `SELECT setval(pg_get_serial_sequence($1,$2), COALESCE((SELECT max(${quoteIdent(c.name)}) FROM ${quoteIdent(t.name)}),0)+1, false)`,
          [quoteIdent(t.name), c.name],
        );
      await p.client.query("COMMIT");
      console.log(`${t.name.padEnd(26)} ${String(copied).padStart(8)} rows`);
    }
    await ensurePostgresSchema(p, schema, wanted);
    await p.client.query("INSERT INTO flowplan_meta(key,value) VALUES('migrated_from',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [
      JSON.stringify({ from: "sqlite", at: new Date().toISOString(), tables: wanted.length }),
    ]);
    await p.client.query("ANALYZE");
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
      const cols = [...(rowidIsKey(t) ? [] : [{ name: "rowid", type: "bigint" }]), ...dataColumns(t)];
      const insert = d.prepare(`INSERT INTO "${t.name}"(${cols.map((c) => `"${c.name}"`).join(",")}) VALUES(${cols.map(() => "?").join(",")})`);
      let copied = 0;
      for await (const rows of readPg(t)) {
        d.exec("BEGIN");
        for (const row of rows) insert.run(...cols.map((c) => (row[c.name] instanceof Buffer ? new Uint8Array(row[c.name]) : row[c.name] ?? null)));
        d.exec("COMMIT");
        copied += rows.length;
      }
      console.log(`${t.name.padEnd(26)} ${String(copied).padStart(8)} rows`);
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
