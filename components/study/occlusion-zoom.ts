"use client";
// Two fingers zoom the picture of an image occlusion card in the focus mode
// (#343; lib/pinch-zoom.ts for the arithmetic) – inside its frame, without
// the browser zooming the page – and the card's swipes keep working:
// - one finger swipes the card (rates it), as before, while the picture is
//   not zoomed; a tap reveals;
// - two fingers anywhere on the card zoom, anchored where they pinch, and
//   moving them pans; a swipe that had started is called off;
// - zoomed in, one finger pans the picture instead of swiping; a tap still
//   reveals; a double tap goes back to the whole picture;
// - a new card starts unzoomed.
// The gestures are claimed through `gate`: the card's own pointer handlers
// (components/study/focus-core.tsx) leave a pointer sequence alone once
// `gate.claimed` is set. The listeners run before them – pointerdown on the
// card itself (React handles events at its root, later) and the moves on
// the window in the capture phase (the card captures a swiping pointer).
// Mouse and pen are not touched. The transform is set through the element's
// style object (allowed by the CSP), the frame gets "is-zoomed".
import { useEffect, type RefObject } from "react";
import {
  FRAME_VIEW,
  distance,
  framePan,
  framePinch,
  isDoubleTap,
  midpoint,
  pinchFactor,
  settleView,
  type FrameView,
  type Tap,
  type XY,
  type ZoomLimits,
} from "@/lib/pinch-zoom";

export type ZoomGate = { claimed: boolean };
export const OCCLUSION_ZOOM: ZoomLimits = { min: 1, max: 5 };
// Movement of one finger (screen pixels) before a zoomed picture pans – less
// than the card's 8 px before it starts a swipe.
const PAN_START = 4;
const TAP_MOVE = 10;

export function useOcclusionZoom(frame: RefObject<HTMLElement | null>, content: RefObject<HTMLElement | null>, gate: ZoomGate | undefined, resetKey: string) {
  useEffect(() => {
    const box = frame.current,
      inner = content.current;
    if (!gate || !box || !inner) return;
    // The card is the surface: the second finger may land beside the picture.
    const surface = box.closest<HTMLElement>(".study-card") || box;
    let view: FrameView = FRAME_VIEW;
    const pointers = new Map<number, { start: XY; now: XY }>();
    let pinch: (FrameView & { mid: XY; distance: number }) | null = null;
    let pan: { view: FrameView; from: XY; id: number } | null = null;
    let moved = false;
    let lastTap: Tap | null = null;
    const size = () => ({ width: box.clientWidth, height: box.clientHeight });
    const local = (p: XY) => {
      const rect = box.getBoundingClientRect();
      return { x: p.x - rect.left, y: p.y - rect.top };
    };
    const apply = (next: FrameView, smooth = false) => {
      view = next;
      inner.classList.toggle("is-settling", smooth);
      inner.style.transform = next.scale === 1 && !next.pan.x && !next.pan.y ? "" : `translate(${next.pan.x}px, ${next.pan.y}px) scale(${next.scale})`;
      box.classList.toggle("is-zoomed", next.scale > 1);
    };
    apply(FRAME_VIEW);
    const startPinch = () => {
      const [a, b] = [...pointers.values()].map((p) => p.now);
      pinch = { ...view, mid: local(midpoint(a, b)), distance: distance(a, b) };
      pan = null;
    };
    const startPan = (id: number) => {
      const p = pointers.get(id);
      pan = p ? { view, from: p.now, id } : null;
    };
    const down = (event: PointerEvent) => {
      // A new sequence: the card has it until a gesture claims it.
      if (!pointers.size) {
        gate.claimed = false;
        moved = false;
      }
      if (event.pointerType !== "touch") return;
      pointers.set(event.pointerId, { start: { x: event.clientX, y: event.clientY }, now: { x: event.clientX, y: event.clientY } });
      if (pointers.size === 2) {
        gate.claimed = true;
        startPinch();
      } else if (pointers.size === 1 && view.scale > 1) startPan(event.pointerId);
    };
    const move = (event: PointerEvent) => {
      const p = pointers.get(event.pointerId);
      if (!p) return;
      p.now = { x: event.clientX, y: event.clientY };
      if (Math.hypot(p.now.x - p.start.x, p.now.y - p.start.y) > TAP_MOVE) moved = true;
      if (pinch && pointers.size >= 2) {
        const [a, b] = [...pointers.values()].map((q) => q.now);
        apply(framePinch(pinch, local(midpoint(a, b)), pinchFactor(pinch.distance, distance(a, b)), OCCLUSION_ZOOM, size()));
        event.preventDefault();
        return;
      }
      if (pan && pan.id === event.pointerId) {
        const delta = { x: p.now.x - pan.from.x, y: p.now.y - pan.from.y };
        if (!gate.claimed && Math.hypot(delta.x, delta.y) < PAN_START) return;
        gate.claimed = true;
        apply(framePan(pan.view, delta, size()));
        event.preventDefault();
      }
    };
    const up = (event: PointerEvent) => {
      const p = pointers.get(event.pointerId);
      if (!p) return;
      pointers.delete(event.pointerId);
      if (pinch) {
        if (pointers.size >= 2) startPinch();
        else {
          pinch = null;
          apply(settleView(view, OCCLUSION_ZOOM), true);
          // The finger left on the picture goes on panning it.
          const [rest] = pointers.keys();
          if (rest !== undefined && view.scale > 1) startPan(rest);
        }
        return;
      }
      if (pan?.id === event.pointerId) pan = null;
      if (event.type !== "pointerup" || moved || pointers.size || gate.claimed) return;
      // A tap: twice in a row on a zoomed picture shows all of it again.
      const tap = { at: event.timeStamp, x: event.clientX, y: event.clientY };
      if (isDoubleTap(lastTap, tap) && view.scale > 1) {
        gate.claimed = true;
        apply(FRAME_VIEW, true);
        lastTap = null;
      } else lastTap = tap;
    };
    // Safari zooms the page on two fingers even where pointer events are
    // handled; its touch and gesture events are cancelled on the card.
    const touch = (event: TouchEvent) => {
      if (event.touches.length > 1 || view.scale > 1) event.preventDefault();
    };
    const gesture = (event: Event) => event.preventDefault();
    surface.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move, { capture: true, passive: false });
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    surface.addEventListener("touchmove", touch, { passive: false });
    surface.addEventListener("gesturestart", gesture);
    surface.addEventListener("gesturechange", gesture);
    return () => {
      surface.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
      surface.removeEventListener("touchmove", touch);
      surface.removeEventListener("gesturestart", gesture);
      surface.removeEventListener("gesturechange", gesture);
      gate.claimed = false;
      inner.style.transform = "";
      box.classList.remove("is-zoomed");
    };
  }, [frame, content, gate, resetKey]);
}
