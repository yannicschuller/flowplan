// Recognising shapes in a hand-drawn stroke (hold the pen at the end of a
// stroke, or the shape tool's "recognise"). Pure geometry, page units.
//
//   1. Resample the stroke to evenly spaced points; decide whether it is
//      closed (end near the start, or crossing back over it).
//   2. Open: a line (straight within a few percent, ignoring hooks at the
//      ends) or an arrow (a long shaft and a short head at one end).
//   3. Closed: fit candidates – ellipse (principal axes), rectangle (edge
//      directions, rounded corners), polygon (corners from Douglas–Peucker,
//      refined by intersecting lines fitted to the edges), star (corners
//      alternating between two radii, or a pentagram) – and take the one
//      with the lowest fit error (mean distance both ways, relative to the
//      size) if it is low enough.
//   4. Tidy: circles and squares when the sides are within 8 %, axes and
//      edges straightened when they are within a few degrees, regular
//      polygons and stars, lines at 0/15/30/45/90°.
import { normDeg, snapAngle, snapLineEnd, type InkShape, type XY } from "./shapes";

export type ShapeName = "line" | "arrow" | "rectangle" | "square" | "rounded" | "ellipse" | "circle" | "triangle" | "diamond" | "polygon" | "star";
export type RecognizedShape = { shape: InkShape; name: ShapeName; error: number };

const r2 = (n: number) => Math.round(n * 100) / 100;
const dist = (a: XY, b: XY) => Math.hypot(a.x - b.x, a.y - b.y);
const deg = (r: number) => (r * 180) / Math.PI;
const rad = (d: number) => (d * Math.PI) / 180;

export function pathLength(points: XY[]) {
  let s = 0;
  for (let i = 1; i < points.length; i++) s += dist(points[i - 1], points[i]);
  return s;
}
// `count` points evenly spaced along the path.
export function resampleEven(points: XY[], count: number): XY[] {
  const total = pathLength(points);
  if (points.length < 2 || total === 0) return points.slice(0, 1);
  const step = total / (count - 1);
  const out: XY[] = [points[0]];
  let carried = 0;
  for (let i = 1; i < points.length && out.length < count; i++) {
    let a = points[i - 1];
    const b = points[i];
    let seg = dist(a, b);
    while (carried + seg >= step && out.length < count) {
      const t = (step - carried) / seg;
      const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      out.push(p);
      seg -= step - carried;
      a = p;
      carried = 0;
    }
    carried += seg;
  }
  while (out.length < count) out.push(points[points.length - 1]);
  return out;
}

function segmentDistance(p: XY, a: XY, b: XY) {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
function douglasPeucker(points: XY[], tolerance: number): XY[] {
  if (points.length < 3) return points.slice();
  let index = 0,
    far = 0;
  const a = points[0],
    b = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const d = segmentDistance(points[i], a, b);
    if (d > far) {
      far = d;
      index = i;
    }
  }
  if (far <= tolerance) return [a, b];
  const left = douglasPeucker(points.slice(0, index + 1), tolerance);
  const right = douglasPeucker(points.slice(index), tolerance);
  return [...left.slice(0, -1), ...right];
}
// Mean distance of points to a polyline (closed: back to the start).
function meanDistance(points: XY[], outline: XY[], closed: boolean) {
  const list = closed ? [...outline, outline[0]] : outline;
  let sum = 0;
  for (const p of points) {
    let d = Infinity;
    for (let i = 1; i < list.length; i++) d = Math.min(d, segmentDistance(p, list[i - 1], list[i]));
    sum += d;
  }
  return sum / points.length;
}
// Fit error both ways (the stroke to the outline and the outline back to
// the stroke), relative to `size`.
function fitError(stroke: XY[], outline: XY[], size: number) {
  const sampled = resampleEven([...outline, outline[0]], 64);
  return (meanDistance(stroke, outline, true) + meanDistance(sampled, stroke, true)) / 2 / size;
}

