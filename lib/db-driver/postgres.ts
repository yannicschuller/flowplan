// The asynchronous `Db` on PostgreSQL (the plain `pg` driver, no ORM).
// SQL keeps SQLite's `?` placeholders; they are numbered here, and each
// distinct statement becomes a named prepared statement per connection (the
// counterpart of the SQLite statement cache). SQLite-only SQL is refused
// with a hint (dialect.ts). Transactions take one pooled connection and
// keep it in AsyncLocalStorage, so every call made inside – also in helpers
// – uses it; a nested tx() is a SAVEPOINT.
//
// Lost connections and a failover (docs/architecture/database.md §14c): one
// PostgreSQL behind a stable address (a VIP, a DNS name, a managed
// service's endpoint) – no list of hosts, no read/write split.
//   - TCP keepalive on every pooled connection, and a client-side limit per
//     query a little above statement_timeout, so a connection to a server
//     that went away (no RST: a switched VIP, a frozen host) fails instead
//     of hanging.
//   - A connection that failed (reset, refused, ended by the server: 57P01
//     admin_shutdown, 57P02/57P03, class 08, "Connection terminated", the
//     client-side limit) leaves the pool; the statement is tried once more
//     on a new connection only when that cannot change anything: outside a
//     transaction and read-only (SELECT, or WITH … SELECT without a
//     data-modifying part, no locking clause, no function known to write).
//     Writes and statements inside a transaction are never repeated – the
//     error reaches the caller as before. A transaction whose BEGIN fails
//     on a dead connection starts again on a fresh one (nothing ran yet).
//   - After a failover the old primary may answer as a read-only standby
//     (25006 read_only_sql_transaction): that connection leaves the pool and
//     every connection opened before it is dropped at its next use, so new
//     connections go to the address again – the new primary.
import pg from "pg";
import { currentTx, dbContext, endScope, type TxScope } from "./context";
import { numberPlaceholders, postgresDialect, sqliteOnly } from "./dialect";
import { configureTypes } from "./pg-types.mjs";
import type { Db, Param, TxOptions } from "./types";
import { noteRollback, noteTransaction, noteWriteOf } from "../db";
import { afterCommit } from "./sqlite";

configureTypes(pg);

export type PostgresOptions = {
  schema?: string;
  max?: number;
  prepare?: boolean;
  // Per connection, in ms (0 = none): see postgresTimeouts().
  statementTimeout?: number;
  lockTimeout?: number;
  idleInTransactionTimeout?: number;
  // How long a caller waits for a free pooled connection before failing.
  connectTimeout?: number;
  applicationName?: string;
  // See postgresConnectionOptions() (ms; 0 = off).
  keepAlive?: number;
  queryTimeout?: number;
  idleTimeout?: number;
  // Tests: a stand-in for pg.Pool.
  createPool?: (config: pg.PoolConfig) => pg.Pool;
};

