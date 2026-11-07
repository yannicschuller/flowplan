// The asynchronous database interface (docs/architecture/database.md).
// Code written against `Db` runs on SQLite (the default, one container) and
// on PostgreSQL (DATABASE_URL=postgres://…). SQL keeps `?` placeholders;
// the Postgres driver numbers them ($1, $2, …). What differs between the two
// dialects goes through `db.dialect` (lib/db-driver/dialect.ts).
import type { Dialect } from "./dialect";

export type Param = string | number | null | Uint8Array;
export type Row = Record<string, unknown>;
export type RunResult = { changes: number };
export type Backend = "sqlite" | "postgres";

export type TxOptions = {
  // Serialises transactions with the same key. SQLite needs nothing (BEGIN
  // IMMEDIATE already serialises every writer); Postgres takes a
  // transaction-scoped advisory lock, since READ COMMITTED alone would let
  // two "is this the first account?" checks both pass.
  lock?: string;
  // Who changes the data (lib/types.ts Identity): passed to the relation
  // sync that runs before the commit (lib/db.ts transaction()).
  actor?: unknown;
};

export interface Db {
  readonly backend: Backend;
  readonly dialect: Dialect;
  // The first row, or undefined.
  one<T = Row>(sql: string, ...params: Param[]): Promise<T | undefined>;
  all<T = Row>(sql: string, ...params: Param[]): Promise<T[]>;
  // A write; `changes` is the number of rows it touched.
  run(sql: string, ...params: Param[]): Promise<RunResult>;
  // Several statements without parameters (schema, maintenance).
  exec(sql: string): Promise<void>;
  // Runs `fn` in a transaction. Every call of this Db made from inside `fn`
  // (also in helpers it calls, found through AsyncLocalStorage) uses the same
  // transaction; a nested tx() is a SAVEPOINT. Throwing rolls back.
  tx<T>(fn: () => Promise<T>, options?: TxOptions): Promise<T>;
  // Whether the caller runs inside tx().
  inTransaction(): boolean;
  // The column names of a table (PRAGMA table_info / information_schema).
  columns(table: string): Promise<string[]>;
  close(): Promise<void>;
}
