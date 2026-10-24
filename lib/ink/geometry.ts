// Geometry of ink: stroke outlines (pressure), bounds, hit tests, the
// stroke and partial eraser, lasso selection, moving and resizing, and shape
// snapping (hold the pen at the end of a stroke). All in page units.
import { recognizeStroke } from "../whiteboard-tools";
import { inkId, type InkItem, type InkStroke, type InkText } from "./model";

export type Pt = { x: number; y: number; p: number };
export type Box = { x: number; y: number; w: number; h: number };
type XY = { x: number; y: number };

const round2 = (n: number) => Math.round(n * 100) / 100;

export function strokePoints(stroke: Pick<InkStroke, "points">): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i + 2 < stroke.points.length; i += 3) out.push({ x: stroke.points[i], y: stroke.points[i + 1], p: stroke.points[i + 2] });
  return out;
}
export const flatPoints = (points: Pt[]) => points.flatMap((p) => [round2(p.x), round2(p.y), round2(p.p)]);

// The width of a pen line at a pressure (0–1); 0.5 gives the nominal width.
export const penWidth = (width: number, pressure: number) => width * (0.35 + 1.3 * pressure);
// Does the stroke's width vary (pressure) – then it is drawn as a filled outline.
export function variesInWidth(stroke: InkStroke) {
  if (stroke.type !== "pen") return false;
  for (let i = 5; i < stroke.points.length; i += 3) if (stroke.points[i] !== stroke.points[2]) return true;
  return false;
}
// The constant width of a stroke drawn as a line.
export const lineWidth = (stroke: InkStroke) => (stroke.type === "highlighter" ? stroke.width : penWidth(stroke.width, stroke.points[2] ?? 0.5));

// The outline of a pen stroke whose width follows the pressure, with round
// ends: a closed polygon around the centre line.
export function strokeOutline(points: Pt[], width: number): [number, number][] {
  const radius = (p: Pt) => penWidth(width, p.p) / 2;
  const circle = (c: Pt, r: number, from: number, sweep: number, steps: number) =>
    Array.from({ length: steps - 1 }, (_, k): [number, number] => {
      const a = from + (sweep * (k + 1)) / steps;
      return [c.x + Math.cos(a) * r, c.y + Math.sin(a) * r];
    });
  // Points closer than a tenth of the width add nothing but noise.
  const list: Pt[] = [];
  for (const p of points) {
    const last = list[list.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > width * 0.1) list.push(p);
    else last.p = Math.max(last.p, p.p);
  }
  if (list.length === 1) {
    const r = radius(list[0]);
    return [[list[0].x + r, list[0].y], ...circle(list[0], r, 0, Math.PI * 2, 16)];
  }
  const left: [number, number][] = [];
  const right: [number, number][] = [];
  const normals: XY[] = [];
  for (let i = 0; i < list.length; i++) {
    const prev = list[Math.max(0, i - 1)];
    const next = list[Math.min(list.length - 1, i + 1)];
    const dx = next.x - prev.x,
      dy = next.y - prev.y;
    const len = Math.hypot(dx, dy) || 1;
    const n = { x: -dy / len, y: dx / len };
    normals.push(n);
    const r = radius(list[i]);
    left.push([list[i].x + n.x * r, list[i].y + n.y * r]);
    right.push([list[i].x - n.x * r, list[i].y - n.y * r]);
  }
  const first = list[0],
    last = list[list.length - 1];
  const nEnd = normals[normals.length - 1],
    nStart = normals[0];
  // From the left side around the tip to the right side, and back at the start.
  const endCap = circle(last, radius(last), Math.atan2(nEnd.y, nEnd.x), -Math.PI, 8);
  const startCap = circle(first, radius(first), Math.atan2(-nStart.y, -nStart.x), -Math.PI, 8);
  return [...left, ...endCap, ...right.reverse(), ...startCap];
}

const f1 = (n: number) => Math.round(n * 100) / 100;
export const polygonPath = (poly: [number, number][]) => (poly.length ? `M${poly.map(([x, y]) => `${f1(x)} ${f1(y)}`).join("L")}Z` : "");
export function polylinePath(points: XY[]) {
  if (!points.length) return "";
  if (points.length === 1) return `M${f1(points[0].x)} ${f1(points[0].y)}l0.01 0`;
  return `M${points.map((p) => `${f1(p.x)} ${f1(p.y)}`).join("L")}`;
}
// The SVG path of a stroke and whether it is filled (outline) or stroked.
export function strokePath(stroke: InkStroke): { d: string; fill: boolean } {
  const points = strokePoints(stroke);
  if (variesInWidth(stroke)) return { d: polygonPath(strokeOutline(points, stroke.width)), fill: true };
  return { d: polylinePath(points), fill: false };
}

