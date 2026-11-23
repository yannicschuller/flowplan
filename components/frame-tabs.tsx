"use client";
// Tabs and frames (#279, stage 1): the places of the app open in tabs, in
// one frame or two side by side (the right one is the former split view).
// The layout model is lib/frame-tabs.ts; this hook keeps it per device,
// keeps the address in step with the left frame's active tab, answers the
// open requests of links and the page tree (lib/open-place.ts), the tab
// shortcuts and gives lib/history-nav.ts the active tab's own steps. Not on
// phones: there the app stays one page at a time, as before.
//
// Only the active tab of a frame is mounted: switching tabs in the left
// frame is a navigation of the main view (the address is replaced), the
// right frame shows its active tab's page (components/split-pane.tsx).
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import {
  ArrowLeft,
  ArrowLineLeft,
  ArrowLineRight,
  ArrowRight,
  CaretDown,
  CaretRight,
  Copy,
  PencilSimple,
  Palette,
  Plus,
  PushPin,
  PushPinSlash,
  SquareSplitHorizontal,
  Stack,
  StackMinus,
  StackPlus,
  X,
  XSquare,
} from "@phosphor-icons/react";
import { colorLabel } from "./color-label";
import { useT } from "./i18n";
import { safeCollisionPadding } from "./safe-area";
import {
  activate,
  activePlace,
  close,
  closeFrame,
  closeGroup,
  closeOthers,
  createGroup,
  GROUP_COLORS,
  groupTabs,
  joinGroup,
  leaveGroup,
  moveGroup,
  newGroupId,
  tabHidden,
  ungroup,
  updateGroup,
  type GroupColor,
  cycle,
  focus,
  follow,
  go,
  move,
  moveBy,
  nth,
  open,
  pin,
  placeOf,
  restore,
  serialize,
  singleLayout,
  tabCount,
  tabOf,
  tabSteps,
  type Change,
  type Frame,
  type Layout,
} from "@/lib/frame-tabs";
import { browserGo, browserPlaceAt, LIST_SIZE, refreshSteps, setStepSource, stepOf, type Steps } from "@/lib/history-nav";
import { OPEN_PLACE_EVENT, type OpenRequest } from "@/lib/open-place";
import { inAppPageHash, parsePageLocation } from "@/lib/page-location";
import { eventKey, isMacPlatform } from "@/lib/keymap";
import { desktopApp } from "@/lib/native-app";

const storeKey = (userId: string, workspaceId: string) => `flowplan-tabs:${userId}:${workspaceId}`;
const readStored = (storage: () => Storage, key: string) => {
  try {
    return JSON.parse(storage().getItem(key) || "null");
  } catch {
    return null;
  }
};
const hashPlace = () => (typeof location === "undefined" ? null : stepOf(location.hash));

// The tabs follow the address before anything else hears of its change:
// one listener, added with this module – before the workspace adds its own
// in an effect. The workspace's changes the screen, which React renders at
// once (a hash change is a discrete event); the tabs, a listener after it,
// were still at the step before, and the pane's scroll position
// (lib/pane-scroll.ts) was kept and looked up under that step – back to a
// page or the start page started at the top.
let addressChanged: (() => void) | null = null;
if (typeof window !== "undefined") window.addEventListener("hashchange", () => addressChanged?.());

// The page a place shows (null: a screen of the app).
export const pageOfPlace = (place: string | null | undefined) => (place?.startsWith("page=") ? parsePageLocation(place)?.pageId ?? null : null);
// Whether a kept place still exists for this person: pages they can read
// and that are not in the trash, the administration only for admins.
export const validPlaceIn =
  (pages: readonly { id: string; deleted_at: string | null }[], admin: boolean) =>
  (place: string) => {
    const page = pageOfPlace(place);
    if (page) return pages.some((p) => p.id === page && !p.deleted_at);
    return !place.startsWith("admin") || admin;
  };
// Which frame an element belongs to (null: neither, e.g. the sidebar).
export const frameOfElement = (el: Element | null | undefined) =>
  el?.closest?.(".split-pane") ? 1 : el?.closest?.(".split-primary") ? 0 : null;

// The place an in-app link leads to (page links, records, screens), or null.
function linkPlace(anchor: HTMLAnchorElement): string | null {
  const href = anchor.getAttribute("href") || "";
  if (href.startsWith("#")) return stepOf(href);
  const hash = inAppPageHash(href, location.href);
  return hash ? stepOf(hash) : null;
}

export type FrameTabs = ReturnType<typeof useFrameTabs>;

