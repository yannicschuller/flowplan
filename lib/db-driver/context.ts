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
  after?: (() => unknown)[];
  // onTransactionRollback() callbacks (lib/db.ts), run when it rolls back.
  rollback?: (() => void)[];
};
// What lib/db.ts adds to every transaction of both drivers (registered
// there, so the drivers need not import the features): the relation sync
// before the commit, the upload cleanup after it, and what the first use
// of the database does (PostgreSQL: a staged restore, the object storage
// queue; both: the data steps of lib/data-steps.ts).
export type DbHooks = {
  beforeCommit?: (actor: unknown) => Promise<void>;
  afterCommit?: () => Promise<void>;
  afterRollback?: () => void;
  open?: (backend: "sqlite" | "postgres") => Promise<void>;
};
type State = {
  als: AsyncLocalStorage<TxScope>;
  // SQLite has one connection: the asynchronous transaction holding it, and
  // a promise that settles when it ends (others wait for it).
  sqliteActive: TxScope | null;
  sqliteDone: Promise<void> | null;
  hooks: DbHooks;
};
const holder = globalThis as unknown as { flowplanDbContext?: State };
export const dbContext: State = (holder.flowplanDbContext ??= {
  als: new AsyncLocalStorage<TxScope>(),
  sqliteActive: null,
  sqliteDone: null,
  hooks: {},
});
dbContext.hooks ??= {};
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
export function afterTransaction(fn: () => unknown) {
  const scope = currentTx();
  if (scope) (scope.root.after ??= []).push(fn);
  // Another flow's asynchronous transaction holds the one SQLite
  // connection (this callback interleaved between its awaits): after it.
  else if (dbContext.sqliteActive && dbContext.sqliteDone) void dbContext.sqliteDone.then(() => afterTransaction(fn));
  else if (dbContext.als.getStore()) dbContext.als.exit(() => settle(fn));
  else settle(fn);
}
// Runs a callback whose failure must not disturb the caller (a rejected
// promise of an asynchronous one is logged, not left unhandled).
function settle(fn: () => unknown) {
  try {
    const result = fn();
    if (result && typeof (result as Promise<void>).catch === "function")
      (result as Promise<void>).catch((error) => console.error("After-transaction callback failed", error));
  } catch (error) {
    console.error("After-transaction callback failed", error);
  }
}
// Called by the drivers when a transaction has ended.
export function endScope(root: TxScope) {
  root.ended = true;
  for (const fn of root.after ?? []) dbContext.als.exit(() => settle(fn));
  root.after = undefined;
}

// DATABASE_URL=postgres://… (or postgresql://) selects PostgreSQL; anything
// else (absent, or a file) keeps SQLite.
export function postgresUrl(): string | null {
  const url = process.env.DATABASE_URL?.trim();
  return url && /^postgres(ql)?:\/\//i.test(url) ? url : null;
}
// The connection for what needs a session of its own: LISTEN, the leader's
// session-level advisory lock (lib/cluster/pg-session.ts) and pg_dump,
// pg_restore, psql (lib/pg-backup.ts). Behind PgBouncer in transaction mode
// DATABASE_URL points at the pooler; DATABASE_SESSION_URL then names the
// server itself or a session-mode pool. Without it: DATABASE_URL.
export function postgresSessionUrl(env: Record<string, string | undefined> = process.env): string | null {
  const main = env.DATABASE_URL?.trim();
  if (!main || !/^postgres(ql)?:\/\//i.test(main)) return null;
  const session = env.DATABASE_SESSION_URL?.trim();
  if (!session) return main;
  if (!/^postgres(ql)?:\/\//i.test(session)) throw new Error("DATABASE_SESSION_URL must point to PostgreSQL (postgres://…).");
  return session;
}
// The schema (namespace) inside the Postgres database; tests use one per
// process so parallel test files do not see each other.
export function postgresSchema(): string {
  const schema = process.env.FLOWPLAN_PG_SCHEMA?.trim() || "public";
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error(`FLOWPLAN_PG_SCHEMA is not a plain identifier: ${schema}`);
  return schema;
}
