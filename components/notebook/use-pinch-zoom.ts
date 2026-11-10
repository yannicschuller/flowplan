"use client";
// Pinch to zoom the sheets of a notebook (lib/pinch-zoom.ts for the
// arithmetic): two fingers on a tablet or phone (touch events, also while
// fingers draw), a trackpad pinch (ctrl + wheel; Safari's gesture events on
// the Mac). The sheets follow the fingers smoothly – drawn scaled while the
// gesture runs, laid out at the new zoom at its end – anchored at the pinch
// midpoint; moving both fingers pans. The pen is left alone: touches while
// it writes are the palm (lib/stylus.ts), and the Apple Pencil never starts
// a pinch.
import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import {
  anchorIndex,
  anchorScroll,
  boundedFactor,
  distance,
  fractionIn,
  midpoint,
  pinchFactor,
  pinchTranslate,
  settleZoom,
  wheelFactor,
  type XY,
  type ZoomLimits,
} from "@/lib/pinch-zoom";
import { palmLikely } from "@/lib/stylus";

type Pinch = {
  kind: "touch" | "wheel" | "gesture";
  zoom: number;
  k: number;
  // The point under the fingers at the start, in the content's pixels.
  local: XY;
  origin: XY;
  scroll: XY;
  // The sheet the anchor is kept to, and where in it.
  sheet: HTMLElement | null;
  fraction: XY;
  to: XY;
  touches?: [number, number];
  distance?: number;
  wheel?: number;
};

const WHEEL_END_MS = 160;
// Touches on these do not pinch the sheets (text being typed, menus).
const OWN_GESTURES = "input, textarea, select, [contenteditable=true], .ink-ui, .ink-menu";