export function useFrameTabs({
  enabled,
  wide,
  userId,
  workspaceId,
  valid,
  onNewTab,
}: {
  // A new tab (#444: ⌘/Ctrl+T in the desktop app, Alt+T everywhere, the
  // "+" of the tab bar): the workspace opens the quick search, and the
  // page picked there opens in a new tab of `frame`. No empty tab is made
  // before – Esc leaves the tabs as they were.
  onNewTab?: (frame: number) => void;
  // Tablets and computers (not phones).
  enabled: boolean;
  // Wide enough for two frames (the split view, > 1024 px).
  wide: boolean;
  userId: string;
  workspaceId: string;
  // Whether a stored place still exists and may be read.
  valid: (place: string) => boolean;
}) {
  const [layout, setLayout] = useState<Layout | null>(null);
  const ref = useRef<Layout | null>(null);
  // The workspace the layout belongs to.
  const owner = useRef<string | null>(null);
  const wideRef = useRef(wide);
  wideRef.current = wide;
  const validRef = useRef(valid);
  validRef.current = valid;
  const newTabRef = useRef(onNewTab);
  newTabRef.current = onNewTab;
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Steps of a tab taken through the browser's history (browserGo): the
  // tab has moved already; when the browser arrives, only the address is
  // checked – another step may have been taken meanwhile.
  const ownSteps = useRef<{ at: number; place: string }[]>([]);
  // An address from before the tabs (?split=<id>), read once when the app
  // opens: the workspace drops it from the address while the layout is not
  // known yet (the screen size is measured after the first render).
  const splitAtOpen = useRef(typeof location === "undefined" ? null : new URLSearchParams(location.search).get("split"));

  // The save that waits for its 200 ms: written at once when the page goes
  // (a reload or closing right after a change keeps the change).
  const pendingSave = useRef<(() => void) | null>(null);
  const flushSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    const save = pendingSave.current;
    pendingSave.current = null;
    save?.();
  }, []);
  const persist = useCallback((next: Layout, local: boolean) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const key = storeKey(userId, owner.current || workspaceId);
    pendingSave.current = () => {
      const value = JSON.stringify(serialize(next));
      try {
        sessionStorage.setItem(key, value);
      } catch {}
      if (local)
        try {
          localStorage.setItem(key, value);
        } catch {}
    };
    saveTimer.current = setTimeout(flushSave, 200);
  }, [userId, workspaceId, flushSave]);

  // The frame worked in, as far as it is shown (the right one only when wide).
  const frameNow = (l: Layout) => (l.focused === 1 && l.frames[1] && wideRef.current ? 1 : 0);

  // A new layout: kept, shown, and the address follows the left frame.
  const commit = useCallback(
    (next: Layout, options: { address?: boolean; save?: boolean } = {}) => {
      const before = ref.current;
      ref.current = next;
      setLayout(next);
      if (options.save !== false) persist(next, true);
      const place = activePlace(next, 0);
      if (options.address !== false && place && hashPlace() !== place) location.replace(`#${place}`);
      if (before !== next) refreshSteps();
    },
    [persist],
  );

  // The layout of a workspace: this browser tab's (a reload), else the
  // device's last one when the app opens without a place of its own; the
  // place in the address joins it (activated, or the active tab goes there).
  const load = useCallback(
    (workspace: string, here: string | null, check: (place: string) => boolean): Layout => {
      const key = storeKey(userId, workspace);
      let next = restore(readStored(() => sessionStorage, key), check);
      const plain = !here || here === "home";
      if (!next && plain) next = restore(readStored(() => localStorage, key), check);
      if (!next) {
        next = singleLayout(here || "home");
        // An address from before the tabs (?split=<id>): the right frame.
        const split = splitAtOpen.current || (typeof location === "undefined" ? null : new URLSearchParams(location.search).get("split"));
        splitAtOpen.current = null;
        if (split && /^[0-9a-f-]{36}$/i.test(split) && check(`page=${split}`)) next = focus(open(next, `page=${split}`, { frame: 1 }), 0);
        return next;
      }
      if (here && !plain && activePlace(next, 0) !== here) {
        const same = next.frames[0].tabs.find((t) => placeOf(t) === here);
        next = same ? activate(next, 0, same.id) : follow(next, 0, here, "push");
      }
      return next;
    },
    [userId],
  );

  // Starts (or stops) with the tabs; a workspace opened by other means
  // (a link into another workspace) brings its own layout.
  useLayoutEffect(() => {
    if (!enabled) {
      ref.current = null;
      owner.current = null;
      setLayout(null);
      return;
    }
    if (ref.current && owner.current === workspaceId) return;
    owner.current = workspaceId;
    const next = load(workspaceId, hashPlace(), validRef.current);
    commit(next, { save: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, workspaceId]);

  // Switching the workspace (components/workspace-app.tsx): its layout,
  // and the place to show first.
  const switchTo = useCallback(
    (workspace: string, check: (place: string) => boolean): string | null => {
      if (!ref.current) return null;
      owner.current = workspace;
      const next = load(workspace, null, check);
      ref.current = next;
      setLayout(next);
      refreshSteps();
      return activePlace(next, 0);
    },
    [load],
  );

  // The address changed: the left frame's active tab goes along. How it
  // changed (a new place, replaced, back or forward) the Navigation API
  // says where there is one.
  useEffect(() => {
    if (!enabled) return;
    const nav = (window as unknown as { navigation?: EventTarget & { currentEntry?: { index: number } | null } }).navigation;
    // The last navigation and where it went: a replaceState() is one too,
    // without a hashchange – its type must not stick to the next change.
    let change: { how: Change; url: string } | null = null;
    const navigating = (e: Event) => {
      const event = e as Event & { navigationType?: string; destination?: { index: number; url?: string } };
      const type = event.navigationType;
      const here = nav?.currentEntry?.index ?? 0;
      const how: Change =
        type === "traverse" ? ((event.destination?.index ?? here) < here ? "back" : "forward")
        : type === "push" ? "push"
        : type === "replace" ? "replace"
        : "unknown";
      const url = event.destination?.url || "";
      // A replaceState() of the same address on the way (the page writing
      // its state) keeps what brought it there.
      if (how === "replace" && change?.url === url) return;
      change = { how, url };
    };
    const changed = () => {
      const how = change && change.url === location.href ? change.how : "unknown";
      change = null;
      const l = ref.current;
      const place = hashPlace();
      if (!l || !place || owner.current !== workspaceId) return;
      const now = Date.now();
      ownSteps.current = ownSteps.current.filter((own) => now - own.at < 3000);
      const own = ownSteps.current.findIndex((step) => step.place === place);
      if (own >= 0) {
        ownSteps.current = ownSteps.current.slice(own + 1);
        const shown = activePlace(l, 0);
        if (shown && shown !== place) location.replace(`#${shown}`);
        return;
      }
      // Back or forward to an entry of another tab: commit() shows this
      // tab's step instead.
      const next = follow(l, 0, place, how, how === "replace" ? browserPlaceAt(-1) : null);
      if (next !== l) commit(next);
    };
    nav?.addEventListener("navigate", navigating);
    addressChanged = changed;
    return () => {
      nav?.removeEventListener("navigate", navigating);
      if (addressChanged === changed) addressChanged = null;
    };
  }, [enabled, workspaceId, commit]);

  // The frame worked in: where the pointer or the focus went last.
  useEffect(() => {
    if (!enabled) return;
    const mark = (e: Event) => {
      const frame = frameOfElement(e.target as Element | null);
      const l = ref.current;
      if (frame === null || !l || l.focused === frame || !l.frames[frame]) return;
      commit(focus(l, frame), { address: false });
    };
    document.addEventListener("pointerdown", mark, true);
    document.addEventListener("focusin", mark, true);
    return () => {
      document.removeEventListener("pointerdown", mark, true);
      document.removeEventListener("focusin", mark, true);
    };
  }, [enabled, commit]);

  // ---- Actions ----

  const openPlace = useCallback(
    (place: string, mode: "tab" | "side" | "here", from?: number | null) => {
      const l = ref.current;
      if (!l) return false;
      const frame = from ?? frameNow(l);
      if (mode === "here") {
        if (frame !== 1 || !l.frames[1] || !wideRef.current) return false;
        commit(focus(follow(l, 1, place, "push"), 1), { address: false });
        return true;
      }
      const target = mode === "side" && wideRef.current ? (frame === 0 ? 1 : 0) : frame;
      commit(open(l, place, { frame: target }));
      return true;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [commit],
  );

  const run = useCallback(
    (change: (l: Layout) => Layout) => {
      const l = ref.current;
      if (!l) return;
      const next = change(l);
      if (next !== l) commit(next);
    },
    [commit],
  );

  // Requests of links, the page tree and the search (lib/open-place.ts).
  useEffect(() => {
    if (!enabled) return;
    const request = (e: Event) => {
      const { place, mode, origin } = (e as CustomEvent<OpenRequest>).detail;
      if (openPlace(place, mode, origin ? frameOfElement(origin) : null)) e.preventDefault();
    };
    // In-app links everywhere: ⌘/Ctrl-click and the middle button open a
    // tab (with Shift the other frame), a plain click in the right frame
    // stays there. Links of the editors are answered before (link-preview).
    const click = (e: MouseEvent) => {
      if (e.defaultPrevented || (e.button !== 0 && e.button !== 1)) return;
      const anchor = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor || (anchor.target === "_blank" && e.button === 0 && !(e.metaKey || e.ctrlKey))) return;
      if (anchor.closest(".link-preview") || (e.button === 0 && anchor.closest('[contenteditable="true"]'))) return;
      const place = linkPlace(anchor);
      if (!place) return;
      const modified = e.button === 1 || e.metaKey || e.ctrlKey;
      const frame = frameOfElement(anchor);
      if (!modified && frame !== 1) return;
      const mode = e.shiftKey && modified ? "side" : modified ? "tab" : "here";
      if (openPlace(place, mode, frame)) e.preventDefault();
    };
    const middleDown = (e: MouseEvent) => {
      if (e.button === 1 && (e.target as Element | null)?.closest?.("a[href], [data-open-place]")) e.preventDefault();
    };
    window.addEventListener(OPEN_PLACE_EVENT, request);
    document.addEventListener("click", click, true);
    document.addEventListener("auxclick", click, true);
    document.addEventListener("mousedown", middleDown, true);
    return () => {
      window.removeEventListener(OPEN_PLACE_EVENT, request);
      document.removeEventListener("click", click, true);
      document.removeEventListener("auxclick", click, true);
      document.removeEventListener("mousedown", middleDown, true);
    };
  }, [enabled, openPlace]);

  // The tab shortcuts (fixed; listed in the shortcut overview). In the
  // browser ⌘/Ctrl+W, ⌘/Ctrl+T, Ctrl+Tab and ⌘/Ctrl+1…9 belong to the
  // browser's own tabs: only the desktop app takes them, everywhere Alt+W,
  // Alt+T and ⌘/Ctrl+Alt+PageDown/PageUp work.
  useEffect(() => {
    if (!enabled) return;
    const desktop = !!desktopApp();
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const l = ref.current;
      if (!l) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"], .presentation')) return;
      const mac = isMacPlatform();
      const mod = mac ? e.metaKey : e.ctrlKey,
        ctrl = e.ctrlKey,
        k = eventKey(e);
      const plainMod = mod && !e.altKey && !e.shiftKey && (mac ? !e.ctrlKey : !e.metaKey);
      const plainAlt = e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
      const frame = frameNow(l);
      if ((plainAlt && k === "T") || (desktop && plainMod && k === "T")) {
        if (!newTabRef.current) return;
        e.preventDefault();
        newTabRef.current(frame);
        return;
      }
      if (tabCount(l) < 2) return;
      const tab = tabOf(l.frames[frame]);
      let next: Layout | null = null;
      if ((plainAlt && k === "W") || (desktop && plainMod && k === "W")) {
        // A pinned tab is closed from its menu only (#444); the shortcut
        // does nothing else either (in the desktop app: no closed window).
        if (tab.pinned) {
          e.preventDefault();
          return;
        }
        next = close(l, frame, tab.id);
      }
      else if (mod && e.altKey && !e.shiftKey && (e.key === "PageDown" || e.key === "PageUp")) next = cycle(l, frame, e.key === "PageDown" ? 1 : -1);
      else if (mod && e.altKey && e.shiftKey && (e.key === "PageDown" || e.key === "PageUp")) next = moveBy(l, frame, tab.id, e.key === "PageDown" ? 1 : -1);
      else if (desktop && ctrl && !e.altKey && !e.metaKey && e.key === "Tab") next = cycle(l, frame, e.shiftKey ? -1 : 1);
      else if (desktop && ctrl && !e.altKey && !e.metaKey && (e.key === "PageDown" || e.key === "PageUp"))
        next = e.shiftKey ? moveBy(l, frame, tab.id, e.key === "PageDown" ? 1 : -1) : cycle(l, frame, e.key === "PageDown" ? 1 : -1);
      else if (desktop && plainMod && k && /^[1-9]$/.test(k)) next = nth(l, frame, k === "9" ? Infinity : Number(k) - 1);
      if (!next) return;
      e.preventDefault();
      if (next !== l) commit(next);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [enabled, commit]);

  // The arrows and ⌘[ / ⌘] go through the active tab's history.
  useEffect(() => {
    if (!enabled) return;
    setStepSource({
      steps: (): Steps => {
        const l = ref.current;
        if (!l) return { current: null, back: [], forward: [] };
        const frame = frameNow(l);
        const { tab, back, forward } = tabSteps(l, frame);
        if (!tab) return { current: null, back: [], forward: [] };
        const step = (s: { place: string; delta: number }) => ({ key: `tab:${frame}:${tab.id}:${tab.index + s.delta}`, hash: s.place, delta: s.delta });
        return { current: placeOf(tab), back: back.slice(0, LIST_SIZE).map(step), forward: forward.slice(0, LIST_SIZE).map(step) };
      },
      go: (step) => {
        const l = ref.current;
        if (!l) return;
        const [, frameText, tabId] = step.key.split(":");
        const frame = Number(frameText);
        if (!l.frames[frame] || tabOf(l.frames[frame]).id !== tabId) return;
        const next = go(l, frame, step.delta);
        if (next === l) return;
        // The same step in the browser's history: through it, so the
        // browser's own buttons stay in step.
        if (frame === 0 && !ownSteps.current.length && browserPlaceAt(step.delta) === activePlace(next, 0)) {
          commit(next, { address: false });
          ownSteps.current.push({ at: Date.now(), place: activePlace(next, 0)! });
          browserGo(step.delta);
        } else commit(next, { address: frame === 0 });
      },
    });
    return () => setStepSource(null);
  }, [enabled, commit]);

  useEffect(() => {
    window.addEventListener("pagehide", flushSave);
    return () => {
      window.removeEventListener("pagehide", flushSave);
      flushSave();
    };
  }, [flushSave]);

  // The tab being dragged and where it would land (set only on a change:
  // every render here renders the workspace).
  const [drag, setDragState] = useState<Drop | null>(null);
  const setDrag = useCallback((next: Drop | null) => setDragState((d) => (JSON.stringify(d) === JSON.stringify(next) ? d : next)), []);

  return {
    layout,
    // Shown at all (not on phones).
    on: enabled && !!layout,
    // The right frame, when there is one and the window is wide enough.
    side: layout && wide ? layout.frames[1] ?? null : null,
    focused: layout ? frameNow(layout) : 0,
    // For the main pane's scroll positions (lib/pane-scroll.ts): one per
    // step of every tab.
    entryKey: () => {
      const l = ref.current;
      if (!l) return null;
      const tab = tabOf(l.frames[0]);
      return `tab:${tab.id}:${tab.index}`;
    },
    openPlace,
    switchTo,
    activate: (frame: number, id: string) => run((l) => activate(l, frame, id)),
    close: (frame: number, id: string) => run((l) => close(l, frame, id)),
    closeOthers: (frame: number, id: string) => run((l) => closeOthers(l, frame, id)),
    pin: (frame: number, id: string, pinned: boolean) => run((l) => pin(l, frame, id, pinned)),
    // Tab groups (#444).
    newGroup: (frame: number, id: string, name: string) => {
      const group = newGroupId();
      run((l) => createGroup(l, frame, id, { id: group, name }));
      return group;
    },
    joinGroup: (frame: number, id: string, group: string) => run((l) => joinGroup(l, frame, id, group)),
    leaveGroup: (frame: number, id: string) => run((l) => leaveGroup(l, frame, id)),
    updateGroup: (frame: number, group: string, change: { name?: string; color?: GroupColor; collapsed?: boolean }) =>
      run((l) => updateGroup(l, frame, group, change)),
    ungroup: (frame: number, group: string) => run((l) => ungroup(l, frame, group)),
    closeGroup: (frame: number, group: string) => run((l) => closeGroup(l, frame, group)),
    moveGroup: (frame: number, group: string, delta: number) => run((l) => moveGroup(l, frame, group, delta)),
    // The "+" of the tab bar.
    newTab: onNewTab ? (frame: number) => newTabRef.current?.(frame) : null,
    closeFrame: (frame: number) => run((l) => closeFrame(l, frame)),
    move: (from: number, id: string, to: number, index: number) => run((l) => move(l, from, id, to, index)),
    moveBy: (frame: number, id: string, delta: number) => run((l) => moveBy(l, frame, id, delta)),
    // The same place once more in the other frame.
    duplicateToSide: (frame: number, id: string) =>
      run((l) => {
        const tab = l.frames[frame]?.tabs.find((t) => t.id === id);
        return tab ? open(l, placeOf(tab), { frame: frame === 0 ? 1 : 0, reuse: false }) : l;
      }),
    drag,
    setDrag,
  };
}

export type Drop = { tab: string; from: number; frame: number; index: number } | { tab: string; from: number; edge: true };

// ---------------------------------------------------------------------------
// The tab bar of a frame.

export type PlaceLook = { title: string; icon: React.ReactNode };

export function TabBar({
  tabs,
  frame,
  index,
  frames,
  focused,
  wide,
  describe,
  panelId,
}: {
  tabs: FrameTabs;
  frame: Frame;
  index: number;
  frames: number;
  focused: boolean;
  wide: boolean;
  describe: (place: string) => PlaceLook;
  panelId: string;
}) {
  const t = useT();
  const list = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  // The menu of a group's chip, and the group being renamed (#444).
  const [groupMenu, setGroupMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const renamingRef = useRef<string | null>(null);
  renamingRef.current = renaming;
  const pressed = useRef<{ id: string; x: number; y: number; pointer: number; dragging: boolean } | null>(null);
  const dragged = useRef(false);
  const only = frames === 1 && frame.tabs.length === 1;
  const drop = tabs.drag;
  const dropIndex = drop && "index" in drop && drop.frame === index ? drop.index : null;

  // Where a dragged tab would land under the pointer.
  const dropAt = (x: number, y: number, id: string): Drop | null => {
    const under = document.elementFromPoint(x, y);
    if (under?.closest(".tab-edge-drop")) return { tab: id, from: index, edge: true };
    const bar = under?.closest<HTMLElement>("[data-tab-frame]");
    if (!bar) return null;
    const target = Number(bar.dataset.tabFrame);
    // The tabs shown (a collapsed group's are not): their place in the frame.
    const items = [...bar.querySelectorAll<HTMLElement>("[role=tab]")];
    let at = Number(bar.dataset.tabCount) || items.length;
    for (const item of items) {
      const box = item.getBoundingClientRect();
      if (x < box.left + box.width / 2) {
        at = Number(item.dataset.index);
        break;
      }
    }
    return { tab: id, from: index, frame: target, index: at };
  };

  const focusTab = (id: string) => requestAnimationFrame(() => document.getElementById(`tab-${id}`)?.focus());
  // Roving focus over the tabs and the groups' chips, as they stand.
  const rove = (e: React.KeyboardEvent<HTMLElement>) => {
    const items = [...(list.current?.querySelectorAll<HTMLElement>("[data-roving]") ?? [])];
    const at = items.indexOf(e.currentTarget);
    const n = items.length;
    if (at < 0 || !n) return;
    const to = e.key === "Home" ? 0 : e.key === "End" ? n - 1 : (at + (e.key === "ArrowRight" ? 1 : -1) + n) % n;
    items[to].focus();
  };
  const groupLabel = (name: string, count: number, collapsed: boolean) => {
    const label = count === 1 ? t(`Gruppe ${name}, 1 Tab`, `Group ${name}, 1 tab`) : t(`Gruppe ${name}, ${count} Tabs`, `Group ${name}, ${count} tabs`);
    return collapsed ? t(`${label}, eingeklappt`, `${label}, collapsed`) : label;
  };
  const commitRename = (group: string, value: string) => {
    setRenaming(null);
    tabs.updateGroup(index, group, { name: value });
    requestAnimationFrame(() => document.getElementById(`tab-group-${group}`)?.focus());
  };

  return (
    <div
      className={`frame-tabs${focused && frames > 1 ? " focused" : ""}${dropIndex !== null ? " dropping" : ""}`}
      data-tab-frame={index}
      data-tab-count={frame.tabs.length}
    >
    <div
      ref={list}
      className="frame-tab-list"
      role="tablist"
      aria-label={frames > 1 ? (index === 0 ? t("Tabs links", "Tabs on the left") : t("Tabs rechts", "Tabs on the right")) : t("Tabs", "Tabs")}
      aria-orientation="horizontal"
    >
      {frame.tabs.map((tab, i) => {
        const place = placeOf(tab);
        const look = describe(place);
        const selected = tab.id === frame.active;
        const group = tab.group ? frame.groups?.find((g) => g.id === tab.group) : undefined;
        // A group's chip before its first tab.
        const chip =
          group && frame.tabs[i - 1]?.group !== group.id
            ? (() => {
                const count = groupTabs(frame, group.id).length;
                if (renaming === group.id)
                  return (
                    <input
                      className={`frame-tab-group-input opt-${group.color}`}
                      autoFocus
                      defaultValue={group.name}
                      maxLength={60}
                      aria-label={t("Name der Gruppe", "Group name")}
                      onFocus={(e) => e.currentTarget.select()}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          commitRename(group.id, e.currentTarget.value);
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          setRenaming(null);
                          requestAnimationFrame(() => document.getElementById(`tab-group-${group.id}`)?.focus());
                        }
                      }}
                      onBlur={(e) => renamingRef.current === group.id && commitRename(group.id, e.currentTarget.value)}
                    />
                  );
                return (
                  <button
                    type="button"
                    id={`tab-group-${group.id}`}
                    data-roving=""
                    tabIndex={-1}
                    className={`frame-tab-group opt-${group.color}${group.collapsed ? " collapsed" : ""}`}
                    aria-expanded={!group.collapsed}
                    aria-label={groupLabel(group.name, count, !!group.collapsed)}
                    title={group.collapsed ? t("Gruppe ausklappen", "Expand group") : t("Gruppe einklappen", "Collapse group")}
                    onClick={() => tabs.updateGroup(index, group.id, { collapsed: !group.collapsed })}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setGroupMenu({ id: group.id, x: e.clientX, y: e.clientY });
                    }}
                    onKeyDown={(e) => {
                      const moving = (e.altKey || e.metaKey || e.ctrlKey) && e.shiftKey;
                      if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && moving) {
                        e.preventDefault();
                        tabs.moveGroup(index, group.id, e.key === "ArrowRight" ? 1 : -1);
                        requestAnimationFrame(() => document.getElementById(`tab-group-${group.id}`)?.focus());
                      } else if (e.key === "ArrowRight" || e.key === "ArrowLeft" || e.key === "Home" || e.key === "End") {
                        if (e.altKey || e.metaKey || e.ctrlKey) return;
                        e.preventDefault();
                        rove(e);
                      } else if (e.key === "F2") {
                        e.preventDefault();
                        setRenaming(group.id);
                      } else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
                        e.preventDefault();
                        const box = e.currentTarget.getBoundingClientRect();
                        setGroupMenu({ id: group.id, x: box.left, y: box.bottom });
                      }
                    }}
                  >
                    <span className="frame-tab-group-name">{group.name}</span>
                    {group.collapsed && (
                      <span className="frame-tab-group-count" aria-hidden="true">
                        {count}
                      </span>
                    )}
                  </button>
                );
              })()
            : null;
        if (tabHidden(frame, tab)) return <Fragment key={tab.id}>{chip}</Fragment>;
        return (
          <Fragment key={tab.id}>
          {chip}
          <div
            id={`tab-${tab.id}`}
            data-index={i}
            data-roving=""
            role="tab"
            aria-selected={selected}
            aria-controls={panelId}
            tabIndex={selected ? 0 : -1}
            title={look.title}
            data-open-place=""
            className={`frame-tab${selected ? " active" : ""}${tab.pinned ? " pinned" : ""}${group ? ` grouped opt-${group.color}` : ""}${drop?.tab === tab.id ? " dragged" : ""}${dropIndex === i ? " drop-before" : ""}${dropIndex === frame.tabs.length && i === frame.tabs.length - 1 ? " drop-after" : ""}`}
            onClick={() => {
              if (dragged.current) {
                dragged.current = false;
                return;
              }
              tabs.activate(index, tab.id);
            }}
            onAuxClick={(e) => {
              if (e.button !== 1 || only) return;
              e.preventDefault();
              if (!tab.pinned) tabs.close(index, tab.id);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ id: tab.id, x: e.clientX, y: e.clientY });
            }}
            onKeyDown={(e) => {
              const moving = (e.altKey || e.metaKey || e.ctrlKey) && e.shiftKey;
              if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && moving) {
                e.preventDefault();
                tabs.moveBy(index, tab.id, e.key === "ArrowRight" ? 1 : -1);
                focusTab(tab.id);
              } else if (e.key === "ArrowRight" || e.key === "ArrowLeft" || e.key === "Home" || e.key === "End") {
                if (e.altKey || e.metaKey || e.ctrlKey) return;
                e.preventDefault();
                rove(e);
              } else if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                tabs.activate(index, tab.id);
              } else if ((e.key === "Delete" || e.key === "Backspace") && !only && !tab.pinned) {
                e.preventDefault();
                const shown = frame.tabs.filter((x) => x.id === tab.id || !tabHidden(frame, x));
                const here = shown.findIndex((x) => x.id === tab.id);
                const neighbour = shown[here + 1] ?? shown[here - 1];
                tabs.close(index, tab.id);
                if (neighbour) focusTab(neighbour.id);
              } else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
                e.preventDefault();
                const box = e.currentTarget.getBoundingClientRect();
                setMenu({ id: tab.id, x: box.left, y: box.bottom });
              }
            }}
            onPointerDown={(e) => {
              if (e.button !== 0 || (e.target as Element).closest(".frame-tab-close")) return;
              pressed.current = { id: tab.id, x: e.clientX, y: e.clientY, pointer: e.pointerId, dragging: false };
            }}
            onPointerMove={(e) => {
              const p = pressed.current;
              if (!p || p.pointer !== e.pointerId) return;
              if (!p.dragging) {
                if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < 6) return;
                p.dragging = true;
                e.currentTarget.setPointerCapture(e.pointerId);
                document.documentElement.classList.add("tab-dragging");
              }
              tabs.setDrag(dropAt(e.clientX, e.clientY, p.id) ?? { tab: p.id, from: index, frame: -1, index: -1 });
            }}
            onPointerUp={(e) => {
              const p = pressed.current;
              pressed.current = null;
              if (!p?.dragging) return;
              dragged.current = true;
              document.documentElement.classList.remove("tab-dragging");
              const target = dropAt(e.clientX, e.clientY, p.id);
              tabs.setDrag(null);
              if (!target) return;
              if ("edge" in target) tabs.move(index, p.id, 1, 0);
              else if (target.frame >= 0) tabs.move(index, p.id, target.frame, target.index);
              // The click after the drag is no activation of its own.
              setTimeout(() => (dragged.current = false), 0);
            }}
            onPointerCancel={() => {
              pressed.current = null;
              document.documentElement.classList.remove("tab-dragging");
              tabs.setDrag(null);
            }}
          >
            <span className="frame-tab-icon" aria-hidden="true">
              {look.icon}
            </span>
            {/* Pinned: the icon only; the title stays the tab's name. */}
            <span className={`frame-tab-title${tab.pinned ? " sr-only" : ""}`}>{look.title}</span>
            {tab.pinned && <span className="sr-only">{t(" (angeheftet)", " (pinned)")}</span>}
            {!only && !tab.pinned && (
              <button
                type="button"
                className="frame-tab-close"
                tabIndex={-1}
                aria-label={t(`${look.title} schließen`, `Close ${look.title}`)}
                title={t("Tab schließen", "Close tab")}
                onClick={(e) => {
                  e.stopPropagation();
                  tabs.close(index, tab.id);
                }}
              >
                <X size={12} weight="bold" />
              </button>
            )}
          </div>
          </Fragment>
        );
      })}
    </div>
      {tabs.newTab && (
        <button
          type="button"
          className="frame-tab-new"
          aria-label={t("Neuer Tab", "New tab")}
          title={t("Neuer Tab", "New tab")}
          onClick={() => tabs.newTab?.(index)}
        >
          <Plus size={14} weight="bold" />
        </button>
      )}
      {menu && (() => {
        const tab = frame.tabs.find((x) => x.id === menu.id);
        if (!tab) return null;
        const look = describe(placeOf(tab));
        const other = index === 0 ? 1 : 0;
        return (
          <Dropdown.Root open modal={false} onOpenChange={(o) => !o && setMenu(null)}>
            <Dropdown.Trigger asChild>
              <span className="context-anchor" style={{ left: menu.x, top: menu.y }} aria-hidden="true" />
            </Dropdown.Trigger>
            <Dropdown.Portal>
              <Dropdown.Content
                className="dropdown"
                align="start"
                sideOffset={2}
                collisionPadding={safeCollisionPadding()}
                aria-label={t(`Aktionen für den Tab ${look.title}`, `Actions for the tab ${look.title}`)}
                onCloseAutoFocus={(e) => {
                  e.preventDefault();
                  // A new group's name field keeps the focus.
                  if (!renamingRef.current) document.getElementById(`tab-${frame.active}`)?.focus();
                }}
              >
                {wide && (frames > 1 || frame.tabs.length > 1) && (
                  <Dropdown.Item className="dropdown-item" onSelect={() => tabs.move(index, tab.id, other, Number.MAX_SAFE_INTEGER)}>
                    {index === 0 ? <ArrowLineRight /> : <ArrowLineLeft />}
                    {index === 0 ? t("In die rechte Ansicht verschieben", "Move to the right view") : t("In die linke Ansicht verschieben", "Move to the left view")}
                  </Dropdown.Item>
                )}
                {wide && (
                  <Dropdown.Item className="dropdown-item" onSelect={() => tabs.duplicateToSide(index, tab.id)}>
                    {frames > 1 ? <Copy /> : <SquareSplitHorizontal />}
                    {index === 0 ? t("Rechts daneben noch einmal öffnen", "Open again on the right") : t("Links daneben noch einmal öffnen", "Open again on the left")}
                  </Dropdown.Item>
                )}
                <Dropdown.Item className="dropdown-item" onSelect={() => tabs.pin(index, tab.id, !tab.pinned)}>
                  {tab.pinned ? <PushPinSlash /> : <PushPin />}
                  {tab.pinned ? t("Lösen", "Unpin tab") : t("Anheften", "Pin tab")}
                </Dropdown.Item>
                {/* Groups (#444): pinned tabs are in none. */}
                {!tab.pinned && (
                  <Dropdown.Item className="dropdown-item" onSelect={() => setRenaming(tabs.newGroup(index, tab.id, t("Gruppe", "Group")))}>
                    <StackPlus />
                    {t("Zu neuer Gruppe hinzufügen", "Add to new group")}
                  </Dropdown.Item>
                )}
                {!tab.pinned && (frame.groups ?? []).some((g) => g.id !== tab.group) && (
                  <Dropdown.Sub>
                    <Dropdown.SubTrigger className="dropdown-item page-menu-sub-trigger">
                      <Stack />
                      {t("Zu Gruppe hinzufügen", "Add to group")}
                      <CaretRight className="page-menu-sub-caret" aria-hidden="true" />
                    </Dropdown.SubTrigger>
                    <Dropdown.Portal>
                      <Dropdown.SubContent className="dropdown page-menu-sub" sideOffset={4} alignOffset={-4} collisionPadding={safeCollisionPadding()}>
                        {(frame.groups ?? [])
                          .filter((g) => g.id !== tab.group)
                          .map((g) => (
                            <Dropdown.Item key={g.id} className="dropdown-item" onSelect={() => tabs.joinGroup(index, tab.id, g.id)}>
                              <span className={`option-swatch opt-${g.color}`} aria-hidden="true" />
                              {g.name}
                            </Dropdown.Item>
                          ))}
                      </Dropdown.SubContent>
                    </Dropdown.Portal>
                  </Dropdown.Sub>
                )}
                {tab.group && (
                  <Dropdown.Item className="dropdown-item" onSelect={() => tabs.leaveGroup(index, tab.id)}>
                    <StackMinus />
                    {t("Aus Gruppe entfernen", "Remove from group")}
                  </Dropdown.Item>
                )}
                {!only && (
                  <Dropdown.Item className="dropdown-item" onSelect={() => tabs.close(index, tab.id)}>
                    <X />
                    {t("Tab schließen", "Close tab")}
                  </Dropdown.Item>
                )}
                {frame.tabs.some((x) => x.id !== tab.id && !x.pinned) && (
                  <Dropdown.Item className="dropdown-item" onSelect={() => tabs.closeOthers(index, tab.id)}>
                    <XSquare />
                    {t("Andere Tabs schließen", "Close other tabs")}
                  </Dropdown.Item>
                )}
                {frames > 1 && (
                  <Dropdown.Item className="dropdown-item" onSelect={() => tabs.closeFrame(index)}>
                    <SquareSplitHorizontal />
                    {t("Diese Ansicht schließen", "Close this view")}
                  </Dropdown.Item>
                )}
              </Dropdown.Content>
            </Dropdown.Portal>
          </Dropdown.Root>
        );
      })()}
      {groupMenu && (() => {
        const group = frame.groups?.find((g) => g.id === groupMenu.id);
        if (!group) return null;
        const runs = frame.tabs.filter((x, i) => !x.pinned && (!x.group || frame.tabs[i - 1]?.group !== x.group));
        const at = runs.findIndex((x) => x.group === group.id);
        return (
          <Dropdown.Root open modal={false} onOpenChange={(o) => !o && setGroupMenu(null)}>
            <Dropdown.Trigger asChild>
              <span className="context-anchor" style={{ left: groupMenu.x, top: groupMenu.y }} aria-hidden="true" />
            </Dropdown.Trigger>
            <Dropdown.Portal>
              <Dropdown.Content
                className="dropdown"
                align="start"
                sideOffset={2}
                collisionPadding={safeCollisionPadding()}
                aria-label={t(`Aktionen für die Gruppe ${group.name}`, `Actions for the group ${group.name}`)}
                onCloseAutoFocus={(e) => {
                  e.preventDefault();
                  if (renamingRef.current) return;
                  (document.getElementById(`tab-group-${group.id}`) ?? document.getElementById(`tab-${frame.active}`))?.focus();
                }}
              >
                <Dropdown.Item className="dropdown-item" onSelect={() => setRenaming(group.id)}>
                  <PencilSimple />
                  {t("Umbenennen", "Rename")}
                </Dropdown.Item>
                <Dropdown.Sub>
                  <Dropdown.SubTrigger className="dropdown-item page-menu-sub-trigger">
                    <Palette />
                    {t("Farbe", "Colour")}
                    <CaretRight className="page-menu-sub-caret" aria-hidden="true" />
                  </Dropdown.SubTrigger>
                  <Dropdown.Portal>
                    <Dropdown.SubContent className="dropdown page-menu-sub" sideOffset={4} alignOffset={-4} collisionPadding={safeCollisionPadding()}>
                      <Dropdown.RadioGroup value={group.color} onValueChange={(color) => tabs.updateGroup(index, group.id, { color: color as GroupColor })}>
                        {GROUP_COLORS.map((color) => (
                          <Dropdown.RadioItem key={color} value={color} className="dropdown-item">
                            <span className={`option-swatch opt-${color}`} aria-hidden="true" />
                            {colorLabel(color, t)}
                          </Dropdown.RadioItem>
                        ))}
                      </Dropdown.RadioGroup>
                    </Dropdown.SubContent>
                  </Dropdown.Portal>
                </Dropdown.Sub>
                <Dropdown.Item className="dropdown-item" onSelect={() => tabs.updateGroup(index, group.id, { collapsed: !group.collapsed })}>
                  {group.collapsed ? <CaretDown /> : <CaretRight />}
                  {group.collapsed ? t("Ausklappen", "Expand") : t("Einklappen", "Collapse")}
                </Dropdown.Item>
                {at > 0 && (
                  <Dropdown.Item className="dropdown-item" onSelect={() => tabs.moveGroup(index, group.id, -1)}>
                    <ArrowLeft />
                    {t("Gruppe nach links verschieben", "Move group left")}
                  </Dropdown.Item>
                )}
                {at >= 0 && at < runs.length - 1 && (
                  <Dropdown.Item className="dropdown-item" onSelect={() => tabs.moveGroup(index, group.id, 1)}>
                    <ArrowRight />
                    {t("Gruppe nach rechts verschieben", "Move group right")}
                  </Dropdown.Item>
                )}
                <Dropdown.Item className="dropdown-item" onSelect={() => tabs.ungroup(index, group.id)}>
                  <StackMinus />
                  {t("Gruppierung aufheben", "Ungroup")}
                </Dropdown.Item>
                <Dropdown.Item className="dropdown-item" onSelect={() => tabs.closeGroup(index, group.id)}>
                  <XSquare />
                  {t("Gruppe schließen", "Close group")}
                </Dropdown.Item>
              </Dropdown.Content>
            </Dropdown.Portal>
          </Dropdown.Root>
        );
      })()}
    </div>
  );
}

// The drop zone at the right edge while a tab is dragged in a single frame.
export function TabEdgeDrop({ tabs }: { tabs: FrameTabs }) {
  const t = useT();
  const over = !!tabs.drag && "edge" in tabs.drag;
  return (
    <div className={`split-dropzone tab-edge-drop${over ? " over" : ""}`} aria-hidden="true">
      <SquareSplitHorizontal size={24} />
      <span>{t("Hier ablegen, um den Tab daneben zu öffnen", "Drop here to open the tab beside it")}</span>
    </div>
  );
}
