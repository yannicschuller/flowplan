// Which tab of a tabs block someone looks at (#272), per person and device:
// the same tab is open again after a reload. Like closed toggles
// (lib/toggle-memory.ts) a way of looking at the document, never part of
// it – switching tabs changes nothing for others and creates no version.
// Stored in localStorage under one key, one entry per person and document,
// with block ids and tab numbers only (no document text). Bounded: the
// documents looked at last, and a limited number of blocks per document.
import { browserStorage } from "./toggle-memory";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type Store = Record<string, { tabs: Record<string, number>; at: number }>;

export const TABS_STORAGE_KEY = "flowplan.tabs";
export const MAX_TABS_DOCUMENTS = 300;
export const MAX_TABS_BLOCKS = 200;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
export { browserStorage };

function readStore(storage: StorageLike | null): Store {
  try {
    const raw = storage?.getItem(TABS_STORAGE_KEY);
    const value = raw ? JSON.parse(raw) : null;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Store) : {};
  } catch {
    return {};
  }
}
const validIndex = (value: unknown) => Number.isInteger(value) && (value as number) >= 0 && (value as number) < 1000;

// The open tab (its number) of each tabs block of a document, by block id.
export function readActiveTabs(storage: StorageLike | null, key: string): Map<string, number> {
  const entry = readStore(storage)[key];
  const out = new Map<string, number>();
  if (!entry || !entry.tabs || typeof entry.tabs !== "object") return out;
  for (const [id, index] of Object.entries(entry.tabs)) {
    if (out.size >= MAX_TABS_BLOCKS) break;
    if (ID.test(id) && validIndex(index)) out.set(id, index);
  }
  return out;
}

export function writeActiveTabs(storage: StorageLike | null, key: string, tabs: ReadonlyMap<string, number>, now = Date.now()) {
  if (!storage) return;
  const store = readStore(storage);
  // The first tab is the default: not stored.
  const list = [...tabs].filter(([id, index]) => ID.test(id) && validIndex(index) && index > 0).slice(-MAX_TABS_BLOCKS);
  if (list.length) store[key] = { tabs: Object.fromEntries(list), at: now };
  else delete store[key];
  const kept = Object.keys(store)
    .filter((k) => store[k] && store[k].tabs && typeof store[k].tabs === "object")
    .sort((a, b) => (store[b].at || 0) - (store[a].at || 0))
    .slice(0, MAX_TABS_DOCUMENTS);
  try {
    if (!kept.length) storage.removeItem(TABS_STORAGE_KEY);
    else storage.setItem(TABS_STORAGE_KEY, JSON.stringify(Object.fromEntries(kept.map((k) => [k, store[k]]))));
  } catch {
    // Full or blocked storage: the first tab shows next time.
  }
}
