// The asynchronous `Db` on PostgreSQL (the plain `pg` driver, no ORM).
// SQL keeps SQLite's `?` placeholders; they are numbered here, and each
// distinct statement becomes a named prepared statement per connection (the
// counterpart of the SQLite statement cache). SQLite-only SQL is refused
// with a hint (dialect.ts). Transactions take one pooled connection and
// keep it in AsyncLocalStorage, so every call made inside – also in helpers
// – uses it; a nested tx() is a SAVEPOINT.
import pg from "pg";
import { currentTx, dbContext, endScope, type TxScope } from "./context";
import { numberPlaceholders, postgresDialect, sqliteOnly } from "./dialect";
import { configureTypes } from "./pg-types.mjs";
import type { Db, Param, TxOptions } from "./types";
import { noteRollback, noteTransaction, noteWriteOf } from "../db";
import { afterCommit } from "./sqlite";

configureTypes(pg);

export type PostgresOptions = { schema?: string; max?: number; prepare?: boolean };
type Prepared = { text: string; name?: string };
const MAX_PREPARED = 2000;

export function createPostgresDb(url: string, options: PostgresOptions = {}): Db & { pool: pg.Pool } {
  const schema = options.schema || "public";
  const pool = new pg.Pool({
    connectionString: url,
    max: options.max ?? 10,
    options: `-c search_path=${schema}`,
    // Idle connections do not keep scripts and tests alive.
    allowExitOnIdle: true,
  });
  pool.on("error", (error) => console.error("Postgres pool error", error));
  const prepared = new Map<string, Prepared>();
  const usePrepared = options.prepare !== false;

  function statement(sql: string): Prepared {
    let found = prepared.get(sql);
    if (found) return found;
    const hint = sqliteOnly(sql);
    if (hint) throw new Error(`SQLite-only SQL reached Postgres (${hint}): ${sql.slice(0, 200)}`);
    found = { text: numberPlaceholders(sql) };
    if (usePrepared && prepared.size < MAX_PREPARED) {
      found.name = `fp${prepared.size}`;
      prepared.set(sql, found);
    }
    return found;
  }
  const client = (): pg.Pool | pg.PoolClient => {
    const scope = currentTx();
    return scope?.backend === "postgres" ? (scope.client as pg.PoolClient) : pool;
  };
  async function query(sql: string, params: Param[]) {
    const s = statement(sql);
    noteWriteOf(sql);
    return client().query({ name: s.name, text: s.text, values: params.map(value) });
  }

  return {
    backend: "postgres",
    dialect: postgresDialect,
    pool,
    async one<T>(sql: string, ...params: Param[]) {
      return (await query(sql, params)).rows[0] as T | undefined;
    },
    async all<T>(sql: string, ...params: Param[]) {
      return (await query(sql, params)).rows as T[];
    },
    async run(sql: string, ...params: Param[]) {
      return { changes: (await query(sql, params)).rowCount ?? 0 };
    },
    async exec(sql: string) {
      await client().query(sql);
    },
    async tx<T>(fn: () => Promise<T>, txOptions: TxOptions = {}): Promise<T> {
      const scope = currentTx();
      if (scope?.backend === "postgres") return nested(scope, fn, txOptions);
      const connection = await pool.connect();
      const root = { depth: 0, backend: "postgres", client: connection, savepoints: 0 } as TxScope;
      root.root = root;
      const start = performance.now();
      let committed = false;
      try {
        await connection.query("BEGIN");
        if (txOptions.lock) await connection.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [txOptions.lock]);
        const result = await dbContext.als.run(root, fn);
        await dbContext.als.run(root, async () => dbContext.hooks.beforeCommit?.(txOptions.actor));
        await connection.query("COMMIT");
        committed = true;
        return result;
      } catch (error) {
        await connection.query("ROLLBACK").catch(() => {});
        noteRollback(root);
        throw error;
      } finally {
        connection.release();
        noteTransaction(start);
        endScope(root);
        if (committed) await afterCommit();
      }
    },
    inTransaction: () => currentTx()?.backend === "postgres",
    async columns(table: string) {
      const rows = (
        await client().query<{ column_name: string }>(
          "SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1 ORDER BY ordinal_position",
          [table],
        )
      ).rows;
      return rows.map((r) => r.column_name);
    },
    async close() {
      await pool.end();
    },
  };
}

async function nested<T>(scope: TxScope, fn: () => Promise<T>, options: TxOptions): Promise<T> {
  const connection = scope.client as pg.PoolClient;
  const name = `sp_${++scope.root.savepoints}`;
  await connection.query(`SAVEPOINT ${name}`);
  try {
    if (options.lock) await connection.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [options.lock]);
    const result = await dbContext.als.run({ ...scope, depth: scope.depth + 1 }, fn);
    await connection.query(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    await connection.query(`ROLLBACK TO SAVEPOINT ${name}`).catch(() => {});
    noteRollback();
    throw error;
  }
}

// node:sqlite hands out Uint8Array; pg wants a Buffer for bytea.
const value = (v: Param) => (v instanceof Uint8Array && !Buffer.isBuffer(v) ? Buffer.from(v.buffer, v.byteOffset, v.byteLength) : v);
