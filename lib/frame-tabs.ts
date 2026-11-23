// Tabs and frames of the workspace (#279, stage 1): every frame holds tabs,
// every tab a place of the app (a page, a record, the start page, the inbox,
// a section of the settings … – the hash route without "#", as stepOf() in
// lib/history-nav.ts writes it) and its own history of places. At most two
// frames side by side: the left one is the main view the address (#…)
// follows, the right one the former split view (?split=<id>).
// components/frame-tabs.tsx keeps the layout per device and draws the tab
// bars; this file is the pure model, without the DOM (tests/frame-tabs.test.ts).
import { stepOf } from "./history-nav";

export type Tab = {
  id: string;
  // The places this tab went through and where it stands among them.
  stack: string[];
  index: number;
  // Pinned (#444): kept at the left of its frame, shown as its icon only,
  // not closed by the close shortcuts, the middle button or "close other
  // tabs" – only from its menu.
  pinned?: boolean;
  // The id of its group (#444) in the frame's `groups`.
  group?: string;
};
// Tab groups (#444): a named, coloured run of tabs in one frame. A group's
// tabs stand side by side; pinned tabs belong to none; a group without
// tabs goes; a collapsed group shows as its chip only – never with the
// active tab inside (switching into it opens it again).
export const GROUP_COLORS = ["gray", "blue", "green", "red", "yellow", "orange", "purple", "pink", "teal"] as const;
export type GroupColor = (typeof GROUP_COLORS)[number];
export type TabGroup = { id: string; name: string; color: GroupColor; collapsed?: boolean };
export const MAX_GROUP_NAME = 60;
export type Frame = { tabs: Tab[]; active: string; groups?: TabGroup[] };
export type Layout = {
  // One frame, or two side by side (index 0: left, the main view).
  frames: Frame[];
  // The frame worked in last: opening, closing and the history act there.
  focused: number;
};

export const MAX_FRAMES = 2;
// Tabs per frame; a tab opened beyond replaces the place of the active one.
export const MAX_TABS = 30;
// Places kept in a tab's history.
export const MAX_STACK = 50;

