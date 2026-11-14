"use client";
// Where the workspace's pane (.main-scroll) stands when another place opens
// (#224, #262). Every place – a page, the start page, the inbox, a
// collection … – starts at its top, never as far down as the place before.
// Back and forward to an entry of the tab's history bring its place back
// where it was left in that entry; a new visit to the same place starts at
// the top again. Positions are kept per history entry (currentEntryKey(),
// the Navigation API's key; without it every place starts at the top) and
// only for this tab while it is open.
import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { currentEntryKey } from "./history-nav";

type Kept = { place: string; top: number };
// Entries kept (the oldest go first).
export const KEPT_ENTRIES = 200;
// How long a restored position waits for the place's content to grow tall
// enough (a document or database loading).
const RESTORE_MS = 2500;

// Where the pane goes for `place` in the history entry `key`: its kept
// position when that entry showed this place before, else the top.
export function paneTarget(kept: ReadonlyMap<string, Kept>, key: string | null, place: string): number {
  const entry = key ? kept.get(key) : undefined;
  return entry && entry.place === place ? entry.top : 0;
}

export function keepPosition(kept: Map<string, Kept>, key: string, place: string, top: number, size = KEPT_ENTRIES) {
  kept.delete(key);
  kept.set(key, { place, top });
  while (kept.size > size) kept.delete(kept.keys().next().value as string);
}

// `place` is null while it is not known yet (a page loading): the pane
// waits at the top and keeps nothing for it.
// `entryKey` names the entry otherwise: with tabs (#279) every step of
// every tab has its own (components/frame-tabs.tsx), as switching tabs
// replaces the browser's entry.
export function usePaneScroll(pane: RefObject<HTMLElement | null>, place: string | null, entryKey?: () => string | null) {
  const keyOf = useRef(entryKey);
  keyOf.current = entryKey;
  const kept = useRef(new Map<string, Kept>());
  // The place shown and the history entry it was shown in. A scroll event
  // can come in after the address has gone on to the next entry (scrolled,
  // then back at once): it still belongs to the entry it was scrolled in.
  const shown = useRef(place);
  const shownIn = useRef<string | null>(null);
  // While a kept position is being restored, the pane's scroll events are
  // not the reader's (no saving).
  const restoring = useRef<(() => void) | null>(null);

  // The reader's position, for the current entry and place.
  useEffect(() => {
    const el = pane.current;
    if (!el) return;
    const save = () => {
      if (restoring.current || shown.current === null) return;
      const key = shownIn.current;
      if (key) keepPosition(kept.current, key, shown.current, el.scrollTop);
    };
    el.addEventListener("scroll", save, { passive: true });
    return () => el.removeEventListener("scroll", save);
  }, [pane]);

  useLayoutEffect(() => {
    const el = pane.current;
    shown.current = place;
    shownIn.current = keyOf.current?.() ?? currentEntryKey();
    restoring.current?.();
    if (!el) return;
    const target = place === null ? 0 : paneTarget(kept.current, shownIn.current, place);
    el.scrollTop = 0;
    if (target <= 0) return;
    // The content may still be loading: the position as soon as the pane
    // is tall enough, until the reader scrolls or a moment has passed.
    const started = performance.now();
    let frame = 0;
    const stop = () => {
      cancelAnimationFrame(frame);
      for (const type of ["wheel", "touchstart", "keydown", "pointerdown"]) el.removeEventListener(type, stop, true);
      if (restoring.current === stop) restoring.current = null;
    };
    const step = () => {
      el.scrollTop = target;
      if (el.scrollTop >= target - 1 || performance.now() - started > RESTORE_MS) stop();
      else frame = requestAnimationFrame(step);
    };
    restoring.current = stop;
    for (const type of ["wheel", "touchstart", "keydown", "pointerdown"]) el.addEventListener(type, stop, { capture: true, passive: true });
    step();
    return stop;
  }, [pane, place]);
}