// ---- Bounds and hits ----

// Text is measured roughly (no fonts on the server): 0.55 em per character.
export function textBox(item: InkText): Box {
  const lines = item.text.split("\n");
  const longest = Math.max(1, ...lines.map((l) => l.length));
  return { x: item.x, y: item.y, w: longest * item.size * 0.55, h: lines.length * item.size * 1.25 };
}
export function itemBounds(item: InkItem): Box {
  if (item.type === "text") return textBox(item);
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < item.points.length; i += 3) {
    minX = Math.min(minX, item.points[i]);
    maxX = Math.max(maxX, item.points[i]);
    minY = Math.min(minY, item.points[i + 1]);
    maxY = Math.max(maxY, item.points[i + 1]);
  }
  const r = (item.type === "highlighter" ? item.width : penWidth(item.width, 1)) / 2;
  return { x: minX - r, y: minY - r, w: maxX - minX + 2 * r, h: maxY - minY + 2 * r };
}
export function unionBox(boxes: Box[]): Box | null {
  if (!boxes.length) return null;
  const x = Math.min(...boxes.map((b) => b.x)),
    y = Math.min(...boxes.map((b) => b.y));
  return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y };
}
function segmentDistance(p: XY, a: XY, b: XY) {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
// Is the item within `tolerance` page units of the point?
export function hitItem(item: InkItem, p: XY, tolerance: number) {
  const box = itemBounds(item);
  if (p.x < box.x - tolerance || p.x > box.x + box.w + tolerance || p.y < box.y - tolerance || p.y > box.y + box.h + tolerance) return false;
  if (item.type === "text") return true;
  const reach = tolerance + lineWidth(item) / 2;
  const pts = strokePoints(item);
  if (pts.length === 1) return Math.hypot(p.x - pts[0].x, p.y - pts[0].y) <= reach;
  for (let i = 1; i < pts.length; i++) if (segmentDistance(p, pts[i - 1], pts[i]) <= reach) return true;
  return false;
}

// ---- Erasers ----

// Stroke eraser: whole items touched by the eraser path go.
export function eraseItems(items: InkItem[], path: XY[], radius: number) {
  const kept = items.filter((item) => !path.some((p) => hitItem(item, p, radius)));
  return kept.length === items.length ? items : kept;
}

// Points no farther apart than `spacing`, so a cut can fall anywhere.
export function resample(points: Pt[], spacing: number): Pt[] {
  if (points.length < 2) return points.slice();
  const out: Pt[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i];
    const steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / spacing);
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, p: a.p + (b.p - a.p) * t });
    }
  }
  return out;
}
// Partial eraser: only the parts of strokes under the eraser go; a stroke
// cut in the middle becomes two. Text touched by it goes as a whole.
export function erasePartial(items: InkItem[], path: XY[], radius: number) {
  let changed = false;
  const out: InkItem[] = [];
  for (const item of items) {
    if (!path.some((p) => hitItem(item, p, radius))) {
      out.push(item);
      continue;
    }
    changed = true;
    if (item.type === "text") continue;
    const reach = radius + lineWidth(item) / 2;
    const points = resample(strokePoints(item), Math.max(0.5, radius / 3));
    let run: Pt[] = [];
    const pieces: Pt[][] = [];
    for (const p of points) {
      if (path.some((e) => Math.hypot(e.x - p.x, e.y - p.y) <= reach)) {
        if (run.length) pieces.push(run);
        run = [];
      } else run.push(p);
    }
    if (run.length) pieces.push(run);
    pieces
      .filter((piece) => piece.length > 1)
      .forEach((piece, i) => out.push({ ...item, id: i ? inkId() : item.id, points: flatPoints(piece) }));
  }
  return changed ? out : items;
}

// ---- Lasso ----