type Frame = { cx: number; cy: number; angle: number };
// Principal axes of a point cloud: centre and the angle of the long axis.
function principal(points: XY[]): Frame & { spread: number } {
  const n = points.length;
  const cx = points.reduce((s, p) => s + p.x, 0) / n,
    cy = points.reduce((s, p) => s + p.y, 0) / n;
  let xx = 0,
    yy = 0,
    xy = 0;
  for (const p of points) {
    xx += (p.x - cx) ** 2;
    yy += (p.y - cy) ** 2;
    xy += (p.x - cx) * (p.y - cy);
  }
  const angle = 0.5 * Math.atan2(2 * xy, xx - yy);
  const root = Math.sqrt(((xx - yy) / 2) ** 2 + xy * xy);
  const l1 = (xx + yy) / 2 + root,
    l2 = (xx + yy) / 2 - root;
  return { cx, cy, angle, spread: l1 > 0 ? l2 / l1 : 1 };
}
// The extents of points in a frame rotated by `angle` (radians) about the origin.
function extents(points: XY[], angle: number) {
  const c = Math.cos(angle),
    s = Math.sin(angle);
  let [minU, maxU, minV, maxV] = [Infinity, -Infinity, Infinity, -Infinity];
  for (const p of points) {
    const u = p.x * c + p.y * s,
      v = -p.x * s + p.y * c;
    minU = Math.min(minU, u);
    maxU = Math.max(maxU, u);
    minV = Math.min(minV, v);
    maxV = Math.max(maxV, v);
  }
  const mu = (minU + maxU) / 2,
    mv = (minV + maxV) / 2;
  return { cx: mu * c - mv * s, cy: mu * s + mv * c, w: maxU - minU, h: maxV - minV };
}
// A rotation in degrees straightened to 0/90 (mod 90 for rectangles) when close.
const straighten = (degrees: number, period: number, tolerance: number) => {
  const nearest = Math.round(degrees / period) * period;
  return Math.abs(degrees - nearest) <= tolerance ? nearest : degrees;
};
const box = (cx: number, cy: number, w: number, h: number, rot: number): NonNullable<InkShape["box"]> => [r2(cx), r2(cy), r2(w), r2(h), normDeg(rot)];
const flat = (list: XY[]) => list.flatMap((p) => [r2(p.x), r2(p.y)]);

// ---- Open strokes ----

function fitLine(points: XY[]) {
  const f = principal(points);
  const ux = Math.cos(f.angle),
    uy = Math.sin(f.angle);
  const project = (p: XY) => {
    const t = (p.x - f.cx) * ux + (p.y - f.cy) * uy;
    return { x: f.cx + t * ux, y: f.cy + t * uy };
  };
  const deviation = Math.max(...points.map((p) => dist(p, project(p))));
  return { project, deviation };
}
function recognizeLine(points: XY[]): RecognizedShape | null {
  const total = pathLength(points);
  // Hooks where the pen lands or lifts do not count.
  const trim = total * 0.06;
  let s = 0;
  const inner = points.filter((p, i) => {
    if (i) s += dist(points[i - 1], p);
    return s >= trim && s <= total - trim;
  });
  if (inner.length < 2) return null;
  const chord = dist(points[0], points[points.length - 1]);
  const { project, deviation } = fitLine(inner);
  if (chord / total < 0.9 || deviation > Math.max(1.5, chord * 0.05)) return null;
  const from = project(points[0]);
  const to = snapLineEnd(from, project(points[points.length - 1]));
  if (dist(from, to) < 4) return null;
  return { shape: { kind: "line", pts: flat([from, to]) }, name: "line", error: deviation / chord };
}
// A shaft followed by a head drawn at its end without lifting the pen.
function recognizeArrow(points: XY[], size: number): RecognizedShape | null {
  const corners = douglasPeucker(points, size * 0.05);
  if (corners.length < 4) return null;
  const tail = corners[0],
    tip = corners[1];
  const shaft = dist(tail, tip);
  if (shaft < size * 0.6) return null;
  const ux = (tip.x - tail.x) / shaft,
    uy = (tip.y - tail.y) / shaft;
  // The shaft itself must be straight.
  const along = points.slice(0, points.indexOf(tip) + 1);
  if (along.some((p) => segmentDistance(p, tail, tip) > Math.max(2, shaft * 0.06))) return null;
  const rest = corners.slice(2);
  const reach = shaft * 0.5;
  if (rest.some((p) => dist(p, tip) > reach)) return null;
  // Wings: behind the tip, one on each side of the shaft.
  let left = 0,
    right = 0;
  for (const p of rest) {
    const back = (p.x - tip.x) * ux + (p.y - tip.y) * uy;
    const side = (p.x - tip.x) * uy - (p.y - tip.y) * ux;
    const d = dist(p, tip);
    if (d < shaft * 0.06) continue;
    if (back > d * 0.15) return null;
    if (side > d * 0.2) left++;
    else if (side < -d * 0.2) right++;
  }
  if (!left || !right) return null;
  const end = snapLineEnd(tail, tip);
  return { shape: { kind: "line", pts: flat([tail, end]), arrow: "end" }, name: "arrow", error: 0 };
}

