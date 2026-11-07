// Transaction scope shared by the asynchronous drivers and the synchronous
// helpers of lib/db.ts. On globalThis because bundles may hold these
// modules more than once (as lib/db.ts does for its own state).
import { AsyncLocalStorage } from "node:async_hooks";

export type TxScope = {
  // The outermost transaction this scope belongs to.
  root: TxScope;
  depth: number;
  backend: "sqlite" | "postgres";
  // The Postgres connection of the transaction (a pg PoolClient).
  client?: unknown;
  savepoints: number;
};
type State = {
  als: AsyncLocalStorage<TxScope>;
  // SQLite has one connection: the asynchronous transaction holding it, and
  // a promise that settles when it ends (others wait for it).
  sqliteActive: TxScope | null;
  sqliteDone: Promise<void> | null;
};
const holder = globalThis as unknown as { flowplanDbContext?: State };
export const dbContext: State = (holder.flowplanDbContext ??= {
  als: new AsyncLocalStorage<TxScope>(),
  sqliteActive: null,
  sqliteDone: null,
});
export const currentTx = () => dbContext.als.getStore();

// DATABASE_URL=postgres://… (or postgresql://) selects PostgreSQL; anything
// else (absent, or a file) keeps SQLite.
export function postgresUrl(): string | null {
  const url = process.env.DATABASE_URL?.trim();
  return url && /^postgres(ql)?:\/\//i.test(url) ? url : null;
}
// The schema (namespace) inside the Postgres database; tests use one per
// process so parallel test files do not see each other.
export function postgresSchema(): string {
  const schema = process.env.FLOWPLAN_PG_SCHEMA?.trim() || "public";
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error(`FLOWPLAN_PG_SCHEMA is not a plain identifier: ${schema}`);
  return schema;
}
