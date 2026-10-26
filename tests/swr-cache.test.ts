// The cache of recently loaded pages (lib/swr-cache.ts): keys and versions,
// invalidation, one person at a time (sign-out and another account empty
// it), encrypted pages never written to storage, journals never kept.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSwrCache, pageCachePolicy, pageKey, recordCachePolicy, rowKey, STORAGE_PREFIX } from "../lib/swr-cache";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}
const page = (id: string, extra: Record<string, unknown> = {}) => ({
  page: { id, parent_id: null, kind: "document", space_id: "s", updated_at: "1", ...extra },
  html: `<p>${id}</p>`,
});

test("entries are keyed by kind and id, versions decide about freshness", () => {
  let now = 1000;
  const cache = createSwrCache({ now: () => now });
  assert.equal(cache.get(pageKey("a")), undefined, "nothing before a person is known");
  cache.set(pageKey("a"), page("a"), { policy: "memory" });
  assert.equal(cache.get(pageKey("a")), undefined, "not even after setting");
  cache.scope("u1");
  cache.set(pageKey("a"), page("a"), { version: "v1", policy: "memory" });
  cache.set(rowKey("db", "r1"), { html: "x" }, { policy: "memory" });
  assert.equal(cache.get<{ html: string }>(pageKey("a"))?.value.html, "<p>a</p>");
  assert.equal(cache.get<{ html: string }>(rowKey("db", "r1"))?.value.html, "x");
  assert.ok(cache.fresh(pageKey("a"), "v1", 30_000));
  assert.ok(!cache.fresh(pageKey("a"), "v2", 30_000), "another version is not fresh");
  now += 31_000;
  assert.ok(!cache.fresh(pageKey("a"), "v1", 30_000), "too old");
  cache.set(pageKey("a"), page("a"), { policy: "none" });
  assert.equal(cache.get(pageKey("a")), undefined, "a page that may not be kept leaves");
});

test("invalidation, the size limit and listeners", () => {
  const cache = createSwrCache({ maxEntries: 3 });
  cache.scope("u1");
  const seen: string[] = [];
  cache.subscribe((key) => seen.push(key));
  for (const id of ["a", "b", "c", "d"]) cache.set(pageKey(id), page(id), { policy: "memory" });
  assert.deepEqual(cache.keys(), ["page:b", "page:c", "page:d"], "the oldest went");
  cache.set(pageKey("b"), page("b"), { policy: "memory" });
  cache.set(pageKey("e"), page("e"), { policy: "memory" });
  assert.deepEqual(cache.keys(), ["page:d", "page:b", "page:e"], "a renewed entry counts as new");
  cache.set(rowKey("d", "r1"), {}, { policy: "memory" });
  cache.invalidate((key) => key.includes(":d"));
  assert.ok(!cache.keys().some((k) => k.includes(":d")));
  assert.ok(seen.includes("page:d"));
});

test("persisted entries survive a reload of the tab – for the same person only", () => {
  const storage = memoryStorage();
  const first = createSwrCache({ storage });
  first.scope("u1");
  first.set(pageKey("a"), page("a"), { policy: "persist" });
  first.set(pageKey("secret"), page("secret"), { policy: "memory" });
  assert.ok(storage.map.has(`${STORAGE_PREFIX}u1:page:a`));
  assert.ok(![...storage.map.keys()].some((k) => k.includes("secret")), "memory entries are never written");
  // Reloaded: the same person gets the kept page back.
  const again = createSwrCache({ storage });
  again.scope("u1");
  assert.equal(again.get<{ html: string }>(pageKey("a"))?.value.html, "<p>a</p>");
  assert.equal(again.get(pageKey("secret")), undefined);
  // Another person in the same tab: everything of the first one is gone.
  const other = createSwrCache({ storage });
  other.scope("u2");
  assert.equal(other.get(pageKey("a")), undefined);
  assert.ok(![...storage.map.keys()].some((k) => k.includes("u1")), "nothing of u1 stays in storage");
});

