// How much of a device's offline copy may be record contents and files, and
// which spaces, pages and databases it keeps whole (#417). Pure functions,
// used by components/offline.ts (the refresh) and
// components/offline-settings.tsx; tests/offline-keep.test.ts checks them.
//
// - The budget: record contents and files counted against it, chosen per
//   device and profile under Settings → Offline & devices. The desktop app
//   keeps 2 GB by default (like the iPhone and iPad app's copy of a
//   profile), browsers and the installed web app 200 MB. The browser's own
//   room (fitsQuota() with STORAGE_RESERVE, lib/offline-assets.ts) still
//   limits every entry.
// - "Offline behalten" / "Keep offline": a space, or a page with every page
//   below it (a database with its records), also stores its record contents
//   and files, even ones never opened, ahead of everything else within the
//   budget. The choice is kept on the device in the offline marker
//   (components/offline.ts): it is about this device's storage, and goes
//   with the copy when offline use is switched off or the person signs out.
//   Encrypted spaces stay online-only, so nothing in them is kept.
// - Pages are always stored (they are small and the app needs them all);
//   the budget and the order only concern record contents and files.

export const MB = 1024 * 1024;
export const GB = 1024 * MB;

export type OfflinePlatform = "desktop" | "app" | "browser";
// 200 MB · 1 GB · 2 GB · 5 GB · 10 GB.
export const BUDGET_CHOICES = [200 * MB, GB, 2 * GB, 5 * GB, 10 * GB] as const;
export const BROWSER_BUDGET = 200 * MB;
export const DESKTOP_BUDGET = 2 * GB;
// The iPhone and iPad app keeps at most 2 GB per profile for the whole
// copy – pages and the app's files included (flowplan-app
// src/offline/policy.ts MAX_PROFILE) – so it offers less than that for
// record contents and files, and keeps 200 MB unless chosen otherwise.
export const APP_PROFILE_LIMIT = 2 * GB;

export function budgetChoices(platform: OfflinePlatform): number[] {
  return BUDGET_CHOICES.filter((bytes) => platform !== "app" || bytes < APP_PROFILE_LIMIT);
}
export function defaultBudget(platform: OfflinePlatform): number {
  return platform === "desktop" ? DESKTOP_BUDGET : BROWSER_BUDGET;
}
// The budget of this device: the stored choice when it is one of the
// choices here, the platform's default otherwise.
export function offlineBudget(chosen: unknown, platform: OfflinePlatform): number {
  return typeof chosen === "number" && budgetChoices(platform).includes(chosen) ? chosen : defaultBudget(platform);
}

export type KeepItem = { kind: "space" | "page"; id: string };
export const sameItem = (a: KeepItem, b: KeepItem) => a.kind === b.kind && a.id.toLowerCase() === b.id.toLowerCase();
export const isKept = (keep: readonly KeepItem[] | undefined, item: KeepItem) => !!keep?.some((k) => sameItem(k, item));
// The list with the item switched on or off. Switching off remembers the
// item as released: the next refresh frees what only it kept.
export function toggleKeep(
  { keep = [], released = [] }: { keep?: KeepItem[]; released?: KeepItem[] },
  item: KeepItem,
  on: boolean,
): { keep: KeepItem[]; released: KeepItem[] } {
  const clean = { kind: item.kind, id: item.id };
  const without = keep.filter((k) => !sameItem(k, item));
  if (on) return { keep: [...without, clean], released: released.filter((k) => !sameItem(k, item)) };
  return { keep: without, released: isKept(keep, item) && !isKept(released, item) ? [...released, clean] : released };
}

// The page tree as the workspace's bootstrap sends it (readable pages only).
export type TreePage = { id: string; space_id: string; parent_id: string | null };
// The pages a list of items covers: every page of a kept space, a kept page
// and everything below it. Pages of encrypted spaces never.
export function keptPageIds(items: readonly KeepItem[] | undefined, pages: readonly TreePage[], encrypted: ReadonlySet<string> = new Set()): Set<string> {
  const out = new Set<string>();
  if (!items?.length) return out;
  const children = new Map<string, string[]>();
  const byId = new Map<string, TreePage>();
  for (const page of pages) {
    byId.set(page.id.toLowerCase(), page);
    if (!page.parent_id) continue;
    const parent = page.parent_id.toLowerCase();
    children.set(parent, [...(children.get(parent) || []), page.id.toLowerCase()]);
  }
  const allowed = (page: TreePage | undefined) => !!page && !encrypted.has(page.space_id);
  const below = (id: string) => {
    const stack = [id];
    while (stack.length) {
      const next = stack.pop()!;
      if (out.has(next) || !allowed(byId.get(next))) continue;
      out.add(next);
      stack.push(...(children.get(next) || []));
    }
  };
  for (const item of items) {
    if (item.kind === "space") {
      if (encrypted.has(item.id)) continue;
      for (const page of pages) if (page.space_id.toLowerCase() === item.id.toLowerCase()) below(page.id.toLowerCase());
    } else below(item.id.toLowerCase());
  }
  return out;
}

