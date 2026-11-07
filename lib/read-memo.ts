// Remembers the results of permission lookups (memberships, grants, the
// spaces and parent pages of a page) for the rest of one request or command,
// so a request that checks hundreds of pages (the sidebar, search, a
// database with record permissions) asks SQLite once per page, space and
// workspace instead of once per check.
//
// Valid only while nothing was written: every write through lib/db.ts
// (run(), a transaction, any statement that is not a plain SELECT) moves
// writeGeneration() and the remembered values are dropped – a command that
// changes grants or memberships sees the new rights in its next check. Outside
// withReadMemo() (background jobs, scripts) nothing is remembered. A scope
// lasts at most MAX_AGE ms, for changes by other processes (scripts on the
// same database file) and long-lived requests (live channels).
import { AsyncLocalStorage } from "node:async_hooks";
import { writeGeneration } from "./db";

type Memo = { generation: number; since: number; values: Map<string, unknown> };
const MAX_AGE = 1000;
// On globalThis: bundles may hold this module more than once.
const store = ((globalThis as { flowplanReadMemo?: AsyncLocalStorage<Memo> }).flowplanReadMemo ??= new AsyncLocalStorage<Memo>());

// Runs fn with a memo of its own, or within the one already in place.
export async function withReadMemo<T>(fn: () => T): Promise<T> {
  if (store.getStore()) return await fn();
  return store.run({ generation: -1, since: 0, values: new Map() }, fn);
}

// The remembered value for key, or compute() remembered. The key names the
// lookup and all its inputs.
export async function memoized<T>(key: string, compute: () => T): Promise<T> {
  const memo = store.getStore();
  if (!memo) return await compute();
  const generation = writeGeneration();
  const now = performance.now();
  if (memo.generation !== generation || now - memo.since > MAX_AGE) {
    memo.values.clear();
    memo.generation = generation;
    memo.since = now;
  }
  if (memo.values.has(key)) return memo.values.get(key) as T;
  const value = await compute();
  memo.values.set(key, value);
  return value;
}