// ---- Closed strokes ----

type Candidate = RecognizedShape & { score: number };

function ellipseCandidate(loop: XY[], size: number): Candidate {
  const f = principal(loop);
  const shifted = loop.map((p) => ({ x: p.x - f.cx, y: p.y - f.cy }));
  const e = extents(shifted, f.angle);
  let w = e.w,
    h = e.h;
  let rot = deg(f.angle);
  let name: ShapeName = "ellipse";
  if (Math.abs(w - h) <= Math.max(w, h) * 0.08 || f.spread > 0.9) {
    w = h = (w + h) / 2;
    rot = 0;
    name = "circle";
  } else rot = straighten(rot, 90, 8);
  // Straightened: measure the size again along the new axes.
  if (name === "ellipse") {
    const again = extents(shifted, rad(rot));
    w = again.w;
    h = again.h;
  }
  const shape: InkShape = { kind: "ellipse", box: box(f.cx + e.cx, f.cy + e.cy, w, h, rot) };
  const outline = Array.from({ length: 48 }, (_, i) => {
    const t = (i / 48) * Math.PI * 2;
    const c = Math.cos(rad(rot)),
      s = Math.sin(rad(rot));
    const lx = (Math.cos(t) * w) / 2,
      ly = (Math.sin(t) * h) / 2;
    return { x: shape.box![0] + lx * c - ly * s, y: shape.box![1] + lx * s + ly * c };
  });
  const error = fitError(loop, outline, size);
  return { shape, name, error, score: error };
}

