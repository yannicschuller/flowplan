"use client";
// The gesture of a sheet dragged down to close it (components/sheet-drag.ts
// loads it when a sheet opens; lib/sheet-drag.ts has the arithmetic).
import { backdropOpacity, dragOffset, releaseVelocity, settleDuration, shouldDismiss, type Sample } from "@/lib/sheet-drag";
import { SHEET_HANDLE, type SheetDragOptions } from "./sheet-drag";

// Elements in which a drag means something else (selecting text, sliders,
// horizontal lists).
const OWN_GESTURES = 'textarea, [contenteditable="true"], input[type="range"], canvas, [data-sheet-no-drag]';
// iOS' sheet curve: quick start, long soft landing.
const SPRING = "cubic-bezier(0.32, 0.72, 0, 1)";
const LEAVE = "cubic-bezier(0.2, 0.7, 0.4, 1)";

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function scrollerOf(target: Element, sheet: HTMLElement): HTMLElement | null {
  for (let el: Element | null = target; el; el = el.parentElement) {
    if (el instanceof HTMLElement) {
      const style = getComputedStyle(el);
      if (/(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1) return el;
    }
    if (el === sheet) break;
  }
  return null;
}

// The vertical translation the sheet shows right now (also mid-transition).
function currentOffset(el: HTMLElement): number {
  const transform = getComputedStyle(el).transform;
  if (!transform || transform === "none") return 0;
  try {
    return new DOMMatrixReadOnly(transform).m42;
  } catch {
    return 0;
  }
}

// Attaches the gesture to a sheet; returns the detach.
export function attachSheetDrag(sheet: HTMLElement, options: () => SheetDragOptions): () => void {
  type State = "idle" | "pending" | "dragging" | "settling" | "leaving";
  let state: State = "idle",
    startX = 0,
    startY = 0,
    base = 0,
    offset = 0,
    fromHandle = false,
    scroller: HTMLElement | null = null,
    samples: Sample[] = [],
    pointerId: number | null = null,
    timer: ReturnType<typeof setTimeout> | null = null,
    suppressClick = 0;
  sheet.setAttribute("data-sheet-drag", "");

  const presented = () => {
    const media = options().media;
    return !media || (typeof matchMedia === "function" && matchMedia(media).matches);
  };
  const apply = (y: number, transition = "") => {
    sheet.style.transition = transition;
    sheet.style.transform = y ? `translate3d(0, ${y}px, 0)` : "";
    const backdrop = options().backdrop?.();
    if (backdrop) {
      backdrop.style.transition = transition.replace(/transform/g, "opacity");
      const opacity = backdropOpacity(y, sheet.offsetHeight);
      backdrop.style.opacity = opacity < 1 ? String(opacity) : "";
    }
  };
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    sheet.style.transition = "";
    sheet.style.transform = "";
    sheet.removeAttribute("data-sheet-dragging");
    const backdrop = options().backdrop?.();
    if (backdrop) {
      backdrop.style.transition = "";
      backdrop.style.opacity = "";
    }
  };
  // Runs `done` when the transition ends (or would have).
  const after = (ms: number, done: () => void) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      done();
    }, ms + 40);
  };
  const springBack = (velocity: number) => {
    const ms = settleDuration(offset, velocity, reducedMotion());
    sheet.removeAttribute("data-sheet-dragging");
    if (!ms || !offset) {
      state = "idle";
      clear();
      return;
    }
    state = "settling";
    apply(0, `transform ${ms}ms ${SPRING}`);
    after(ms, () => {
      if (state === "settling") {
        state = "idle";
        clear();
      }
    });
  };
  const dismiss = (velocity: number) => {
    const distance = Math.max(sheet.offsetHeight, 1) + 24;
    const ms = settleDuration(distance - offset, Math.max(velocity, 0), reducedMotion());
    state = "leaving";
    const close = () => {
      options().onDismiss();
      // A dialog that stays (busy, unsaved changes) comes back up.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (state !== "leaving") return;
          if (sheet.isConnected && sheet.getAttribute("data-state") !== "closed" && !sheet.closest("[hidden]")) {
            offset = distance;
            springBack(0);
          } else {
            state = "idle";
            clear();
          }
        }),
      );
    };
    if (!ms) return close();
    apply(distance, `transform ${ms}ms ${LEAVE}`);
    after(ms, close);
  };

  const begin = (x: number, y: number, target: Element) => {
    if (state === "leaving" || !presented()) return false;
    fromHandle = !!target.closest(`.${SHEET_HANDLE}`);
    if (!fromHandle && target.closest(OWN_GESTURES)) return false;
    startX = x;
    startY = y;
    samples = [{ t: performance.now(), y }];
    scroller = scrollerOf(target, sheet);
    if (state === "settling") {
      // Caught on its way back: it follows the finger from where it is.
      if (timer) clearTimeout(timer);
      timer = null;
      base = Math.max(0, currentOffset(sheet));
      offset = base;
      apply(base);
      state = "dragging";
      sheet.setAttribute("data-sheet-dragging", "");
      return true;
    }
    base = 0;
    offset = 0;
    state = "pending";
    return true;
  };
  // false: the gesture is not the sheet's (anymore).
  const move = (x: number, y: number) => {
    const dx = x - startX,
      dy = y - startY;
    if (state === "pending") {
      if (!dx && !dy) return true;
      const scrolled = !!scroller && scroller.scrollTop > 0;
      if (Math.abs(dx) > Math.abs(dy) || (!fromHandle && (dy < 0 || scrolled))) {
        state = "idle";
        return false;
      }
      state = "dragging";
      sheet.setAttribute("data-sheet-dragging", "");
    }
    if (state !== "dragging") return false;
    offset = dragOffset(base + dy);
    samples.push({ t: performance.now(), y });
    if (samples.length > 20) samples.splice(0, samples.length - 20);
    apply(offset);
    return true;
  };
  const end = (cancelled: boolean) => {
    if (state === "pending") state = "idle";
    if (state !== "dragging") return;
    // The release ends a drag, not a tap on what lies under the finger.
    if (Math.abs(offset - base) > 4) suppressClick = performance.now();
    // Letting go after a pause is letting go standing still.
    const last = samples[samples.length - 1];
    if (last) samples.push({ t: performance.now(), y: last.y });
    const velocity = releaseVelocity(samples);
    if (!cancelled && shouldDismiss({ offset, velocity, height: sheet.offsetHeight })) dismiss(velocity);
    else springBack(velocity);
  };

  // Touch: the first move decides; once the sheet's, the page does not
  // scroll (or bounce) under it.
  const touchStart = (e: TouchEvent) => {
    if (e.touches.length !== 1) {
      if (state === "dragging") end(true);
      return;
    }
    const touch = e.touches[0];
    begin(touch.clientX, touch.clientY, e.target as Element);
  };
  const touchMove = (e: TouchEvent) => {
    if (state !== "pending" && state !== "dragging") return;
    const touch = e.touches[0];
    if (!touch) return;
    if (state === "dragging" && !e.cancelable) return end(true);
    if (move(touch.clientX, touch.clientY) && state === "dragging" && e.cancelable) e.preventDefault();
  };
  const touchEnd = (e: TouchEvent) => end(e.type === "touchcancel");
  // Mouse and pen: only on the handle (the content keeps selecting text).
  const pointerDown = (e: PointerEvent) => {
    if (e.pointerType === "touch" || e.button !== 0) return;
    const target = e.target as Element;
    if (!target.closest(`.${SHEET_HANDLE}`) || !begin(e.clientX, e.clientY, target)) return;
    pointerId = e.pointerId;
    try {
      sheet.setPointerCapture(e.pointerId);
    } catch {}
  };
  const pointerMove = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    if (move(e.clientX, e.clientY)) e.preventDefault();
  };
  const pointerUp = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    pointerId = null;
    end(e.type === "pointercancel");
  };
  const click = (e: MouseEvent) => {
    if (suppressClick && performance.now() - suppressClick < 400) {
      e.preventDefault();
      e.stopPropagation();
    }
    suppressClick = 0;
  };

  sheet.addEventListener("touchstart", touchStart, { passive: true });
  sheet.addEventListener("touchmove", touchMove, { passive: false });
  sheet.addEventListener("touchend", touchEnd);
  sheet.addEventListener("touchcancel", touchEnd);
  sheet.addEventListener("pointerdown", pointerDown);
  sheet.addEventListener("pointermove", pointerMove);
  sheet.addEventListener("pointerup", pointerUp);
  sheet.addEventListener("pointercancel", pointerUp);
  sheet.addEventListener("click", click, true);
  return () => {
    sheet.removeEventListener("touchstart", touchStart);
    sheet.removeEventListener("touchmove", touchMove);
    sheet.removeEventListener("touchend", touchEnd);
    sheet.removeEventListener("touchcancel", touchEnd);
    sheet.removeEventListener("pointerdown", pointerDown);
    sheet.removeEventListener("pointermove", pointerMove);
    sheet.removeEventListener("pointerup", pointerUp);
    sheet.removeEventListener("pointercancel", pointerUp);
    sheet.removeEventListener("click", click, true);
    sheet.removeAttribute("data-sheet-drag");
    if (timer) clearTimeout(timer);
  };
}

