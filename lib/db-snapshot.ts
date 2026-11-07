// A consistent copy of the whole database as a SQLite file, the format of
// instance backups, scheduled backups and instance moves. On SQLite that is
// VACUUM INTO. On PostgreSQL the same file is written from the data: the
// SQLite schema of this version (from the translated schema,
// lib/db-driver/postgres-schema.json), every table copied in key order in
// one REPEATABLE READ transaction, then indexes and triggers, the schema
// version; the search index is rebuilt by the instance that opens the file.
// So a backup taken on PostgreSQL restores on SQLite and vice versa
// (scripts/db-migrate.mjs does the same for whole instances).
import { DatabaseSync } from "node:sqlite";
import { all, run, sql, transaction } from "./db";
import schemaJson from "./db-driver/postgres-schema.json";
import type { PgSchema } from "./db-driver/pg-schema";
import { quoteIdent } from "./db-driver/pg-ddl.mjs";

const BATCH = 2000;
export function snapshotDatabase(path: string) {
  if (sql.name === "sqlite") {
    run(`VACUUM INTO '${path.replaceAll("'", "''")}'`); // sqlite-only
    return;
  }
  const schema = schemaJson as unknown as PgSchema;
  const file = new DatabaseSync(path);
  try {
    file.exec("PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=OFF;");
    for (const o of schema.sqlite.filter((x) => x.type === "table")) file.exec(o.sql);
    const sqliteTables = new Set(schema.sqlite.filter((x) => x.type === "table").map((x) => x.name));
    transaction(() => {
      run("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      for (const t of schema.tables) {
        // The search index is rebuilt from the data (search_state below).
        if (t.name === "search_index" || !sqliteTables.has(t.name)) continue;
        const cols = t.columns.map((c) => c.name);
        const insert = file.prepare(`INSERT INTO "${t.name}"(${cols.map((c) => `"${c}"`).join(",")}) VALUES(${cols.map(() => "?").join(",")})`);
        const key = t.primaryKey.length ? t.primaryKey : cols;
        const list = cols.map(quoteIdent).join(",");
        const order = key.map(quoteIdent).join(",");
        let after: unknown[] | null = null;
        let offset = 0;
        for (;;) {
          // Keyset by the primary key; tables without one by offset (small ones).
          const rows: Record<string, unknown>[] = t.primaryKey.length
            ? all(
                `SELECT ${list} FROM ${quoteIdent(t.name)}${after ? ` WHERE (${order})>(${key.map(() => "?").join(",")})` : ""} ORDER BY ${order} LIMIT ${BATCH}`,
                ...((after ?? []) as (string | number | null)[]),
              )
            : all(`SELECT ${list} FROM ${quoteIdent(t.name)} ORDER BY ${order} LIMIT ${BATCH} OFFSET ${offset}`);
          if (!rows.length) break;
          file.exec("BEGIN");
          for (const row of rows) insert.run(...cols.map((c) => value(row[c])));
          file.exec("COMMIT");
          if (rows.length < BATCH) break;
          after = key.map((k) => rows[rows.length - 1][k]);
          offset += rows.length;
        }
      }
    });
    for (const o of schema.sqlite.filter((x) => x.type !== "table")) file.exec(o.sql);
    file.exec(`DELETE FROM search_state; PRAGMA user_version=${schema.sqliteVersion}`);
  } finally {
    file.close();
  }
}
const value = (v: unknown) => (v === undefined ? null : Buffer.isBuffer(v) ? new Uint8Array(v) : (v as string | number | null | Uint8Array));
