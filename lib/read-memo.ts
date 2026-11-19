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

// `tables`: while set, the tables the SQLite helpers read are collected
// there (withTrackedReads, lib/kept-answers.ts).
// `until`: the time (ms) the answer being tracked stays valid (keepUntil()).
type Memo = { generation: number; since: number; values: Map<string, unknown>; tables?: Set<string>; until?: { at: number } };
const MAX_AGE = 1000;
// On globalThis: bundles may hold this module more than once.
const store = ((globalThis as { flowplanReadMemo?: AsyncLocalStorage<Memo> }).flowplanReadMemo ??= new AsyncLocalStorage<Memo>());

// Runs fn with a memo of its own, or within the one already in place.
export async function withReadMemo<T>(fn: () => T): Promise<T> {
  if (store.getStore()) return await fn();
  return store.run({ generation: -1, since: 0, values: new Map() }, fn);
}

// Runs fn in a memo of its own that also collects the tables it reads
// (lib/db.ts) – and names noted with noteNamesRead() – for an answer kept
// until one of them is written (lib/kept-answers.ts). Values remembered
// before are not used: what they were read from would be missing.
export async function withTrackedReads<T>(fn: () => Promise<T>): Promise<{ value: T; tables: Set<string>; until: number }> {
  const tables = new Set<string>();
  const until = { at: Infinity };
  return await store.run({ generation: -1, since: 0, values: new Map(), tables, until }, async () => {
    const value = await fn();
    return { value, tables, until: until.at };
  });
}
// Inside withTrackedReads: what is being built is valid only until `at`
// (ms) – e.g. when someone shown as present drops out of the window.
export function keepUntil(at: number) {
  const until = store.getStore()?.until;
  if (until && at < until.at) until.at = at;
}

// The remembered value for key, or compute() remembered. The key names the
// lookup and all its inputs.
// The memo in place, current (emptied after a write or MAX_AGE), or null.
function current(): Memo | null {
  const memo = store.getStore();
  if (!memo) return null;
  const generation = writeGeneration();
  const now = performance.now();
  if (memo.generation !== generation || now - memo.since > MAX_AGE) {
    memo.values.clear();
    memo.generation = generation;
    memo.since = now;
  }
  return memo;
}
export async function memoized<T>(key: string, compute: () => T): Promise<T> {
  const memo = current();
  if (!memo) return await compute();
  if (memo.values.has(key)) return memo.values.get(key) as T;
  const value = await compute();
  memo.values.set(key, value);
  return value;
}

// Whether a memo is in place (a request or command).
export function inReadMemo() {
  return !!store.getStore();
}
// The value remembered under key, or undefined – never computes.
export function peekMemo<T>(key: string): T | undefined {
  return current()?.values.get(key) as T | undefined;
}

// Remembers values looked up in bulk (one query for many pages) under the
// keys memoized() would use for them one by one – the same lifetime, so a
// write drops them as well. Keys already remembered keep their value.
// Without a memo in place nothing happens: the checks then ask themselves.
export function primeMemo(entries: Iterable<[string, unknown]>) {
  const memo = current();
  if (!memo) return false;
  for (const [key, value] of entries) if (!memo.values.has(key)) memo.values.set(key, value);
  return true;
}
