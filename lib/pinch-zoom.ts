// The arithmetic of zooming a scrolled surface with two fingers, a trackpad
// pinch (ctrl + wheel, Safari's gesture events) or steps (buttons, keys).
// Pure, for the tests; notebooks and the PDF viewer use it
// (components/notebook/use-pinch-zoom.ts), the picture of an image
// occlusion card (components/study/occlusion-zoom.ts) and the image being
// marked up (components/image-annotator.tsx, lib/image-markup-view.ts) zoom
// inside their frame (the "frame" functions at the end).
//
// A pinch is measured against its start: the factor is the distance of the
// fingers now over their distance when the second one landed – never the
// product of the changes between events (which grows exponentially) and
// never rounded to steps while the fingers move.

export type XY = { x: number; y: number };
export type Rect = { left: number; top: number; width: number; height: number };
export type ZoomLimits = { min: number; max: number };

export const clampZoom = (zoom: number, { min, max }: ZoomLimits) => Math.min(max, Math.max(min, zoom));

export const distance = (a: XY, b: XY) => Math.hypot(a.x - b.x, a.y - b.y);
export const midpoint = (a: XY, b: XY): XY => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

// The scale of a pinch so far (1 while the fingers are too close to measure).
export function pinchFactor(startDistance: number, nowDistance: number) {
  if (!(startDistance >= 8) || !(nowDistance > 0) || !Number.isFinite(nowDistance)) return 1;
  return nowDistance / startDistance;
}

// `factor` as far as the limits allow, starting from `zoom`.
export const boundedFactor = (zoom: number, factor: number, limits: ZoomLimits) => clampZoom(zoom * factor, limits) / zoom;

// One ctrl + wheel event (a trackpad pinch in Chrome, Edge and Firefox, or
// ctrl + mouse wheel) as a factor: smooth for the small deltas of a trackpad,
// a moderate step for a mouse wheel notch.
export function wheelFactor(deltaY: number, deltaMode = 0) {
  const pixels = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  return Math.exp(-Math.max(-60, Math.min(60, pixels)) * 0.01);
}

// The zoom a button or key goes to: the next step of `step` above or below,
// from wherever a pinch left it (1.13 → 1.25 or 1).
export function stepZoom(zoom: number, direction: 1 | -1, step: number, limits: ZoomLimits) {
  const steps = zoom / step;
  const next = direction > 0 ? Math.floor(steps + 1e-6) + 1 : Math.ceil(steps - 1e-6) - 1;
  return clampZoom(Math.round(next * step * 1000) / 1000, limits);
}

// The zoom kept at the end of a gesture (two decimals, within the limits).
export const settleZoom = (zoom: number, limits: ZoomLimits) => clampZoom(Math.round(zoom * 100) / 100, limits);

// While the fingers move the content is only drawn scaled (CSS transform,
// origin at its top left), which is smooth; the layout follows at the end.
// `local` is the point under the fingers at the start, in the content's own
// pixels; `origin` where the content's top left is on the screen now
// (without the transform); `to` where the fingers are now. Gives the
// translation that keeps `local` under the fingers at scale `k` – zoom
// anchored at the pinch midpoint, and moving the fingers pans.
export function pinchTranslate(local: XY, origin: XY, to: XY, k: number): XY {
  return { x: to.x - origin.x - k * local.x, y: to.y - origin.y - k * local.y };
}

// Where `point` lies in `rect`, as fractions of its size (outside: below 0
// or above 1). The anchor is kept relative to a sheet, so it survives the
// relayout – gaps and padding do not scale with the zoom.
export function fractionIn(rect: Rect, point: XY): XY {
  return { x: (point.x - rect.left) / (rect.width || 1), y: (point.y - rect.top) / (rect.height || 1) };
}

// How far to scroll so the point at `fraction` of `rect` (as laid out after
// the zoom) comes to lie under `to`.
export function anchorScroll(rect: Rect, fraction: XY, to: XY): XY {
  return { x: rect.left + fraction.x * rect.width - to.x, y: rect.top + fraction.y * rect.height - to.y };
}

