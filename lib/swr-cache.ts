// Stale-while-revalidate for what the app loaded recently: a page's data,
// a record's document, a workspace's bootstrap. Opening it again shows the
// kept copy at once while the fresh one loads; live updates (the editor's
// Yjs sync, the reload after a change) replace it as soon as they arrive.
//
// Rules (tests/swr-cache.test.ts):
// - Entries belong to one person: the cache is scoped to the signed-in user
//   and emptied when that changes, on sign-out and when the session ends.
// - "memory" entries never leave this tab's memory: pages of end-to-end
//   encrypted spaces (decrypted content must not be written anywhere).
// - "persist" entries also go to sessionStorage (this tab only, gone when
//   it closes), so a reload opens the last pages at once. Large entries
//   stay in memory only.
// - "none": pages behind a journal PIN and everything of a journal are
//   never kept (the caller decides, see pageCachePolicy below).
// - Keys are kind + id; the version (e.g. updated_at and generation) tells
//   whether a prefetch is still needed.
// This is not the offline copy (components/offline.ts): it holds a few
// recent things for speed, not the whole workspace for offline use.

export type CachePolicy = "none" | "memory" | "persist";
export type CacheEntry<T> = { value: T; version: string; at: number; persist: boolean };
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

// components/login.tsx clears the same prefix (without loading this module).
export const STORAGE_PREFIX = "flowplan:swr:";
const OWNER_KEY = `${STORAGE_PREFIX}owner`;