// The dominant edge direction (mod 90°) of a loop, weighted by length.
function edgeDirection(loop: XY[]) {
  let sx = 0,
    sy = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i],
      b = loop[(i + 1) % loop.length];
    const len = dist(a, b);
    const phi = Math.atan2(b.y - a.y, b.x - a.x) * 4;
    sx += Math.cos(phi) * len;
    sy += Math.sin(phi) * len;
  }
  return Math.atan2(sy, sx) / 4;
}
function rectOutline(cx: number, cy: number, w: number, h: number, rot: number, radius: number) {
  const c = Math.cos(rad(rot)),
    s = Math.sin(rad(rot));
  const at = (lx: number, ly: number) => ({ x: cx + lx * c - ly * s, y: cy + lx * s + ly * c });
  if (!radius)
    return [
      at(-w / 2, -h / 2),
      at(w / 2, -h / 2),
      at(w / 2, h / 2),
      at(-w / 2, h / 2),
    ];
  const out: XY[] = [];
  const corners = [
    [w / 2 - radius, -h / 2 + radius, -90],
    [w / 2 - radius, h / 2 - radius, 0],
    [-w / 2 + radius, h / 2 - radius, 90],
    [-w / 2 + radius, -h / 2 + radius, 180],
  ];
  for (const [lx, ly, start] of corners)
    for (let k = 0; k <= 4; k++) {
      const a = rad(start + k * 22.5);
      out.push(at(lx + Math.cos(a) * radius, ly + Math.sin(a) * radius));
    }
  return out;
}
function rectCandidate(loop: XY[], size: number): Candidate {
  const c = principal(loop);
  const shifted = loop.map((p) => ({ x: p.x - c.cx, y: p.y - c.cy }));
  let rot = deg(edgeDirection(loop));
  // Within (-45°, 45°]: a rectangle turned by 90° is the same one, wider.
  rot = snapAngle(straighten(((((rot % 90) + 90) % 90) + 45) % 90 - 45, 90, 7), 15, 2.5);
  if (rot <= -45) rot += 90;
  const e = extents(shifted, rad(rot));
  let { w, h } = e;
  let name: ShapeName = "rectangle";
  if (Math.abs(w - h) <= Math.max(w, h) * 0.08) {
    w = h = (w + h) / 2;
    name = "square";
  }
  const cx = c.cx + e.cx,
    cy = c.cy + e.cy;
  // Rounded corners: how far the stroke stays from each corner.
  const cos = Math.cos(rad(rot)),
    sin = Math.sin(rad(rot));
  const gaps = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([sx, sy]) => {
    const corner = { x: cx + ((sx * w) / 2) * cos - ((sy * h) / 2) * sin, y: cy + ((sx * w) / 2) * sin + ((sy * h) / 2) * cos };
    return Math.min(...loop.map((p) => dist(p, corner)));
  });
  gaps.sort((a, b) => a - b);
  const gap = (gaps[1] + gaps[2]) / 2;
  const sharp = fitError(loop, rectOutline(cx, cy, w, h, rot, 0), size);
  let radius = 0;
  let error = sharp;
  const r = gap / (Math.SQRT2 - 1);
  // Corners rounded almost all the way: that is an ellipse.
  if (gap > Math.min(w, h) * 0.06 && r < Math.min(w, h) * 0.4) {
    const rounded = fitError(loop, rectOutline(cx, cy, w, h, rot, r), size);
    if (rounded < sharp * 0.85) {
      radius = r2(r);
      error = rounded;
      name = "rounded";
    }
  }
  const shape: InkShape = { kind: "rect", box: box(cx, cy, w, h, rot), ...(radius ? { radius } : {}) };
  return { shape, name, error, score: error };
}

