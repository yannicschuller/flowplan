"use client";
// Phones: the sidebar follows the finger. A swipe from the left edge pulls
// it in, a swipe to the left on the open sidebar (or the dimmed page beside
// it) pushes it out – released past a third of its width or with some
// speed, it settles open or closed, otherwise it springs back. Vertical
// swipes, dialogs, whiteboards and places that pan sideways themselves are
// left alone. On iOS the very edge belongs to "back" – Safari's own swipe,
// and the app's (flowplan-app) whenever the page has a step back – so there
// the swipe that opens starts a little further in, where back never begins.
// Where nothing claims the edge (the installed web app, the app on its start
// page) it may start at the edge itself.
import { useEffect, useRef } from "react";

const PHONE = "(max-width: 767px)";
// Where a swipe that opens may start, from the left edge; BACK_EDGE is left
// to iOS's back swipe (it begins within about 20 points of the edge).
const EDGE = 64;
const BACK_EDGE = 24;
// Moved this far before deciding: sideways (drawer) or not (scroll).
const DECIDE = 10;
const IGNORE =
  "[role=dialog], canvas, .whiteboard, .wb-root, input[type=range], [data-no-edge-swipe]";

export function useDrawerSwipe(
  open: boolean,
  setOpen: (open: boolean) => void,
) {
  const state = useRef({ open, setOpen });
  state.current = { open, setOpen };
  useEffect(() => {
    const phone = window.matchMedia(PHONE);
    const ios =
      /iP(hone|ad|od)/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const inApp = "FlowplanApp" in window;
    const standalone = window.matchMedia("(display-mode: standalone)").matches;
    // Whether a swipe from the very edge goes back instead (lib/app-back.ts
    // turns the app's gesture on only when there is a step back).
    const backAtEdge = () => {
      if (!ios) return false;
      if (inApp) {
        const nav = (
          window as { FlowplanNavigation?: { canGoBack?: () => boolean } }
        ).FlowplanNavigation;
        return nav?.canGoBack?.() !== false;
      }
      return !standalone;
    };
    let start: { x: number; y: number; t: number; open: boolean } | null = null;
    let dragging = false;
    let width = 0;
    let last = { x: 0, t: 0 };
    let velocity = 0;
    const parts = () => ({
      sidebar: document.querySelector<HTMLElement>(".app-shell > .sidebar"),
      scrim: document.querySelector<HTMLElement>(".app-shell > .mobile-scrim"),
    });
    // The sidebar at `shown` (0 closed … 1 open), without its transition.
    const place = (shown: number) => {
      const { sidebar, scrim } = parts();
      if (!sidebar) return;
      sidebar.style.transition = "none";
      sidebar.style.transform = `translateX(${(shown - 1) * 100}%)`;
      if (scrim) {
        scrim.style.display = "block";
        scrim.style.transition = "none";
        scrim.style.opacity = String(shown);
      }
    };
    const release = () => {
      const { sidebar, scrim } = parts();
      for (const el of [sidebar, scrim]) el?.removeAttribute("style");
    };
    const down = (e: TouchEvent) => {
      start = null;
      dragging = false;
      if (!phone.matches || e.touches.length !== 1) return;
      const touch = e.touches[0];
      const target = e.target as Element | null;
      if (target?.closest(IGNORE)) return;
      const { open } = state.current;
      if (open) {
        // Closing: on the sidebar or the dimmed page.
        if (
          !target?.closest(".app-shell > .sidebar, .app-shell > .mobile-scrim")
        )
          return;
      } else {
        const from = backAtEdge() ? BACK_EDGE : 0;
        if (touch.clientX < from || touch.clientX > EDGE) return;
      }
      width = parts().sidebar?.getBoundingClientRect().width || 300;
      start = {
        x: touch.clientX,
        y: touch.clientY,
        t: performance.now(),
        open,
      };
      last = { x: touch.clientX, t: start.t };
      velocity = 0;
    };
    const move = (e: TouchEvent) => {
      if (!start) return;
      const touch = e.touches[0];
      const dx = touch.clientX - start.x,
        dy = touch.clientY - start.y;
      if (!dragging) {
        if (Math.abs(dx) < DECIDE && Math.abs(dy) < DECIDE) return;
        // Up or down, or the wrong way: not the drawer.
        if (Math.abs(dy) > Math.abs(dx) || (start.open ? dx > 0 : dx < 0)) {
          start = null;
          return;
        }
        dragging = true;
      }
      e.preventDefault();
      const now = performance.now();
      if (now > last.t) velocity = (touch.clientX - last.x) / (now - last.t);
      last = { x: touch.clientX, t: now };
      const shown = start.open
        ? 1 + Math.min(0, dx) / width
        : Math.min(1, Math.max(0, dx) / width);
      place(shown);
    };
    const up = () => {
      if (!start) return;
      const was = start;
      start = null;
      if (!dragging) return;
      dragging = false;
      const { sidebar } = parts();
      const shown = sidebar
        ? 1 +
          new DOMMatrixReadOnly(getComputedStyle(sidebar).transform).m41 / width
        : was.open
          ? 1
          : 0;
      const next =
        Math.abs(velocity) > 0.45
          ? velocity > 0
          : shown > (was.open ? 0.66 : 0.34);
      // Let the stylesheet's transition carry it the rest of the way.
      const { scrim } = parts();
      if (sidebar) {
        sidebar.style.transition = "";
        sidebar.style.transform = next ? "translateX(0)" : "translateX(-100%)";
      }
      if (scrim) {
        scrim.style.transition = "opacity 0.18s ease";
        scrim.style.opacity = next ? "1" : "0";
      }
      state.current.setOpen(next);
      window.setTimeout(release, 220);
    };
    document.addEventListener("touchstart", down, { passive: true });
    // Not passive: a sideways drag must not scroll the page underneath.
    document.addEventListener("touchmove", move, { passive: false });
    document.addEventListener("touchend", up);
    document.addEventListener("touchcancel", up);
    return () => {
      document.removeEventListener("touchstart", down);
      document.removeEventListener("touchmove", move);
      document.removeEventListener("touchend", up);
      document.removeEventListener("touchcancel", up);
      release();
    };
  }, []);
}
