// The lasso's selection: what is picked and what can be done with it –
// moving, scaling (free or keeping the aspect), turning (snapping to 15°),
// stacking order, width and placing new text next to it. Free of React and
// the DOM; all in page units. Works over every item type through
// `itemBounds` and one affine transform per item kind, so new kinds
// (shapes, images) only add their case to `transformItem`.
import { hitItem, itemBounds, unionBox, withShape, type Box } from "./geometry";
import { affineShape } from "./shapes";
import { normalRotation, type InkImage, type InkItem } from "./model";
import { HIGHLIGHTER_WIDTHS, PEN_WIDTHS, TEXT_SIZES } from "./presets";

type XY = { x: number; y: number };
const round2 = (n: number) => Math.round(n * 100) / 100;

// x' = a·x + c·y + e, y' = b·x + d·y + f (as in SVG and PDF).
export type Affine = { a: number; b: number; c: number; d: number; e: number; f: number };
export const IDENTITY: Affine = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
export const translation = (dx: number, dy: number): Affine => ({ ...IDENTITY, e: dx, f: dy });
// First `first`, then `then`.
export function compose(first: Affine, then: Affine): Affine {
  return {
    a: then.a * first.a + then.c * first.b,
    b: then.b * first.a + then.d * first.b,
    c: then.a * first.c + then.c * first.d,
    d: then.b * first.c + then.d * first.d,
    e: then.a * first.e + then.c * first.f + then.e,
    f: then.b * first.e + then.d * first.f + then.f,
  };
}
export const scaling = (sx: number, sy: number, origin: XY): Affine => ({ a: sx, b: 0, c: 0, d: sy, e: origin.x * (1 - sx), f: origin.y * (1 - sy) });
// Clockwise on the page (y down) by `radians` around `centre`.
export function rotation(radians: number, centre: XY): Affine {
  const cos = Math.cos(radians),
    sin = Math.sin(radians);
  return { a: cos, b: sin, c: -sin, d: cos, e: centre.x - cos * centre.x + sin * centre.y, f: centre.y - sin * centre.x - cos * centre.y };
}
export const applyPoint = (m: Affine, p: XY): XY => ({ x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f });

// One item through the transform. Line widths and font sizes follow the
// mean scale; text keeps its own turn plus the transform's.
export function transformItem(item: InkItem, m: Affine): InkItem {
  const scale = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1;
  if (item.type === "text") {
    const at = applyPoint(m, item);
    const turn = normalRotation((item.rotation || 0) + (Math.atan2(m.b, m.a) * 180) / Math.PI);
    const { rotation: _old, ...rest } = item;
    void _old;
    return { ...rest, x: round2(at.x), y: round2(at.y), size: round2(Math.min(400, Math.max(2, item.size * scale))), ...(turn ? { rotation: turn } : {}) };
  }
  if (item.type === "image") return transformImage(item, m);
  const width = round2(Math.min(200, Math.max(0.1, item.width * scale)));
  // A shape stays a shape: its own geometry is transformed and its outline
  // (`points`) drawn again from it; turning goes into its box's rotation.
  if (item.type === "pen" && item.shape) return withShape({ ...item, width }, affineShape(item.shape, m), item.points[2] ?? 0.5);
  const points = item.points.slice();
  for (let i = 0; i + 2 < points.length; i += 3) {
    const p = applyPoint(m, { x: points[i], y: points[i + 1] });
    points[i] = round2(p.x);
    points[i + 1] = round2(p.y);
  }
  return { ...item, points, width };
}
// A picture keeps its proportions under a turn or an even scale; an uneven
// scale stretches it along its own sides (exact while it stands upright).
// Its centre goes through the transform, its turn adds the transform's.
function transformImage(item: InkImage, m: Affine): InkImage {
  const theta = ((item.rotation || 0) * Math.PI) / 180;
  const ux = { x: m.a * Math.cos(theta) + m.c * Math.sin(theta), y: m.b * Math.cos(theta) + m.d * Math.sin(theta) };
  const uy = { x: -m.a * Math.sin(theta) + m.c * Math.cos(theta), y: -m.b * Math.sin(theta) + m.d * Math.cos(theta) };
  const w = round2(Math.min(1e4, Math.max(1, item.w * Math.hypot(ux.x, ux.y)))),
    h = round2(Math.min(1e4, Math.max(1, item.h * Math.hypot(uy.x, uy.y))));
  const c = applyPoint(m, { x: item.x + item.w / 2, y: item.y + item.h / 2 });
  const turn = normalRotation((Math.atan2(ux.y, ux.x) * 180) / Math.PI);
  const { rotation: _old, ...rest } = item;
  void _old;
  return { ...rest, x: round2(c.x - w / 2), y: round2(c.y - h / 2), w, h, ...(turn ? { rotation: turn } : {}) };
}
export const transformSelected = (items: InkItem[], ids: Set<string>, m: Affine) => items.map((item) => (ids.has(item.id) ? transformItem(item, m) : item));

