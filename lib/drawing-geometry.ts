// The arithmetic of the drawing viewer (#384, components/viewer2d): 2D
// transforms (blocks are inserted with a position, scale and rotation),
// curves turned into polylines (bulges, arcs, ellipses, splines), the view
// (fit, zoom about a point) and snapping to the nearest end or vertex for
// the measuring tool. Pure, for the tests and the parsing worker.

export type Pt = { x: number; y: number };
// An affine transform: x' = a·x + c·y + e, y' = b·x + d·y + f.
export type Mat = [number, number, number, number, number, number];

export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];
const TAU = Math.PI * 2;

// m · n: first n, then m.
export function multiply(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}
export const translation = (x: number, y: number): Mat => [1, 0, 0, 1, x, y];
export const rotation = (angle: number): Mat => [Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), 0, 0];
export const scaling = (sx: number, sy: number): Mat => [sx, 0, 0, sy, 0, 0];
export const apply = (m: Mat, p: Pt): Pt => ({ x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] });

// The transform of a block reference: the block's base point to the
// insertion point, scaled, then rotated about it – DXF's order. `offset`
// places one copy of an array (columns and rows, in the rotated frame).
export function insertTransform(at: Pt, sx: number, sy: number, angle: number, base: Pt = { x: 0, y: 0 }, offset: Pt = { x: 0, y: 0 }): Mat {
  return multiply(
    translation(at.x, at.y),
    multiply(rotation(angle), multiply(translation(offset.x, offset.y), multiply(scaling(sx || 1, sy || 1), translation(-base.x, -base.y)))),
  );
}
// How much a transform enlarges lengths (on average over both axes), and
// the direction its x axis points to – for text heights and angles.
export const matScale = (m: Mat) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
export const matAngle = (m: Mat) => Math.atan2(m[1], m[0]);
// Whether it mirrors (text then still reads left to right, as in CAD).
export const matMirrors = (m: Mat) => m[0] * m[3] - m[1] * m[2] < 0;

// Segments for a sweep of `angle` radians: 128 for a full circle, at
// least 4, at most 1024 for very long arcs.
export function segmentsFor(angle: number) {
  return Math.max(4, Math.min(1024, Math.ceil((Math.abs(angle) / TAU) * 128)));
}

// Points of an arc around `c` from `start` to `end` (radians), counter-
// clockwise; the end is reached even when it is "before" the start.
export function arcPoints(c: Pt, r: number, start: number, end: number, ccw = true): Pt[] {
  let sweep = ccw ? end - start : start - end;
  while (sweep <= 0) sweep += TAU;
  while (sweep > TAU + 1e-9) sweep -= TAU;
  const n = segmentsFor(sweep);
  const dir = ccw ? 1 : -1;
  const points: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const a = start + (dir * sweep * i) / n;
    points.push({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) });
  }
  return points;
}
export function circlePoints(c: Pt, r: number): Pt[] {
  const n = segmentsFor(TAU);
  const points: Pt[] = [];
  for (let i = 0; i <= n; i++) points.push({ x: c.x + r * Math.cos((TAU * i) / n), y: c.y + r * Math.sin((TAU * i) / n) });
  return points;
}

// An ellipse: centre, the end of the major axis (relative to the centre),
// minor/major ratio and the start and end parameter (radians, 0–2π).
export function ellipsePoints(c: Pt, major: Pt, ratio: number, start: number, end: number, ccw = true): Pt[] {
  let sweep = ccw ? end - start : start - end;
  while (sweep <= 0) sweep += TAU;
  while (sweep > TAU + 1e-9) sweep -= TAU;
  const n = segmentsFor(sweep);
  const minor = { x: -major.y * ratio, y: major.x * ratio };
  const dir = ccw ? 1 : -1;
  const points: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = start + (dir * sweep * i) / n;
    const cos = Math.cos(t),
      sin = Math.sin(t);
    points.push({ x: c.x + major.x * cos + minor.x * sin, y: c.y + major.y * cos + minor.y * sin });
  }
  return points;
}