// Limits every pooled connection gets (env, ms; 0 switches one off). A stuck
// lock or a runaway query fails instead of holding a connection (and with
// it, in cluster mode, other instances) forever. The bridge of phase 1 had
// lock_timeout=10s; long-running work (data steps, snapshots, restores)
// lifts them for its own transaction with untimed() (lib/db.ts).
const msFrom = (env: Record<string, string | undefined>, name: string, fallback: number) => {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a number of milliseconds (0 = off): ${raw}`);
  return Math.round(value);
};
export function postgresTimeouts(env: Record<string, string | undefined> = process.env) {
  return {
    statementTimeout: msFrom(env, "FLOWPLAN_PG_STATEMENT_TIMEOUT", 120_000),
    lockTimeout: msFrom(env, "FLOWPLAN_PG_LOCK_TIMEOUT", 10_000),
    idleInTransactionTimeout: msFrom(env, "FLOWPLAN_PG_IDLE_TX_TIMEOUT", 60_000),
    connectTimeout: msFrom(env, "FLOWPLAN_PG_CONNECT_TIMEOUT", 30_000),
  };
}
// How pooled connections notice a server that went away (env, ms):
//   FLOWPLAN_PG_KEEPALIVE      TCP keepalive: idle time before the first
//                              probe (default 10000; 0 or "off": none).
//   FLOWPLAN_PG_QUERY_TIMEOUT  client-side limit per query (default
//                              statement_timeout + 5000, i.e. 125000; 0 =
//                              none, also the default when statement_timeout
//                              is 0). The server ends a slow query first
//                              (57014); this catches a connection that no
//                              longer answers at all. Lifted with the
//                              server's limit by untimed() (lib/db.ts).
//   FLOWPLAN_PG_IDLE_TIMEOUT   an idle pooled connection is closed after
//                              this (default 30000; 0 = kept).
export function postgresConnectionOptions(env: Record<string, string | undefined> = process.env, statementTimeout = postgresTimeouts(env).statementTimeout) {
  const keep = env.FLOWPLAN_PG_KEEPALIVE?.trim().toLowerCase();
  return {
    keepAlive: keep === "off" || keep === "false" || keep === "no" ? 0 : keep === "on" || keep === "true" || keep === "yes" ? 10_000 : msFrom(env, "FLOWPLAN_PG_KEEPALIVE", 10_000),
    queryTimeout: msFrom(env, "FLOWPLAN_PG_QUERY_TIMEOUT", statementTimeout > 0 ? statementTimeout + 5_000 : 0),
    idleTimeout: msFrom(env, "FLOWPLAN_PG_IDLE_TIMEOUT", 30_000),
  };
}
// Named prepared statements (default on): FLOWPLAN_PG_PREPARE=off sends
// every statement unnamed – for PgBouncer in transaction mode before 1.21,
// or without max_prepared_statements, where a name prepared on one server
// connection is unknown on the next.
export function postgresPrepare(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.FLOWPLAN_PG_PREPARE?.trim().toLowerCase();
  if (!raw || ["on", "1", "true", "yes"].includes(raw)) return true;
  if (["off", "0", "false", "no"].includes(raw)) return false;
  throw new Error(`FLOWPLAN_PG_PREPARE must be on or off: ${raw}`);
}

// A failure of the connection rather than of the statement: the connection
// is not used again.
const CONNECTION_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "EPIPE", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN", "57P01", "57P02", "57P03"]);
const CONNECTION_MESSAGE = /Connection terminated|Client has encountered a connection error|Query read timeout|not queryable|socket hang up/i;
export function isConnectionError(error: unknown): boolean {
  const code = String((error as { code?: unknown })?.code ?? "");
  if (CONNECTION_CODES.has(code) || /^08/.test(code)) return true;
  return CONNECTION_MESSAGE.test(String((error as Error)?.message ?? ""));
}
// The server is (now) a read-only standby: after a failover, the old primary.
export const isReadOnlyError = (error: unknown) => (error as { code?: unknown })?.code === "25006";

// Whether running `sql` a second time cannot change anything: a plain
// SELECT (or WITH … SELECT) with no data-modifying part, no locking clause
// and no call of a function known to write or to hold session state.
// Conservative: a keyword anywhere (also in a string or a name) counts.
const WRITES = /\b(INSERT|UPDATE|DELETE|MERGE|UPSERT|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE|COPY|CALL|DO|LOCK|SET|RESET|VACUUM|ANALYZE|REINDEX|CLUSTER|REFRESH|LISTEN|NOTIFY|UNLISTEN|PREPARE|EXECUTE|DEALLOCATE|DISCARD|INTO|FOR\s+(NO\s+KEY\s+)?(UPDATE|SHARE|KEY\s+SHARE))\b/i;
const WRITING_FUNCTIONS = /\b(nextval|setval|pg_advisory\w*|pg_try_advisory\w*|set_config|pg_notify|lo_\w+|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|txid_current|pg_current_xact_id|dblink\w*)\s*\(/i;
export function retrySafe(sql: string): boolean {
  const text = sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, " ").replace(/^[\s(]+/, "");
  if (!/^(SELECT|WITH)\b/i.test(text)) return false;
  return !WRITES.test(text) && !WRITING_FUNCTIONS.test(text);
}

// A query's client-side limit inside a transaction that called untimed()
// (SET LOCAL statement_timeout=…): the transaction's own limit.
const SET_STATEMENT_TIMEOUT = /^\s*SET\s+LOCAL\s+statement_timeout\s*(?:=|TO)\s*'?(\d+)'?\s*;?\s*$/i;

type Prepared = { text: string; name?: string };
const MAX_PREPARED = 2000;
const SCHEMA_CHANGE = /^\s*(ALTER|DROP|CREATE)\s/i;
type QueryConfig = { name?: string; text: string; values?: unknown[]; query_timeout?: number };
// A transaction's scope as this driver uses it.
type PgScope = TxScope & { queryTimeout?: number; broken?: boolean };

export function createPostgresDb(url: string, options: PostgresOptions = {}): Db & { pool: pg.Pool } {
  const schema = options.schema || "public";
  const settings = [
    `-c search_path=${schema}`,
    `-c statement_timeout=${options.statementTimeout ?? 0}`,
    `-c lock_timeout=${options.lockTimeout ?? 0}`,
    `-c idle_in_transaction_session_timeout=${options.idleInTransactionTimeout ?? 0}`,
  ];
  const keepAlive = options.keepAlive ?? 0;
  const queryTimeout = options.queryTimeout ?? 0;
  const config: pg.PoolConfig = {
    connectionString: url,
    max: options.max ?? 10,
    options: settings.join(" "),
    connectionTimeoutMillis: options.connectTimeout ?? 0,
    application_name: (options.applicationName || "flowplan").slice(0, 63),
    // Idle connections do not keep scripts and tests alive.
    allowExitOnIdle: true,
    ...(keepAlive > 0 ? { keepAlive: true, keepAliveInitialDelayMillis: keepAlive } : {}),
    ...(options.idleTimeout !== undefined ? { idleTimeoutMillis: options.idleTimeout } : {}),
  };
  const pool = options.createPool ? options.createPool(config) : new pg.Pool(config);
  pool.on("error", (error) => console.error("Postgres pool error", error));
  // Connections opened before the last failover (see the top of the file)
  // are dropped at their next use.
  let generation = 0;
  const born = new WeakMap<object, number>();
  pool.on("connect", (connection) => born.set(connection, generation));
  let failoverLogged = 0;
  function failedOver(connection: pg.PoolClient) {
    // Only a connection of the current generation moves it on: the other
    // connections to the old server fail the same way and are dropped anyway.
    if ((born.get(connection) ?? generation) !== generation) return;
    generation++;
    if (Date.now() - failoverLogged > 10_000) {
      failoverLogged = Date.now();
      console.warn("PostgreSQL: the server is read-only (25006, a standby after a failover?) – its connections are dropped, new ones go to the address again");
    }
  }
  // A pooled connection of the current generation.
  async function acquire(): Promise<pg.PoolClient> {
    for (;;) {
      const connection = await pool.connect();
      if ((born.get(connection) ?? generation) === generation) return connection;
      connection.release(new Error("opened before a failover"));
    }
  }
  // Gives a connection back – or drops it, after an error of the
  // connection or of a read-only server.
  function giveBack(connection: pg.PoolClient, error?: unknown) {
    if (error !== undefined && isReadOnlyError(error)) failedOver(connection);
    const drop = error !== undefined && (isConnectionError(error) || isReadOnlyError(error));
    connection.release(drop ? (error instanceof Error ? error : new Error(String(error))) : undefined);
  }

  const prepared = new Map<string, Prepared>();
  const usePrepared = options.prepare !== false;
  // Names are never reused: a connection keeps the statements it prepared
  // under their name (pg), so new SQL after a schema change gets new ones.
  let names = 0;

  function statement(sql: string): Prepared {
    let found = prepared.get(sql);
    if (found) return found;
    const hint = sqliteOnly(sql);
    if (hint) throw new Error(`SQLite-only SQL reached Postgres (${hint}): ${sql.slice(0, 200)}`);
    found = { text: numberPlaceholders(sql) };
    if (usePrepared && prepared.size < MAX_PREPARED) {
      found.name = `fp${names++}`;
      prepared.set(sql, found);
    }
    return found;
  }
  const scopeNow = (): PgScope | null => {
    const scope = currentTx();
    return scope?.backend === "postgres" ? (scope as PgScope) : null;
  };
  // The client-side limit of a query: the pool's, or inside a transaction
  // that set its own statement_timeout (untimed()) that one's.
  const limitFor = (scope: PgScope | null) => {
    const limit = scope?.root ? (scope.root as PgScope).queryTimeout : undefined;
    return limit === undefined ? queryTimeout : limit;
  };
  const withLimit = (config: QueryConfig, scope: PgScope | null): QueryConfig => {
    const limit = limitFor(scope);
    // 0 cannot be passed (pg reads it as "the client's default"): leave it out.
    return limit > 0 ? { ...config, query_timeout: limit } : config;
  };

  // One statement on the transaction's connection.
  async function onTx(scope: PgScope, config: QueryConfig, sql: string) {
    const root = scope.root as PgScope;
    try {
      const result = await (scope.client as pg.PoolClient).query(withLimit(config, scope));
      const timeout = SET_STATEMENT_TIMEOUT.exec(sql);
      if (timeout) root.queryTimeout = Number(timeout[1]) > 0 ? Number(timeout[1]) + 5_000 : 0;
      return result;
    } catch (error) {
      // The connection is dropped when the transaction ends.
      if (isConnectionError(error) || isReadOnlyError(error)) {
        root.broken = true;
        if (isReadOnlyError(error)) failedOver(scope.client as pg.PoolClient);
      }
      throw error;
    }
  }
  // One statement outside a transaction: on a pooled connection, once more
  // on a new one when the connection failed and the statement is safe to
  // repeat (see the top of the file).
  async function onPool(config: QueryConfig, sql: string, retry = true): Promise<pg.QueryResult> {
    let connection: pg.PoolClient;
    try {
      connection = await acquire();
    } catch (error) {
      if (retry && isConnectionError(error) && retrySafe(sql)) return await onPool(config, sql, false);
      throw error;
    }
    try {
      const result = await connection.query(withLimit(config, null));
      giveBack(connection);
      return result;
    } catch (error) {
      giveBack(connection, error);
      if (retry && isConnectionError(error) && retrySafe(sql)) {
        console.warn(`PostgreSQL: connection lost (${String((error as Error)?.message || error).slice(0, 120)}), the read-only statement runs once more`);
        return await onPool(config, sql, false);
      }
      throw error;
    }
  }
  async function send(config: QueryConfig, sql: string) {
    const scope = scopeNow();
    return scope ? await onTx(scope, config, sql) : await onPool(config, sql);
  }
  async function query(sql: string, params: Param[]) {
    const s = statement(sql);
    noteWriteOf(sql, params);
    // A schema change (ALTER/CREATE/DROP) outdates what was prepared before
    // (`SELECT *` keeps its columns): later statements are prepared anew.
    if (SCHEMA_CHANGE.test(sql)) prepared.clear();
    try {
      return await send({ name: s.name, text: s.text, values: params.map(value) }, sql);
    } catch (error) {
      // Prepared on this connection before a schema change made elsewhere
      // (another connection, another instance): once more, unnamed – outside
      // a transaction (inside one the failure has spoilt it).
      if (s.name && (error as { code?: string }).code === "0A000" && /cached plan/.test(String((error as Error).message))) {
        prepared.delete(sql);
        if (!currentTx()) return await send({ text: s.text, values: params.map(value) }, sql);
      }
      throw error;
    }
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
      if (/\b(ALTER|CREATE|DROP)\b/i.test(sql)) prepared.clear();
      await send({ text: sql }, sql);
    },
    async tx<T>(fn: () => Promise<T>, txOptions: TxOptions = {}): Promise<T> {
      const scope = currentTx();
      if (scope?.backend === "postgres") return nested(scope, fn, txOptions);
      let connection = await acquire();
      const begin = () => connection.query(withLimit({ text: "BEGIN" }, null));
      try {
        await begin();
      } catch (error) {
        // A dead connection (the server restarted, a failover): nothing ran
        // yet, so the transaction starts on a fresh one.
        giveBack(connection, error);
        if (!isConnectionError(error)) throw error;
        connection = await acquire();
        try {
          await begin();
        } catch (again) {
          giveBack(connection, again);
          throw again;
        }
      }
      const root = { depth: 0, backend: "postgres", client: connection, savepoints: 0 } as PgScope;
      root.root = root;
      const start = performance.now();
      let committed = false;
      let failure: unknown;
      try {
        if (txOptions.lock) await onTx(root, { text: "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", values: [txOptions.lock] }, "");
        const result = await dbContext.als.run(root, fn);
        await dbContext.als.run(root, async () => dbContext.hooks.beforeCommit?.(txOptions.actor));
        await onTx(root, { text: "COMMIT" }, "COMMIT");
        committed = true;
        return result;
      } catch (error) {
        failure = error;
        await connection.query("ROLLBACK").catch((rollback) => {
          if (isConnectionError(rollback)) root.broken = true;
        });
        noteRollback(root);
        throw error;
      } finally {
        // (A connection error caught inside still drops the connection.)
        giveBack(
          connection,
          root.broken ? (isConnectionError(failure) || isReadOnlyError(failure) ? failure : new Error("Connection terminated during the transaction")) : undefined,
        );
        noteTransaction(start);
        endScope(root);
        if (committed) await afterCommit();
      }
    },
    inTransaction: () => currentTx()?.backend === "postgres",
    async columns(table: string) {
      const rows = (
        await send(
          {
            text: "SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1 ORDER BY ordinal_position",
            values: [table],
          },
          "SELECT column_name FROM information_schema.columns",
        )
      ).rows as { column_name: string }[];
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
