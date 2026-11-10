// The arithmetic of zooming a scrolled surface with two fingers, a trackpad
// pinch (ctrl + wheel, Safari's gesture events) or steps (buttons, keys).
// Pure, for the tests; the notebook uses it (components/notebook/use-pinch-zoom.ts).
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