export function insidePolygon(p: XY, polygon: XY[]) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i],
      b = polygon[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
// The items the lasso goes around: most of a stroke's points, the middle of a text.
export function lassoItems(items: InkItem[], polygon: XY[]): string[] {
  if (polygon.length < 3) return [];
  return items
    .filter((item) => {
      if (item.type === "text") {
        const b = textBox(item);
        return insidePolygon({ x: b.x + b.w / 2, y: b.y + b.h / 2 }, polygon);
      }
      const pts = strokePoints(item);
      const inside = pts.filter((p) => insidePolygon(p, polygon)).length;
      return inside > 0 && inside >= pts.length / 2;
    })
    .map((item) => item.id);
}

// Moves the chosen items by (dx, dy) and scales them by `scale` around
// (ox, oy) – line widths and font sizes grow with them.
export function transformItems(items: InkItem[], ids: Set<string>, t: { dx?: number; dy?: number; scale?: number; ox?: number; oy?: number }) {
  const { dx = 0, dy = 0, scale = 1, ox = 0, oy = 0 } = t;
  const mx = (x: number) => round2(ox + (x - ox) * scale + dx);
  const my = (y: number) => round2(oy + (y - oy) * scale + dy);
  return items.map((item): InkItem => {
    if (!ids.has(item.id)) return item;
    if (item.type === "text") return { ...item, x: mx(item.x), y: my(item.y), size: round2(Math.max(2, item.size * scale)) };
    const points = item.points.slice();
    for (let i = 0; i + 2 < points.length; i += 3) {
      points[i] = mx(points[i]);
      points[i + 1] = my(points[i + 1]);
    }
    return { ...item, points, width: round2(Math.max(0.1, item.width * scale)) };
  });
}
export const recolorItems = (items: InkItem[], ids: Set<string>, color: string) =>
  items.map((item) => (ids.has(item.id) && item.type !== "highlighter" ? { ...item, color } : item));
// Copies with new ids (duplicate, paste).
export const copyItems = (items: InkItem[], dx = 0, dy = 0) =>
  items.map((item) => {
    const copy = { ...item, id: inkId() };
    return transformItems([copy], new Set([copy.id]), { dx, dy })[0];
  });

// ---- Shape snapping ----

// The stroke straightened into the shape it looks like (line, rectangle,
// ellipse, triangle, diamond), or null. Uses the whiteboard's recognition.
export function snapStroke(stroke: InkStroke): InkStroke | null {
  const pts = strokePoints(stroke);
  const recognized = recognizeStroke(pts.map((p) => ({ x: p.x, y: p.y })));
  if (!recognized) return null;
  const pressure = round2(pts.reduce((s, p) => s + p.p, 0) / pts.length || 0.5);
  let outline: XY[];
  if (recognized.kind === "line") outline = [recognized.from, recognized.to];
  else {
    const { x, y, w, h } = recognized.box;
    if (recognized.shape === "ellipse")
      outline = Array.from({ length: 73 }, (_, i) => {
        const a = (i / 72) * Math.PI * 2;
        return { x: x + w / 2 + (Math.cos(a) * w) / 2, y: y + h / 2 + (Math.sin(a) * h) / 2 };
      });
    else if (recognized.shape === "triangle")
      outline = [
        { x: x + w / 2, y },
        { x: x + w, y: y + h },
        { x, y: y + h },
        { x: x + w / 2, y },
      ];
    else if (recognized.shape === "diamond")
      outline = [
        { x: x + w / 2, y },
        { x: x + w, y: y + h / 2 },
        { x: x + w / 2, y: y + h },
        { x, y: y + h / 2 },
        { x: x + w / 2, y },
      ];
    else
      outline = [
        { x, y },
        { x: x + w, y },
        { x: x + w, y: y + h },
        { x, y: y + h },
        { x, y },
      ];
  }
  return { ...stroke, points: flatPoints(outline.map((p) => ({ ...p, p: pressure }))) };
}

// Has the pen rested at the end of the stroke: no movement beyond
// `tolerance` during the last `holdMs` of the timed samples?
export function heldStill(samples: { x: number; y: number; t: number }[], now: number, holdMs: number, tolerance: number) {
  if (samples.length < 2) return false;
  const last = samples[samples.length - 1];
  if (now - samples[0].t < holdMs) return false;
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i];
    if (Math.hypot(s.x - last.x, s.y - last.y) > tolerance) return now - samples[i + 1].t >= holdMs;
    if (now - s.t >= holdMs) return true;
  }
  return true;
}