test("sign-out and a person switch wipe memory and storage", () => {
  const storage = memoryStorage();
  const cache = createSwrCache({ storage });
  cache.scope("u1");
  cache.set(pageKey("a"), page("a"), { policy: "persist" });
  cache.set(pageKey("b"), page("b"), { policy: "memory" });
  cache.scope("u2");
  assert.deepEqual(cache.keys(), []);
  cache.set(pageKey("c"), page("c"), { policy: "persist" });
  cache.clear();
  assert.deepEqual(cache.keys(), []);
  assert.equal(cache.owner(), null);
  assert.equal([...storage.map.keys()].filter((k) => k.startsWith(STORAGE_PREFIX)).length, 0);
  assert.equal(cache.get(pageKey("c")), undefined);
});

test("large entries stay in memory, storage keeps to its budget", () => {
  const storage = memoryStorage();
  const cache = createSwrCache({ storage, maxPersistBytes: 2000, maxStoredBytes: 5000 });
  cache.scope("u1");
  cache.set(pageKey("big"), { html: "x".repeat(5000) }, { policy: "persist" });
  assert.ok(cache.get(pageKey("big")), "kept in memory");
  assert.equal(cache.get(pageKey("big"))?.persist, false);
  assert.ok(!storage.map.has(`${STORAGE_PREFIX}u1:page:big`));
  for (let i = 0; i < 6; i++) cache.set(pageKey(`p${i}`), { html: "y".repeat(1500) }, { policy: "persist" });
  const stored = [...storage.map.entries()].filter(([k]) => k.startsWith(`${STORAGE_PREFIX}u1:`));
  assert.ok(stored.reduce((n, [, v]) => n + v.length, 0) <= 5000);
  assert.ok(storage.map.has(`${STORAGE_PREFIX}u1:page:p5`), "the newest stays");
  // A storage that refuses (private mode, full) does not break anything.
  const broken = { ...memoryStorage(), setItem: () => { throw new Error("QuotaExceeded"); } };
  const safe = createSwrCache({ storage: broken });
  safe.scope("u1");
  safe.set(pageKey("a"), page("a"), { policy: "persist" });
  assert.ok(safe.get(pageKey("a")));
});

test("policies: journals and PIN pages never, encrypted spaces only in memory", () => {
  assert.equal(pageCachePolicy(page("a") as never), "persist");
  assert.equal(pageCachePolicy({ ...page("j", { kind: "journal" }) } as never), "none");
  assert.equal(pageCachePolicy({ ...page("d", { journal_date: "2026-10-25" }) } as never), "none");
  assert.equal(pageCachePolicy({ ...page("l"), locked: { journalId: "j" } } as never), "none");
  // Below a journal (its sub-pages).
  const pages = [
    { id: "j", parent_id: null, kind: "journal", space_id: "s" },
    { id: "day", parent_id: "j", kind: "document", space_id: "s", journal_date: "2026-10-25" },
    { id: "note", parent_id: "day", kind: "document", space_id: "s" },
  ];
  assert.equal(pageCachePolicy({ ...page("note", { parent_id: "day" }) } as never, pages), "none");
  assert.equal(pageCachePolicy({ ...page("e"), encrypted: { spaceId: "x" } } as never), "memory");
  assert.equal(pageCachePolicy({ ...page("e2", { space_id: "enc" }) } as never, [], ["enc"]), "memory");
  assert.equal(pageCachePolicy({ ...page("big", { kind: "database" }), rows: new Array(301).fill({}) } as never), "memory", "large databases stay in memory");
  // Records follow their database; none without a kept copy of it.
  const cache = createSwrCache({ storage: memoryStorage() });
  cache.scope("u1");
  assert.equal(recordCachePolicy(cache, "db"), "none");
  cache.set(pageKey("db"), page("db"), { policy: "memory" });
  assert.equal(recordCachePolicy(cache, "db"), "memory");
  cache.set(pageKey("db"), page("db"), { policy: "persist" });
  assert.equal(recordCachePolicy(cache, "db"), "persist");
});