// A polyline vertex's bulge (tan of a quarter of the arc's angle, positive
// counter-clockwise) as the points of the arc from a to b, without a.
export function bulgePoints(a: Pt, b: Pt, bulge: number): Pt[] {
  if (!bulge || !Number.isFinite(bulge)) return [b];
  const chord = Math.hypot(b.x - a.x, b.y - a.y);
  if (chord < 1e-12) return [b];
  const theta = 4 * Math.atan(bulge);
  const r = chord / (2 * Math.sin(Math.abs(theta) / 2));
  // The centre lies on the chord's perpendicular bisector.
  const mx = (a.x + b.x) / 2,
    my = (a.y + b.y) / 2;
  const h = Math.sqrt(Math.max(0, r * r - (chord / 2) ** 2));
  const ux = -(b.y - a.y) / chord,
    uy = (b.x - a.x) / chord;
  // A bulge under 1 (less than a half circle) has its centre on the left
  // of a→b when turning counter-clockwise.
  const side = (bulge > 0 ? 1 : -1) * (Math.abs(bulge) < 1 ? 1 : -1);
  const c = { x: mx + side * h * ux, y: my + side * h * uy };
  const start = Math.atan2(a.y - c.y, a.x - c.x);
  const n = segmentsFor(theta);
  const points: Pt[] = [];
  for (let i = 1; i <= n; i++) {
    const t = start + (theta * i) / n;
    points.push({ x: c.x + r * Math.cos(t), y: c.y + r * Math.sin(t) });
  }
  points[points.length - 1] = b;
  return points;
}
// The points of a polyline with bulges (closed: back to the first vertex).
export function polylinePoints(vertices: (Pt & { bulge?: number })[], closed: boolean): Pt[] {
  if (!vertices.length) return [];
  const points: Pt[] = [{ x: vertices[0].x, y: vertices[0].y }];
  const n = vertices.length;
  for (let i = 1; i < n + (closed ? 1 : 0); i++) {
    const a = vertices[i - 1],
      b = vertices[i % n];
    points.push(...bulgePoints(a, { x: b.x, y: b.y }, a.bulge || 0));
  }
  return points;
}

// A B-spline (NURBS with weights) by de Boor's algorithm, as points.
// Without control points (only fit points), the fit points themselves.
export function splinePoints(degree: number, controls: Pt[], knots: number[], weights?: number[], fit: Pt[] = []): Pt[] {
  const p = Math.max(1, Math.floor(degree) || 3);
  const n = controls.length;
  if (n < 2 || knots.length !== n + p + 1) return n >= 2 ? controls.map((c) => ({ ...c })) : fit.map((f) => ({ ...f }));
  const w = weights && weights.length === n ? weights : null;
  const lo = knots[p],
    hi = knots[n];
  if (!(hi > lo)) return controls.map((c) => ({ ...c }));
  const steps = Math.max(8, Math.min(2048, (n - p) * 16));
  const points: Pt[] = [];
  for (let s = 0; s <= steps; s++) {
    const u = s === steps ? hi : lo + ((hi - lo) * s) / steps;
    // The knot span: knots[k] <= u < knots[k+1], within [p, n-1].
    let k = p;
    while (k < n - 1 && u >= knots[k + 1]) k++;
    const d: [number, number, number][] = [];
    for (let j = 0; j <= p; j++) {
      const c = controls[k - p + j];
      const wj = w ? w[k - p + j] || 1 : 1;
      d.push([c.x * wj, c.y * wj, wj]);
    }
    for (let r = 1; r <= p; r++)
      for (let j = p; j >= r; j--) {
        const i = k - p + j;
        const denom = knots[i + p - r + 1] - knots[i];
        const alpha = denom === 0 ? 0 : (u - knots[i]) / denom;
        for (let q = 0; q < 3; q++) d[j][q] = (1 - alpha) * d[j - 1][q] + alpha * d[j][q];
      }
    const [x, y, wt] = d[p];
    points.push({ x: x / (wt || 1), y: y / (wt || 1) });
  }
  return points;
}

// ---- The view: drawing coordinates (y up) to screen pixels (y down) ----

export type View = { scale: number; x: number; y: number };
// screen = (world − origin) · scale, y flipped; (x, y) is the screen
// position of the world origin.
export const toScreen = (v: View, p: Pt): Pt => ({ x: v.x + p.x * v.scale, y: v.y - p.y * v.scale });
export const toWorld = (v: View, s: Pt): Pt => ({ x: (s.x - v.x) / v.scale, y: (v.y - s.y) / v.scale });

