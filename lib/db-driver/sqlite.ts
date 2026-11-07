// The asynchronous `Db` on SQLite: synchronous inside, asynchronous outside.
// Every call goes through the SQLite helpers of lib/db.ts (statement
// cache, write generation for lib/read-memo.ts, runtime metrics), so the
// behaviour is the one SQLite users had before; only the result is wrapped
// in a promise. A statement runs when it is called, not after an await.
//
// There is one connection. An asynchronous transaction holds it from BEGIN
// to COMMIT, also while its function awaits; calls of this Db from outside
// the transaction wait for it to end. Calls from inside – found through
// AsyncLocalStorage, so helpers need no handle passed around – run in it;
// tx() inside tx() is a savepoint.
import { db as connection, noteRollback, noteTransaction, sqliteAll, sqliteOne, sqliteRun } from "../db";
import { currentTx, dbContext, endScope, type TxScope } from "./context";
import { sqliteDialect } from "./dialect";
import type { Db, Param, TxOptions } from "./types";

// Whether another asynchronous transaction holds the connection. Callers
// wait in a loop *right before* their synchronous statement – a helper
// that awaited for them would add a microtask between the check and the
// statement, in which another transaction could begin.
const held = () => !!dbContext.sqliteActive && currentTx()?.root !== dbContext.sqliteActive;

export function createSqliteDb(): Db {
  return {
    backend: "sqlite",
    dialect: sqliteDialect,
    one<T>(sql: string, ...params: Param[]) {
      if (!held()) return settled(() => sqliteOne<T>(sql, ...params));
      return (async () => {
        while (held()) await dbContext.sqliteDone;
        return sqliteOne<T>(sql, ...params);
      })();
    },
    all<T>(sql: string, ...params: Param[]) {
      if (!held()) return settled(() => sqliteAll<T>(sql, ...params));
      return (async () => {
        while (held()) await dbContext.sqliteDone;
        return sqliteAll<T>(sql, ...params);
      })();
    },
    run(sql: string, ...params: Param[]) {
      const go = () => ({ changes: Number(sqliteRun(sql, ...params).changes) });
      if (!held()) return settled(go);
      return (async () => {
        while (held()) await dbContext.sqliteDone;
        return go();
      })();
    },
    async exec(sql: string) {
      while (held()) await dbContext.sqliteDone;
      connection().exec(sql);
    },
    async tx<T>(fn: () => Promise<T>, options: TxOptions = {}): Promise<T> {
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
      // A transaction that awaits more than database calls (fetch, scrypt,
      // timers) holds the one connection across macrotasks; everybody else
      // waits meanwhile. Noticed in development: the check runs after the
      // current microtasks.
      const spans =
        process.env.NODE_ENV === "production"
          ? null
          : setImmediate((stack) => dbContext.sqliteActive === root && console.warn("Asynchronous SQLite transaction spans I/O:", stack), new Error().stack);
      let committed = false;
      try {
        connection().exec("BEGIN IMMEDIATE"); // sqlite-only
        try {
          const value = await dbContext.als.run(root, fn);
          await dbContext.als.run(root, async () => dbContext.hooks.beforeCommit?.(options.actor));
          connection().exec("COMMIT");
          committed = true;
          return value;
        } catch (error) {
          try {
            if (connection().isTransaction) connection().exec("ROLLBACK");
          } catch {}
          noteRollback(root);
          throw error;
        }
      } finally {
        if (spans) clearImmediate(spans);
        dbContext.sqliteActive = null;
        dbContext.sqliteDone = null;
        release();
        noteTransaction(start);
        endScope(root);
        if (committed) await afterCommit();
      }
    },
    inTransaction: () => currentTx()?.backend === "sqlite",
    async columns(table: string) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error(`Not a table name: ${table}`);
      return sqliteAll<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name); // sqlite-only
    },
    async close() {},
  };
}

// A statement run now, its outcome as a promise (a throw becomes a rejection).
function settled<T>(fn: () => T): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (error) {
    return Promise.reject(error);
  }
}

// The upload cleanup after a commit, outside the transaction; it never
// fails the transaction that has committed.
export async function afterCommit() {
  try {
    await dbContext.als.exit(async () => dbContext.hooks.afterCommit?.());
  } catch (error) {
    console.error("Upload cleanup failed", error);
  }
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
    noteRollback();
    throw error;
  }
}