export const selectionBounds = (items: InkItem[], ids: Set<string>): Box | null => unionBox(items.filter((i) => ids.has(i.id)).map(itemBounds));

// ---- Picking ----

// The item under a tap: ink and text drawn on top first, highlighter
// (drawn underneath) only where nothing else is. `only`: just items of a
// kind (the shape tool picks shapes with it).
export function itemAt(items: InkItem[], at: XY, tolerance: number, only: (item: InkItem) => boolean = () => true): string | null {
  const hit = (item: InkItem) => only(item) && hitItem(item, at, tolerance);
  for (let i = items.length - 1; i >= 0; i--) if (items[i].type !== "highlighter" && hit(items[i])) return items[i].id;
  for (let i = items.length - 1; i >= 0; i--) if (items[i].type === "highlighter" && hit(items[i])) return items[i].id;
  return null;
}
export const isShape = (item: InkItem) => item.type === "pen" && !!item.shape;
// A lasso that hardly moved is a tap.
export function isTap(polygon: XY[], tolerance: number) {
  const box = unionBox(polygon.map((p) => ({ x: p.x, y: p.y, w: 0, h: 0 })));
  return !box || Math.max(box.w, box.h) <= tolerance;
}

// ---- Handles ----

export type Corner = "nw" | "ne" | "sw" | "se";
export type Handle = Corner | "rotate";
export const CORNERS: Corner[] = ["nw", "ne", "sw", "se"];
export function cornerPoint(box: Box, corner: Corner): XY {
  return { x: corner.endsWith("w") ? box.x : box.x + box.w, y: corner.startsWith("n") ? box.y : box.y + box.h };
}
const opposite = (corner: Corner): Corner => ((corner[0] === "n" ? "s" : "n") + (corner[1] === "w" ? "e" : "w")) as Corner;
// The rotation handle: above the middle of the box, `offset` page units up.
export const rotateHandlePoint = (box: Box, offset: number): XY => ({ x: box.x + box.w / 2, y: box.y - offset });

// Which handle is under the point (`reach`: page units), if any.
export function handleAt(box: Box, at: XY, reach: number, rotateOffset: number): Handle | null {
  const r = rotateHandlePoint(box, rotateOffset);
  if (Math.hypot(at.x - r.x, at.y - r.y) <= reach) return "rotate";
  for (const corner of CORNERS) {
    const c = cornerPoint(box, corner);
    if (Math.hypot(at.x - c.x, at.y - c.y) <= reach) return corner;
  }
  return null;
}

// Dragging a corner from `start` to `at`: scales around the opposite
// corner – freely, or by one factor (`keepAspect`: Shift, pinch). Never
// flips or collapses (at least 5 %).
export function cornerScale(box: Box, corner: Corner, at: XY, keepAspect: boolean): Affine {
  const origin = cornerPoint(box, opposite(corner));
  const handle = cornerPoint(box, corner);
  const factor = (now: number, from: number, o: number) => (Math.abs(from - o) < 0.01 ? 1 : (now - o) / (from - o));
  let sx = Math.max(0.05, factor(at.x, handle.x, origin.x));
  let sy = Math.max(0.05, factor(at.y, handle.y, origin.y));
  // A line (no width or no height) scales along its length only.
  if (box.w < 0.5) sx = keepAspect ? sy : 1;
  if (box.h < 0.5) sy = keepAspect ? sx : 1;
  if (keepAspect) sx = sy = Math.max(sx, sy);
  return scaling(sx, sy, origin);
}

export const ROTATION_SNAP = 15;
function snapDegrees(degrees: number, steps = false) {
  const nearest = Math.round(degrees / ROTATION_SNAP) * ROTATION_SNAP;
  return normalRotation(steps || Math.abs(degrees - nearest) <= 4 ? nearest : degrees);
}
// The turn from `start` to `at` around `centre`, in degrees: snaps to
// multiples of 15° when within 4° of one, always with `steps` (Shift).
export function rotationDegrees(centre: XY, start: XY, at: XY, steps = false) {
  const angle = (Math.atan2(at.y - centre.y, at.x - centre.x) - Math.atan2(start.y - centre.y, start.x - centre.x)) * (180 / Math.PI);
  return snapDegrees(normalRotation(angle), steps);
}

