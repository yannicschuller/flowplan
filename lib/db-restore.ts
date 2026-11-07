// A restore (or an instance move) on PostgreSQL. Backups are SQLite files
// on both databases (lib/db-snapshot.ts); lib/instance-restore-apply.ts
// swaps a staged one into the data folder before the database is used. On
// SQLite that file is the database. On PostgreSQL its content is loaded:
// the file is brought to this version's schema by the SQLite migrations,
// the current state is kept as a SQLite file next to the previous uploads
// (as the swapped-out database file is on SQLite), and in one transaction
// every table is emptied and filled from the file – foreign keys and
// triggers set aside meanwhile, identity sequences moved on. The search
// index is rebuilt afterwards.
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { all, migrateFile, run, transaction } from "./db";
import { snapshotDatabase } from "./db-snapshot";
import { applyPendingRestore } from "./instance-restore-apply";
import schemaJson from "./db-driver/postgres-schema.json";
import type { PgSchema } from "./db-driver/pg-schema";
import { foreignKeySql, quoteIdent } from "./db-driver/pg-ddl.mjs";

type Param = string | number | null | Uint8Array;
const ROWS_PER_INSERT = 200;

export async function restorePendingIntoPostgres() {
  const dir = resolve(/* turbopackIgnore: true */ process.env.FLOWPLAN_DATA_DIR || "./data");
  if (!existsSync(resolve(dir, "restore-pending", "READY"))) return null;
  const previous = applyPendingRestore(dir);
  if (!previous) return null;
  // The state before, recoverable like the database file on SQLite.
  if (!existsSync(resolve(previous, "flowplan.sqlite"))) await snapshotDatabase(resolve(previous, "flowplan.sqlite"));
  await loadSqliteFile(resolve(dir, "flowplan.sqlite"));
  console.log(`Instanz wiederhergestellt; vorheriger Stand in ${previous}`);
  return previous;
}

export async function loadSqliteFile(path: string) {
  const schema = schemaJson as unknown as PgSchema;
  const file = new DatabaseSync(path);
  try {
    migrateFile(file);
    const tables = schema.tables.filter((t) => t.name !== "search_index");
    const names = tables.map((t) => quoteIdent(t.name));
    await transaction(async () => {
      // Foreign keys go while the tables are refilled (parents and children
      // in any order) and come back checked; triggers would fire per row.
      const fks = await all<{ tbl: string; conname: string }>(
        "SELECT conrelid::regclass::text AS tbl,conname FROM pg_constraint WHERE connamespace=current_schema()::regnamespace AND contype='f'",
      );
      for (const fk of fks) await run(`ALTER TABLE ${fk.tbl} DROP CONSTRAINT ${quoteIdent(fk.conname)}`);
      for (const name of names) await run(`ALTER TABLE ${name} DISABLE TRIGGER USER`);
      await run(`TRUNCATE ${names.join(",")}`);
      for (const t of tables) {
        const have = new Set((file.prepare(`PRAGMA table_info("${t.name}")`).all() as { name: string }[]).map((c) => c.name)); // sqlite-only
        const cols = t.columns.filter((c) => have.has(c.name));
        if (!cols.length) continue;
        // Row by row from the file, a few hundred per INSERT: memory stays
        // bounded however large the backup is.
        const insert = (part: Record<string, Param>[]) =>
          run(
            `INSERT INTO ${quoteIdent(t.name)}(${cols.map((c) => quoteIdent(c.name)).join(",")}) OVERRIDING SYSTEM VALUE VALUES ${part.map(() => `(${cols.map(() => "?").join(",")})`).join(",")}`,
            ...part.flatMap((row) => cols.map((c) => row[c.name] ?? null)),
          );
        let part: Record<string, Param>[] = [];
        for (const row of file.prepare(`SELECT ${cols.map((c) => `"${c.name}"`).join(",")} FROM "${t.name}"`).iterate() as Iterable<Record<string, Param>>) {
          part.push(row);
          if (part.length === ROWS_PER_INSERT) {
            await insert(part);
            part = [];
          }
        }
        if (part.length) await insert(part);
        for (const c of t.columns.filter((x) => x.identity))
          await run(
            `SELECT setval(pg_get_serial_sequence(?,?), COALESCE((SELECT max(${quoteIdent(c.name)}) FROM ${quoteIdent(t.name)}),0)+1, false)`,
            quoteIdent(t.name),
            c.name,
          );
      }
      for (const name of names) await run(`ALTER TABLE ${name} ENABLE TRIGGER USER`);
      for (const t of tables) for (const fk of t.foreignKeys) await run(foreignKeySql(t, fk));
      // Built again from the restored data.
      await run("DELETE FROM search_index");
      await run("DELETE FROM search_state");
    });
  } finally {
    file.close();
  }
}
