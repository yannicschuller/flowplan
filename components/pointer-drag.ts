// Dragging with pointer events instead of the browser's drag and drop
// (#100): during a native drag the browser owns the cursor (Safari shows the
// arrow instead of the closed hand) and touch screens cannot start one. Used
// for every database drag: table, list and feed rows, board and gallery
// cards, board columns, table columns, view tabs, sprint and calendar
// entries. Files dragged in from the desktop stay with the browser.
//
// A press becomes a drag once the pointer has moved a few pixels, so clicks
// still open records; by touch once a finger has rested on the handle for a
// moment (LONG_PRESS_MS), so swipes keep scrolling the table (#98). While it
// runs, the cursor is the closed hand everywhere (html.pointer-dragging), a
// light copy of the dragged element follows the pointer, the container and
// the window scroll near their edges, and Escape puts everything back. The
// caller hit-tests the element under the pointer and shows its own drop
// hints; the arithmetic is in lib/pointer-drag.ts.
import { useCallback, useEffect, useRef } from "react";
import {
  autoScrollStep,
  LONG_PRESS_MS,
  MOUSE_THRESHOLD,
  pastThreshold,
  SCROLL_EDGE,
  TOUCH_SLOP,
  TOUCH_THRESHOLD,
  towards,
  type Rect,
} from "@/lib/pointer-drag";

// A record dragged from a database onto a database in the sidebar moves
// there (with Alt held, a copy): components/database-view.tsx sends these,
// components/workspace-app.tsx highlights the page and moves the record.
export const RECORD_OVER_EVENT = "flowplan:record-over";
export const RECORD_DROP_EVENT = "flowplan:record-drop";
export type RecordOverDetail = { targetPageId: string | null };
export type RecordDropDetail = {
  pageId: string;
  rowId: string;
  targetPageId: string;
  copy: boolean;
};

export type DragPoint = {
  x: number;
  y: number;
  /** The element under the pointer (the preview lets it through). */
  target: Element | null;
  altKey: boolean;
  pointerType: string;
};

export type PointerDragOptions = {
  /** Mouse and pen: pixels before the drag starts. */
  threshold?: number;
  /**
   * Touch: "hold" waits for a long press (the handle may scroll), "move"
   * starts on movement (a handle with `touch-action: none`), "none" leaves
   * touches alone.
   */
  touch?: "hold" | "move" | "none";
  /** The element whose copy follows the pointer; none without. */
  preview?: HTMLElement | null;
  /** Marked with data-drag-source while dragged (faded by CSS). */
  source?: HTMLElement | null;
  /** Return false to refuse the drag after all. */
  onStart?: (point: DragPoint) => boolean | void;
  onMove?: (point: DragPoint) => void;
  onDrop: (point: DragPoint) => void;
  onCancel?: () => void;
};

type Press = {
  pointerId: number;
  pointerType: string;
  clientX: number;
  clientY: number;
  button: number;
  altKey: boolean;
  currentTarget: EventTarget | null;
};

// More than one drag may want the cursor (a timeline bar and its page).
let cursorHolds = 0;
/** The closed hand everywhere while something is dragged. */
export function dragCursor(on: boolean) {
  cursorHolds = Math.max(0, cursorHolds + (on ? 1 : -1));
  document.documentElement.classList.toggle("pointer-dragging", cursorHolds > 0);
}

// The click the browser sends after a drag ends (to the handle, the card or
// whatever is under the pointer) is not a click.
function swallowClick() {
  const swallow = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    done();
  };
  const done = () => {
    window.removeEventListener("click", swallow, true);
    window.clearTimeout(timer);
  };
  window.addEventListener("click", swallow, true);
  const timer = window.setTimeout(done, 400);
}