// The element among `rects` the anchor is kept to: the one under `point`,
// else the one nearest to it vertically (between two sheets). -1 for none.
export function anchorIndex(rects: Rect[], point: XY) {
  let best = -1;
  let gap = Infinity;
  rects.forEach((rect, index) => {
    const d = point.y < rect.top ? rect.top - point.y : point.y > rect.top + rect.height ? point.y - rect.top - rect.height : 0;
    if (d < gap) {
      gap = d;
      best = index;
    }
  });
  return best;
}

// ---- Zooming inside a frame (no scrolling) ----
// The content of a fixed frame is drawn scaled by `scale` from its top left
// and moved by `pan` (CSS translate, then scale). It always covers the
// frame: at 1 it sits exactly in it, zoomed in it cannot be pulled away
// from an edge.
export type FrameView = { scale: number; pan: XY };
export type Size = { width: number; height: number };
export const FRAME_VIEW: FrameView = { scale: 1, pan: { x: 0, y: 0 } };

export function clampPan(pan: XY, scale: number, size: Size): XY {
  const clamp = (value: number, span: number) => Math.min(0, Math.max(span * (1 - scale), value));
  return { x: clamp(pan.x, size.width), y: clamp(pan.y, size.height) };
}
// A pinch from `start` (the view and the fingers' midpoint when the second
// finger landed, in the frame's pixels) to the midpoint `mid` now, scaled by
// `factor` (pinchFactor): the point that was under the fingers stays under
// them, moving the fingers pans.
export function framePinch(start: FrameView & { mid: XY }, mid: XY, factor: number, limits: ZoomLimits, size: Size): FrameView {
  const scale = clampZoom(start.scale * factor, limits);
  const local = { x: (start.mid.x - start.pan.x) / start.scale, y: (start.mid.y - start.pan.y) / start.scale };
  return { scale, pan: clampPan(pinchTranslate(local, { x: 0, y: 0 }, mid, scale), scale, size) };
}
// Zooming by `factor` with `at` (frame pixels) kept in place: a wheel
// notch, a key or a button.
export const frameZoom = (view: FrameView, at: XY, factor: number, limits: ZoomLimits, size: Size): FrameView =>
  framePinch({ ...view, mid: at }, at, factor, limits, size);
// A point of the frame (its pixels) in the content's own pixels, and back.
export const toContent = (view: FrameView, p: XY): XY => ({ x: (p.x - view.pan.x) / view.scale, y: (p.y - view.pan.y) / view.scale });
export const toFrame = (view: FrameView, p: XY): XY => ({ x: p.x * view.scale + view.pan.x, y: p.y * view.scale + view.pan.y });
// The same part of the content in a frame of another size (the window was
// resized).
export function resizeView(view: FrameView, from: Size, to: Size): FrameView {
  if (!from.width || !from.height) return FRAME_VIEW;
  const pan = { x: (view.pan.x * to.width) / from.width, y: (view.pan.y * to.height) / from.height };
  return { scale: view.scale, pan: clampPan(pan, view.scale, to) };
}
// One finger moving a zoomed picture by `delta` from where it started.
export const framePan = (start: FrameView, delta: XY, size: Size): FrameView => ({
  scale: start.scale,
  pan: clampPan({ x: start.pan.x + delta.x, y: start.pan.y + delta.y }, start.scale, size),
});
// The view kept when the fingers leave: hardly zoomed is not zoomed.
export function settleView(view: FrameView, limits: ZoomLimits): FrameView {
  return view.scale < 1.05 ? FRAME_VIEW : { scale: clampZoom(view.scale, limits), pan: view.pan };
}
// A second tap close to the first in time and place.
export type Tap = { at: number; x: number; y: number };
export const isDoubleTap = (previous: Tap | null, now: Tap, ms = 320, near = 30) =>
  !!previous && now.at - previous.at <= ms && Math.hypot(now.x - previous.x, now.y - previous.y) <= near;
