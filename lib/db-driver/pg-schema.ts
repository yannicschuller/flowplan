// The PostgreSQL schema, translated from the SQLite schema that lib/db.ts
// builds (docs/architecture/database.md, "Schema"). The SQLite migrations
// stay the one source of truth; scripts/db-pg-schema.mjs runs them on an
// empty database, reads the result through PRAGMA (columns, keys, foreign
// keys, the collation of unique keys) and the CREATE INDEX texts, and writes
// lib/db-driver/postgres-schema.json. ensurePostgresSchema() brings a
// Postgres database up to that state: missing tables, columns, indexes and
// foreign keys are added (never dropped). Triggers and the FTS5 search index
// are not translated (listed under `skipped`); Postgres gets its own search
// (tsvector) and queue design.
import type { DatabaseSync } from "node:sqlite";
import type { Db } from "./types";
import { postgresDialect } from "./dialect";

export type PgColumn = { name: string; type: string; notNull: boolean; default: string | null; identity: boolean };
export type PgForeignKey = { name: string; columns: string[]; table: string; to: string[]; onDelete: string; onUpdate: string };
export type PgTable = { name: string; columns: PgColumn[]; primaryKey: string[]; uniques: string[][]; checks: string[]; foreignKeys: PgForeignKey[] };
export type PgIndex = { name: string; table: string; sql: string };
export type PgSchema = { sqliteVersion: number; tables: PgTable[]; indexes: PgIndex[]; skipped: { kind: string; name: string; reason: string }[] };

// Words Postgres reserves (fully, or as function/type names) that appear as
// identifiers; quoted in the DDL. Queries that use them (time_entries.end)
// must quote them as well.
const RESERVED = new Set(
  "all analyse analyze and any array as asc asymmetric authorization binary both case cast check collate collation column concurrently constraint create cross current_catalog current_date current_role current_schema current_time current_timestamp current_user default deferrable desc distinct do else end except false fetch for foreign freeze from full grant group having ilike in initially inner intersect into is isnull join lateral leading left like limit localtime localtimestamp natural not notnull null offset on only or order outer overlaps placing primary references returning right select session_user similar some symmetric system_user table tablesample then to trailing true union unique user using variadic verbose when where window with".split(
    " ",
  ),
);
export const quoteIdent = (name: string) => (RESERVED.has(name.toLowerCase()) || !/^[a-z_][a-z0-9_]*$/.test(name) ? `"${name.replace(/"/g, '""')}"` : name);

