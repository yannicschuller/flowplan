// Groups on whiteboards. Every element keeps the ids of the groups it is
// in, outermost first ("groups": ["g1", "g2"] – g2 is a group inside g1).
// Groups therefore live in the elements themselves: they move, sync,
// undo and copy with them, and a group without members simply is gone.
//
// A click selects the "unit" of an element: its outermost group, or – after
// a double click entered a group – the next group inside it, or the
// element itself on the innermost level.
import type { WhiteboardItem } from "./whiteboard-model";

type Grouped = Pick<WhiteboardItem, "id" | "groups">;
type Box = { x: number; y: number; w: number; h: number };
const GROUP_ID = /^[\w-]{1,64}$/;

export function groupPath(item: Pick<WhiteboardItem, "groups">): string[] {
  if (!Array.isArray(item.groups)) return [];
  const out: string[] = [];
  for (const g of item.groups) if (typeof g === "string" && GROUP_ID.test(g) && !out.includes(g)) out.push(g);
  return out.slice(0, 16);
}
export function groupMembers(items: Grouped[], groupId: string) {
  return items.filter((i) => groupPath(i).includes(groupId)).map((i) => i.id);
}
// The group a click on the element selects, or null for the element alone.
export function unitGroup(item: Grouped, entered: string | null) {
  const path = groupPath(item);
  if (!entered) return path[0] ?? null;
  const at = path.indexOf(entered);
  return (at < 0 ? path[0] : path[at + 1]) ?? null;
}
export function selectionUnit(item: Grouped, items: Grouped[], entered: string | null): string[] {
  const group = unitGroup(item, entered);
  return group ? groupMembers(items, group) : [item.id];
}
// A selection made of single elements (marquee, select all) grows to the
// whole units they belong to.
export function expandSelection(ids: Iterable<string>, items: Grouped[], entered: string | null) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const out = new Set<string>();
  for (const id of ids) {
    const item = byId.get(id);
    if (!item) continue;
    for (const member of selectionUnit(item, items, entered)) out.add(member);
  }
  return out;
}
// Groups whose members are all selected.
function wholeGroups(selected: Grouped[], items: Grouped[]) {
  const chosen = new Set(selected.map((i) => i.id));
  const whole = new Set<string>();
  for (const item of selected)
    for (const g of groupPath(item))
      if (!whole.has(g) && groupMembers(items, g).every((id) => chosen.has(id))) whole.add(g);
  return whole;
}
// Where the unit of each selected element starts in its path: the
// outermost group that is selected whole, else the end of the path.
function unitIndex(item: Grouped, whole: Set<string>) {
  const path = groupPath(item);
  const at = path.findIndex((g) => whole.has(g));
  return at < 0 ? path.length : at;
}
const commonPrefix = (paths: string[][]) => {
  if (!paths.length) return [];
  let n = Math.min(...paths.map((p) => p.length));
  for (let i = 0; i < n; i++)
    if (paths.some((p) => p[i] !== paths[0][i])) {
      n = i;
      break;
    }
  return paths[0].slice(0, n);
};

