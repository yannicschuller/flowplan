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
};
export type Frame = { tabs: Tab[]; active: string };
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

export const placeOf = (tab: Tab) => tab.stack[tab.index];
export const tabOf = (frame: Frame) => frame.tabs.find((t) => t.id === frame.active) ?? frame.tabs[0];
export const activePlace = (layout: Layout, frame = layout.focused) => {
  const f = layout.frames[frame];
  return f ? placeOf(tabOf(f)) : null;
};
export const tabCount = (layout: Layout) => layout.frames.reduce((n, f) => n + f.tabs.length, 0);

export function singleLayout(place: string, id = newTabId()): Layout {
  return { frames: [{ tabs: [{ id, stack: [place], index: 0 }], active: id }], focused: 0 };
}

const withFrame = (layout: Layout, index: number, frame: Frame): Layout => ({
  ...layout,
  frames: layout.frames.map((f, i) => (i === index ? frame : f)),
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

// The active tab of `frame` follows a change of its place.
export function follow(layout: Layout, frame: number, place: string, change: Change = "push"): Layout {
  const f = layout.frames[frame];
  if (!f) return layout;
  const tab = tabOf(f);
  if (placeOf(tab) === place) return layout;
  let next: Tab;
  if (change === "replace") {
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
  if (!f || f.tabs.length < 2) return layout;
  const at = f.tabs.findIndex((t) => t.id === tabOf(f).id);
  const n = f.tabs.length;
  return activate(layout, frame, f.tabs[(((at + delta) % n) + n) % n].id);
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
  const at = f.tabs.findIndex((t) => t.id === tabOf(f).id);
  const tabs = [...f.tabs.slice(0, at + 1), tab, ...f.tabs.slice(at + 1)];
  const next = withFrame(layout, frame, { tabs, active: options.background ? f.active : id });
  return options.background ? next : { ...next, focused: frame };
}

// After removing the tab at `at` of a frame: the tab that becomes active
// when the removed one was – the one to its right, else to its left.
function afterRemoval(f: Frame, at: number, removedId: string): Frame | null {
  const tabs = f.tabs.filter((t) => t.id !== removedId);
  if (!tabs.length) return null;
  const active = f.active === removedId ? tabs[Math.min(at, tabs.length - 1)].id : f.active;
  return { tabs, active };
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
  return { ...withFrame(layout, frame, { tabs: [tab], active: tab.id }), focused: frame };
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
    tabs.splice(place, 0, tab);
    return { ...withFrame(layout, from, { tabs, active: tabId }), focused: from };
  }
  const target = Math.min(to, layout.frames.length, MAX_FRAMES - 1);
  if (target === from) return layout;
  // The only tab of the only frame cannot leave it.
  if (!layout.frames[target] && source.tabs.length === 1) return layout;
  const rest = afterRemoval(source, at, tabId);
  let next: Layout = rest ? withFrame(layout, from, rest) : layout;
  const dest = next.frames[target];
  if (!dest) next = { ...next, frames: [...next.frames, { tabs: [tab], active: tab.id }] };
  else {
    const tabs = dest.tabs.slice();
    tabs.splice(Math.max(0, Math.min(index, tabs.length)), 0, tab);
    next = withFrame(next, target, { tabs, active: tab.id });
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
// Kept per device (components/frame-tabs.tsx: localStorage and the
// browser tab's sessionStorage).

export type StoredLayout = { v: 1; focused: number; frames: { active: number; tabs: { stack: string[]; index: number }[] }[] };

export function serialize(layout: Layout): StoredLayout {
  return {
    v: 1,
    focused: layout.focused,
    frames: layout.frames.map((f) => ({
      active: Math.max(0, f.tabs.findIndex((t) => t.id === f.active)),
      tabs: f.tabs.map((t) => ({ stack: t.stack, index: t.index })),
    })),
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
      const tab = { id: newTabId(), stack, index: Math.max(0, index) };
      tabs.push(tab);
      if (j === raw.active) active = tab.id;
      else if (active === null && j > (raw.active ?? 0)) active = tab.id;
    }
    if (!tabs.length) continue;
    frames.push({ tabs, active: active ?? tabs[tabs.length - 1].id });
    kept.push(i);
  }
  if (!frames.length) return null;
  const focusedAt = kept.indexOf(Number(stored.focused));
  return { frames, focused: focusedAt < 0 ? 0 : focusedAt };
}