// Corners of a closed loop: Douglas–Peucker on both halves (split at the
// point farthest from the start), close corners merged, straight ones dropped.
function loopCorners(loop: XY[], size: number): XY[] {
  const start = loop[0];
  let far = 0;
  loop.forEach((p, i) => {
    if (dist(p, start) > dist(loop[far], start)) far = i;
  });
  const closed = [...loop, start];
  let corners = [...douglasPeucker(closed.slice(0, far + 1), size * 0.055).slice(0, -1), ...douglasPeucker(closed.slice(far), size * 0.055).slice(0, -1)];
  // The start of the stroke is not a corner unless the loop turns there.
  for (let pass = 0; pass < 3; pass++) {
    const kept: XY[] = [];
    corners.forEach((c, i) => {
      const prev = kept.length ? kept[kept.length - 1] : corners[(i - 1 + corners.length) % corners.length];
      const next = corners[(i + 1) % corners.length];
      if (dist(c, prev) < size * 0.1 && kept.length) {
        // Two corners close together: keep their middle.
        kept[kept.length - 1] = { x: (c.x + prev.x) / 2, y: (c.y + prev.y) / 2 };
        return;
      }
      const a1 = Math.atan2(c.y - prev.y, c.x - prev.x),
        a2 = Math.atan2(next.y - c.y, next.x - c.x);
      let turn = Math.abs(deg(a2 - a1)) % 360;
      if (turn > 180) turn = 360 - turn;
      if (turn < 22) return;
      kept.push(c);
    });
    if (kept.length >= 2 && dist(kept[0], kept[kept.length - 1]) < size * 0.1) kept.pop();
    if (kept.length === corners.length) break;
    corners = kept;
  }
  return corners;
}
// Sharper corners: lines fitted to the middle of each edge, intersected.
function refineCorners(loop: XY[], corners: XY[]): XY[] {
  const n = corners.length;
  const lines = corners.map((a, i) => {
    const b = corners[(i + 1) % n];
    const len = dist(a, b);
    const near = loop.filter((p) => segmentDistance(p, a, b) < len * 0.08 && dist(p, a) > len * 0.2 && dist(p, b) > len * 0.2);
    if (near.length < 3) return { p: a, d: { x: (b.x - a.x) / (len || 1), y: (b.y - a.y) / (len || 1) } };
    const f = principal(near);
    return { p: { x: f.cx, y: f.cy }, d: { x: Math.cos(f.angle), y: Math.sin(f.angle) } };
  });
  return corners.map((c, i) => {
    const l1 = lines[(i - 1 + n) % n],
      l2 = lines[i];
    const cross = l1.d.x * l2.d.y - l1.d.y * l2.d.x;
    if (Math.abs(cross) < 0.2) return c;
    const t = ((l2.p.x - l1.p.x) * l2.d.y - (l2.p.y - l1.p.y) * l2.d.x) / cross;
    const p = { x: l1.p.x + t * l1.d.x, y: l1.p.y + t * l1.d.y };
    return dist(p, c) < dist(corners[(i + 1) % n], c) * 0.35 ? p : c;
  });
}
const interiorAngles = (pts: XY[]) =>
  pts.map((c, i) => {
    const a = pts[(i - 1 + pts.length) % pts.length],
      b = pts[(i + 1) % pts.length];
    const v1 = Math.atan2(a.y - c.y, a.x - c.x),
      v2 = Math.atan2(b.y - c.y, b.x - c.x);
    let d = Math.abs(deg(v1 - v2)) % 360;
    if (d > 180) d = 360 - d;
    return d;
  });
function selfIntersecting(pts: XY[]) {
  const n = pts.length;
  const cross = (a: XY, b: XY, c: XY) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  for (let i = 0; i < n; i++)
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const [a, b, c, d] = [pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n]];
      if (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) return true;
    }
  return false;
}
const centroid = (pts: XY[]) => ({ x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length });
const spreadOf = (values: number[]) => {
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return Math.max(...values.map((v) => Math.abs(v - mean))) / (mean || 1);
};