export function createSwrCache({
  storage = null,
  maxEntries = 40,
  maxPersistBytes = 300_000,
  maxStoredBytes = 2_000_000,
  now = () => Date.now(),
}: {
  storage?: StorageLike | null;
  maxEntries?: number;
  maxPersistBytes?: number;
  maxStoredBytes?: number;
  now?: () => number;
} = {}) {
  const memory = new Map<string, CacheEntry<unknown>>();
  let owner: string | null = null;
  const listeners = new Set<(key: string) => void>();
  const storageKey = (key: string) => `${STORAGE_PREFIX}${owner}:${key}`;
  const safe = <R>(run: () => R, fallback: R): R => {
    try {
      return run();
    } catch {
      return fallback;
    }
  };
  function storedKeys() {
    if (!storage) return [];
    return safe(() => {
      const keys: string[] = [];
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key?.startsWith(STORAGE_PREFIX) && key !== OWNER_KEY) keys.push(key);
      }
      return keys;
    }, [] as string[]);
  }
  function wipeStorage() {
    for (const key of storedKeys()) safe(() => storage!.removeItem(key), undefined);
    if (storage) safe(() => storage.removeItem(OWNER_KEY), undefined);
  }
  function evict() {
    while (memory.size > maxEntries) {
      const oldest = memory.keys().next().value as string;
      remove(oldest);
    }
  }
  function remove(key: string) {
    const had = memory.delete(key);
    if (storage && owner) safe(() => storage.removeItem(storageKey(key)), undefined);
    if (had) listeners.forEach((l) => l(key));
  }
  // Stored entries over the budget: the oldest go first.
  function trimStorage() {
    if (!storage || !owner) return;
    const entries = storedKeys()
      .map((key) => {
        const raw = safe(() => storage.getItem(key), null);
        let at = 0;
        try {
          at = raw ? (JSON.parse(raw) as CacheEntry<unknown>).at : 0;
        } catch {}
        return { key, size: raw?.length || 0, at };
      })
      .sort((a, b) => a.at - b.at);
    let total = entries.reduce((sum, e) => sum + e.size, 0);
    for (const e of entries) {
      if (total <= maxStoredBytes) break;
      safe(() => storage.removeItem(e.key), undefined);
      total -= e.size;
    }
  }
  const cache = {
    // The signed-in person. Another one (or none) empties everything.
    scope(userId: string | null) {
      if (userId === owner) return;
      memory.clear();
      const stored = storage ? safe(() => storage.getItem(OWNER_KEY), null) : null;
      if (stored !== userId) wipeStorage();
      owner = userId;
      if (!userId || !storage) return;
      safe(() => storage.setItem(OWNER_KEY, userId), undefined);
      // Back from the tab's storage (after a reload): oldest first, so
      // the newest stay when there are more than fit.
      const restored: [string, CacheEntry<unknown>][] = [];
      for (const key of storedKeys()) {
        if (!key.startsWith(`${STORAGE_PREFIX}${userId}:`)) {
          safe(() => storage.removeItem(key), undefined);
          continue;
        }
        try {
          const entry = JSON.parse(storage.getItem(key) || "null") as CacheEntry<unknown> | null;
          if (entry && entry.persist) restored.push([key.slice(`${STORAGE_PREFIX}${userId}:`.length), entry]);
        } catch {
          safe(() => storage.removeItem(key), undefined);
        }
      }
      restored.sort((a, b) => a[1].at - b[1].at).forEach(([key, entry]) => memory.set(key, entry));
      evict();
    },
    owner: () => owner,
    get<T>(key: string): CacheEntry<T> | undefined {
      if (!owner) return undefined;
      return memory.get(key) as CacheEntry<T> | undefined;
    },
    // Whether a copy of this version exists and is younger than maxAge.
    fresh(key: string, version: string | undefined, maxAge: number) {
      const entry = cache.get(key);
      return !!entry && (version === undefined || entry.version === version) && now() - entry.at < maxAge;
    },
    set<T>(key: string, value: T, { version = "", policy }: { version?: string; policy: CachePolicy }) {
      if (!owner) return;
      if (policy === "none") {
        remove(key);
        return;
      }
      let persist = policy === "persist" && !!storage;
      const entry: CacheEntry<T> = { value, version, at: now(), persist };
      if (persist) {
        const raw = safe(() => JSON.stringify(entry), "");
        persist = !!raw && raw.length <= maxPersistBytes;
        if (persist) {
          const stored = safe(() => (storage!.setItem(storageKey(key), raw), true), false);
          if (!stored) {
            trimStorage();
            persist = safe(() => (storage!.setItem(storageKey(key), raw), true), false);
          }
        }
        if (!persist) safe(() => storage!.removeItem(storageKey(key)), undefined);
        entry.persist = persist;
      }
      // Newest last: Map order is the eviction order.
      memory.delete(key);
      memory.set(key, entry);
      evict();
      if (persist) trimStorage();
      listeners.forEach((l) => l(key));
    },
    delete: remove,
    // Drops every entry whose key matches (e.g. a page and its records).
    invalidate(match: (key: string) => boolean) {
      for (const key of [...memory.keys()]) if (match(key)) remove(key);
      for (const key of storedKeys()) {
        const short = key.slice(`${STORAGE_PREFIX}${owner}:`.length);
        if (key.startsWith(`${STORAGE_PREFIX}${owner}:`) && match(short)) safe(() => storage!.removeItem(key), undefined);
      }
    },
    // Sign-out, another person, an ended session: nothing stays.
    clear() {
      memory.clear();
      wipeStorage();
      owner = null;
    },
    keys: () => [...memory.keys()],
    subscribe(listener: (key: string) => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
  return cache;
}
export type SwrCache = ReturnType<typeof createSwrCache>;

// Keys.
export const pageKey = (pageId: string) => `page:${pageId}`;
export const rowKey = (pageId: string, rowId: string) => `row:${pageId}:${rowId}`;
export const bootKey = (workspaceId: string) => `boot:${workspaceId}`;

export const LARGE_DATABASE_ROWS = 300;
type PolicyPage = { id: string; parent_id: string | null; kind: string; journal_date?: string | null; space_id: string };
// How a page's data may be kept: never for journals (and their days or pages
// below them – a PIN may guard them) or a page shown behind a PIN; only in
// memory for end-to-end encrypted spaces; otherwise also in the tab's storage.
export function pageCachePolicy(
  data: { page: PolicyPage; locked?: unknown; encrypted?: unknown; journal?: unknown; journalDay?: unknown; rows?: unknown[] },
  pages: PolicyPage[] = [],
  encryptedSpaces: string[] = [],
): CachePolicy {
  if (data.locked || data.journal || data.journalDay || data.page.kind === "journal" || data.page.journal_date) return "none";
  const byId = new Map(pages.map((p) => [p.id, p]));
  for (let p = data.page.parent_id ? byId.get(data.page.parent_id) : undefined, depth = 0; p && depth < 64; p = p.parent_id ? byId.get(p.parent_id) : undefined, depth++)
    if (p.kind === "journal" || p.journal_date) return "none";
  if (data.encrypted || encryptedSpaces.includes(data.page.space_id)) return "memory";
  // Large databases stay in memory: writing them to storage after every
  // change would cost more than it saves.
  if ((data.rows?.length || 0) > LARGE_DATABASE_ROWS) return "memory";
  return "persist";
}

// The app's cache (one per tab).
let shared: SwrCache | null = null;
export function appCache(): SwrCache {
  if (!shared)
    shared = createSwrCache({
      storage: typeof sessionStorage === "undefined" ? null : (() => {
        try {
          return sessionStorage;
        } catch {
          return null;
        }
      })(),
    });
  return shared;
}
// Sign-out and the sign-in page: nothing of the last person stays in this tab.
export function clearAppCache() {
  appCache().clear();
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const key = sessionStorage.key(i);
      if (key?.startsWith(STORAGE_PREFIX)) sessionStorage.removeItem(key);
    }
  } catch {}
}
// A record's document is kept like the database it belongs to; without a
// kept copy of that database (a journal, not opened yet) it is not kept.
export function recordCachePolicy(cache: SwrCache, pageId: string): CachePolicy {
  const parent = cache.get(pageKey(pageId));
  return parent ? (parent.persist ? "persist" : "memory") : "none";
}