function pgType(declared: string, primaryKeyInteger: boolean) {
  const t = declared.toUpperCase();
  if (primaryKeyInteger) return "bigint";
  if (t.includes("INT")) return "bigint";
  if (/REAL|FLOA|DOUB/.test(t)) return "double precision";
  if (t.includes("BLOB")) return "bytea";
  if (/TEXT|CHAR|CLOB/.test(t)) return "text";
  if (t === "") return "text";
  return "double precision";
}
// A SQLite expression (defaults, CHECK, index columns and WHERE) in Postgres.
export function translateExpression(sql: string) {
  return quoteReserved(
    sql
      .replace(/\bifnull\s*\(/gi, "coalesce(")
      .replace(/([A-Za-z_][A-Za-z0-9_."]*)\s+COLLATE\s+NOCASE/gi, "lower($1)")
      .replace(/\bunixepoch\(\)\s*\*\s*1000/gi, postgresDialect.nowMs()),
  );
}
// Reserved words used as bare column names (outside strings) get quotes.
function quoteReserved(sql: string) {
  return sql.replace(/('(?:[^']|'')*')|("(?:[^"]|"")*")|\b([A-Za-z_][A-Za-z0-9_]*)\b(?!\s*\()/g, (m, s, q, word) =>
    s || q ? m : RESERVED.has(word.toLowerCase()) && /^(end|user|order|limit|offset|default|group|check|column|table)$/i.test(word) ? `"${word}"` : m,
  );
}
function defaultValue(raw: string | null, type: string): string | null {
  if (raw === null) return null;
  if (/^CURRENT_TIMESTAMP$/i.test(raw)) return type === "text" ? postgresDialect.nowText() : "now()";
  return translateExpression(raw);
}
// CHECK(…) clauses of a CREATE TABLE text (balanced parentheses).
function checks(sql: string): string[] {
  const out: string[] = [];
  const re = /\bCHECK\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < sql.length && depth; i++) {
      if (sql[i] === "'") i = sql.indexOf("'", i + 1);
      else if (sql[i] === "(") depth++;
      else if (sql[i] === ")") depth--;
    }
    out.push(translateExpression(sql.slice(start, i - 1)));
  }
  return out;
}

type Info = { cid: number; name: string; type: string; notnull: number; dflt_value: string | null; pk: number };
export function translateSqliteSchema(d: DatabaseSync): PgSchema {
  const objects = d.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY rowid").all() as { type: string; name: string; tbl_name: string; sql: string | null }[];
  const skipped: PgSchema["skipped"] = [];
  const virtual = new Set(objects.filter((o) => o.type === "table" && /^CREATE VIRTUAL TABLE/i.test(o.sql || "")).map((o) => o.name));
  const shadow = (name: string) => [...virtual].some((v) => name.startsWith(`${v}_`));
  const tables: PgTable[] = [];
  const nocaseIndexes: PgIndex[] = [];
  for (const o of objects) {
    if (o.type === "trigger") skipped.push({ kind: "trigger", name: o.name, reason: "triggers are ported by hand (plpgsql) or replaced" });
    if (o.type !== "table") continue;
    if (virtual.has(o.name)) {
      skipped.push({ kind: "table", name: o.name, reason: "FTS5 virtual table: Postgres search uses tsvector" });
      continue;
    }
    if (shadow(o.name) || o.name.startsWith("sqlite_")) continue;
    const sql = o.sql || "";
    const info = d.prepare(`PRAGMA table_info("${o.name}")`).all() as Info[];
    const pk = info.filter((c) => c.pk).sort((a, b) => a.pk - b.pk);
    const autoincrement = /AUTOINCREMENT/i.test(sql);
    const columns: PgColumn[] = info.map((c) => {
      const integerKey = pk.length === 1 && pk[0].name === c.name && c.type.toUpperCase() === "INTEGER";
      const type = pgType(c.type, integerKey);
      const identity = integerKey && autoincrement;
      return { name: c.name, type, notNull: !!c.notnull, default: identity ? null : defaultValue(c.dflt_value, type), identity };
    });
    // Unique constraints (not the primary key), with their collation: a
    // NOCASE one becomes a unique index on lower(…).
    const uniques: string[][] = [];
    const indexes = d.prepare(`PRAGMA index_list("${o.name}")`).all() as { name: string; unique: number; origin: string }[];
    for (const index of indexes.filter((i) => i.origin === "u")) {
      const cols = (d.prepare(`PRAGMA index_xinfo("${index.name}")`).all() as { name: string | null; coll: string; key: number }[]).filter((c) => c.key && c.name);
      if (cols.some((c) => c.coll.toUpperCase() === "NOCASE"))
        nocaseIndexes.push({
          name: `${o.name}_${cols.map((c) => c.name).join("_")}_nocase`,
          table: o.name,
          sql: `CREATE UNIQUE INDEX IF NOT EXISTS ${o.name}_${cols.map((c) => c.name).join("_")}_nocase ON ${quoteIdent(o.name)}(${cols.map((c) => (c.coll.toUpperCase() === "NOCASE" ? `lower(${quoteIdent(c.name!)})` : quoteIdent(c.name!))).join(",")})`,
        });
      else uniques.push(cols.map((c) => c.name!));
    }
    const fks = d.prepare(`PRAGMA foreign_key_list("${o.name}")`).all() as { id: number; seq: number; table: string; from: string; to: string | null; on_update: string; on_delete: string }[];
    const foreignKeys: PgForeignKey[] = [];
    for (const fk of fks) {
      let entry = foreignKeys[fk.id];
      if (!entry) entry = foreignKeys[fk.id] = { name: `${o.name}_fk${fk.id}`, columns: [], table: fk.table, to: [], onDelete: fk.on_delete, onUpdate: fk.on_update };
      entry.columns.push(fk.from);
      if (fk.to) entry.to.push(fk.to);
    }
    // SQLite's implicit rowid: 32 queries order by it (insertion order as a
    // tiebreaker) and a few delete by it. Postgres gets it as a real column,
    // last, so INSERT … VALUES without a column list still fits; the
    // drivers leave it out of results unless the SQL names it.
    if (!columns.some((c) => c.name === "rowid") && !/WITHOUT ROWID/i.test(sql))
      columns.push({ name: "rowid", type: "bigint", notNull: true, default: null, identity: true });
    tables.push({ name: o.name, columns, primaryKey: pk.map((c) => c.name), uniques, checks: checks(sql), foreignKeys: foreignKeys.filter(Boolean) });
  }
  // Foreign keys need a key on the other side (SQLite checks that only when
  // a row is written); `REFERENCES t` without columns means t's primary key.
  const byName = new Map(tables.map((t) => [t.name, t]));
  for (const t of tables)
    t.foreignKeys = t.foreignKeys.filter((fk) => {
      const target = byName.get(fk.table);
      if (!target) {
        skipped.push({ kind: "foreign key", name: `${t.name}(${fk.columns}) → ${fk.table}`, reason: "target table missing" });
        return false;
      }
      if (!fk.to.length) fk.to = target.primaryKey;
      const keyed = [target.primaryKey, ...target.uniques].some((k) => k.length === fk.to.length && k.every((c) => fk.to.includes(c)));
      if (!keyed) skipped.push({ kind: "foreign key", name: `${t.name}(${fk.columns}) → ${fk.table}(${fk.to})`, reason: "target columns are not a key" });
      return keyed;
    });
  const indexes: PgIndex[] = nocaseIndexes;
  for (const o of objects.filter((x) => x.type === "index" && x.sql)) {
    if (!byName.has(o.tbl_name)) {
      skipped.push({ kind: "index", name: o.name, reason: `on ${o.tbl_name} (not translated)` });
      continue;
    }
    indexes.push({ name: o.name, table: o.tbl_name, sql: translateExpression(o.sql!.replace(/^CREATE\s+(UNIQUE\s+)?INDEX\s+(IF NOT EXISTS\s+)?/i, (_m, u) => `CREATE ${u || ""}INDEX IF NOT EXISTS `)) });
  }
  const version = Number((d.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  return { sqliteVersion: version, tables, indexes, skipped };
}

const action = (a: string) => (/^(CASCADE|SET NULL|SET DEFAULT|RESTRICT)$/i.test(a) ? a.toUpperCase() : "NO ACTION");
function columnDdl(c: PgColumn) {
  return `${quoteIdent(c.name)} ${c.type}${c.identity ? " GENERATED BY DEFAULT AS IDENTITY" : ""}${c.notNull ? " NOT NULL" : ""}${c.default !== null ? ` DEFAULT ${c.default}` : ""}`;
}
export function createTableSql(t: PgTable) {
  const parts = t.columns.map(columnDdl);
  if (t.primaryKey.length) parts.push(`PRIMARY KEY(${t.primaryKey.map(quoteIdent).join(",")})`);
  for (const u of t.uniques) parts.push(`UNIQUE(${u.map(quoteIdent).join(",")})`);
  for (const c of t.checks) parts.push(`CHECK(${c})`);
  return `CREATE TABLE IF NOT EXISTS ${quoteIdent(t.name)}(${parts.join(",")})`;
}
export function foreignKeySql(t: PgTable, fk: PgForeignKey) {
  return `ALTER TABLE ${quoteIdent(t.name)} ADD CONSTRAINT ${quoteIdent(fk.name)} FOREIGN KEY(${fk.columns.map(quoteIdent).join(",")}) REFERENCES ${quoteIdent(fk.table)}(${fk.to.map(quoteIdent).join(",")}) ON DELETE ${action(fk.onDelete)} ON UPDATE ${action(fk.onUpdate)}`;
}

// Brings the Postgres schema up to `schema`: adds what is missing. `only`
// limits it to some tables (and their indexes and foreign keys among them).
export async function ensurePostgresSchema(db: Db, schema: PgSchema, only?: string[]) {
  const tables = only ? schema.tables.filter((t) => only.includes(t.name)) : schema.tables;
  const names = new Set(tables.map((t) => t.name));
  await db.exec("CREATE TABLE IF NOT EXISTS flowplan_meta(key text PRIMARY KEY,value text NOT NULL)");
  for (const t of tables) {
    await db.exec(createTableSql(t));
    const have = new Set(await db.columns(t.name));
    for (const c of t.columns) if (!have.has(c.name)) await db.exec(`ALTER TABLE ${quoteIdent(t.name)} ADD COLUMN ${columnDdl(c)}`);
  }
  for (const index of schema.indexes) if (names.has(index.table)) await db.exec(index.sql);
  const existing = new Set((await db.all<{ conname: string }>("SELECT conname FROM pg_constraint WHERE connamespace=current_schema()::regnamespace AND contype='f'")).map((r) => r.conname));
  for (const t of tables)
    for (const fk of t.foreignKeys) if (names.has(fk.table) && !existing.has(fk.name)) await db.exec(foreignKeySql(t, fk));
  await db.run(
    "INSERT INTO flowplan_meta(key,value) VALUES('sqlite_schema',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    String(schema.sqliteVersion),
  );
}
