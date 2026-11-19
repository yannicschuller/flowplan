// Values kept across requests under a version (#383): the roles of all
// pages of a workspace for a person (lib/permissions.ts) and the page list
// of the bootstrap (lib/api.ts). The versions live in the database
// (cache_versions, schema 109); triggers give them a new random value on
// every write that can change what is kept (lib/db.ts
// migrateCacheVersions()) – by any code path, an older version or another
// instance of a cluster. A value is used only while its version has not
// changed since it was computed.
//
// The version is read before the value is computed: a write in between
// changes the version, and the value is never used again. Nothing is kept
// from inside a transaction (it could still roll back).
import { inTransaction, one } from "./db";
import { databaseEpoch } from "./db-driver";
import { memoized } from "./read-memo";

// The version, read once per request until the next write
// (lib/read-memo.ts). A name without a row counts as 0; a database opened
// anew (a restore) starts other versions.
export async function cacheVersion(name: string): Promise<string> {
  return await memoized(`cache-version:${name}`, async () => {
    const epoch = databaseEpoch();
    return `${epoch}:${(await one<{ version: number }>("SELECT version FROM cache_versions WHERE name=?", name))?.version ?? 0}`;
  });
}

// A bounded map of values with the version they were computed for; the
// least recently used goes first.
export class VersionedCache<T> {
  private entries = new Map<string, { version: string; value: T }>();
  constructor(private max: number) {}
  get(key: string, version: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.version !== version) {
      this.entries.delete(key);
      return undefined;
    }
    // Most recently used: to the end.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }
  set(key: string, version: string, value: T) {
    if (inTransaction()) return;
    this.entries.delete(key);
    this.entries.set(key, { version, value });
    while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value!);
  }
  clear() {
    this.entries.clear();
  }
  get size() {
    return this.entries.size;
  }
}

// Computes `fn` for (key, version) or takes it from `cache`; never from or
// into the cache inside a transaction.
export async function cachedFor<T>(cache: VersionedCache<T>, key: string, version: string, fn: () => Promise<T>): Promise<T> {
  if (inTransaction()) return await fn();
  const hit = cache.get(key, version);
  if (hit !== undefined) return hit;
  const value = await fn();
  cache.set(key, version, value);
  return value;
}
