"use client";
// The swipe from the right edge goes forward (#647, lib/forward-swipe.ts):
// in the app, with "Wischen vom linken Rand" on "Zurück" and a step forward
// (lib/history-nav.ts). A round chevron comes in from the right with the
// finger; past the threshold it grows a little and the app taps once
// (haptic), and letting go there – or a flick – goes forward. Released
// before, it slides back out and nothing happens. Vertical swipes, the
// open drawer and the places that use the right edge themselves are left
// alone (FORWARD_IGNORE, a table that can still scroll to the right, a text
// selection). The app learns whether the edge goes forward now
// (FlowplanApp.forwardState): on Android it then keeps a strip of the right
// edge from the system's back gesture.
import { useEffect, useRef } from "react";
import { atRightEdge, CHEVRON, FORWARD_EDGE, forwardCommits, forwardSwipeOn, forwardTravel } from "@/lib/forward-swipe";
import { edgeSwipePref, onEdgeSwipePref } from "@/lib/edge-swipe-pref";
import { goForward, historySteps, subscribeHistory } from "@/lib/history-nav";
import { prefersReducedMotion } from "@/lib/motion";
import { nativeApp } from "@/lib/native-app";
import { canScrollForward, sidewaysBoxes } from "@/lib/sideways-scroll";

// Moved this far before deciding: sideways (forward) or not (scroll).
const DECIDE = 10;
const SLANT = 1.3;
export const FORWARD_IGNORE =
  "[role=dialog], [aria-modal=true], canvas, .whiteboard, .wb-root, input[type=range], [data-no-edge-swipe], .side-panel, .ai-ask, .comments-panel, .sidebar, .mobile-scrim, .sidebar-resize";

function env() {
  const app = nativeApp();
  return {
    platform: app?.platform === "ios" || app?.platform === "android" ? app.platform : null,
    appTakesChoice: typeof app?.edgeSwipe === "function",
    appForward: typeof app?.forwardState === "function",
    pref: edgeSwipePref(),
    canGoForward: historySteps().forward.length > 0,
  };
}

export function useForwardSwipe(drawerOpen: boolean) {
  const open = useRef(drawerOpen);
  open.current = drawerOpen;
  useEffect(() => {
    if (!nativeApp()) return;
    // The app learns whether the right edge goes forward (once per change).
    let reported: boolean | null = null;
    const report = () => {
      const app = nativeApp();
      if (typeof app?.forwardState !== "function") return;
      const on = forwardSwipeOn(env());
      if (on === reported) return;
      reported = on;
      try {
        app.forwardState(on);
      } catch {}
    };
    report();
    const unHistory = subscribeHistory(report);
    const unPref = onEdgeSwipePref(report);

    let start: { x: number; y: number; t: number } | null = null;
    let dragging = false;
    let armed = false;
    let last = { x: 0, t: 0 };
    let velocity = 0;
    let chevron: HTMLElement | null = null;
    let unlisten: (() => void) | null = null;
    const reduced = () => prefersReducedMotion();

    const show = (y: number) => {
      chevron?.remove();
      const el = document.createElement("div");
      el.className = "forward-swipe-chevron";
      el.setAttribute("aria-hidden", "true");
      if (reduced()) el.dataset.reduced = "";
      el.style.setProperty("--forward-swipe-y", `${Math.round(y - CHEVRON / 2)}px`);
      document.body.append(el);
      chevron = el;
    };
    const place = (distance: number) => {
      if (!chevron) return;
      const { travel, armed: past } = forwardTravel(distance);
      chevron.style.setProperty("--forward-swipe-x", `${Math.round(travel)}px`);
      if (past !== armed) {
        armed = past;
        chevron.toggleAttribute("data-armed", past);
        if (past)
          try {
            nativeApp()?.haptic?.("light");
          } catch {}
      }
    };
    const hide = () => {
      const el = chevron;
      chevron = null;
      if (!el) return;
      el.dataset.leaving = "";
      el.style.setProperty("--forward-swipe-x", "0px");
      window.setTimeout(() => el.remove(), reduced() ? 120 : 200);
    };

    const down = (e: TouchEvent) => {
      if (dragging) up();
      start = null;
      dragging = false;
      if (e.touches.length !== 1 || open.current) return;
      const touch = e.touches[0];
      if (!atRightEdge(touch.clientX, window.innerWidth)) return;
      if (!forwardSwipeOn(env())) return;
      const target = e.target as Element | null;
      if (target?.closest(FORWARD_IGNORE)) return;
      // A table (board, timeline …) that scrolls on to the right scrolls –
      // also when the finger starts in the margin beside it.
      if (canScrollForward(sidewaysBoxes(target))) return;
      const beside = document.elementFromPoint(touch.clientX - FORWARD_EDGE - 8, touch.clientY);
      if (beside && beside !== target && (beside.closest(FORWARD_IGNORE) || canScrollForward(sidewaysBoxes(beside)))) return;
      // A text selection: its handles may sit at the edge.
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && selection.toString().trim()) return;
      start = { x: touch.clientX, y: touch.clientY, t: performance.now() };
      last = { x: touch.clientX, t: start.t };
      velocity = 0;
      armed = false;
      // On the touch's own target, as the drawer's swipe does.
      unlisten?.();
      const el = e.target as EventTarget;
      el.addEventListener("touchmove", move as EventListener, { passive: false });
      el.addEventListener("touchend", up as EventListener);
      el.addEventListener("touchcancel", cancel as EventListener);
      unlisten = () => {
        el.removeEventListener("touchmove", move as EventListener);
        el.removeEventListener("touchend", up as EventListener);
        el.removeEventListener("touchcancel", cancel as EventListener);
        unlisten = null;
      };
    };
    const move = (e: TouchEvent) => {
      if (!start) return;
      const touch = e.touches[0];
      const dx = touch.clientX - start.x,
        dy = touch.clientY - start.y;
      if (!dragging) {
        if (Math.abs(dx) < DECIDE && Math.abs(dy) < DECIDE) return;
        // Up or down, to the right, or a move the browser scrolls with.
        if (Math.abs(dy) * SLANT > Math.abs(dx) || dx > 0 || !e.cancelable) {
          start = null;
          unlisten?.();
          return;
        }
        dragging = true;
        show(start.y);
      }
      e.stopPropagation();
      e.preventDefault();
      const now = performance.now();
      if (now > last.t) velocity = (last.x - touch.clientX) / (now - last.t);
      last = { x: touch.clientX, t: now };
      place(-dx);
    };
    const finish = (commit: boolean, e?: TouchEvent) => {
      if (!start) return;
      const was = start;
      start = null;
      unlisten?.();
      if (!dragging) return;
      dragging = false;
      if (e?.cancelable) e.preventDefault();
      const go = commit && forwardCommits(was.x - last.x, velocity);
      armed = false;
      hide();
      if (go) goForward();
    };
    const up = (e?: TouchEvent) => finish(true, e);
    const cancel = (e?: TouchEvent) => finish(false, e);
    document.addEventListener("touchstart", down, { passive: true });
    return () => {
      unHistory();
      unPref();
      document.removeEventListener("touchstart", down);
      unlisten?.();
      chevron?.remove();
      chevron = null;
    };
  }, []);
}