// A regular polygon with `n` corners through the given ones, turned so an
// edge lies flat when it nearly does.
function regular(corners: XY[]): XY[] {
  const n = corners.length;
  const c = centroid(corners);
  const radius = corners.reduce((s, p) => s + dist(p, c), 0) / n;
  // Average phase of the corners (mod 360/n).
  let sx = 0,
    sy = 0;
  for (const p of corners) {
    const a = Math.atan2(p.y - c.y, p.x - c.x) * n;
    sx += Math.cos(a);
    sy += Math.sin(a);
  }
  let phase = deg(Math.atan2(sy, sx) / n);
  // Flat bottom edge: a corner sits at 90° + 180/n (y down).
  const flatPhase = 90 + 180 / n;
  const step = 360 / n;
  const off = ((((phase - flatPhase) % step) + step * 1.5) % step) - step / 2;
  if (Math.abs(off) < 6) phase -= off;
  return Array.from({ length: n }, (_, i) => {
    const a = rad(phase + i * step);
    return { x: c.x + Math.cos(a) * radius, y: c.y + Math.sin(a) * radius };
  });
}
// How far the stroke bulges out of the polygon's edges, on average, as a
// share of the edge length (arcs about 0.07, drawn straight edges near 0).
function bulge(loop: XY[], pts: XY[]) {
  const c = centroid(pts);
  let sum = 0,
    count = 0;
  pts.forEach((a, i) => {
    const b = pts[(i + 1) % pts.length];
    const len = dist(a, b) || 1;
    const nx = (b.y - a.y) / len,
      ny = -(b.x - a.x) / len;
    // The normal pointing away from the centre.
    const out = (a.x - c.x) * nx + (a.y - c.y) * ny > 0 ? 1 : -1;
    for (const p of loop) {
      const t = ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (len * len);
      if (t < 0.15 || t > 0.85 || segmentDistance(p, a, b) > len * 0.3) continue;
      sum += (out * ((p.x - a.x) * nx + (p.y - a.y) * ny)) / len;
      count++;
    }
  });
  return count ? sum / count : 0;
}
// A rectangle through four corners with right angles.
function quadRect(pts: XY[], error: number): Candidate {
  let rot = deg(edgeDirection(pts));
  rot = snapAngle(straighten(((((rot % 90) + 90) % 90) + 45) % 90 - 45, 90, 7), 15, 2.5);
  if (rot <= -45) rot += 90;
  const c = centroid(pts);
  const e = extents(
    pts.map((p) => ({ x: p.x - c.x, y: p.y - c.y })),
    rad(rot),
  );
  // Sides from the mean of opposite edges (the corners, not their extremes).
  const cos = Math.cos(rad(rot)),
    sin = Math.sin(rad(rot));
  const local = pts.map((p) => ({ u: (p.x - c.x) * cos + (p.y - c.y) * sin, v: -(p.x - c.x) * sin + (p.y - c.y) * cos }));
  const mean = (list: number[]) => list.reduce((s, v) => s + v, 0) / list.length;
  let w = mean(local.filter((p) => p.u > 0).map((p) => p.u)) - mean(local.filter((p) => p.u <= 0).map((p) => p.u));
  let h = mean(local.filter((p) => p.v > 0).map((p) => p.v)) - mean(local.filter((p) => p.v <= 0).map((p) => p.v));
  if (!Number.isFinite(w) || !Number.isFinite(h)) ({ w, h } = e);
  let name: ShapeName = "rectangle";
  if (Math.abs(w - h) <= Math.max(w, h) * 0.08) {
    w = h = (w + h) / 2;
    name = "square";
  }
  return { shape: { kind: "rect", box: box(c.x, c.y, w, h, rot) }, name, error, score: error * 0.95 };
}
function polygonCandidate(loop: XY[], size: number): Candidate | null {
  const raw = loopCorners(loop, size);
  if (raw.length < 3 || raw.length > 8 || selfIntersecting(raw)) return null;
  let pts = refineCorners(loop, raw);
  const n = pts.length;
  // Edges bulging out on average are arcs: a round shape, not a polygon.
  if (bulge(loop, pts) > 0.035) return null;
  const error = fitError(loop, pts, size);
  let name: ShapeName = n === 3 ? "triangle" : "polygon";
  const sides = pts.map((p, i) => dist(p, pts[(i + 1) % n]));
  if (n === 4) {
    const c = centroid(pts);
    const angles = interiorAngles(pts);
    // Right angles all round: a rectangle (or square) through the corners.
    if (angles.every((a) => Math.abs(a - 90) < 14)) return quadRect(pts, error);
    // A rhombus with its corners up, right, down, left: a diamond.
    const axis = pts.map((p) => Math.abs(deg(Math.atan2(p.y - c.y, p.x - c.x))) % 90).map((a) => Math.min(a, 90 - a));
    if (spreadOf(sides) < 0.25 && axis.every((a) => a < 12) && angles.some((a) => Math.abs(a - 90) > 12)) {
      const xs = pts.map((p) => p.x),
        ys = pts.map((p) => p.y);
      const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      const cx = (x0 + x1) / 2,
        cy = (y0 + y1) / 2;
      pts = [
        { x: cx, y: y0 },
        { x: x1, y: cy },
        { x: cx, y: y1 },
        { x: x0, y: cy },
      ];
      name = "diamond";
    }
  } else if (n === 3 && spreadOf(sides) < 0.08) pts = regular(pts);
  else if (n >= 5) {
    const c = centroid(pts);
    if (spreadOf(pts.map((p) => dist(p, c))) < 0.12 && spreadOf(sides) < 0.2) pts = regular(pts);
  }
  // Polygons are a little less likely than smooth shapes with as good a fit.
  return { shape: { kind: "polygon", pts: flat(pts) }, name, error, score: error * 1.1 + 0.0005 * n };
}
// A star: corners alternating between an outer and an inner radius, or a
// pentagram drawn in one go (five corners, crossing lines).
function starCandidate(loop: XY[], size: number): Candidate | null {
  const corners = loopCorners(loop, size * 0.8);
  const n = corners.length;
  const c = centroid(corners);
  const shapeOf = (points: number, outer: number, inner: number, first: XY): InkShape => {
    const rot = straighten(normDeg(deg(Math.atan2(first.y - c.y, first.x - c.x)) + 90), 360 / points, 10);
    return { kind: "star", box: box(c.x, c.y, outer * 2, outer * 2, rot % (360 / points)), n: points, inner: r2(inner) };
  };
  if (n === 5 && selfIntersecting(corners)) {
    const radii = corners.map((p) => dist(p, c));
    if (spreadOf(radii) > 0.25) return null;
    const outer = radii.reduce((s, r) => s + r, 0) / 5;
    const top = corners.reduce((best, p) => (p.y < best.y ? p : best));
    return { shape: shapeOf(5, outer, 0.382, top), name: "star", error: 0, score: 0.02 };
  }
  if (n < 8 || n > 24 || n % 2) return null;
  const radii = corners.map((p) => dist(p, c));
  const even = radii.filter((_, i) => i % 2 === 0),
    odd = radii.filter((_, i) => i % 2 === 1);
  const [outerList, innerList, offset] = even.reduce((s, r) => s + r, 0) > odd.reduce((s, r) => s + r, 0) ? [even, odd, 0] : [odd, even, 1];
  const outer = outerList.reduce((s, r) => s + r, 0) / outerList.length;
  const inner = innerList.reduce((s, r) => s + r, 0) / innerList.length;
  if (inner / outer > 0.8 || Math.max(...innerList) > Math.min(...outerList) * 0.95 || spreadOf(outerList) > 0.25) return null;
  const top = corners.filter((_, i) => i % 2 === offset).reduce((best, p) => (p.y < best.y ? p : best));
  const shape = shapeOf(n / 2, outer, inner / outer, top);
  const error = fitError(loop, corners, size);
  return { shape, name: "star", error, score: error * 0.9 };
}