function scrollable(el: Element, axis: "x" | "y") {
  const style = getComputedStyle(el);
  const overflow = axis === "x" ? style.overflowX : style.overflowY;
  return (
    /(auto|scroll)/.test(overflow) &&
    (axis === "x" ? el.scrollWidth > el.clientWidth + 1 : el.scrollHeight > el.clientHeight + 1)
  );
}
// The boxes that scroll near their edges, per axis: the ancestors of the
// dragged element that scroll that way, innermost first, then the page.
function scrollers(from: Element | null) {
  const list = { x: [] as HTMLElement[], y: [] as HTMLElement[] };
  for (let el = from?.parentElement; el && el !== document.body; el = el.parentElement)
    for (const axis of ["x", "y"] as const) if (scrollable(el, axis)) list[axis].push(el);
  const page = document.scrollingElement as HTMLElement | null;
  if (page) {
    const style = getComputedStyle(page);
    if (!list.x.includes(page) && style.overflowX !== "hidden" && page.scrollWidth > page.clientWidth + 1)
      list.x.push(page);
    if (!list.y.includes(page) && style.overflowY !== "hidden" && page.scrollHeight > page.clientHeight + 1)
      list.y.push(page);
  }
  return list;
}
const viewport = (): Rect => ({
  left: 0,
  top: 0,
  right: window.innerWidth,
  bottom: window.innerHeight,
});
function boxOf(el: HTMLElement): Rect {
  if (el === document.scrollingElement) return viewport();
  const r = el.getBoundingClientRect(),
    v = viewport();
  return {
    left: Math.max(r.left, v.left),
    top: Math.max(r.top, v.top),
    right: Math.min(r.right, v.right),
    bottom: Math.min(r.bottom, v.bottom),
  };
}

// The copy that follows the pointer. A table row (or cell) cannot stand on
// its own, so it gets a table of its own with the same columns; the copy is
// cut to the part of the element that is visible in its sideways scroller.
const KEPT_STYLES = [
  "display",
  "flex-direction",
  "align-items",
  "justify-content",
  "gap",
  "padding",
  "font",
  "color",
  "background-color",
  "border",
  "border-radius",
  "text-align",
  "white-space",
] as const;
function faceOf(el: HTMLElement) {
  const strip = (node: HTMLElement) => {
    for (const name of ["id", "data-drag-source", "data-drag-pressing"]) {
      node.removeAttribute(name);
      node.querySelectorAll(`[${name}]`).forEach((n) => n.removeAttribute(name));
    }
    node.querySelectorAll("input, button, select, textarea, a").forEach((n) => n.setAttribute("tabindex", "-1"));
    return node;
  };
  if (el instanceof HTMLTableRowElement) {
    const table = el.closest("table");
    const copy = document.createElement("table");
    copy.className = table?.className || "";
    copy.style.width = `${table?.getBoundingClientRect().width || el.getBoundingClientRect().width}px`;
    copy.style.margin = "0";
    const columns = table?.querySelector(":scope > colgroup");
    if (columns) copy.appendChild(columns.cloneNode(true));
    const body = document.createElement("tbody");
    body.appendChild(strip(el.cloneNode(true) as HTMLElement));
    copy.appendChild(body);
    return copy;
  }
  const face = strip(el.cloneNode(true) as HTMLElement);
  // Out of its place the copy loses the styles of its ancestors' rules.
  const style = getComputedStyle(el);
  for (const name of KEPT_STYLES) face.style.setProperty(name, style.getPropertyValue(name));
  if (el instanceof HTMLTableCellElement) face.style.display = "block";
  face.style.margin = "0";
  face.style.boxSizing = "border-box";
  return face;
}
function makePreview(el: HTMLElement, x: number, y: number) {
  const rect = el.getBoundingClientRect();
  const clip = { left: rect.left, right: rect.right };
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    if (getComputedStyle(p).overflowX === "visible") continue;
    const box = p.getBoundingClientRect();
    clip.left = Math.max(clip.left, box.left);
    clip.right = Math.min(clip.right, box.right);
  }
  clip.left = Math.max(clip.left, 0);
  clip.right = Math.min(clip.right, window.innerWidth);
  if (clip.right - clip.left < 40) {
    clip.left = rect.left;
    clip.right = rect.right;
  }
  const preview = document.createElement("div");
  preview.className = "pointer-drag-preview";
  preview.setAttribute("aria-hidden", "true");
  preview.setAttribute("inert", "");
  const height = Math.min(rect.height, window.innerHeight * 0.5);
  preview.style.width = `${clip.right - clip.left}px`;
  preview.style.height = `${height}px`;
  const lift = document.createElement("div");
  lift.className = "pointer-drag-lift";
  const face = faceOf(el);
  face.classList.add("pointer-drag-face");
  // The lift takes the element's rounding (a card's, none for a row).
  const radius = getComputedStyle(el).borderRadius;
  if (radius && radius !== "0px") lift.style.borderRadius = radius;
  face.style.position = "absolute";
  face.style.left = `${rect.left - clip.left}px`;
  face.style.top = "0";
  face.style.width = `${rect.width}px`;
  if (!(el instanceof HTMLTableRowElement)) face.style.height = `${rect.height}px`;
  lift.appendChild(face);
  preview.appendChild(lift);
  document.body.appendChild(preview);
  const origin = { left: clip.left, top: rect.top };
  const place = (px: number, py: number) => {
    preview.style.transform = `translate3d(${origin.left + px - x}px, ${origin.top + py - y}px, 0)`;
  };
  place(x, y);
  return { place, remove: () => preview.remove() };
}