export function usePinchZoom({
  scroller,
  content,
  sheetSelector,
  zoom,
  setZoom,
  limits,
}: {
  scroller: RefObject<HTMLElement | null>;
  content: RefObject<HTMLElement | null>;
  sheetSelector: string;
  zoom: number;
  setZoom: (zoom: number) => void;
  limits: ZoomLimits;
}) {
  const pinch = useRef<Pinch | null>(null);
  // A gesture that ended, waiting for the layout at its zoom.
  const settle = useRef<{ sheet: HTMLElement | null; fraction: XY; to: XY } | null>(null);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const limitsRef = useRef(limits);
  limitsRef.current = limits;
  const setZoomRef = useRef(setZoom);
  setZoomRef.current = setZoom;

  const clear = useCallback(() => {
    const el = content.current;
    if (!el) return;
    el.style.transform = "";
    el.style.transformOrigin = "";
    el.style.willChange = "";
  }, [content]);
  // Puts the anchored point of the sheet back under the fingers.
  const anchor = useCallback(() => {
    const target = settle.current;
    settle.current = null;
    clear();
    const box = scroller.current;
    if (!target?.sheet || !box || !target.sheet.isConnected) return;
    const d = anchorScroll(target.sheet.getBoundingClientRect(), target.fraction, target.to);
    box.scrollBy({ left: d.x, top: d.y, behavior: "instant" as ScrollBehavior });
  }, [clear, scroller]);
  // The new layout is in place: scroll it under the fingers, before paint.
  useLayoutEffect(() => {
    if (settle.current) anchor();
  }, [zoom, anchor]);

  useEffect(() => {
    const box = scroller.current;
    if (!box) return;
    const begin = (kind: Pinch["kind"], at: XY): Pinch | null => {
      const el = content.current;
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      const sheets = [...el.querySelectorAll<HTMLElement>(sheetSelector)];
      const index = anchorIndex(
        sheets.map((s) => s.getBoundingClientRect()),
        at,
      );
      const sheet = index >= 0 ? sheets[index] : null;
      el.style.transformOrigin = "0 0";
      el.style.willChange = "transform";
      return {
        kind,
        zoom: zoomRef.current,
        k: 1,
        local: { x: at.x - rect.left, y: at.y - rect.top },
        origin: { x: rect.left, y: rect.top },
        scroll: { x: box.scrollLeft, y: box.scrollTop },
        sheet,
        fraction: sheet ? fractionIn(sheet.getBoundingClientRect(), at) : { x: 0, y: 0 },
        to: at,
      };
    };
    const update = (g: Pinch, to: XY, factor: number) => {
      const el = content.current;
      if (!el) return;
      g.k = boundedFactor(g.zoom, factor, limitsRef.current);
      g.to = to;
      // A scroll the browser still runs (it began before the second finger) moves the content as well.
      const origin = { x: g.origin.x - (box.scrollLeft - g.scroll.x), y: g.origin.y - (box.scrollTop - g.scroll.y) };
      const t = pinchTranslate(g.local, origin, to, g.k);
      el.style.transform = `translate(${t.x}px, ${t.y}px) scale(${g.k})`;
    };
    const end = () => {
      const g = pinch.current;
      pinch.current = null;
      if (!g) return;
      const next = settleZoom(g.zoom * g.k, limitsRef.current);
      settle.current = { sheet: g.sheet, fraction: g.fraction, to: g.to };
      if (next !== zoomRef.current) setZoomRef.current(next);
      // Only panned: the layout stays, the scroll takes over the transform.
      else anchor();
    };

    // ---- Two fingers ----
    const point = (touch: Touch): XY => ({ x: touch.clientX, y: touch.clientY });
    const stylus = (list: TouchList) => [...list].some((touch) => (touch as Touch & { touchType?: string }).touchType === "stylus");
    const find = (list: TouchList, id: number) => [...list].find((touch) => touch.identifier === id);
    // Fingers on the screen: Safari's gesture events then only get stopped.
    let touching = 0;
    const onTouchStart = (event: TouchEvent) => {
      touching = event.touches.length;
      if (pinch.current || event.touches.length !== 2) return;
      if (stylus(event.touches) || palmLikely({ pointerType: "touch" })) return;
      if ([...event.touches].some((touch) => (touch.target as Element | null)?.closest?.(OWN_GESTURES))) return;
      const [a, b] = [...event.touches];
      const g = begin("touch", midpoint(point(a), point(b)));
      if (!g) return;
      g.touches = [a.identifier, b.identifier];
      g.distance = distance(point(a), point(b));
      pinch.current = g;
      if (event.cancelable) event.preventDefault();
    };
    const onTouchMove = (event: TouchEvent) => {
      const g = pinch.current;
      if (g?.kind !== "touch" || !g.touches) return;
      if (event.cancelable) event.preventDefault();
      const a = find(event.touches, g.touches[0]);
      const b = find(event.touches, g.touches[1]);
      if (!a || !b) return end();
      update(g, midpoint(point(a), point(b)), pinchFactor(g.distance!, distance(point(a), point(b))));
    };
    const onTouchEnd = (event: TouchEvent) => {
      touching = event.touches.length;
      const g = pinch.current;
      if (g?.kind !== "touch" || !g.touches) return;
      if (!find(event.touches, g.touches[0]) || !find(event.touches, g.touches[1])) end();
    };

    // ---- Trackpad: ctrl + wheel (Chrome, Edge, Firefox) ----
    let wheelTimer: ReturnType<typeof setTimeout> | undefined;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey || (pinch.current && pinch.current.kind !== "wheel")) return;
      event.preventDefault();
      const at = { x: event.clientX, y: event.clientY };
      const g = pinch.current ?? (pinch.current = begin("wheel", at));
      if (!g) return;
      g.wheel = (g.wheel ?? 1) * wheelFactor(event.deltaY, event.deltaMode);
      // The product stays within the limits: zooming back starts at once.
      g.wheel = boundedFactor(g.zoom, g.wheel, limitsRef.current);
      update(g, at, g.wheel);
      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(end, WHEEL_END_MS);
    };

    // ---- Safari: gesture events (trackpad on the Mac; on iOS the page itself
    // would zoom – the touches above do the work there). `scale` counts from
    // the start of the gesture. ----
    type GestureEvent = UIEvent & { scale: number; clientX: number; clientY: number };
    const onGestureStart = (event: Event) => {
      event.preventDefault();
      if (pinch.current || touching) return;
      const e = event as GestureEvent;
      pinch.current = begin("gesture", { x: e.clientX, y: e.clientY });
    };
    const onGestureChange = (event: Event) => {
      event.preventDefault();
      const g = pinch.current;
      const e = event as GestureEvent;
      if (g?.kind === "gesture") update(g, g.to, e.scale || 1);
    };
    const onGestureEnd = (event: Event) => {
      event.preventDefault();
      if (pinch.current?.kind === "gesture") end();
    };

    const active = { passive: false } as const;
    box.addEventListener("touchstart", onTouchStart, active);
    box.addEventListener("touchmove", onTouchMove, active);
    box.addEventListener("touchend", onTouchEnd);
    box.addEventListener("touchcancel", onTouchEnd);
    box.addEventListener("wheel", onWheel, active);
    box.addEventListener("gesturestart", onGestureStart, active);
    box.addEventListener("gesturechange", onGestureChange, active);
    box.addEventListener("gestureend", onGestureEnd, active);
    return () => {
      clearTimeout(wheelTimer);
      box.removeEventListener("touchstart", onTouchStart);
      box.removeEventListener("touchmove", onTouchMove);
      box.removeEventListener("touchend", onTouchEnd);
      box.removeEventListener("touchcancel", onTouchEnd);
      box.removeEventListener("wheel", onWheel);
      box.removeEventListener("gesturestart", onGestureStart);
      box.removeEventListener("gesturechange", onGestureChange);
      box.removeEventListener("gestureend", onGestureEnd);
      pinch.current = null;
      clear();
    };
  }, [anchor, clear, content, scroller, sheetSelector]);
}
