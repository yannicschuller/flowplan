// The ruler on a page: a straight edge (ruler), a set square with a
// protractor (Geodreieck) and a compass. Pure geometry in page units – PDF
// points, so its scale is the paper's real one (A4, Letter, an imported
// PDF page) at any zoom. Angles in degrees clockwise (y down).
import type { PageSize } from "./coords";
import type { InkItem } from "./model";
import { normDeg, type XY } from "./shapes";

export type RulerMode = "ruler" | "protractor" | "compass";
export type RulerUnit = "cm" | "in";
// Where the tool lies: its middle (the ruler's centre, the protractor's
// zero point, the compass's needle), its turn, the compass's radius.
export type RulerState = { page: string; x: number; y: number; angle: number; mode: RulerMode; radius: number; unit: RulerUnit };

export const PT_PER_CM = 72 / 2.54;
export const PT_PER_IN = 72;
export const ptPerUnit = (unit: RulerUnit) => (unit === "in" ? PT_PER_IN : PT_PER_CM);
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;
const dist = (a: XY, b: XY) => Math.hypot(a.x - b.x, a.y - b.y);

// Letter paper measures in inches, everything else in centimetres.
export const defaultUnit = (size: PageSize): RulerUnit =>
  (Math.abs(size.width - 612) < 2 && Math.abs(size.height - 792) < 2) || (Math.abs(size.width - 792) < 2 && Math.abs(size.height - 612) < 2) ? "in" : "cm";

// Size of the tool on a page: about the page's width long, at least
// `minThickness` (page units: a size on the screen) thick.
export function rulerSize(state: Pick<RulerState, "mode">, size: PageSize, minThickness = 0) {
  if (state.mode === "protractor") {
    const length = Math.max(8 * PT_PER_CM, Math.min(size.width, size.height) * 0.62);
    return { length, thickness: length / 2 };
  }
  // As long as the page is wide (a 20 cm ruler on A4), so both ends stay in view.
  return { length: Math.max(10 * PT_PER_CM, Math.min(size.width, size.height) * 0.95), thickness: Math.max(2.2 * PT_PER_CM, minThickness) };
}

// A point of the tool's own frame on the page.
export function rulerPoint(state: Pick<RulerState, "x" | "y" | "angle">, lx: number, ly: number): XY {
  const c = Math.cos(rad(state.angle)),
    s = Math.sin(rad(state.angle));
  return { x: state.x + lx * c - ly * s, y: state.y + lx * s + ly * c };
}
export function toRuler(state: Pick<RulerState, "x" | "y" | "angle">, p: XY): XY {
  const c = Math.cos(rad(state.angle)),
    s = Math.sin(rad(state.angle));
  const dx = p.x - state.x,
    dy = p.y - state.y;
  return { x: dx * c + dy * s, y: -dx * s + dy * c };
}

