// What the quick search shows besides a hit's title (#243): where it sits
// (its path) and the groups of the recently visited list. Pure functions
// over what the workspace already sent, so they run in the browser.
//
// The path comes from lib/page-path.ts (#231), over the pages the person
// may read (the bootstrap's list): it stops at the first parent that is
// not readable, so a hit never shows titles of hidden pages above it.
import { structuralPath, type PathPage, type PathRecordParent } from "./page-path";

export type HitPlace = { id: string; rowId?: string; space_id: string };

// The path of a hit, without the hit itself: its space, the pages above it,
// and for a record its database. Long paths keep the space, "…" and the
// last two segments.
export function hitPath(
  hit: HitPlace,
  readable: readonly PathPage[],
  spaces: readonly { id: string; name: string }[],
  records: readonly PathRecordParent[] = [],
  room = 4,
): string[] {
  const page = readable.find((p) => p.id === hit.id);
  const space = spaces.find((s) => s.id === hit.space_id)?.name;
  if (!page) return space ? [space] : [];
  const segments = structuralPath(readable, page, null, records).map((s) => s.title || "…");
  // A page: the path above it; a record: its database too.
  const above = hit.rowId ? segments : segments.slice(0, -1);
  const full = space ? [space, ...above] : above;
  if (full.length <= room) return full;
  return [full[0], "…", ...full.slice(full.length - (room - 2))];
}

// The local day (YYYY-MM-DD) of a moment.
export function localDayOf(ms: number, timeZone?: string) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

// Recently visited entries grouped by the day of the visit, newest first:
// "today", "yesterday" or the day itself (the caller names them).
export type DayGroup<T> = { day: string; label: "today" | "yesterday" | "date"; items: T[] };
export function groupByDay<T extends { visitedAt: number }>(items: readonly T[], now = Date.now(), timeZone?: string): DayGroup<T>[] {
  const today = localDayOf(now, timeZone);
  const yesterday = localDayOf(now - 86_400_000, timeZone);
  const groups: DayGroup<T>[] = [];
  for (const item of [...items].sort((a, b) => b.visitedAt - a.visitedAt)) {
    const day = localDayOf(item.visitedAt, timeZone);
    let group = groups[groups.length - 1];
    if (!group || group.day !== day) {
      group = { day, label: day === today ? "today" : day === yesterday ? "yesterday" : "date", items: [] };
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}
