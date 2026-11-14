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
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { ArrowLineLeft, ArrowLineRight, Copy, SquareSplitHorizontal, X, XSquare } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { safeCollisionPadding } from "./safe-area";
import {
  activate,
  activePlace,
  close,
  closeFrame,
  closeOthers,
  cycle,
  focus,
  follow,
  go,
  move,
  moveBy,
  nth,
  open,
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
}: {
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
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Steps of a tab taken through the browser's history (browserGo): the
  // tab has moved already; when the browser arrives, only the address is
  // checked – another step may have been taken meanwhile.
  const ownSteps = useRef<{ at: number; place: string }[]>([]);

  const persist = useCallback((next: Layout, local: boolean) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const key = storeKey(userId, owner.current || workspaceId);
    saveTimer.current = setTimeout(() => {
      const value = JSON.stringify(serialize(next));
      try {
        sessionStorage.setItem(key, value);
      } catch {}
      if (local)
        try {
          localStorage.setItem(key, value);
        } catch {}
    }, 200);
  }, [userId, workspaceId]);

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
        const split = typeof location === "undefined" ? null : new URLSearchParams(location.search).get("split");
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
      const next = follow(l, 0, place, how);
      if (next !== l) commit(next);
    };
    nav?.addEventListener("navigate", navigating);
    window.addEventListener("hashchange", changed);
    return () => {
      nav?.removeEventListener("navigate", navigating);
      window.removeEventListener("hashchange", changed);
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
  // browser ⌘/Ctrl+W, Ctrl+Tab and ⌘/Ctrl+1…9 belong to the browser's own
  // tabs: only the desktop app takes them, everywhere Alt+W and
  // ⌘/Ctrl+Alt+PageDown/PageUp work.
  useEffect(() => {
    if (!enabled) return;
    const desktop = !!desktopApp();
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const l = ref.current;
      if (!l || tabCount(l) < 2) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"], .presentation')) return;
      const mac = isMacPlatform();
      const mod = mac ? e.metaKey : e.ctrlKey,
        ctrl = e.ctrlKey,
        k = eventKey(e);
      const frame = frameNow(l);
      const tab = tabOf(l.frames[frame]);
      let next: Layout | null = null;
      const plainMod = mod && !e.altKey && !e.shiftKey && (mac ? !e.ctrlKey : !e.metaKey);
      if ((e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && k === "W") || (desktop && plainMod && k === "W")) next = close(l, frame, tab.id);
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

  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    [],
  );

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
    const items = [...bar.querySelectorAll<HTMLElement>("[role=tab]")];
    let at = items.length;
    for (const [i, item] of items.entries()) {
      const box = item.getBoundingClientRect();
      if (x < box.left + box.width / 2) {
        at = i;
        break;
      }
    }
    return { tab: id, from: index, frame: target, index: at };
  };

  const focusTab = (id: string) => requestAnimationFrame(() => document.getElementById(`tab-${id}`)?.focus());

  return (
    <div
      ref={list}
      className={`frame-tabs${focused && frames > 1 ? " focused" : ""}${dropIndex !== null ? " dropping" : ""}`}
      role="tablist"
      data-tab-frame={index}
      aria-label={frames > 1 ? (index === 0 ? t("Tabs links", "Tabs on the left") : t("Tabs rechts", "Tabs on the right")) : t("Tabs", "Tabs")}
      aria-orientation="horizontal"
    >
      {frame.tabs.map((tab, i) => {
        const place = placeOf(tab);
        const look = describe(place);
        const selected = tab.id === frame.active;
        return (
          <div
            key={tab.id}
            id={`tab-${tab.id}`}
            role="tab"
            aria-selected={selected}
            aria-controls={panelId}
            tabIndex={selected ? 0 : -1}
            title={look.title}
            data-open-place=""
            className={`frame-tab${selected ? " active" : ""}${drop?.tab === tab.id ? " dragged" : ""}${dropIndex === i ? " drop-before" : ""}${dropIndex === frame.tabs.length && i === frame.tabs.length - 1 ? " drop-after" : ""}`}
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
              tabs.close(index, tab.id);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ id: tab.id, x: e.clientX, y: e.clientY });
            }}
            onKeyDown={(e) => {
              const at = frame.tabs.findIndex((x) => x.id === tab.id);
              const moving = (e.altKey || e.metaKey || e.ctrlKey) && e.shiftKey;
              if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && moving) {
                e.preventDefault();
                tabs.moveBy(index, tab.id, e.key === "ArrowRight" ? 1 : -1);
                focusTab(tab.id);
              } else if (e.key === "ArrowRight" || e.key === "ArrowLeft" || e.key === "Home" || e.key === "End") {
                if (e.altKey || e.metaKey || e.ctrlKey) return;
                e.preventDefault();
                const n = frame.tabs.length;
                const to = e.key === "Home" ? 0 : e.key === "End" ? n - 1 : (at + (e.key === "ArrowRight" ? 1 : -1) + n) % n;
                document.getElementById(`tab-${frame.tabs[to].id}`)?.focus();
              } else if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                tabs.activate(index, tab.id);
              } else if ((e.key === "Delete" || e.key === "Backspace") && !only) {
                e.preventDefault();
                const neighbour = frame.tabs[at + 1] ?? frame.tabs[at - 1];
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
            <span className="frame-tab-title">{look.title}</span>
            {!only && (
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
        );
      })}
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
                  document.getElementById(`tab-${frame.active}`)?.focus();
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
                {!only && (
                  <Dropdown.Item className="dropdown-item" onSelect={() => tabs.close(index, tab.id)}>
                    <X />
                    {t("Tab schließen", "Close tab")}
                  </Dropdown.Item>
                )}
                {frame.tabs.length > 1 && (
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
