// The database of this instance, asynchronous (docs/architecture/database.md):
//
//   import { db } from "./db-driver";
//   const user = await db.one<User>("SELECT * FROM users WHERE id=?", id);
//   await db.tx(async () => { await db.run(…); await helper(); });
//
// SQLite unless DATABASE_URL=postgres://… is set. The synchronous helpers of
// lib/db.ts keep working next to it during the transition.
import { AsyncLocalStorage } from "node:async_hooks";
import { currentTx, dbContext, postgresSchema, postgresUrl } from "./context";
import { createPostgresDb, postgresTimeouts } from "./postgres";
import { createSqliteDb } from "./sqlite";
import type { Db, Param, Row } from "./types";

export type { Db, Param, Row, RunResult, TxOptions, Backend } from "./types";
export type { Dialect } from "./dialect";
export { uniqueViolation } from "./dialect";

const holder = globalThis as unknown as { flowplanAsyncDb?: Db };
export function database(): Db {
  if (holder.flowplanAsyncDb) return holder.flowplanAsyncDb;
  const url = postgresUrl();
  return (holder.flowplanAsyncDb = opened(
    url
      ? createPostgresDb(url, { schema: postgresSchema(), max: poolSize(), ...postgresTimeouts(), applicationName: applicationName() })
      : createSqliteDb(),
  ));
}
// Connections per process (FLOWPLAN_PG_POOL, default 10). With several
// instances: instances × pool (+1 each for the leader election in cluster
// mode) must stay below the server's max_connections.
export const poolSize = () => Math.max(1, Math.min(500, Number(process.env.FLOWPLAN_PG_POOL) || 10));
// Shown in pg_stat_activity: which instance holds a connection.
const applicationName = () => `flowplan${process.env.FLOWPLAN_INSTANCE_ID ? `:${process.env.FLOWPLAN_INSTANCE_ID}` : ""}`;

// The first use of the database runs its opening steps (dbContext.hooks.open,
// lib/db.ts): on PostgreSQL what opening the SQLite file does (a staged
// restore is loaded, the object storage queue set up), on both the data
// steps (lib/data-steps.ts). Every call waits for that; the calls they
// make themselves do not.
function opened(inner: Db): Db {
  const opening = new AsyncLocalStorage<boolean>();
  let ready: Promise<void> | null = null;
  let done = false;
  const wait = (): Promise<void> | null => {
    if (done || opening.getStore() || currentTx()) return null;
    return (ready ??= opening.run(true, async () => {
      try {
        await dbContext.hooks.open?.(inner.backend);
      } catch (error) {
        console.error("Database: opening steps failed", error);
      } finally {
        done = true;
      }
    }));
  };
  const gate = <T>(fn: () => Promise<T>): Promise<T> => {
    const pending = wait();
    return pending ? pending.then(fn) : fn();
  };
  return {
    ...inner,
    backend: inner.backend,
    dialect: inner.dialect,
    one: (sql, ...params) => gate(() => inner.one(sql, ...params)),
    all: (sql, ...params) => gate(() => inner.all(sql, ...params)),
    run: (sql, ...params) => gate(() => inner.run(sql, ...params)),
    exec: (sql) => gate(() => inner.exec(sql)),
    tx: (fn, options) => gate(() => inner.tx(fn, options)),
    columns: (table) => gate(() => inner.columns(table)),
    inTransaction: () => inner.inTransaction(),
    close: () => inner.close(),
  } as Db;
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
