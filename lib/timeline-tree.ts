// The rows of a database timeline as an outline (#394): records below
// their parent (a self-relation chosen as "Hierarchie-Feld"), optionally in
// groups of a property (the view's groupBy), each parent or group with a
// summary period from the earliest start to the latest end of everything
// below it. Collapsed parents and groups hide what is below them; links to
// hidden records attach to the nearest shown line. Pure and free of the
// app's imports, so the published timeline (components/public-timeline.tsx)
// uses it as well; the tests call it directly.

type Range = { start: number; end: number };
export type OutlineInput = {
  id: string;
  // The parent record's id (absent: a top-level record). Parents that are
  // not among the inputs, or would form a loop, make a record top-level.
  parent?: string;
  // The group's key (absent: no groups).
  group?: string;
};
export type OutlineLine =
  | { type: "group"; id: string; key: string; label: string; count: number; depth: 0; collapsed: boolean }
  | { type: "row"; id: string; depth: number; parent?: string; children: number; collapsed: boolean };
export const groupLineId = (key: string) => `group:${key}`;

export function timelineOutline(
  items: OutlineInput[],
  {
    groups,
    collapsed = new Set(),
  }: {
    // The groups in their order, with their labels (absent: no groups).
    groups?: { key: string; label: string }[];
    collapsed?: ReadonlySet<string>;
  } = {},
) {
  const ids = new Set(items.map((i) => i.id));
  const byId = new Map(items.map((i) => [i.id, i]));
  // The parent each record really sits below: present, in the same group
  // and not on a loop.
  const parentOf = new Map<string, string>();
  for (const item of items) {
    const p = item.parent;
    if (!p || p === item.id || !ids.has(p) || byId.get(p)!.group !== item.group) continue;
    parentOf.set(item.id, p);
  }
  for (const item of items) {
    const seen = new Set([item.id]);
    for (let p = parentOf.get(item.id); p; p = parentOf.get(p)) {
      if (seen.has(p)) {
        parentOf.delete(item.id);
        break;
      }
      seen.add(p);
    }
  }
  const childrenOf = new Map<string, string[]>();
  for (const item of items) {
    const p = parentOf.get(item.id);
    if (p) childrenOf.set(p, [...(childrenOf.get(p) || []), item.id]);
  }
  const lines: OutlineLine[] = [];
  // Hidden record → the line it shows on (its collapsed ancestor or group).
  const anchor = new Map<string, string>();
  const walk = (id: string, depth: number, hiddenBy: string | null) => {
    const kids = childrenOf.get(id) || [];
    const closed = collapsed.has(id);
    if (hiddenBy) anchor.set(id, hiddenBy);
    else lines.push({ type: "row", id, depth, parent: parentOf.get(id), children: kids.length, collapsed: closed && kids.length > 0 });
    for (const k of kids) walk(k, depth + 1, hiddenBy ?? (closed ? id : null));
  };
  const roots = (group?: string) => items.filter((i) => !parentOf.has(i.id) && i.group === group);
  if (groups) {
    const known = new Set(groups.map((g) => g.key));
    for (const g of groups) {
      const members = items.filter((i) => i.group === g.key);
      if (!members.length) continue;
      const id = groupLineId(g.key),
        closed = collapsed.has(id);
      lines.push({ type: "group", id, key: g.key, label: g.label, count: members.length, depth: 0, collapsed: closed });
      for (const r of roots(g.key)) walk(r.id, 1, closed ? id : null);
    }
    // Records of a group that is not listed stay visible at the end.
    for (const r of items.filter((i) => !parentOf.has(i.id) && (i.group === undefined || !known.has(i.group)))) walk(r.id, 0, null);
  } else for (const r of roots(undefined)) walk(r.id, 0, null);
  return { lines, anchor, childrenOf, parentOf };
}

// Every record below `id`, at any depth.
export function descendants(childrenOf: Map<string, string[]>, id: string) {
  const out: string[] = [];
  const queue = [...(childrenOf.get(id) || [])];
  const seen = new Set<string>();
  while (queue.length) {
    const next = queue.shift()!;
    if (seen.has(next)) continue;
    seen.add(next);
    out.push(next);
    queue.push(...(childrenOf.get(next) || []));
  }
  return out;
}

// The summary period of every parent: from the earliest start to the
// latest end of all records below it that have a period (its own stored
// dates do not count). Parents with nothing dated below them get none.
export function summaryRanges(childrenOf: Map<string, string[]>, rangeOf: (id: string) => Range | null | undefined) {
  const out = new Map<string, Range>();
  const visit = (id: string, trail: Set<string>): Range | null => {
    if (out.has(id)) return out.get(id)!;
    let start = Infinity,
      end = -Infinity;
    for (const child of childrenOf.get(id) || []) {
      if (trail.has(child)) continue;
      trail.add(child);
      const own = rangeOf(child),
        below = childrenOf.has(child) ? visit(child, trail) : null;
      trail.delete(child);
      for (const r of [own, below])
        if (r) {
          start = Math.min(start, r.start);
          end = Math.max(end, r.end);
        }
    }
    if (start > end) return null;
    const range = { start, end };
    out.set(id, range);
    return range;
  };
  for (const id of childrenOf.keys()) visit(id, new Set([id]));
  return out;
}
// The same for groups: everything in the group.
export function groupRange(ids: string[], rangeOf: (id: string) => Range | null | undefined): Range | null {
  let start = Infinity,
    end = -Infinity;
  for (const id of ids) {
    const r = rangeOf(id);
    if (r) {
      start = Math.min(start, r.start);
      end = Math.max(end, r.end);
    }
  }
  return start <= end ? { start, end } : null;
}

// Links between shown lines: a link to a hidden record goes to the line it
// shows on; links inside one collapsed line disappear, doubles merge.
export function anchoredLinks<T extends { from: string; to: string }>(links: T[], anchor: Map<string, string>) {
  const out: (T & { line: { from: string; to: string } })[] = [];
  const seen = new Set<string>();
  for (const link of links) {
    const from = anchor.get(link.from) || link.from,
      to = anchor.get(link.to) || link.to;
    if (from === to) continue;
    const key = `${from}>${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...link, line: { from, to } });
  }
  return out;
}

// Collapsed parents and groups, remembered per view on this device
// (localStorage; missing or throwing storage keeps nothing).
type Store = Pick<Storage, "getItem" | "setItem"> | undefined | null;
export const collapsedKey = (id: string) => `flowplan:timeline-collapsed:${id}`;
export function readCollapsed(store: Store, id: string): Set<string> {
  try {
    const value = JSON.parse(store?.getItem(collapsedKey(id)) || "[]");
    return new Set(Array.isArray(value) ? value.filter((v): v is string => typeof v === "string").slice(0, 5000) : []);
  } catch {
    return new Set();
  }
}
export function writeCollapsed(store: Store, id: string, collapsed: ReadonlySet<string>) {
  try {
    store?.setItem(collapsedKey(id), JSON.stringify([...collapsed].slice(0, 5000)));
  } catch {}
}
