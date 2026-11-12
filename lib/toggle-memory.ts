// Which toggles someone closed, per person and device (#230): a closed
// toggle stays closed after a reload. Like folded headings (#71,
// lib/heading-folds.ts) this is a way of looking at the document, never part
// of it – others, exports and published pages see toggles open, as before
// (#137). Stored in localStorage under one key, one entry per person and
// document, with block ids only (no document text). A toggle without a
// block id gets one when it is closed (lib/toggle-view.ts), imported ones on
// import (lib/block-ids.ts withToggleIds). Bounded: the documents changed
// last, and a limited number of toggles per document.

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type Store = Record<string, { ids: string[]; at: number }>;

export const TOGGLE_STORAGE_KEY = "flowplan.toggles";
export const MAX_TOGGLE_DOCUMENTS = 300;
export const MAX_CLOSED_TOGGLES = 500;
// Block ids (lib/block-ids.ts); positional identities ("@12") never.
const ID = /^[A-Za-z0-9_-]{1,64}$/;

// The entry of a document: the person, the page and the record in it.
export const toggleDocumentKey = (userId: string, pageId: string, rowId?: string | null) =>
  `${userId}:${rowId ? `${pageId}/${rowId}` : pageId}`;

export function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function readStore(storage: StorageLike | null): Store {
  try {
    const raw = storage?.getItem(TOGGLE_STORAGE_KEY);
    const value = raw ? JSON.parse(raw) : null;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Store) : {};
  } catch {
    return {};
  }
}

export function readClosedToggles(storage: StorageLike | null, key: string): string[] {
  const entry = readStore(storage)[key];
  if (!entry || !Array.isArray(entry.ids)) return [];
  return entry.ids.filter((id) => typeof id === "string" && ID.test(id)).slice(0, MAX_CLOSED_TOGGLES);
}

export function writeClosedToggles(storage: StorageLike | null, key: string, ids: Iterable<string>, now = Date.now()) {
  if (!storage) return;
  const store = readStore(storage);
  const list = [...new Set(ids)].filter((id) => ID.test(id)).slice(0, MAX_CLOSED_TOGGLES);
  if (list.length) store[key] = { ids: list, at: now };
  else delete store[key];
  const kept = Object.keys(store)
    .filter((k) => store[k] && Array.isArray(store[k].ids))
    .sort((a, b) => (store[b].at || 0) - (store[a].at || 0))
    .slice(0, MAX_TOGGLE_DOCUMENTS);
  try {
    if (!kept.length) storage.removeItem(TOGGLE_STORAGE_KEY);
    else storage.setItem(TOGGLE_STORAGE_KEY, JSON.stringify(Object.fromEntries(kept.map((k) => [k, store[k]]))));
  } catch {
    // Full or blocked storage: the toggles simply open again next time.
  }
}
