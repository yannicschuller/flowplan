"use client";
// The header row of a database table stays at the top of whatever scrolls
// the table vertically – the page, a document with the table inline, a
// frame of the split view, a dialog (#287). The table scrolls sideways in
// its own scroller, so `position: sticky` cannot do it (lib/sticky-head.ts);
// the header cells are moved down by `--sticky-head-y` on the `thead`
// instead (app/globals.css). They stay the real `th` and keep scrolling
// sideways with the body. Only the header and a few boxes are measured,
// once per frame while something scrolls: no work per row.
import { useEffect, useState } from "react";
import { stickLine, stickyHeadOffset, type TopBar } from "@/lib/sticky-head";

// Bars that stick to the top of a scroller themselves: the header sticks
// below them (formatting toolbar, dialog heading, a sheet's handle, the bar
// of a record opened as a page).
const TOP_BARS = ".editor-toolbar, .modal-heading, .sheet-handle, .record-page-bar";
const SCROLLS = /^(auto|scroll|overlay)$/;

/** The nearest ancestor that really scrolls vertically, or null for the window. */
function verticalScroller(from: HTMLElement): HTMLElement | null {
  for (let el = from.parentElement; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
    if (el.scrollHeight > el.clientHeight + 1 && SCROLLS.test(getComputedStyle(el).overflowY)) return el;
  }
  return null;
}

/** A ref callback for the `<table>`; it may mount later (switching views). */
export function useStickyTableHead() {
  const [el, setTable] = useState<HTMLTableElement | null>(null);
  useEffect(() => {
    const scroll = el?.parentElement;
    if (!el || !scroll) return;
    let frame = 0;
    let shown = 0;
    let shownOn: HTMLElement | null = null;
    // The bars of the current scroller, looked up again at most once a second.
    let bars: { scroller: HTMLElement | null; list: HTMLElement[]; at: number } | null = null;
    const topBars = (scroller: HTMLElement | null) => {
      const now = performance.now();
      if (!bars || bars.scroller !== scroller || now - bars.at > 1000) {
        const root: ParentNode = scroller || document;
        bars = {
          scroller,
          at: now,
          list: [...root.querySelectorAll<HTMLElement>(TOP_BARS)].filter((bar) => !el.contains(bar) && !bar.contains(el)),
        };
      }
      return bars.list;
    };
    const set = (y: number) => {
      const head = el.tHead;
      if (!head) return;
      // Unchanged (to a quarter pixel) on the same header: nothing to write.
      if (head === shownOn && y > 0 === shown > 0 && Math.abs(y - shown) < 0.25) return;
      shown = y;
      shownOn = head;
      if (y > 0) {
        head.style.setProperty("--sticky-head-y", `${y}px`);
        head.dataset.stuck = "";
      } else {
        head.style.removeProperty("--sticky-head-y");
        delete head.dataset.stuck;
      }
    };
    const update = () => {
      frame = 0;
      const head = el.tHead;
      if (!head || !el.isConnected) return;
      const scroller = verticalScroller(scroll);
      const box = el.getBoundingClientRect();
      if (!box.height) return set(0);
      // The header row's own top (the cells move, the thead box does not):
      // below the table's top by half a collapsed border.
      const headTop = head.getBoundingClientRect().top;
      let top = 0;
      if (scroller) {
        const s = scroller.getBoundingClientRect();
        top = s.top + scroller.clientTop;
        // Not in view at all: nothing to stick.
        if (box.bottom < top || box.top > s.bottom) return set(0);
      }
      const list: TopBar[] = [];
      for (const bar of topBars(scroller)) {
        const r = bar.getBoundingClientRect();
        if (r.height && r.right > box.left && r.left < box.right) list.push({ top: r.top, bottom: r.bottom });
      }
      const foot = el.tFoot;
      set(
        stickyHeadOffset({
          headTop,
          headHeight: head.offsetHeight,
          bodyEnd: foot ? foot.getBoundingClientRect().top : box.bottom,
          line: stickLine(top, list),
        }),
      );
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    // Every scroll on the page (captured: scroll does not bubble), so
    // nested scrollers – a frame, a dialog, a document – are covered without
    // knowing which one moves the table.
    document.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule, { passive: true });
    const sizes = new ResizeObserver(schedule);
    sizes.observe(el);
    sizes.observe(scroll);
    schedule();
    return () => {
      document.removeEventListener("scroll", schedule, { capture: true });
      window.removeEventListener("resize", schedule);
      sizes.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [el]);
  return setTable;
}