export type RecognizeOptions = { minSize?: number };
// The shape a stroke looks like, or null (then it stays as drawn).
export function recognizeShape(input: XY[], { minSize = 10 }: RecognizeOptions = {}): RecognizedShape | null {
  const points = input.filter((p, i) => i === 0 || dist(p, input[i - 1]) > 0.01);
  if (points.length < 3) return null;
  const xs = points.map((p) => p.x),
    ys = points.map((p) => p.y);
  const size = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  if (size < minSize) return null;
  const total = pathLength(points);
  const even = resampleEven(points, 96);
  // Closed: the end comes back near the start, or the stroke runs over its
  // start again after most of the way (then the overshoot is cut).
  let closedAt = -1;
  if (dist(points[0], points[points.length - 1]) < size * 0.22 && total > size * 2) closedAt = even.length - 1;
  else
    for (let i = Math.floor(even.length * 0.6); i < even.length; i++)
      if (dist(even[i], even[0]) < size * 0.1) {
        closedAt = i;
        break;
      }
  if (closedAt < 0) return recognizeLine(points) || recognizeArrow(even, size);
  const loop = resampleEven(even.slice(0, closedAt + 1), 72).slice(0, -1);
  const candidates = [ellipseCandidate(loop, size), rectCandidate(loop, size), polygonCandidate(loop, size), starCandidate(loop, size)].filter(
    (c): c is Candidate => !!c,
  );
  candidates.sort((a, b) => a.score - b.score);
  const best = candidates[0];
  if (!best || best.error > 0.05) return null;
  const { score: _score, ...result } = best;
  void _score;
  return result;
}

