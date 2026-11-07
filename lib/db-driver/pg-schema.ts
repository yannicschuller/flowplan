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
import { translateTrigger, type PgTrigger } from "./pg-triggers";

export type PgColumn = { name: string; type: string; notNull: boolean; default: string | null; identity: boolean };
export type PgForeignKey = { name: string; columns: string[]; table: string; to: string[]; onDelete: string; onUpdate: string };
export type PgTable = { name: string; columns: PgColumn[]; primaryKey: string[]; uniques: string[][]; checks: string[]; foreignKeys: PgForeignKey[] };
export type PgIndex = { name: string; table: string; sql: string };
// `sqlite`: the objects of the SQLite schema as SQLite itself has them
// (tables, indexes, triggers, the FTS5 table), so the way back to SQLite
// (scripts/db-migrate.mjs) builds the same schema without running lib/db.ts.
export type SqliteObject = { type: string; name: string; table: string; sql: string };
export type PgSchema = {
  sqliteVersion: number;
  tables: PgTable[];
  indexes: PgIndex[];
  // The SQLite triggers in PL/pgSQL (pg-triggers.ts), created after the
  // tables (and, by the migration tool, after the data).
  triggers: PgTrigger[];
  // Rows the SQLite migrations write into an empty database (defaults,
  // control rows); a timestamp of the moment of creation as "now".
  seed: { table: string; rows: Record<string, string | number | null>[] }[];
  skipped: { kind: string; name: string; reason: string }[];
  sqlite: SqliteObject[];
};

// The DDL itself (and ensurePostgresSchema) is plain JavaScript in
// pg-ddl.mjs, so scripts/db-migrate.mjs runs without the TypeScript loader.
import { RESERVED, quoteIdent, createTableSql, foreignKeySql, ensurePostgresSchema as ensure } from "./pg-ddl.mjs";
export { quoteIdent, createTableSql, foreignKeySql };

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

// Postgres' search index (lib/search-store.ts): the entries of SQLite's
// FTS5 table plus their text folded for matching (lower case, without
// diacritics), as the trigram tokenizer with remove_diacritics compares.
const SEARCH_INDEX: PgTable = {
  name: "search_index",
  columns: [
    { name: "id", type: "bigint", notNull: true, default: null, identity: true },
    ...["page_id", "row_id", "title", "body", "title_folded", "body_folded"].map((name) => ({ name, type: "text", notNull: true, default: "''", identity: false })),
  ],
  primaryKey: ["id"],
  uniques: [],
  checks: [],
  foreignKeys: [],
};

type Info = { cid: number; name: string; type: string; notnull: number; dflt_value: string | null; pk: number };
export function translateSqliteSchema(d: DatabaseSync): PgSchema {
  const objects = d.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY rowid").all() as { type: string; name: string; tbl_name: string; sql: string | null }[];
  const skipped: PgSchema["skipped"] = [];
  const virtual = new Set(objects.filter((o) => o.type === "table" && /^CREATE VIRTUAL TABLE/i.test(o.sql || "")).map((o) => o.name));
  const shadow = (name: string) => [...virtual].some((v) => name.startsWith(`${v}_`));
  const tables: PgTable[] = [];
  const nocaseIndexes: PgIndex[] = [];
  const triggers: PgTrigger[] = [];
  for (const o of objects) {
    if (o.type === "trigger") {
      // `<table>_seq` fills SQLite's insertion order; Postgres has an identity.
      if (/_seq$/.test(o.name) && /SET seq=NEW\.rowid/.test(o.sql || ""))
        skipped.push({ kind: "trigger", name: o.name, reason: "seq is an identity column in Postgres" });
      else triggers.push(translateTrigger(o.sql!));
    }
    if (o.type !== "table") continue;
    if (virtual.has(o.name)) {
      skipped.push({ kind: "table", name: o.name, reason: "FTS5 virtual table: a plain table in Postgres (lib/search-store.ts)" });
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
      // `seq` (schema 94): the insertion order SQLite takes from the rowid.
      const identity = (integerKey && autoincrement) || (c.name === "seq" && type === "bigint");
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
  const sqlite = objects
    .filter((o) => o.sql && !o.name.startsWith("sqlite_") && !shadow(o.name))
    .map((o) => ({ type: o.type, name: o.name, table: o.tbl_name, sql: o.sql! }));
  // The FTS5 search index: a plain table in Postgres (lib/search-store.ts).
  tables.push(SEARCH_INDEX);
  indexes.push({ name: "search_index_key", table: "search_index", sql: "CREATE INDEX IF NOT EXISTS search_index_key ON search_index(page_id,row_id)" });
  const seed: PgSchema["seed"] = [];
  const now = Date.now();
  for (const t of tables) {
    if (t.name === "search_index") continue;
    const rows = d.prepare(`SELECT * FROM "${t.name}"`).all() as Record<string, string | number | null>[];
    if (rows.length)
      seed.push({
        table: t.name,
        rows: rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "number" && Math.abs(v - now) < 86_400_000 ? "now" : v]))),
      });
  }
  return { sqliteVersion: version, tables, indexes, triggers, seed, skipped, sqlite };
}

// Brings the Postgres schema up to `schema`: adds what is missing. `only`
// limits it to some tables (and their indexes and foreign keys among them).
export async function ensurePostgresSchema(db: Db, schema: PgSchema, only?: string[], options: { triggers?: boolean; seed?: boolean } = {}): Promise<void> {
  await ensure(db, schema, only, options);
}