// An entry of the copy that counts against the budget: a record's content
// or a file. `kept`: it belongs to a kept item. `locked`: it must stay –
// a record or file with changes on this device that are not sent yet.
export type BudgetEntry = { key: string; size: number; kept: boolean; locked?: boolean };
// What may go to make room: entries outside kept items, never locked ones,
// largest first.
function evictable(entries: Iterable<BudgetEntry>) {
  return [...entries].filter((e) => !e.kept && !e.locked).sort((a, b) => b.size - a.size || a.key.localeCompare(b.key));
}
// Over the budget (it was lowered): entries outside kept items go first,
// then kept ones, largest first; locked ones never.
export function planTrim(entries: Iterable<BudgetEntry>, budget: number): string[] {
  const list = [...entries];
  let used = list.reduce((sum, e) => sum + e.size, 0);
  const drop: string[] = [];
  const kept = list.filter((e) => e.kept && !e.locked).sort((a, b) => b.size - a.size || a.key.localeCompare(b.key));
  for (const entry of [...evictable(list), ...kept]) {
    if (used <= budget) break;
    drop.push(entry.key);
    used -= entry.size;
  }
  return drop;
}
// Room for one more entry of `size` bytes: it fits as it is, or – for a
// kept entry – once entries outside kept items are dropped (they come back
// when opened). Nothing is dropped when even that would not be enough.
export function planRoom({ entries, used, budget, size, kept }: { entries: Iterable<BudgetEntry>; used: number; budget: number; size: number; kept: boolean }): { fits: boolean; drop: string[] } {
  if (used + size <= budget) return { fits: true, drop: [] };
  if (!kept) return { fits: false, drop: [] };
  const drop: string[] = [];
  let freed = 0;
  for (const entry of evictable(entries)) {
    if (used - freed + size <= budget) break;
    drop.push(entry.key);
    freed += entry.size;
  }
  return used - freed + size <= budget ? { fits: true, drop } : { fits: false, drop: [] };
}

// Freed after "Keep offline" was switched off (and "Also store record
// contents and files" is off): the records of the released pages and the
// files only they refer to – unless another kept item still covers them,
// they are locked, or they are a flashcard deck's pictures. Opened ones go
// too and come back the next time they are opened, as when "Also store
// record contents and files" is switched off.
export function planRelease({
  keys,
  released,
  kept,
  referrers,
  locked = () => false,
}: {
  keys: string[];
  released: ReadonlySet<string>;
  kept: ReadonlySet<string>;
  // File id → the pages whose stored page or record answers refer to it
  // ("cards" for a flashcard deck's pictures).
  referrers: ReadonlyMap<string, ReadonlySet<string>>;
  locked?: (key: string) => boolean;
}): string[] {
  const freed = (page: string) => released.has(page) && !kept.has(page);
  const drop: string[] = [];
  for (const key of keys) {
    if (locked(key)) continue;
    const row = ROW_KEY.exec(key);
    if (row) {
      if (freed(row[1].toLowerCase())) drop.push(key);
      continue;
    }
    const file = FILE_KEY.exec(key)?.[1]?.toLowerCase();
    if (!file) continue;
    const from = referrers.get(file);
    if (from?.size && [...from].every(freed)) drop.push(key);
  }
  return drop;
}

// Storage per space (Settings → Offline & devices): pages (with their
// previews, decks …), record contents and files, in bytes. A file counts
// for the space of the first page that refers to it; what belongs to no
// page of the tree (the app's page, the workspace) is left out.
export type SpaceUsage = { pages: number; records: number; files: number };
export function usageBySpace({
  sizes,
  spaceOf,
  fileOwner,
}: {
  sizes: Iterable<[string, number]>;
  spaceOf: ReadonlyMap<string, string>;
  fileOwner: ReadonlyMap<string, string>;
}): Record<string, SpaceUsage> {
  const out: Record<string, SpaceUsage> = {};
  const add = (space: string | undefined, part: keyof SpaceUsage, size: number) => {
    if (!space) return;
    out[space] ??= { pages: 0, records: 0, files: 0 };
    out[space][part] += size;
  };
  for (const [key, size] of sizes) {
    const row = ROW_KEY.exec(key);
    if (row) {
      add(spaceOf.get(row[1].toLowerCase()), "records", size);
      continue;
    }
    const page = PAGE_KEY.exec(key)?.[1]?.toLowerCase();
    if (page) {
      add(spaceOf.get(page), "pages", size);
      continue;
    }
    const file = FILE_KEY.exec(key)?.[1]?.toLowerCase();
    if (file) {
      const owner = fileOwner.get(file);
      add(owner ? spaceOf.get(owner) : undefined, "files", size);
    }
  }
  return out;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PAGE_KEY = new RegExp(`^/api/pages/(${UUID})(?:[/?]|$)`, "i");
const ROW_KEY = new RegExp(`^/api/pages/(${UUID})/rows/(${UUID})$`, "i");
const FILE_KEY = new RegExp(`^/api/files/(${UUID})(?:[/?]|$)`, "i");
// The page a record answer belongs to, or null.
export const rowPage = (key: string) => ROW_KEY.exec(key)?.[1]?.toLowerCase() ?? null;
