// Shapes of ink: lines, arrows, rectangles, ellipses, polygons and stars
// that stay editable. Free of React and the DOM (browser and server).
//
// A shape is a pen stroke with a `shape` field (lib/ink/README.md): the
// stroke's `points` are the shape's outline as a plain line, so versions
// without shapes show it as a stroke; this version draws it from `shape`
// (fill, dashes, arrow heads) and keeps `points` in step whenever the shape
// changes. All in page units, angles in degrees clockwise (y down).

export type XY = { x: number; y: number };
export type InkShapeKind = "line" | "rect" | "ellipse" | "polygon" | "star";
export type InkShapeDash = "dash" | "dot";
export type InkShape = {
  kind: InkShapeKind;
  // line: x1, y1, x2, y2; polygon: x, y of its 3–8 corners (closed).
  pts?: number[];
  // rect, ellipse, star: centre x, y, width, height, rotation.
  box?: [number, number, number, number, number];
  // rect: corner radius.
  radius?: number;
  // star: number of points and the inner radius as a share of the outer one.
  n?: number;
  inner?: number;
  // line: arrow heads at the end or at both ends.
  arrow?: "end" | "both";
  // Fill colour (closed shapes), drawn at SHAPE_FILL_OPACITY.
  fill?: string;
  dash?: InkShapeDash;
};

export const SHAPE_FILL_OPACITY = 0.25;
export const SHAPE_LIMITS = { corners: 8, starPoints: 12 };

const COLOR = /^#[0-9a-f]{6}$/i;
const r2 = (n: number) => Math.round(n * 100) / 100;
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const coord = (n: number) => r2(clamp(n, -1e5, 1e5));
const rad = (deg: number) => (deg * Math.PI) / 180;
export const normDeg = (deg: number) => {
  const d = deg % 360;
  return r2(d < 0 ? d + 360 : d);
};

// ---- Stored form ----

// A stored shape checked, or undefined when it is unusable (the stroke then
// stays a plain stroke).
export function cleanShape(raw: unknown): InkShape | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const s = raw as Record<string, unknown>;
  const style: Partial<InkShape> = {};
  if (typeof s.fill === "string" && COLOR.test(s.fill)) style.fill = s.fill.toLowerCase();
  if (s.dash === "dash" || s.dash === "dot") style.dash = s.dash;
  const flat = (list: unknown, min: number, max: number) => {
    if (!Array.isArray(list) || list.length % 2 || list.length < min * 2 || list.length > max * 2 || !list.every(finite)) return null;
    return (list as number[]).map(coord);
  };
  if (s.kind === "line") {
    const pts = flat(s.pts, 2, 2);
    if (!pts) return undefined;
    return { kind: "line", pts, ...(s.arrow === "end" || s.arrow === "both" ? { arrow: s.arrow } : {}), ...(style.dash ? { dash: style.dash } : {}) };
  }
  if (s.kind === "polygon") {
    const pts = flat(s.pts, 3, SHAPE_LIMITS.corners);
    return pts ? { kind: "polygon", pts, ...style } : undefined;
  }
  if (s.kind === "rect" || s.kind === "ellipse" || s.kind === "star") {
    const b = s.box;
    if (!Array.isArray(b) || b.length !== 5 || !b.every(finite)) return undefined;
    const box: InkShape["box"] = [coord(b[0]), coord(b[1]), r2(clamp(Math.abs(b[2]), 0.5, 1e5)), r2(clamp(Math.abs(b[3]), 0.5, 1e5)), normDeg(b[4])];
    if (s.kind === "rect") {
      const radius = finite(s.radius) && s.radius > 0 ? r2(Math.min(s.radius, Math.min(box[2], box[3]) / 2)) : 0;
      return { kind: "rect", box, ...(radius ? { radius } : {}), ...style };
    }
    if (s.kind === "star")
      return {
        kind: "star",
        box,
        n: finite(s.n) ? clamp(Math.round(s.n), 3, SHAPE_LIMITS.starPoints) : 5,
        inner: finite(s.inner) ? r2(clamp(s.inner, 0.15, 0.95)) : 0.45,
        ...style,
      };
    return { kind: "ellipse", box, ...style };
  }
  return undefined;
}

// ---- Outline ----