// Ctrl/⌘+G: the selected units become one group (inside the group the
// selection lies in). Null when there is nothing to group.
export function groupSelection(selected: Grouped[], items: Grouped[], newId: () => string) {
  if (selected.length < 2) return null;
  const whole = wholeGroups(selected, items);
  const units = new Set(selected.map((i) => groupPath(i)[unitIndex(i, whole)] ?? `item:${i.id}`));
  if (units.size < 2) return null;
  const common = commonPrefix(selected.map((i) => groupPath(i).slice(0, unitIndex(i, whole))));
  const id = newId();
  const paths = new Map<string, string[]>();
  for (const item of selected) {
    const path = groupPath(item);
    paths.set(item.id, [...common, id, ...path.slice(unitIndex(item, whole))]);
  }
  return { id, paths };
}
// Shift+Ctrl/⌘+G: the outermost selected groups dissolve; groups inside
// them stay.
export function ungroupSelection(selected: Grouped[], items: Grouped[]) {
  const whole = wholeGroups(selected, items);
  const paths = new Map<string, string[]>();
  for (const item of selected) {
    const path = groupPath(item);
    const at = unitIndex(item, whole);
    if (at < path.length) paths.set(item.id, [...path.slice(0, at), ...path.slice(at + 1)]);
  }
  return paths.size ? paths : null;
}
export function canUngroup(selected: Grouped[], items: Grouped[]) {
  return !!ungroupSelection(selected, items);
}
// Copies get groups of their own (the same structure, new ids).
export function remapGroups<T extends Grouped>(list: T[], newId: () => string): T[] {
  const ids = new Map<string, string>();
  return list.map((item) => {
    const path = groupPath(item);
    if (!path.length) return item;
    return {
      ...item,
      groups: path.map((g) => {
        if (!ids.has(g)) ids.set(g, newId());
        return ids.get(g)!;
      }),
    };
  });
}
// The selection is exactly one group (shown with handles to resize as a unit).
export function selectedGroup(selected: Grouped[], items: Grouped[]) {
  if (selected.length < 2) return null;
  const common = commonPrefix(selected.map(groupPath));
  for (let i = common.length - 1; i >= 0; i--) {
    const members = groupMembers(items, common[i]);
    if (members.length === selected.length) return common[i];
  }
  return null;
}

// Resizing several elements as one: positions and sizes scale with the
// box; texts grow and shrink with it.
export type ScaleOrigin = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fontSize?: number;
  strokeWidth?: number;
  from?: { x: number; y: number };
  to?: { x: number; y: number };
};
export function scaleItems(origins: ScaleOrigin[], from: Box, to: Box) {
  const sx = to.w / Math.max(1, from.w),
    sy = to.h / Math.max(1, from.h);
  const font = Math.sqrt(Math.abs(sx * sy));
  const mapX = (x: number) => to.x + (x - from.x) * sx,
    mapY = (y: number) => to.y + (y - from.y) * sy;
  return origins.map((o) => {
    const props: Partial<WhiteboardItem> & { id: string } = {
      id: o.id,
      x: Math.round(mapX(o.x)),
      y: Math.round(mapY(o.y)),
      w: Math.max(1, Math.round(o.w * sx)),
      h: Math.max(1, Math.round(o.h * sy)),
    };
    if (o.fontSize) props.fontSize = Math.max(6, Math.round(o.fontSize * font));
    if (o.from) props.from = { x: Math.round(mapX(o.from.x)), y: Math.round(mapY(o.from.y)) };
    if (o.to) props.to = { x: Math.round(mapX(o.to.x)), y: Math.round(mapY(o.to.y)) };
    return props;
  });
}
// The box after dragging a corner handle (opposite corner fixed, aspect
// kept: groups scale like pictures).
export function resizeBox(origin: Box, handle: string, dx: number, dy: number, keepRatio = true): Box {
  let { x, y, w, h } = origin;
  if (handle.includes("e")) w = origin.w + dx;
  if (handle.includes("s")) h = origin.h + dy;
  if (handle.includes("w")) {
    w = origin.w - dx;
    x = origin.x + dx;
  }
  if (handle.includes("n")) {
    h = origin.h - dy;
    y = origin.y + dy;
  }
  if (keepRatio) {
    // The side pulled further decides; the other follows.
    const scale = Math.max(w / Math.max(1, origin.w), h / Math.max(1, origin.h), 20 / Math.max(1, Math.min(origin.w, origin.h)));
    w = origin.w * scale;
    h = origin.h * scale;
  }
  w = Math.max(20, w);
  h = Math.max(20, h);
  if (handle.includes("w")) x = origin.x + origin.w - w;
  if (handle.includes("n")) y = origin.y + origin.h - h;
  return { x, y, w, h };
}
