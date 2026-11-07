// The database of this instance, asynchronous (docs/architecture/database.md):
//
//   import { db } from "./db-driver";
//   const user = await db.one<User>("SELECT * FROM users WHERE id=?", id);
//   await db.tx(async () => { await db.run(…); await helper(); });
//
// SQLite unless DATABASE_URL=postgres://… is set. The synchronous helpers of
// lib/db.ts keep working next to it during the transition.
import { postgresSchema, postgresUrl } from "./context";
import { createPostgresDb } from "./postgres";
import { createSqliteDb } from "./sqlite";
import type { Db, Param, Row } from "./types";

export type { Db, Param, Row, RunResult, TxOptions, Backend } from "./types";
export type { Dialect } from "./dialect";
export { uniqueViolation } from "./dialect";

const holder = globalThis as unknown as { flowplanAsyncDb?: Db };
export function database(): Db {
  if (holder.flowplanAsyncDb) return holder.flowplanAsyncDb;
  const url = postgresUrl();
  return (holder.flowplanAsyncDb = url ? createPostgresDb(url, { schema: postgresSchema() }) : createSqliteDb());
}
// Ends the Postgres pool (scripts, tests); SQLite stays open.
export async function closeDatabase() {
  const current = holder.flowplanAsyncDb;
  holder.flowplanAsyncDb = undefined;
  await current?.close();
}

// The same as database(), as a value to import.
export const db: Db = {
  get backend() {
    return database().backend;
  },
  get dialect() {
    return database().dialect;
  },
  one: <T = Row>(sql: string, ...params: Param[]) => database().one<T>(sql, ...params),
  all: <T = Row>(sql: string, ...params: Param[]) => database().all<T>(sql, ...params),
  run: (sql, ...params) => database().run(sql, ...params),
  exec: (sql) => database().exec(sql),
  tx: (fn, options) => database().tx(fn, options),
  inTransaction: () => database().inTransaction(),
  columns: (table) => database().columns(table),
  close: () => closeDatabase(),
};