// Two fingers on a selection: from where they started to where they are –
// moved with their middle, scaled with their distance, turned with their
// angle (snapping like the handle). Uniform: the aspect stays.
export function pinchTransform(from: [XY, XY], to: [XY, XY]): Affine {
  const mid = (p: [XY, XY]) => ({ x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 });
  const c0 = mid(from),
    c1 = mid(to);
  const d0 = Math.hypot(from[1].x - from[0].x, from[1].y - from[0].y) || 1;
  const d1 = Math.hypot(to[1].x - to[0].x, to[1].y - to[0].y);
  const s = Math.max(0.05, d1 / d0);
  const turn = snapDegrees(
    normalRotation((Math.atan2(to[1].y - to[0].y, to[1].x - to[0].x) - Math.atan2(from[1].y - from[0].y, from[1].x - from[0].x)) * (180 / Math.PI)),
  );
  return compose(compose(scaling(s, s, c0), rotation((turn * Math.PI) / 180, c0)), translation(c1.x - c0.x, c1.y - c0.y));
}

// ---- Order, width, placement ----

// To the front (top of the stack, end of the list) or the back, keeping
// their order among themselves. Highlighters stay under ink anyway.
export function reorderItems(items: InkItem[], ids: Set<string>, where: "front" | "back") {
  const chosen = items.filter((i) => ids.has(i.id));
  if (!chosen.length) return items;
  const rest = items.filter((i) => !ids.has(i.id));
  const next = where === "front" ? [...rest, ...chosen] : [...chosen, ...rest];
  return next.every((item, i) => item === items[i]) ? items : next;
}

// One of the three widths (fine, medium, bold) for every chosen item of its
// kind: pen width, highlighter width, text size.
export const WIDTH_STEPS = 3;
export function setItemsWidth(items: InkItem[], ids: Set<string>, step: number) {
  const i = Math.max(0, Math.min(WIDTH_STEPS - 1, Math.round(step)));
  let changed = false;
  const next = items.map((item): InkItem => {
    if (!ids.has(item.id) || item.type === "image") return item;
    if (item.type === "text") {
      if (item.size === TEXT_SIZES[i]) return item;
      changed = true;
      return { ...item, size: TEXT_SIZES[i] };
    }
    const width = item.type === "highlighter" ? HIGHLIGHTER_WIDTHS[i] : PEN_WIDTHS[i];
    if (item.width === width) return item;
    changed = true;
    // A shape's outline (arrow heads) depends on the width.
    if (item.type === "pen" && item.shape) return withShape({ ...item, width }, item.shape, item.points[2] ?? 0.5);
    return { ...item, width };
  });
  return changed ? next : items;
}
// The step the chosen items share, or null when they differ (or have none).
export function sharedWidthStep(items: InkItem[]): number | null {
  const steps = new Set(
    items.filter((item) => item.type !== "image").map((item) => (item.type === "text" ? TEXT_SIZES.indexOf(item.size) : (item.type === "highlighter" ? HIGHLIGHTER_WIDTHS : PEN_WIDTHS).indexOf(item.width))),
  );
  return steps.size === 1 && !steps.has(-1) ? [...steps][0] : null;
}

// Where text goes "next to the handwriting": right of the box when it
// fits on the page, else below it, else over it at its top left.
export function besideBox(box: Box, size: { width: number; height: number }, text: { w: number; h: number }, gap = 12): XY {
  if (box.x + box.w + gap + text.w <= size.width) return { x: round2(box.x + box.w + gap), y: round2(box.y) };
  if (box.y + box.h + gap + text.h <= size.height) return { x: round2(Math.max(0, Math.min(box.x, size.width - text.w))), y: round2(box.y + box.h + gap) };
  return { x: round2(box.x), y: round2(box.y) };
}

// Pasted items fully on the page: moved in when they stick out (e.g. onto
// a smaller sheet), never scaled.
export function fitOnPage(items: InkItem[], size: { width: number; height: number }) {
  const box = unionBox(items.map(itemBounds));
  if (!box) return items;
  const dx = box.x < 0 ? -box.x : box.x + box.w > size.width ? Math.max(-box.x, size.width - box.x - box.w) : 0;
  const dy = box.y < 0 ? -box.y : box.y + box.h > size.height ? Math.max(-box.y, size.height - box.y - box.h) : 0;
  if (!dx && !dy) return items;
  const m = translation(dx, dy);
  return items.map((item) => transformItem(item, m));
}
