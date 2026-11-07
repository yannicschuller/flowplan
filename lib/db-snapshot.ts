// A consistent copy of the whole database as a SQLite file, the format of
// instance backups, scheduled backups and instance moves. On SQLite that is
// VACUUM INTO. On PostgreSQL the same file is written from the data: the
// SQLite schema of this version (from the translated schema,
// lib/db-driver/postgres-schema.json), every table copied in key order in
// one REPEATABLE READ transaction (a cursor per table, batches of rows:
// memory stays bounded for large instances), then indexes and triggers, the schema
// version; the search index is rebuilt by the instance that opens the file.
// So a backup taken on PostgreSQL restores on SQLite and vice versa
// (scripts/db-migrate.mjs does the same for whole instances).
import { DatabaseSync } from "node:sqlite";
import { all, run, sql, transaction } from "./db";
import { db } from "./db-driver";
import schemaJson from "./db-driver/postgres-schema.json";
import type { PgSchema } from "./db-driver/pg-schema";
import { quoteIdent } from "./db-driver/pg-ddl.mjs";

// Rows per round trip (documents can be large: a few hundred at a time).
const BATCH = 500;
export async function snapshotDatabase(path: string) {
  if (sql.name === "sqlite") {
    await run(`VACUUM INTO '${path.replaceAll("'", "''")}'`); // sqlite-only
    return;
  }
  const schema = schemaJson as unknown as PgSchema;
  const file = new DatabaseSync(path);
  try {
    file.exec("PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=OFF;"); // sqlite-only: the file
    for (const o of schema.sqlite.filter((x) => x.type === "table")) file.exec(o.sql);
    const sqliteTables = new Set(schema.sqlite.filter((x) => x.type === "table").map((x) => x.name));
    await transaction(async () => {
      await run("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      for (const t of schema.tables) {
        // The search index is rebuilt from the data (search_state below).
        if (t.name === "search_index" || !sqliteTables.has(t.name)) continue;
        const cols = t.columns.map((c) => c.name);
        const insert = file.prepare(`INSERT INTO "${t.name}"(${cols.map((c) => `"${c}"`).join(",")}) VALUES(${cols.map(() => "?").join(",")})`);
        const key = t.primaryKey.length ? t.primaryKey : cols;
        // A cursor of the snapshot transaction: the rows come in batches,
        // whatever the size of the table (bounded memory), in key order.
        await db.exec(`DECLARE fp_snapshot NO SCROLL CURSOR FOR SELECT ${cols.map(quoteIdent).join(",")} FROM ${quoteIdent(t.name)} ORDER BY ${key.map(quoteIdent).join(",")}`);
        for (;;) {
          const rows = await all(`FETCH ${BATCH} FROM fp_snapshot`);
          if (!rows.length) break;
          file.exec("BEGIN");
          for (const row of rows) insert.run(...cols.map((c) => value(row[c])));
          file.exec("COMMIT");
          if (rows.length < BATCH) break;
        }
        await db.exec("CLOSE fp_snapshot");
      }
    });
    for (const o of schema.sqlite.filter((x) => x.type !== "table")) file.exec(o.sql);
    file.exec(`DELETE FROM search_state; PRAGMA user_version=${schema.sqliteVersion}`); // sqlite-only: the file
  } finally {
    file.close();
  }
}
const value = (v: unknown) => (v === undefined ? null : Buffer.isBuffer(v) ? new Uint8Array(v) : (v as string | number | null | Uint8Array));