/**
 * Starts watching a press (call from onPointerDown). Returns a function that
 * stops it quietly (unmount), or null when the press is not one to drag.
 */
export function startPointerDrag(
  event: Press,
  options: PointerDragOptions,
): (() => void) | null {
  const touch = event.pointerType === "touch";
  const mode = touch ? options.touch ?? "hold" : "move";
  if (mode === "none") return null;
  if (event.pointerType === "mouse" && event.button !== 0) return null;
  const handle = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  const pointerId = event.pointerId,
    x0 = event.clientX,
    y0 = event.clientY;
  const threshold = touch ? TOUCH_THRESHOLD : (options.threshold ?? MOUSE_THRESHOLD);
  let state: "pending" | "active" | "done" = "pending";
  let point: DragPoint = {
    x: x0,
    y: y0,
    target: null,
    altKey: event.altKey,
    pointerType: event.pointerType,
  };
  let preview: Awaited<ReturnType<typeof makePreview>> | null = null;
  let frame = 0;
  let boxes: Awaited<ReturnType<typeof scrollers>> = { x: [], y: [] };
  let timer = 0;
  let roamed = false;

  const hit = () => {
    point = { ...point, target: document.elementFromPoint(point.x, point.y) };
    return point;
  };
  const cleanup = () => {
    state = "done";
    window.clearTimeout(timer);
    cancelAnimationFrame(frame);
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", cancelled, true);
    window.removeEventListener("keydown", key, true);
    window.removeEventListener("touchmove", touchMove, true);
    window.removeEventListener("contextmenu", menu, true);
    window.removeEventListener("dragstart", nativeDrag, true);
    window.removeEventListener("blur", blur);
    window.removeEventListener("scroll", scrolled, true);
    handle?.removeAttribute("data-drag-pressing");
    options.source?.removeAttribute("data-drag-source");
    preview?.remove();
    preview = null;
  };
  const stop = () => {
    const was = state;
    cleanup();
    if (was === "active") dragCursor(false);
  };
  // Near an edge the innermost box that can still scroll that way scrolls.
  const autoScroll = () => {
    frame = 0;
    if (state !== "active") return;
    // Not before the pointer has moved: a record lifted near an edge (by a
    // long press) stays where it is until the finger goes somewhere.
    if (!roamed) {
      frame = requestAnimationFrame(autoScroll);
      return;
    }
    let moved = false;
    for (const axis of ["x", "y"] as const) {
      // The innermost box the pointer is over (or just beyond the edge of)
      // scrolls; once it is at its end, the page behind does not take over.
      const el = boxes[axis].find((candidate) => {
        if (candidate === document.scrollingElement) return true;
        const box = boxOf(candidate);
        return !(
          point.x < box.left - SCROLL_EDGE ||
          point.x > box.right + SCROLL_EDGE ||
          point.y < box.top - SCROLL_EDGE ||
          point.y > box.bottom + SCROLL_EDGE
        );
      });
      if (!el) continue;
      const step = autoScrollStep(boxOf(el), point.x, point.y)[axis];
      // Only towards where the pointer went: a drag that starts near the
      // top does not scroll up while it moves sideways.
      if (!step || !towards(step, axis === "x" ? point.x - x0 : point.y - y0)) continue;
      const key = axis === "x" ? "scrollLeft" : "scrollTop";
      const before = el[key];
      el[key] = before + step;
      if (el[key] !== before) moved = true;
    }
    if (moved) options.onMove?.(hit());
    frame = requestAnimationFrame(autoScroll);
  };
  const activate = () => {
    if (state !== "pending") return;
    if (options.onStart?.(hit()) === false) return stop();
    state = "active";
    handle?.removeAttribute("data-drag-pressing");
    dragCursor(true);
    window.getSelection()?.removeAllRanges();
    if (options.preview) preview = makePreview(options.preview, x0, y0);
    options.source?.setAttribute("data-drag-source", "");
    preview?.place(point.x, point.y);
    if (touch && mode === "hold") {
      try {
        navigator.vibrate?.(8);
      } catch {}
    }
    boxes = scrollers(options.preview || options.source || handle);
    frame = requestAnimationFrame(autoScroll);
    options.onMove?.(hit());
  };
  const move = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return;
    point = { ...point, x: ev.clientX, y: ev.clientY, altKey: ev.altKey };
    if (state === "pending") {
      const far = pastThreshold(ev.clientX - x0, ev.clientY - y0, mode === "hold" ? TOUCH_SLOP : threshold);
      // A finger that moves before the hold is over scrolls.
      if (mode === "hold") {
        if (far) stop();
        return;
      }
      if (!far) return;
      activate();
      // onStart may have refused it.
      if ((state as string) !== "active") return;
    }
    if (ev.cancelable) ev.preventDefault();
    if (!roamed) roamed = pastThreshold(point.x - x0, point.y - y0, TOUCH_SLOP * 2);
    preview?.place(point.x, point.y);
    options.onMove?.(hit());
  };
  const up = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return;
    if (state !== "active") return stop();
    point = { ...point, x: ev.clientX, y: ev.clientY, altKey: ev.altKey };
    hit();
    stop();
    swallowClick();
    options.onDrop(point);
  };
  const cancel = () => {
    if (state !== "active") return stop();
    stop();
    swallowClick();
    options.onCancel?.();
  };
  const cancelled = (ev: PointerEvent) => {
    if (ev.pointerId === pointerId) cancel();
  };
  const key = (ev: KeyboardEvent) => {
    if (ev.key !== "Escape") {
      if (state === "active") point = { ...point, altKey: ev.altKey };
      return;
    }
    if (state === "active") {
      ev.preventDefault();
      ev.stopPropagation();
    }
    cancel();
  };
  // While a finger drags, it does not scroll the page.
  const touchMove = (ev: TouchEvent) => {
    if (state === "active" && ev.cancelable) ev.preventDefault();
  };
  // A held finger brings up no context menu.
  const menu = (ev: Event) => {
    if (touch || state === "active") ev.preventDefault();
  };
  // Images and links in a card would start the browser's own drag.
  const nativeDrag = (ev: DragEvent) => {
    const from = ev.target as Node | null;
    if (from && (options.source?.contains(from) || handle?.contains(from))) ev.preventDefault();
  };
  const blur = () => cancel();
  const scrolled = () => {
    if (state === "active") options.onMove?.(hit());
  };

  window.addEventListener("pointermove", move, { capture: true, passive: false });
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", cancelled, true);
  window.addEventListener("keydown", key, true);
  window.addEventListener("touchmove", touchMove, { capture: true, passive: false });
  window.addEventListener("contextmenu", menu, true);
  window.addEventListener("dragstart", nativeDrag, true);
  window.addEventListener("blur", blur);
  window.addEventListener("scroll", scrolled, { capture: true, passive: true });
  if (mode === "hold") {
    handle?.setAttribute("data-drag-pressing", "");
    timer = window.setTimeout(activate, LONG_PRESS_MS);
  }
  return stop;
}

/**
 * startPointerDrag for a component: one drag at a time, stopped when the
 * component goes away.
 */
export function usePointerDrag() {
  const current = useRef<(() => void) | null>(null);
  useEffect(() => () => current.current?.(), []);
  return useCallback((event: Press, options: PointerDragOptions) => {
    current.current?.();
    current.current = startPointerDrag(event, options);
    return current.current;
  }, []);
}
