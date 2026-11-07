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
import { currentTx, dbContext, endScope, type TxScope } from "./context";
import { sqliteDialect } from "./dialect";
import type { Db, Param } from "./types";

// Whether another asynchronous transaction holds the connection. Callers
// wait in a loop *right before* their synchronous statement – a helper
// that awaited for them would add a microtask between the check and the
// statement, in which another transaction could begin.
const held = () => !!dbContext.sqliteActive && currentTx()?.root !== dbContext.sqliteActive;

export function createSqliteDb(): Db {
  return {
    backend: "sqlite",
    dialect: sqliteDialect,
    async one<T>(sql: string, ...params: Param[]) {
      while (held()) await dbContext.sqliteDone;
      return oneSync<T>(sql, ...params);
    },
    async all<T>(sql: string, ...params: Param[]) {
      while (held()) await dbContext.sqliteDone;
      return allSync<T>(sql, ...params);
    },
    async run(sql: string, ...params: Param[]) {
      while (held()) await dbContext.sqliteDone;
      return { changes: Number(runSync(sql, ...params).changes) };
    },
    async exec(sql: string) {
      while (held()) await dbContext.sqliteDone;
      connection().exec(sql);
    },
    async tx<T>(fn: () => Promise<T>): Promise<T> {
      const scope = currentTx();
      if (scope?.backend === "sqlite") return nested(scope, fn);
      while (held()) await dbContext.sqliteDone;
      // From here to BEGIN without an await: nobody can take it in between.
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
        endScope(root);
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
