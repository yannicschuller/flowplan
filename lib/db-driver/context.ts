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
  // Set when the transaction has committed or rolled back. Callbacks queued
  // inside it (timers, microtasks) keep its scope, so they check this.
  ended?: boolean;
  // afterTransaction() callbacks, run once it has ended.
  after?: (() => void)[];
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
// The transaction the caller runs in, if it is still open.
export const currentTx = () => {
  const scope = dbContext.als.getStore();
  return scope && !scope.root.ended ? scope : undefined;
};

// Runs `fn` once the caller's transaction has ended (committed or rolled
// back), outside of it; without a transaction right away. For writes that
// must stay when the transaction is rolled back (security events, refusal
// counters): before the asynchronous database they relied on "transactions
// never span an await" and a microtask; inside an asynchronous transaction
// a microtask would still run inside it.
export function afterTransaction(fn: () => void) {
  const scope = currentTx();
  if (scope) (scope.root.after ??= []).push(fn);
  else if (dbContext.als.getStore()) dbContext.als.exit(fn);
  else fn();
}
// Called by the drivers when a transaction has ended.
export function endScope(root: TxScope) {
  root.ended = true;
  for (const fn of root.after ?? [])
    dbContext.als.exit(() => {
      try {
        fn();
      } catch (error) {
        console.error("After-transaction callback failed", error);
      }
    });
  root.after = undefined;
}

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