// A shape continued while the pen still rests after snapping: lines follow
// the pen with their end, other shapes grow or shrink about their centre.
export function followPen(shape: InkShape, start: XY, now: XY): InkShape {
  if (shape.kind === "line" && shape.pts) {
    const a = { x: shape.pts[0], y: shape.pts[1] };
    const b = { x: shape.pts[2] + now.x - start.x, y: shape.pts[3] + now.y - start.y };
    return { ...shape, pts: flat([a, snapLineEnd(a, b)]) };
  }
  const c = shape.box ? { x: shape.box[0], y: shape.box[1] } : centroid(Array.from({ length: (shape.pts?.length || 0) / 2 }, (_, i) => ({ x: shape.pts![i * 2], y: shape.pts![i * 2 + 1] })));
  const factor = Math.max(0.1, dist(now, c) / Math.max(1, dist(start, c)));
  if (shape.box) {
    const [x, y, w, h, rot] = shape.box;
    return { ...shape, box: [x, y, r2(w * factor), r2(h * factor), rot], ...(shape.radius ? { radius: r2(shape.radius * factor) } : {}) };
  }
  return { ...shape, pts: shape.pts!.map((v, i) => r2((i % 2 ? c.y : c.x) + (v - (i % 2 ? c.y : c.x)) * factor)) };
}

// ---- The shape tool: a shape dragged from one corner to the other ----

export type ShapeToolKind = "auto" | "line" | "arrow" | "double" | "rect" | "ellipse" | "triangle" | "diamond" | "pentagon" | "hexagon" | "star";
export const SHAPE_TOOL_KINDS: ShapeToolKind[] = ["auto", "line", "arrow", "double", "rect", "ellipse", "triangle", "diamond", "pentagon", "hexagon", "star"];

// The shape between where the drag began and where it is now; squares,
// circles and regular shapes when the sides are within 8 % (or always with
// `even`, e.g. Shift).
export function dragShape(kind: Exclude<ShapeToolKind, "auto">, from: XY, to: XY, { even = false, snap = true } = {}): InkShape {
  if (kind === "line" || kind === "arrow" || kind === "double") {
    const end = snap ? snapLineEnd(from, to) : to;
    return { kind: "line", pts: flat([from, end]), ...(kind === "arrow" ? { arrow: "end" as const } : kind === "double" ? { arrow: "both" as const } : {}) };
  }
  let w = Math.abs(to.x - from.x),
    h = Math.abs(to.y - from.y);
  const regularKind = kind === "pentagon" || kind === "hexagon" || kind === "star";
  if (even || regularKind || (snap && Math.abs(w - h) <= Math.max(w, h) * 0.08)) w = h = Math.max(w, h);
  const x = to.x >= from.x ? from.x : from.x - w,
    y = to.y >= from.y ? from.y : from.y - h;
  const cx = x + w / 2,
    cy = y + h / 2;
  if (kind === "rect" || kind === "ellipse") return { kind, box: box(cx, cy, Math.max(1, w), Math.max(1, h), 0) };
  if (kind === "star") return { kind: "star", box: box(cx, cy, Math.max(1, w), Math.max(1, h), 0), n: 5, inner: 0.45 };
  if (kind === "triangle")
    return {
      kind: "polygon",
      pts: flat([
        { x: cx, y },
        { x: x + w, y: y + h },
        { x, y: y + h },
      ]),
    };
  if (kind === "diamond")
    return {
      kind: "polygon",
      pts: flat([
        { x: cx, y },
        { x: x + w, y: cy },
        { x: cx, y: y + h },
        { x, y: cy },
      ]),
    };
  const n = kind === "pentagon" ? 5 : 6;
  const start = n === 5 ? -90 : 0;
  return {
    kind: "polygon",
    pts: flat(
      Array.from({ length: n }, (_, i) => {
        const a = rad(start + (i * 360) / n);
        return { x: cx + (Math.cos(a) * w) / 2, y: cy + (Math.sin(a) * h) / 2 };
      }),
    ),
  };
}

export { snapAngle };
