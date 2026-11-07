// The asynchronous `Db` on SQLite: synchronous inside, asynchronous outside.
// Every call goes through the helpers of lib/db.ts (statement cache, write
// generation for lib/read-memo.ts, runtime metrics), so the behaviour is
// the one SQLite users have today; only the result is wrapped in a promise.
//
// There is one connection. An asynchronous transaction holds it from BEGIN
// to COMMIT, also while its function awaits; calls of this Db from outside
// the transaction wait for it to end, synchronous writes from outside are
// refused (lib/db.ts). Calls from inside – found through AsyncLocalStorage,
// so helpers need no handle passed around – run in it; tx() inside tx() and
// transaction() inside tx() are savepoints.
import {
  all as allSync,
  beginTransaction,
  commitTransaction,
  db as connection,
  endTransaction,
  one as oneSync,
  rollbackTransaction,
  run as runSync,
} from "../db";
import { currentTx, dbContext, type TxScope } from "./context";
import { sqliteDialect } from "./dialect";
import type { Db, Param } from "./types";

// Outside the active transaction: wait until it has ended.
async function turn() {
  while (dbContext.sqliteActive && currentTx()?.root !== dbContext.sqliteActive) await dbContext.sqliteDone;
}

export function createSqliteDb(): Db {
  return {
    backend: "sqlite",
    dialect: sqliteDialect,
    async one<T>(sql: string, ...params: Param[]) {
      if (dbContext.sqliteActive) await turn();
      return oneSync<T>(sql, ...params);
    },
    async all<T>(sql: string, ...params: Param[]) {
      if (dbContext.sqliteActive) await turn();
      return allSync<T>(sql, ...params);
    },
    async run(sql: string, ...params: Param[]) {
      if (dbContext.sqliteActive) await turn();
      return { changes: Number(runSync(sql, ...params).changes) };
    },
    async exec(sql: string) {
      if (dbContext.sqliteActive) await turn();
      connection().exec(sql);
    },
    async tx<T>(fn: () => Promise<T>): Promise<T> {
      const scope = currentTx();
      if (scope?.backend === "sqlite") return nested(scope, fn);
      await turn();
      const root = { depth: 0, backend: "sqlite", savepoints: 0 } as TxScope;
      root.root = root;
      let release!: () => void;
      dbContext.sqliteActive = root;
      dbContext.sqliteDone = new Promise<void>((resolve) => (release = resolve));
      const start = performance.now();
      try {
        beginTransaction();
        try {
          const value = await dbContext.als.run(root, fn);
          dbContext.als.run(root, () => commitTransaction());
          return value;
        } catch (error) {
          dbContext.als.run(root, () => rollbackTransaction());
          throw error;
        } finally {
          endTransaction(start);
        }
      } finally {
        dbContext.sqliteActive = null;
        dbContext.sqliteDone = null;
        release();
      }
    },
    inTransaction: () => currentTx()?.backend === "sqlite",
    async columns(table: string) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error(`Not a table name: ${table}`);
      return allSync<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name);
    },
    async close() {},
  };
}

async function nested<T>(scope: TxScope, fn: () => Promise<T>): Promise<T> {
  const name = `sp_${++scope.root.savepoints}`;
  const d = connection();
  d.exec(`SAVEPOINT ${name}`);
  try {
    const value = await dbContext.als.run({ ...scope, depth: scope.depth + 1 }, fn);
    d.exec(`RELEASE ${name}`);
    return value;
  } catch (error) {
    d.exec(`ROLLBACK TO ${name}`);
    d.exec(`RELEASE ${name}`);
    throw error;
  }
}