// The view that shows the box [minX, minY, maxX, maxY] whole in a viewport
// of width × height pixels, centred, with a margin.
export function fitView(box: [number, number, number, number] | null, width: number, height: number, margin = 0.06): View {
  if (!box || !(width > 0) || !(height > 0)) return { scale: 1, x: width / 2, y: height / 2 };
  const w = Math.max(box[2] - box[0], 1e-9),
    h = Math.max(box[3] - box[1], 1e-9);
  const usable = 1 - margin * 2;
  let scale = Math.min((width * usable) / w, (height * usable) / h);
  // A single point (or a line along an axis): something sensible.
  if (!Number.isFinite(scale) || scale <= 0) scale = 1;
  if (box[2] - box[0] < 1e-9 && box[3] - box[1] < 1e-9) scale = 1;
  const cx = (box[0] + box[2]) / 2,
    cy = (box[1] + box[3]) / 2;
  return { scale, x: width / 2 - cx * scale, y: height / 2 + cy * scale };
}
// Zoom by `factor` keeping the world point under the screen point `at`
// where it is; the scale stays within [min, max].
export function zoomAt(v: View, factor: number, at: Pt, min = 1e-12, max = 1e12): View {
  const scale = Math.min(max, Math.max(min, v.scale * factor));
  const k = scale / v.scale;
  return { scale, x: at.x - (at.x - v.x) * k, y: at.y - (at.y - v.y) * k };
}
export const panBy = (v: View, dx: number, dy: number): View => ({ ...v, x: v.x + dx, y: v.y + dy });

// ---- Snapping: the nearest end or vertex within a radius ----

// A grid over the snap points (x, y pairs) for quick nearest-point queries.
export class SnapIndex {
  private cells = new Map<number, number[]>();
  private size: number;
  private minX = 0;
  private minY = 0;
  private columns = 1;
  constructor(readonly points: Float64Array) {
    const n = points.length / 2;
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (let i = 0; i < points.length; i += 2) {
      const x = points[i],
        y = points[i + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (!n) {
      this.size = 1;
      return;
    }
    const area = Math.max((maxX - minX) * (maxY - minY), 1e-18);
    // About eight points per cell.
    this.size = Math.max(Math.sqrt((area * 8) / n), (Math.max(maxX - minX, maxY - minY) || 1) / 4096, 1e-9);
    this.minX = minX;
    this.minY = minY;
    this.columns = Math.floor((maxX - minX) / this.size) + 1;
    for (let i = 0; i < n; i++) {
      const key = this.key(points[i * 2], points[i * 2 + 1]);
      const cell = this.cells.get(key);
      if (cell) cell.push(i);
      else this.cells.set(key, [i]);
    }
  }
  private cx = (x: number) => Math.floor((x - this.minX) / this.size);
  private cy = (y: number) => Math.floor((y - this.minY) / this.size);
  private key(x: number, y: number) {
    return this.cy(y) * this.columns + this.cx(x);
  }
  // The nearest point within `radius` of (x, y), or null.
  nearest(x: number, y: number, radius: number): Pt | null {
    const points = this.points;
    let best = -1,
      bestD = radius * radius;
    const visit = (i: number) => {
      const dx = points[i * 2] - x,
        dy = points[i * 2 + 1] - y;
      const d = dx * dx + dy * dy;
      if (d <= bestD) {
        bestD = d;
        best = i;
      }
    };
    const x0 = this.cx(x - radius),
      x1 = this.cx(x + radius),
      y0 = this.cy(y - radius),
      y1 = this.cy(y + radius);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 4096) for (let i = 0; i < points.length / 2; i++) visit(i);
    else
      for (let gy = y0; gy <= y1; gy++)
        for (let gx = Math.max(0, x0); gx <= Math.min(this.columns - 1, x1); gx++) for (const i of this.cells.get(gy * this.columns + gx) || []) visit(i);
    return best < 0 ? null : { x: points[best * 2], y: points[best * 2 + 1] };
  }
}

// The distance of two points and its parts along the axes.
export function measure(a: Pt, b: Pt) {
  return { distance: Math.hypot(b.x - a.x, b.y - a.y), dx: Math.abs(b.x - a.x), dy: Math.abs(b.y - a.y) };
}