const pairs = (flat: number[]) => {
  const out: XY[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push({ x: flat[i], y: flat[i + 1] });
  return out;
};
const flatXY = (list: XY[]) => list.flatMap((p) => [coord(p.x), coord(p.y)]);
export const shapeVertices = (shape: InkShape) => pairs(shape.pts || []);

// A point of the box's own frame (centre origin, unrotated) on the page.
export function boxPoint(box: NonNullable<InkShape["box"]>, lx: number, ly: number): XY {
  const [cx, cy, , , rot] = box;
  const c = Math.cos(rad(rot)),
    s = Math.sin(rad(rot));
  return { x: cx + lx * c - ly * s, y: cy + lx * s + ly * c };
}
// A page point in the box's own frame.
export function toBox(box: NonNullable<InkShape["box"]>, p: XY): XY {
  const [cx, cy, , , rot] = box;
  const c = Math.cos(rad(rot)),
    s = Math.sin(rad(rot));
  const dx = p.x - cx,
    dy = p.y - cy;
  return { x: dx * c + dy * s, y: -dx * s + dy * c };
}
// The corners of a box, clockwise from the top left (in its own frame).
export const boxCorners = (box: NonNullable<InkShape["box"]>) =>
  [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([sx, sy]) => boxPoint(box, (sx * box[2]) / 2, (sy * box[3]) / 2));

export function starVertices(box: NonNullable<InkShape["box"]>, n: number, inner: number): XY[] {
  const [, , w, h] = box;
  return Array.from({ length: n * 2 }, (_, i) => {
    const a = -Math.PI / 2 + (i * Math.PI) / n;
    const r = i % 2 ? inner : 1;
    return boxPoint(box, (Math.cos(a) * r * w) / 2, (Math.sin(a) * r * h) / 2);
  });
}

// The arrow head at `tip` coming from `from`: two wing points.
export function arrowHead(from: XY, tip: XY, width: number): [XY, XY, XY] {
  const len = Math.hypot(tip.x - from.x, tip.y - from.y) || 1;
  const size = Math.min(Math.max(7, width * 5), len * 0.45);
  const ux = (tip.x - from.x) / len,
    uy = (tip.y - from.y) / len;
  const a = rad(28);
  const wing = (sign: number) => ({
    x: tip.x - size * (ux * Math.cos(a) - sign * uy * Math.sin(a)),
    y: tip.y - size * (uy * Math.cos(a) + sign * ux * Math.sin(a)),
  });
  return [wing(1), tip, wing(-1)];
}

export type ShapeParts = { body: XY[]; closed: boolean; heads: XY[][] };
// What is drawn: the outline (closed or not) and arrow heads.
export function shapeParts(shape: InkShape, width = 1.6): ShapeParts {
  if (shape.kind === "line") {
    const [a, b] = shapeVertices(shape);
    const heads: XY[][] = [];
    if (shape.arrow) heads.push(arrowHead(a, b, width));
    if (shape.arrow === "both") heads.push(arrowHead(b, a, width));
    return { body: [a, b], closed: false, heads };
  }
  if (shape.kind === "polygon") return { body: shapeVertices(shape), closed: true, heads: [] };
  const box = shape.box!;
  const [, , w, h] = box;
  if (shape.kind === "star") return { body: starVertices(box, shape.n || 5, shape.inner ?? 0.45), closed: true, heads: [] };
  if (shape.kind === "ellipse") {
    // Enough segments to look round at any zoom up to a page wide.
    const steps = Math.round(clamp(Math.sqrt(Math.max(w, h)) * 6, 32, 120));
    return {
      body: Array.from({ length: steps }, (_, i) => {
        const t = (i / steps) * Math.PI * 2;
        return boxPoint(box, (Math.cos(t) * w) / 2, (Math.sin(t) * h) / 2);
      }),
      closed: true,
      heads: [],
    };
  }
  const radius = Math.min(shape.radius || 0, w / 2, h / 2);
  if (!radius) return { body: boxCorners(box), closed: true, heads: [] };
  const body: XY[] = [];
  const corners = [
    [w / 2 - radius, -h / 2 + radius, -90],
    [w / 2 - radius, h / 2 - radius, 0],
    [-w / 2 + radius, h / 2 - radius, 90],
    [-w / 2 + radius, -h / 2 + radius, 180],
  ];
  for (const [lx, ly, start] of corners)
    for (let k = 0; k <= 8; k++) {
      const a = rad(start + (k * 90) / 8);
      body.push(boxPoint(box, lx + Math.cos(a) * radius, ly + Math.sin(a) * radius));
    }
  return { body, closed: true, heads: [] };
}

// The outline as one line (the stroke's `points`, pressure 0.5): the closed
// outline back to its start, arrow heads drawn there and back.
export function shapeOutline(shape: InkShape, width = 1.6): XY[] {
  const { body, closed, heads } = shapeParts(shape, width);
  const out = closed ? [...body, body[0]] : body.slice();
  if (shape.kind === "line" && heads.length) {
    const [end, start] = heads;
    out.push(end[0], end[1], end[2]);
    if (start) out.unshift(start[0], start[1], start[2], start[1]);
  }
  return out;
}
export const shapePoints = (shape: InkShape, width = 1.6, pressure = 0.5) => shapeOutline(shape, width).flatMap((p) => [r2(p.x), r2(p.y), pressure]);

export const isClosedShape = (shape: InkShape) => shape.kind !== "line";
export function shapeBounds(shape: InkShape, width = 1.6) {
  const pts = shapeOutline(shape, width);
  const xs = pts.map((p) => p.x),
    ys = pts.map((p) => p.y);
  const x = Math.min(...xs),
    y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}
export function shapeCentre(shape: InkShape): XY {
  if (shape.box) return { x: shape.box[0], y: shape.box[1] };
  const v = shapeVertices(shape);
  if (shape.kind === "line") return { x: (v[0].x + v[1].x) / 2, y: (v[0].y + v[1].y) / 2 };
  // Centre of the polygon's bounds: rotating about it keeps it in place.
  const xs = v.map((p) => p.x),
    ys = v.map((p) => p.y);
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
}

// SVG path data for the parts.
const f = (n: number) => r2(n);
export function partsPath(list: XY[], closed: boolean) {
  if (!list.length) return "";
  return `M${list.map((p) => `${f(p.x)} ${f(p.y)}`).join("L")}${closed ? "Z" : ""}`;
}
export function shapePaths(shape: InkShape, width = 1.6) {
  const { body, closed, heads } = shapeParts(shape, width);
  return { body: partsPath(body, closed), heads: heads.map((h) => partsPath(h, false)).join(""), closed };
}
// The dash pattern of a style, scaled with the line width.
export function dashArray(dash: InkShapeDash | undefined, width: number): number[] | null {
  if (dash === "dash") return [r2(width * 4 + 2), r2(width * 2.5 + 2)];
  if (dash === "dot") return [0.01, r2(width * 2 + 1.5)];
  return null;
}

// ---- Changes ----

const mapPts = (shape: InkShape, fn: (p: XY) => XY): InkShape => (shape.pts ? { ...shape, pts: flatXY(shapeVertices(shape).map(fn)) } : shape);

export function moveShape(shape: InkShape, dx: number, dy: number): InkShape {
  if (shape.box) {
    const [x, y, w, h, rot] = shape.box;
    return { ...shape, box: [coord(x + dx), coord(y + dy), w, h, rot] };
  }
  return mapPts(shape, (p) => ({ x: p.x + dx, y: p.y + dy }));
}
// Scales by `scale` around (ox, oy) and moves by (dx, dy) – as a lasso selection does.
export function scaleShape(shape: InkShape, t: { dx?: number; dy?: number; scale?: number; ox?: number; oy?: number }): InkShape {
  const { dx = 0, dy = 0, scale = 1, ox = 0, oy = 0 } = t;
  const m = (p: XY) => ({ x: ox + (p.x - ox) * scale + dx, y: oy + (p.y - oy) * scale + dy });
  if (shape.box) {
    const [x, y, w, h, rot] = shape.box;
    const c = m({ x, y });
    return {
      ...shape,
      box: [coord(c.x), coord(c.y), r2(Math.max(0.5, w * scale)), r2(Math.max(0.5, h * scale)), rot],
      ...(shape.radius ? { radius: r2(shape.radius * scale) } : {}),
    };
  }
  return mapPts(shape, m);
}
export function rotateShape(shape: InkShape, deg: number, about = shapeCentre(shape)): InkShape {
  const c = Math.cos(rad(deg)),
    s = Math.sin(rad(deg));
  const turn = (p: XY) => ({ x: about.x + (p.x - about.x) * c - (p.y - about.y) * s, y: about.y + (p.x - about.x) * s + (p.y - about.y) * c });
  if (shape.box) {
    const [x, y, w, h, rot] = shape.box;
    const centre = turn({ x, y });
    return { ...shape, box: [coord(centre.x), coord(centre.y), w, h, normDeg(rot + deg)] };
  }
  return mapPts(shape, turn);
}
// The rotation shown for a shape (its own, or the line's direction).
export function shapeAngle(shape: InkShape) {
  if (shape.box) return shape.box[4];
  const v = shapeVertices(shape);
  return normDeg((Math.atan2(v[1].y - v[0].y, v[1].x - v[0].x) * 180) / Math.PI);
}

// ---- Snapping ----

// An angle snapped to the nearest multiple of `step` when within `tolerance`
// (a little more for 0°, 45°, 90° …).
export function snapAngle(deg: number, step = 15, tolerance = 3.5) {
  const nearest = Math.round(deg / step) * step;
  const reach = nearest % 45 === 0 ? tolerance * 1.7 : tolerance;
  return Math.abs(deg - nearest) <= reach ? nearest : deg;
}
// The end `to` of a line from `from`, its direction snapped (length kept).
export function snapLineEnd(from: XY, to: XY, tolerance = 3.5): XY {
  const len = Math.hypot(to.x - from.x, to.y - from.y);
  if (len < 1e-6) return to;
  const deg = (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
  const snapped = snapAngle(deg, 15, tolerance);
  if (snapped === deg) return to;
  return { x: from.x + Math.cos(rad(snapped)) * len, y: from.y + Math.sin(rad(snapped)) * len };
}
// The anchor nearest to p within `tolerance`, or null.
export function nearestAnchor(p: XY, anchors: XY[], tolerance: number): XY | null {
  let best: XY | null = null;
  let distance = tolerance;
  for (const a of anchors) {
    const d = Math.hypot(a.x - p.x, a.y - p.y);
    if (d <= distance) {
      distance = d;
      best = a;
    }
  }
  return best;
}
// Corners and ends of shapes (and the centre of round ones): where the ends
// of new lines and corners snap to.
export function shapeAnchors(shape: InkShape): XY[] {
  if (shape.kind === "line" || shape.kind === "polygon") return shapeVertices(shape);
  const box = shape.box!;
  if (shape.kind === "ellipse")
    return [
      boxPoint(box, 0, 0),
      boxPoint(box, box[2] / 2, 0),
      boxPoint(box, -box[2] / 2, 0),
      boxPoint(box, 0, box[3] / 2),
      boxPoint(box, 0, -box[3] / 2),
    ];
  if (shape.kind === "star") return starVertices(box, shape.n || 5, shape.inner ?? 0.45).filter((_, i) => i % 2 === 0);
  return boxCorners(box);
}
// Ends of lines and corners of polygons pulled onto anchors nearby.
export function magnetShape(shape: InkShape, anchors: XY[], tolerance: number): InkShape {
  if (!anchors.length || (shape.kind !== "line" && shape.kind !== "polygon")) return shape;
  let moved = false;
  const pts = shapeVertices(shape).map((p) => {
    const a = nearestAnchor(p, anchors, tolerance);
    if (a && (a.x !== p.x || a.y !== p.y)) moved = true;
    return a || p;
  });
  if (shape.kind === "line" && Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) < 1) return shape;
  return moved ? { ...shape, pts: flatXY(pts) } : shape;
}

// ---- Handles ----

export type ShapeHandle = { id: string; x: number; y: number; kind: "vertex" | "corner" | "rotate" | "scale" };
// Handles of a shape on the page; `reach` is the rotate handle's distance
// above the shape (page units, a fixed size on the screen).
export function shapeHandles(shape: InkShape, reach: number): ShapeHandle[] {
  if (shape.kind === "line") return shapeVertices(shape).map((p, i) => ({ id: `v${i}`, ...p, kind: "vertex" }));
  const handles: ShapeHandle[] = [];
  if (shape.kind === "polygon") {
    shapeVertices(shape).forEach((p, i) => handles.push({ id: `v${i}`, ...p, kind: "vertex" }));
    const b = shapeBounds(shape);
    handles.push({ id: "scale", x: b.x + b.w + reach * 0.35, y: b.y + b.h + reach * 0.35, kind: "scale" });
    handles.push({ id: "rotate", x: b.x + b.w / 2, y: b.y - reach, kind: "rotate" });
    return handles;
  }
  const box = shape.box!;
  boxCorners(box).forEach((p, i) => handles.push({ id: `c${i}`, ...p, kind: "corner" }));
  handles.push({ id: "rotate", ...boxPoint(box, 0, -box[3] / 2 - reach), kind: "rotate" });
  return handles;
}

export type DragOptions = { snap?: boolean; anchors?: XY[]; tolerance?: number };
// The shape with handle `id` dragged from `from` to `to` (both page points;
// `shape` is the state when the drag began).
export function dragHandle(shape: InkShape, id: string, from: XY, to: XY, options: DragOptions = {}): InkShape {
  const { snap = true, anchors = [], tolerance = 0 } = options;
  if (id === "move") {
    const moved = moveShape(shape, to.x - from.x, to.y - from.y);
    return snap ? magnetMove(shape, moved, anchors, tolerance) : moved;
  }
  if (id.startsWith("v") && shape.pts) {
    const index = Number(id.slice(1));
    const v = shapeVertices(shape);
    if (!v[index]) return shape;
    let p = { x: v[index].x + to.x - from.x, y: v[index].y + to.y - from.y };
    const anchor = snap ? nearestAnchor(p, anchors, tolerance) : null;
    if (anchor) p = anchor;
    else if (snap && shape.kind === "line") p = snapLineEnd(v[1 - index], p);
    v[index] = p;
    return { ...shape, pts: flatXY(v) };
  }
  if (id === "rotate") {
    const c = shapeCentre(shape);
    const start = (Math.atan2(from.y - c.y, from.x - c.x) * 180) / Math.PI;
    const now = (Math.atan2(to.y - c.y, to.x - c.x) * 180) / Math.PI;
    if (shape.box) {
      const target = shape.box[4] + now - start;
      const angle = snap ? snapAngle(normDeg(target), 15, 4) : target;
      return { ...shape, box: [...shape.box.slice(0, 4), normDeg(angle)] as InkShape["box"] };
    }
    let delta = now - start;
    if (snap) delta = snapAngle(delta, 15, 4);
    return rotateShape(shape, delta, c);
  }
  if (id === "scale") {
    const c = shapeCentre(shape);
    const factor = Math.max(0.05, Math.hypot(to.x - c.x, to.y - c.y) / Math.max(1, Math.hypot(from.x - c.x, from.y - c.y)));
    return scaleShape(shape, { scale: factor, ox: c.x, oy: c.y });
  }
  if (id.startsWith("c") && shape.box) {
    const index = Number(id.slice(1));
    const box = shape.box;
    const corners = boxCorners(box);
    const fixed = corners[(index + 2) % 4];
    const dragged = { x: corners[index].x + to.x - from.x, y: corners[index].y + to.y - from.y };
    // The new extent in the box's own frame, from the fixed corner.
    const a = toBox(box, fixed),
      b = toBox(box, dragged);
    let w = Math.abs(b.x - a.x),
      h = Math.abs(b.y - a.y);
    if (snap && shape.kind !== "star" && Math.abs(w - h) <= Math.max(w, h) * 0.08) w = h = Math.max(w, h);
    if (shape.kind === "star" && snap) w = h = Math.max(w, h);
    w = Math.max(1, w);
    h = Math.max(1, h);
    const sx = Math.sign(b.x - a.x) || 1,
      sy = Math.sign(b.y - a.y) || 1;
    const centre = boxPoint(box, a.x + (sx * w) / 2, a.y + (sy * h) / 2);
    const radius = shape.radius ? Math.min(shape.radius, w / 2, h / 2) : 0;
    return { ...shape, box: [coord(centre.x), coord(centre.y), r2(w), r2(h), box[4]], ...(shape.radius ? { radius: r2(radius) } : {}) };
  }
  return shape;
}
// A moved shape pulled so one of its anchors sits on an anchor nearby.
function magnetMove(before: InkShape, moved: InkShape, anchors: XY[], tolerance: number) {
  if (!anchors.length || !tolerance) return moved;
  let best: { dx: number; dy: number; d: number } | null = null;
  for (const p of shapeAnchors(moved)) {
    const a = nearestAnchor(p, anchors, tolerance);
    if (!a) continue;
    const d = Math.hypot(a.x - p.x, a.y - p.y);
    if (!best || d < best.d) best = { dx: a.x - p.x, dy: a.y - p.y, d };
  }
  return best ? moveShape(moved, best.dx, best.dy) : moved;
}

// ---- Hits ----

function segmentDistance(p: XY, a: XY, b: XY) {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
export function insideOutline(p: XY, polygon: XY[]) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i],
      b = polygon[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
// Distance from p to the drawn outline (0 inside a filled shape).
export function shapeDistance(shape: InkShape, p: XY, width = 1.6) {
  const { body, closed, heads } = shapeParts(shape, width);
  if (closed && shape.fill && insideOutline(p, body)) return 0;
  let d = Infinity;
  const lines = [closed ? [...body, body[0]] : body, ...heads];
  for (const list of lines) for (let i = 1; i < list.length; i++) d = Math.min(d, segmentDistance(p, list[i - 1], list[i]));
  return d;
}