let counter = 0;
export const newTabId = () => `t${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
export const newGroupId = () => `g${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const placeOf = (tab: Tab) => tab.stack[tab.index];
export const tabOf = (frame: Frame) => frame.tabs.find((t) => t.id === frame.active) ?? frame.tabs[0];
export const activePlace = (layout: Layout, frame = layout.focused) => {
  const f = layout.frames[frame];
  return f ? placeOf(tabOf(f)) : null;
};
export const tabCount = (layout: Layout) => layout.frames.reduce((n, f) => n + f.tabs.length, 0);
// The pinned tabs lead their frame: how many there are.
export const pinnedCount = (frame: Frame) => {
  const at = frame.tabs.findIndex((t) => !t.pinned);
  return at < 0 ? frame.tabs.length : at;
};
// Pinned tabs first, otherwise the order kept.
const pinnedFirst = (tabs: Tab[]) => [...tabs.filter((t) => t.pinned), ...tabs.filter((t) => !t.pinned)];
const withoutGroup = (tab: Tab): Tab => {
  if (!tab.group) return tab;
  const { group: _gone, ...rest } = tab;
  return rest;
};

export const groupOf = (frame: Frame, tab: Tab | undefined) => (tab?.group ? (frame.groups?.find((g) => g.id === tab.group) ?? null) : null);
export const groupTabs = (frame: Frame, groupId: string) => frame.tabs.filter((t) => t.group === groupId);
// Hidden in a collapsed group.
export const tabHidden = (frame: Frame, tab: Tab) => !!groupOf(frame, tab)?.collapsed && tab.id !== frame.active;

// The frame with its rules kept: pinned tabs first and in no group; a
// group's tabs side by side (where its first tab stands); groups without
// tabs and tabs of unknown groups let go; the active tab's group open.
export function tidy(frame: Frame): Frame {
  const known = new Set((frame.groups ?? []).map((g) => g.id));
  const clean = pinnedFirst(frame.tabs.map((t) => (t.group && (t.pinned || !known.has(t.group)) ? withoutGroup(t) : t)));
  const tabs: Tab[] = [];
  const placed = new Set<string>();
  for (const t of clean) {
    if (!t.group) tabs.push(t);
    else if (!placed.has(t.group)) {
      placed.add(t.group);
      tabs.push(...clean.filter((x) => x.group === t.group));
    }
  }
  const open = tabs.find((t) => t.id === frame.active)?.group;
  const groups = (frame.groups ?? [])
    .filter((g) => placed.has(g.id))
    .map((g) => {
      if (g.id !== open || !g.collapsed) return g;
      const { collapsed: _open, ...rest } = g;
      return rest;
    });
  const next: Frame = { tabs, active: frame.active };
  if (groups.length) next.groups = groups;
  return next;
}

export function singleLayout(place: string, id = newTabId()): Layout {
  return { frames: [{ tabs: [{ id, stack: [place], index: 0 }], active: id }], focused: 0 };
}

const withFrame = (layout: Layout, index: number, frame: Frame): Layout => ({
  ...layout,
  frames: layout.frames.map((f, i) => (i === index ? tidy(frame) : f)),
});
const withTab = (frame: Frame, tab: Tab): Frame => ({ ...frame, tabs: frame.tabs.map((t) => (t.id === tab.id ? tab : t)) });
const clampFocus = (layout: Layout): Layout => ({ ...layout, focused: Math.max(0, Math.min(layout.focused, layout.frames.length - 1)) });

// A new place in a tab: the places after the current one go (as in a
// browser), the oldest beyond MAX_STACK as well.
function pushed(tab: Tab, place: string): Tab {
  if (placeOf(tab) === place) return tab;
  const stack = [...tab.stack.slice(0, tab.index + 1), place];
  const drop = Math.max(0, stack.length - MAX_STACK);
  return { ...tab, stack: stack.slice(drop), index: stack.length - 1 - drop };
}

// How the address of the active tab changed: a new place ("push"), its
// place replaced ("replace"), back or forward through the history
// ("back"/"forward") or not known (an address change without the
// Navigation API: a place next to the current one counts as back or
// forward, as lib/history-nav.ts's trail does).
export type Change = "push" | "replace" | "back" | "forward" | "unknown";

// The active tab of `frame` follows a change of its place. `before`: the
// place of the browser's entry before the current one, where known.
export function follow(layout: Layout, frame: number, place: string, change: Change = "push", before?: string | null): Layout {
  const f = layout.frames[frame];
  if (!f) return layout;
  const tab = tabOf(f);
  if (placeOf(tab) === place) return layout;
  let next: Tab;
  // A browser entry with the tab's place on top of the entry of that place
  // – the related record's overlay (lib/related-record.ts), a step without
  // an address of its own – replaced by a new place ("In Datenbank
  // öffnen"): for the tab a new step, so that Back returns to the place
  // below, as the browser does.
  if (change === "replace" && before && before === placeOf(tab)) next = pushed(tab, place);
  else if (change === "replace") {
    const stack = tab.stack.slice();
    stack[tab.index] = place;
    next = { ...tab, stack };
  } else if (change === "push") next = pushed(tab, place);
  else {
    const before = tab.stack[tab.index - 1] === place,
      after = tab.stack[tab.index + 1] === place;
    if (change === "back" || change === "forward") {
      // Through the browser's own history: the step of this tab in that
      // direction, whatever place the browser's entry held (it may belong
      // to another tab) – the caller shows that tab's place again. At the
      // end of the tab's history the browser's place joins it there, so
      // the browser's buttons never stand still.
      const delta = change === "back" ? -1 : 1;
      const index = tab.index + delta;
      if (index >= 0 && index < tab.stack.length) next = { ...tab, index };
      else if (change === "back") next = { ...tab, stack: [place, ...tab.stack].slice(0, MAX_STACK), index: 0 };
      else next = pushed(tab, place);
    } else if (before) next = { ...tab, index: tab.index - 1 };
    else if (after) next = { ...tab, index: tab.index + 1 };
    else next = pushed(tab, place);
  }
  return withFrame(layout, frame, withTab(f, next));
}

// Back (negative) or forward through the active tab's own history.
export function go(layout: Layout, frame: number, delta: number): Layout {
  const f = layout.frames[frame];
  if (!f) return layout;
  const tab = tabOf(f);
  const index = Math.max(0, Math.min(tab.stack.length - 1, tab.index + delta));
  if (index === tab.index) return layout;
  return withFrame(layout, frame, withTab(f, { ...tab, index }));
}

// The steps of the active tab of `frame`: before (nearest first) and after.
export function tabSteps(layout: Layout, frame: number) {
  const f = layout.frames[frame];
  if (!f) return { tab: null, back: [] as { place: string; delta: number }[], forward: [] as { place: string; delta: number }[] };
  const tab = tabOf(f);
  const back = tab.stack.slice(0, tab.index).map((place, i) => ({ place, delta: i - tab.index })).reverse();
  const forward = tab.stack.slice(tab.index + 1).map((place, i) => ({ place, delta: i + 1 }));
  return { tab, back, forward };
}

export function focus(layout: Layout, frame: number): Layout {
  if (frame === layout.focused || !layout.frames[frame]) return layout;
  return { ...layout, focused: frame };
}

export function activate(layout: Layout, frame: number, tabId: string): Layout {
  const f = layout.frames[frame];
  if (!f || !f.tabs.some((t) => t.id === tabId)) return layout;
  return { ...withFrame(layout, frame, { ...f, active: tabId }), focused: frame };
}

// The tab `delta` places further (wrapping around), or the n-th tab
// (0-based; Infinity: the last).
export function cycle(layout: Layout, frame: number, delta: number): Layout {
  const f = layout.frames[frame];
  // Not into collapsed groups.
  const shown = f ? f.tabs.filter((t) => !tabHidden(f, t)) : [];
  if (!f || shown.length < 2) return layout;
  const at = shown.findIndex((t) => t.id === tabOf(f).id);
  const n = shown.length;
  return activate(layout, frame, shown[(((at + delta) % n) + n) % n].id);
}
export function nth(layout: Layout, frame: number, index: number): Layout {
  const f = layout.frames[frame];
  if (!f) return layout;
  const tab = f.tabs[Math.min(index, f.tabs.length - 1)];
  return tab ? activate(layout, frame, tab.id) : layout;
}

// A place in a new tab of `frame` (beside the active one) – or in a new
// frame on the right when `frame` is the next index. A tab of that frame
// already showing the place is activated instead (`reuse`).
export function open(
  layout: Layout,
  place: string,
  options: { frame?: number; id?: string; reuse?: boolean; background?: boolean } = {},
): Layout {
  const frame = Math.min(options.frame ?? layout.focused, layout.frames.length, MAX_FRAMES - 1);
  const id = options.id ?? newTabId();
  const tab: Tab = { id, stack: [place], index: 0 };
  const f = layout.frames[frame];
  if (!f) return { frames: [...layout.frames, { tabs: [tab], active: id }], focused: frame };
  if (options.reuse !== false) {
    const same = f.tabs.find((t) => placeOf(t) === place);
    if (same) return options.background ? layout : activate(layout, frame, same.id);
  }
  // Full: the active tab goes to the place instead.
  if (f.tabs.length >= MAX_TABS) return focus(follow(layout, frame, place, "push"), frame);
  // Beside the active tab, never among the pinned ones; in its group, if
  // it has one (as a browser does).
  const current = tabOf(f);
  const at = Math.max(f.tabs.findIndex((t) => t.id === current.id) + 1, pinnedCount(f));
  if (current.group && !current.pinned) tab.group = current.group;
  const tabs = [...f.tabs.slice(0, at), tab, ...f.tabs.slice(at)];
  const next = withFrame(layout, frame, { ...f, tabs, active: options.background ? f.active : id });
  return options.background ? next : { ...next, focused: frame };
}

// After removing the tab at `at` of a frame: the tab that becomes active
// when the removed one was – the one to its right, else to its left.
function afterRemoval(f: Frame, at: number, removedId: string): Frame | null {
  const tabs = f.tabs.filter((t) => t.id !== removedId);
  if (!tabs.length) return null;
  const active = f.active === removedId ? tabs[Math.min(at, tabs.length - 1)].id : f.active;
  return { ...f, tabs, active };
}
function dropFrame(layout: Layout, frame: number): Layout {
  const frames = layout.frames.filter((_, i) => i !== frame);
  const focused = layout.focused === frame ? 0 : layout.focused > frame ? layout.focused - 1 : layout.focused;
  return clampFocus({ frames, focused });
}

// Closes a tab. The last tab of a frame closes the frame; the last tab of
// all leaves the start page in its place.
export function close(layout: Layout, frame: number, tabId: string, fallback = "home"): Layout {
  const f = layout.frames[frame];
  if (!f) return layout;
  const at = f.tabs.findIndex((t) => t.id === tabId);
  if (at < 0) return layout;
  const rest = afterRemoval(f, at, tabId);
  if (rest) return withFrame(layout, frame, rest);
  if (layout.frames.length > 1) return dropFrame(layout, frame);
  return singleLayout(fallback);
}
export function closeOthers(layout: Layout, frame: number, tabId: string): Layout {
  const f = layout.frames[frame];
  const tab = f?.tabs.find((t) => t.id === tabId);
  if (!tab) return layout;
  // Pinned tabs stay.
  return { ...withFrame(layout, frame, { ...f, tabs: f.tabs.filter((t) => t.id === tabId || t.pinned), active: tab.id }), focused: frame };
}

// Pins a tab (to the end of the pinned ones) or unpins it (to the first
// place after them).
export function pin(layout: Layout, frame: number, tabId: string, pinned = true): Layout {
  const f = layout.frames[frame];
  const tab = f?.tabs.find((t) => t.id === tabId);
  if (!f || !tab || !!tab.pinned === pinned) return layout;
  const rest = f.tabs.filter((t) => t.id !== tabId);
  const at = pinnedCount({ ...f, tabs: rest });
  const changed: Tab = withoutGroup({ ...tab });
  if (pinned) changed.pinned = true;
  else delete changed.pinned;
  return withFrame(layout, frame, { ...f, tabs: [...rest.slice(0, at), changed, ...rest.slice(at)] });
}
// Closes a whole frame (the split view's "close"). The only frame stays.
export function closeFrame(layout: Layout, frame: number): Layout {
  if (layout.frames.length < 2 || !layout.frames[frame]) return layout;
  return dropFrame(layout, frame);
}

// Moves a tab to `index` of frame `to` – the same frame (reordering), the
// other one, or a new frame on the right (`to` = the number of frames).
// The tab becomes the active one there; a frame left empty closes.
export function move(layout: Layout, from: number, tabId: string, to: number, index: number): Layout {
  const source = layout.frames[from];
  const at = source ? source.tabs.findIndex((t) => t.id === tabId) : -1;
  if (!source || at < 0) return layout;
  const tab = source.tabs[at];
  if (to === from) {
    const tabs = source.tabs.filter((t) => t.id !== tabId);
    const place = Math.max(0, Math.min(index > at ? index - 1 : index, tabs.length));
    // Between two tabs of a group: into it; out of its own group's run:
    // out of the group; beside its group: it stays in.
    const left = tabs[place - 1]?.group,
      right = tabs[place]?.group;
    const group = left && left === right ? left : tab.group && (left === tab.group || right === tab.group) ? tab.group : undefined;
    const moved = group ? { ...tab, group } : withoutGroup(tab);
    tabs.splice(place, 0, moved);
    return { ...withFrame(layout, from, { ...source, tabs: pinnedFirst(tabs), active: tabId }), focused: from };
  }
  const target = Math.min(to, layout.frames.length, MAX_FRAMES - 1);
  if (target === from) return layout;
  // The only tab of the only frame cannot leave it.
  if (!layout.frames[target] && source.tabs.length === 1) return layout;
  const rest = afterRemoval(source, at, tabId);
  let next: Layout = rest ? withFrame(layout, from, rest) : layout;
  const dest = next.frames[target];
  // Into the other frame without its group (groups are per frame).
  const moved = withoutGroup(tab);
  if (!dest) next = { ...next, frames: [...next.frames, { tabs: [moved], active: tab.id }] };
  else {
    const tabs = dest.tabs.slice();
    tabs.splice(Math.max(0, Math.min(index, tabs.length)), 0, moved);
    next = withFrame(next, target, { ...dest, tabs: pinnedFirst(tabs), active: tab.id });
  }
  next = { ...next, focused: target };
  return rest ? next : dropFrame(next, from);
}
// One place to the left (-1) or right (+1) within its frame.
export function moveBy(layout: Layout, frame: number, tabId: string, delta: number): Layout {
  const f = layout.frames[frame];
  const at = f ? f.tabs.findIndex((t) => t.id === tabId) : -1;
  if (!f || at < 0) return layout;
  const index = Math.max(0, Math.min(f.tabs.length - 1, at + delta));
  if (index === at) return layout;
  return move(layout, frame, tabId, frame, delta > 0 ? index + 1 : index);
}

// ---------------------------------------------------------------------------
// Tab groups (#444).

// The colour a new group gets: the first one not used in the frame yet
// (grey last: it reads as "no colour").
export function nextGroupColor(frame: Frame): GroupColor {
  const used = new Set((frame.groups ?? []).map((g) => g.color));
  const order = [...GROUP_COLORS.filter((c) => c !== "gray"), "gray" as const];
  return order.find((c) => !used.has(c)) ?? order[(frame.groups?.length ?? 0) % order.length];
}
export const groupName = (name: unknown, fallback: string) => {
  const clean = typeof name === "string" ? name.replace(/\s+/g, " ").trim().slice(0, MAX_GROUP_NAME) : "";
  return clean || fallback;
};
export const isGroupColor = (value: unknown): value is GroupColor => typeof value === "string" && (GROUP_COLORS as readonly string[]).includes(value);

// A new group of one tab (where it stands); not for pinned tabs.
export function createGroup(layout: Layout, frame: number, tabId: string, group: { name: string; color?: GroupColor; id?: string }): Layout {
  const f = layout.frames[frame];
  const tab = f?.tabs.find((t) => t.id === tabId);
  if (!f || !tab || tab.pinned) return layout;
  const id = group.id ?? newGroupId();
  const created: TabGroup = { id, name: groupName(group.name, "…"), color: group.color ?? nextGroupColor(f) };
  // Out of a group it was in: right after that group.
  let tabs = f.tabs;
  if (tab.group) {
    const rest = f.tabs.filter((t) => t.id !== tabId);
    const last = rest.map((t) => t.group).lastIndexOf(tab.group);
    tabs = [...rest.slice(0, last + 1), tab, ...rest.slice(last + 1)];
  }
  return withFrame(layout, frame, { ...f, tabs: tabs.map((t) => (t.id === tabId ? { ...t, group: id } : t)), groups: [...(f.groups ?? []), created] });
}

// A tab into a group of its frame: at the group's end.
export function joinGroup(layout: Layout, frame: number, tabId: string, groupId: string): Layout {
  const f = layout.frames[frame];
  const tab = f?.tabs.find((t) => t.id === tabId);
  if (!f || !tab || tab.pinned || tab.group === groupId || !f.groups?.some((g) => g.id === groupId)) return layout;
  const rest = f.tabs.filter((t) => t.id !== tabId);
  const last = rest.map((t) => t.group).lastIndexOf(groupId);
  const tabs = [...rest.slice(0, last + 1), { ...tab, group: groupId }, ...rest.slice(last + 1)];
  return withFrame(layout, frame, { ...f, tabs });
}

// A tab out of its group: right after the group.
export function leaveGroup(layout: Layout, frame: number, tabId: string): Layout {
  const f = layout.frames[frame];
  const tab = f?.tabs.find((t) => t.id === tabId);
  if (!f || !tab?.group) return layout;
  const rest = f.tabs.filter((t) => t.id !== tabId);
  const last = rest.map((t) => t.group).lastIndexOf(tab.group);
  const at = last < 0 ? f.tabs.findIndex((t) => t.id === tabId) : last + 1;
  return withFrame(layout, frame, { ...f, tabs: [...rest.slice(0, at), withoutGroup(tab), ...rest.slice(at)] });
}

// Name, colour, collapsed. Collapsing the group of the active tab first
// activates the nearest tab outside it (to the right, else the left); a
// frame of that group alone does not collapse.
export function updateGroup(layout: Layout, frame: number, groupId: string, change: { name?: string; color?: GroupColor; collapsed?: boolean }): Layout {
  const f = layout.frames[frame];
  const group = f?.groups?.find((g) => g.id === groupId);
  if (!f || !group) return layout;
  const next: TabGroup = { ...group };
  if (change.name !== undefined) next.name = groupName(change.name, group.name);
  if (change.color && isGroupColor(change.color)) next.color = change.color;
  let active = f.active;
  if (change.collapsed === false) delete next.collapsed;
  else if (change.collapsed) {
    if (tabOf(f).group === groupId) {
      const first = f.tabs.findIndex((t) => t.group === groupId),
        last = f.tabs.map((t) => t.group).lastIndexOf(groupId);
      const other = f.tabs.slice(last + 1).find((t) => !tabHidden(f, t)) ?? f.tabs.slice(0, first).reverse().find((t) => !tabHidden(f, t));
      if (!other) return layout;
      active = other.id;
    }
    next.collapsed = true;
  }
  if (JSON.stringify(next) === JSON.stringify(group) && active === f.active) return layout;
  return withFrame(layout, frame, { ...f, active, groups: f.groups!.map((g) => (g.id === groupId ? next : g)) });
}

// The tabs stay, the group goes.
export function ungroup(layout: Layout, frame: number, groupId: string): Layout {
  const f = layout.frames[frame];
  if (!f?.groups?.some((g) => g.id === groupId)) return layout;
  return withFrame(layout, frame, { ...f, tabs: f.tabs.map((t) => (t.group === groupId ? withoutGroup(t) : t)), groups: f.groups.filter((g) => g.id !== groupId) });
}

// Closes the group's tabs. The active one among them: the tab after the
// group becomes active, else the one before; a frame left empty closes as
// with its last tab.
export function closeGroup(layout: Layout, frame: number, groupId: string, fallback = "home"): Layout {
  const f = layout.frames[frame];
  if (!f?.groups?.some((g) => g.id === groupId)) return layout;
  const first = f.tabs.findIndex((t) => t.group === groupId);
  const tabs = f.tabs.filter((t) => t.group !== groupId);
  if (!tabs.length) {
    if (layout.frames.length > 1) return dropFrame(layout, frame);
    return singleLayout(fallback);
  }
  const active = tabs.some((t) => t.id === f.active) ? f.active : tabs[Math.min(first, tabs.length - 1)].id;
  return withFrame(layout, frame, { ...f, tabs, active });
}

// The whole group one step left (-1) or right (+1): past the next tab or
// group beside it, never among the pinned tabs.
export function moveGroup(layout: Layout, frame: number, groupId: string, delta: number): Layout {
  const f = layout.frames[frame];
  if (!f?.groups?.some((g) => g.id === groupId) || !delta) return layout;
  // The frame as runs: a group, or a single tab.
  const runs: Tab[][] = [];
  for (const t of f.tabs) {
    const last = runs[runs.length - 1];
    if (t.group && last?.[0].group === t.group) last.push(t);
    else runs.push([t]);
  }
  const at = runs.findIndex((r) => r[0].group === groupId);
  const to = at + (delta > 0 ? 1 : -1);
  if (to < 0 || to >= runs.length || runs[to][0].pinned) return layout;
  [runs[at], runs[to]] = [runs[to], runs[at]];
  return withFrame(layout, frame, { ...f, tabs: runs.flat() });
}

// ---------------------------------------------------------------------------
// Kept per device (components/frame-tabs.tsx: localStorage and the
// browser tab's sessionStorage).

// `pinned` and the groups (#444) are only written when set: layouts from
// before stay valid and older versions of the app read the new ones
// (without pins and groups). A tab's `group` is the index in its frame's
// `groups`.
type StoredGroup = { name: string; color: GroupColor; collapsed?: true };
export type StoredLayout = {
  v: 1;
  focused: number;
  frames: { active: number; tabs: { stack: string[]; index: number; pinned?: true; group?: number }[]; groups?: StoredGroup[] }[];
};

export function serialize(layout: Layout): StoredLayout {
  return {
    v: 1,
    focused: layout.focused,
    frames: layout.frames.map((f) => {
      const groups = f.groups ?? [];
      const at = (id: string | undefined) => (id ? groups.findIndex((g) => g.id === id) : -1);
      return {
        active: Math.max(0, f.tabs.findIndex((t) => t.id === f.active)),
        tabs: f.tabs.map((t) => ({
          stack: t.stack,
          index: t.index,
          ...(t.pinned ? { pinned: true as const } : {}),
          ...(at(t.group) >= 0 ? { group: at(t.group) } : {}),
        })),
        ...(groups.length ? { groups: groups.map((g): StoredGroup => ({ name: g.name, color: g.color, ...(g.collapsed ? { collapsed: true as const } : {}) })) } : {}),
      };
    }),
  };
}

// A stored layout, checked: only places of the app (stepOf), only those
// `valid` says still exist and may be read – a tab without any left goes,
// a frame without tabs as well. Null when nothing remains.
export function restore(value: unknown, valid: (place: string) => boolean): Layout | null {
  if (!value || typeof value !== "object") return null;
  const stored = value as Partial<StoredLayout>;
  if (stored.v !== 1 || !Array.isArray(stored.frames)) return null;
  const frames: Frame[] = [];
  const kept: number[] = [];
  for (const [i, raw] of stored.frames.slice(0, MAX_FRAMES).entries()) {
    if (!raw || !Array.isArray(raw.tabs)) continue;
    // The frame's groups, checked; a tab's index into them becomes the id.
    const groups: TabGroup[] = (Array.isArray(raw.groups) ? raw.groups.slice(0, MAX_TABS) : []).map((g: unknown) => {
      const stored = (g && typeof g === "object" ? g : {}) as Partial<StoredGroup>;
      return {
        id: newGroupId(),
        name: groupName(stored.name, "…"),
        color: isGroupColor(stored.color) ? stored.color : "gray",
        ...(stored.collapsed === true ? { collapsed: true } : {}),
      };
    });
    const tabs: Tab[] = [];
    let active: string | null = null;
    for (const [j, t] of raw.tabs.slice(0, MAX_TABS).entries()) {
      if (!t || !Array.isArray(t.stack)) continue;
      const at = Number.isInteger(t.index) ? t.index : t.stack.length - 1;
      const stack: string[] = [];
      let index = -1;
      for (const [k, entry] of t.stack.slice(-MAX_STACK).entries()) {
        const place = typeof entry === "string" ? stepOf(entry) : null;
        // The entries before the current one keep its place in the list:
        // a dropped current place leaves the one before it current.
        const position = k + Math.max(0, t.stack.length - MAX_STACK);
        if (!place || !valid(place)) continue;
        if (stack[stack.length - 1] === place) {
          if (position <= at) index = stack.length - 1;
          continue;
        }
        stack.push(place);
        if (position <= at) index = stack.length - 1;
      }
      if (!stack.length) continue;
      const extra = t as { pinned?: unknown; group?: unknown };
      const group = Number.isInteger(extra.group) ? groups[extra.group as number] : undefined;
      const tab: Tab = {
        id: newTabId(),
        stack,
        index: Math.max(0, index),
        ...(extra.pinned === true ? { pinned: true } : {}),
        ...(group ? { group: group.id } : {}),
      };
      tabs.push(tab);
      if (j === raw.active) active = tab.id;
      else if (active === null && j > (raw.active ?? 0)) active = tab.id;
    }
    if (!tabs.length) continue;
    frames.push(tidy({ tabs, active: active ?? tabs[tabs.length - 1].id, groups }));
    kept.push(i);
  }
  if (!frames.length) return null;
  const focusedAt = kept.indexOf(Number(stored.focused));
  return { frames, focused: focusedAt < 0 ? 0 : focusedAt };
}