export type Edge = { a: XY; b: XY; scale: boolean };
// The straight edges strokes are drawn along.
export function rulerEdges(state: RulerState, size: PageSize, minThickness = 0): Edge[] {
  const { length, thickness } = rulerSize(state, size, minThickness);
  const at = (lx: number, ly: number) => rulerPoint(state, lx, ly);
  if (state.mode === "ruler")
    return [
      { a: at(-length / 2, -thickness / 2), b: at(length / 2, -thickness / 2), scale: true },
      { a: at(-length / 2, thickness / 2), b: at(length / 2, thickness / 2), scale: false },
    ];
  if (state.mode === "protractor") {
    // The hypotenuse through the zero point, the right angle above it.
    const left = at(-length / 2, 0),
      right = at(length / 2, 0),
      apex = at(0, -length / 2);
    return [
      { a: left, b: right, scale: true },
      { a: left, b: apex, scale: false },
      { a: apex, b: right, scale: false },
    ];
  }
  return [];
}
// The point on the line through a and b nearest to p.
export function projectOnLine(p: XY, a: XY, b: XY): XY {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const len = dx * dx + dy * dy || 1;
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len;
  return { x: a.x + t * dx, y: a.y + t * dy };
}
// Is p inside the tool's body (moving it, not drawing)?
export function insideRuler(state: RulerState, size: PageSize, p: XY, minThickness = 0) {
  const { length, thickness } = rulerSize(state, size, minThickness);
  const l = toRuler(state, p);
  if (state.mode === "ruler") return Math.abs(l.x) <= length / 2 && Math.abs(l.y) <= thickness / 2;
  if (state.mode === "protractor") return l.y <= 0 && l.y >= -length / 2 && Math.abs(l.x) <= length / 2 + l.y;
  return dist(p, state) <= minThickness;
}
// The edge a stroke beginning at p follows: within `reach` of it (outside
// the body or just inside), along its length.
export function edgeNear(state: RulerState, size: PageSize, p: XY, reach: number, minThickness = 0): Edge | null {
  let best: Edge | null = null;
  let distance = reach;
  for (const edge of rulerEdges(state, size, minThickness)) {
    const q = projectOnLine(p, edge.a, edge.b);
    const len = dist(edge.a, edge.b);
    const t = ((q.x - edge.a.x) * (edge.b.x - edge.a.x) + (q.y - edge.a.y) * (edge.b.y - edge.a.y)) / (len * len);
    if (t < -0.02 || t > 1.02) continue;
    const d = dist(p, q);
    if (d <= distance) {
      distance = d;
      best = edge;
    }
  }
  return best;
}

// Turns snap to 0/15/30/45/60/90° … when within `tolerance`.
export function snapRulerAngle(angle: number, tolerance = 3) {
  const a = normDeg(angle);
  const nearest = Math.round(a / 15) * 15;
  return Math.abs(a - nearest) <= tolerance ? normDeg(nearest) : a;
}
// The angle as shown (0–180°: a ruler turned by 180° lies the same way).
export const shownAngle = (angle: number) => {
  const a = normDeg(angle) % 180;
  return Math.round((a > 90 ? 180 - a : a) * 10) / 10;
};

// A length in the unit, rounded for reading (1 mm, 1/100 in).
export const measure = (pt: number, unit: RulerUnit) => Math.round((pt / ptPerUnit(unit)) * (unit === "in" ? 100 : 10)) / (unit === "in" ? 100 : 10);

export type Tick = { at: number; level: 1 | 2 | 3; label?: string };
// Marks along an edge `length` long, as fine as the zoom shows apart
// (`pxPerPt`): millimetres or half centimetres; sixteenths to quarters of an inch.
export function rulerTicks(length: number, unit: RulerUnit, pxPerPt: number): Tick[] {
  const unitPt = ptPerUnit(unit);
  const divisions = unit === "cm" ? [10, 2, 1] : [16, 8, 4, 2, 1];
  const steps = divisions.find((d) => (unitPt / d) * pxPerPt >= 4) ?? 1;
  const labelEvery = unitPt * pxPerPt >= 22 ? 1 : unitPt * pxPerPt >= 11 ? 2 : 5;
  const out: Tick[] = [];
  const count = Math.floor((length / unitPt) * steps + 1e-6);
  for (let i = 0; i <= count; i++) {
    const at = (i * unitPt) / steps;
    const whole = i % steps === 0;
    const half = !whole && (i * 2) % steps === 0;
    const units = i / steps;
    out.push({ at, level: whole ? 3 : half ? 2 : 1, ...(whole && units % labelEvery === 0 ? { label: String(units) } : {}) });
  }
  return out;
}

// ---- Protractor: angles between lines through the zero point ----

export type Segment = { a: XY; b: XY };
// Rays from `centre` along lines passing within `reach` of it: two for a
// line crossing it, one for a line ending there. Degrees, sorted.
export function raysThrough(segments: Segment[], centre: XY, reach: number): number[] {
  const rays: number[] = [];
  for (const { a, b } of segments) {
    const q = projectOnLine(centre, a, b);
    const len = dist(a, b);
    if (len < reach * 2) continue;
    const t = ((q.x - a.x) * (b.x - a.x) + (q.y - a.y) * (b.y - a.y)) / (len * len);
    if (t < -0.05 || t > 1.05 || dist(q, centre) > reach) continue;
    for (const end of [a, b]) if (dist(end, centre) > reach * 2) rays.push(normDeg(deg(Math.atan2(end.y - centre.y, end.x - centre.x))));
  }
  const sorted = rays.sort((x, y) => x - y);
  return sorted.filter((r, i) => !i || r - sorted[i - 1] > 0.5).filter((r, i, list) => !(i === list.length - 1 && list.length > 1 && 360 - r + list[0] <= 0.5));
}
// The angles between neighbouring rays (all the way round), each with its
// start and sweep; a single ray has none.
export function anglesBetween(rays: number[]): { from: number; sweep: number }[] {
  if (rays.length < 2) return [];
  return rays.map((r, i) => {
    const next = rays[(i + 1) % rays.length];
    return { from: r, sweep: Math.round(normDeg(next - r) * 10) / 10 };
  });
}
// The straight pieces of ink: lines of shapes, edges of polygons and
// rectangles, pen strokes that are nearly straight.
export function straightSegments(items: InkItem[]): Segment[] {
  const out: Segment[] = [];
  for (const item of items) {
    if (item.type !== "pen") continue;
    const s = item.shape;
    if (s?.kind === "line" && s.pts) out.push({ a: { x: s.pts[0], y: s.pts[1] }, b: { x: s.pts[2], y: s.pts[3] } });
    else if (s?.kind === "polygon" && s.pts) {
      const n = s.pts.length / 2;
      for (let i = 0; i < n; i++) out.push({ a: { x: s.pts[i * 2], y: s.pts[i * 2 + 1] }, b: { x: s.pts[((i + 1) % n) * 2], y: s.pts[((i + 1) % n) * 2 + 1] } });
    } else if (!s) {
      const p = item.points;
      if (p.length < 6) continue;
      const a = { x: p[0], y: p[1] },
        b = { x: p[p.length - 3], y: p[p.length - 2] };
      let path = 0;
      for (let i = 3; i + 2 < p.length; i += 3) path += Math.hypot(p[i] - p[i - 3], p[i + 1] - p[i - 2]);
      if (path > 0 && dist(a, b) / path > 0.985) out.push({ a, b });
    }
  }
  return out;
}
// A ray's reading on the protractor (0° at its right end, 180° at the left,
// over the half above the edge), or null below it.
export function protractorReading(state: Pick<RulerState, "angle">, ray: number) {
  const local = normDeg(ray - state.angle);
  if (local === 0) return 0;
  if (local < 180) return null;
  return Math.round((360 - local) * 10) / 10;
}

// ---- Compass ----

export const compassPoint = (state: Pick<RulerState, "x" | "y" | "radius">, angle: number): XY => ({
  x: state.x + Math.cos(rad(angle)) * state.radius,
  y: state.y + Math.sin(rad(angle)) * state.radius,
});
// An angle continued from the previous one without jumping at ±180°.
export function unwrapAngle(previous: number, next: number) {
  let a = next;
  while (a - previous > 180) a -= 360;
  while (a - previous < -180) a += 360;
  return a;
}
export const angleAt = (centre: XY, p: XY) => deg(Math.atan2(p.y - centre.y, p.x - centre.x));
// The arc from `from` to `to` (degrees, unwrapped) as points every 2° or so.
export function arcPoints(state: Pick<RulerState, "x" | "y" | "radius">, from: number, to: number): XY[] {
  const steps = Math.max(1, Math.ceil(Math.abs(to - from) / 2));
  return Array.from({ length: steps + 1 }, (_, i) => compassPoint(state, from + ((to - from) * i) / steps));
}
// A radius snapped to whole millimetres (or sixteenths of an inch).
export const snapRadius = (pt: number, unit: RulerUnit) => {
  const step = unit === "in" ? PT_PER_IN / 16 : PT_PER_CM / 10;
  return Math.max(step, Math.round(pt / step) * step);
};
