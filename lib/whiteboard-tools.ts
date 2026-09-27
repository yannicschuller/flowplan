// Geometry for whiteboard tools, kept free of React so it can be tested:
// snapping with guide lines, aligning/distributing/stacking, sorting and
// clustering sticky notes, mind-map layout, recognising drawn shapes and
// the outline of a pressure-sensitive pen stroke.
import type { Point, ShapeKind, WhiteboardItem } from "./whiteboard-model";

type Box = { x: number; y: number; w: number; h: number };
export type Guide = { axis: "x" | "y"; at: number; from: number; to: number };

// ---- Snapping ----

// Moves a box so its edges or centre line up with other items (within
// `tolerance`) or, without a match, with the grid. Returns the offset to
// apply and the guide lines to show.
export function snapBox(
  box: Box,
  others: Box[],
  tolerance: number,
  grid = 0,
): { dx: number; dy: number; guides: Guide[] } {
  const xs = [box.x, box.x + box.w / 2, box.x + box.w];
  const ys = [box.y, box.y + box.h / 2, box.y + box.h];
  let best: { d: number; delta: number; at: number } | null = null;
  let bestY: { d: number; delta: number; at: number } | null = null;
  for (const o of others) {
    for (const target of [o.x, o.x + o.w / 2, o.x + o.w])
      for (const edge of xs) {
        const d = Math.abs(target - edge);
        if (d <= tolerance && (!best || d < best.d)) best = { d, delta: target - edge, at: target };
      }
    for (const target of [o.y, o.y + o.h / 2, o.y + o.h])
      for (const edge of ys) {
        const d = Math.abs(target - edge);
        if (d <= tolerance && (!bestY || d < bestY.d)) bestY = { d, delta: target - edge, at: target };
      }
  }
  let dx = best?.delta ?? 0;
  let dy = bestY?.delta ?? 0;
  if (!best && grid > 0) dx = Math.round(box.x / grid) * grid - box.x;
  if (!bestY && grid > 0) dy = Math.round(box.y / grid) * grid - box.y;
  const guides: Guide[] = [];
  const moved = { ...box, x: box.x + dx, y: box.y + dy };
  if (best) {
    const related = others.filter((o) => [o.x, o.x + o.w / 2, o.x + o.w].some((v) => Math.abs(v - best!.at) < 0.5));
    const top = Math.min(moved.y, ...related.map((o) => o.y));
    const bottom = Math.max(moved.y + moved.h, ...related.map((o) => o.y + o.h));
    guides.push({ axis: "x", at: best.at, from: top - 20, to: bottom + 20 });
  }
  if (bestY) {
    const related = others.filter((o) => [o.y, o.y + o.h / 2, o.y + o.h].some((v) => Math.abs(v - bestY!.at) < 0.5));
    const left = Math.min(moved.x, ...related.map((o) => o.x));
    const right = Math.max(moved.x + moved.w, ...related.map((o) => o.x + o.w));
    guides.push({ axis: "y", at: bestY.at, from: left - 20, to: right + 20 });
  }
  return { dx, dy, guides };
}
export function boundsOf(list: Box[]): Box {
  const x = Math.min(...list.map((i) => i.x));
  const y = Math.min(...list.map((i) => i.y));
  return {
    x,
    y,
    w: Math.max(...list.map((i) => i.x + i.w)) - x,
    h: Math.max(...list.map((i) => i.y + i.h)) - y,
  };
}

// ---- Align, distribute, stack ----

export type AlignMode = "left" | "center" | "right" | "top" | "middle" | "bottom";
export function alignItems(list: (Box & { id: string })[], mode: AlignMode) {
  const b = boundsOf(list);
  return list.map((i) => ({
    id: i.id,
    x:
      mode === "left" ? b.x : mode === "center" ? b.x + (b.w - i.w) / 2 : mode === "right" ? b.x + b.w - i.w : i.x,
    y:
      mode === "top" ? b.y : mode === "middle" ? b.y + (b.h - i.h) / 2 : mode === "bottom" ? b.y + b.h - i.h : i.y,
  }));
}
// Equal gaps between items, in their current order along the axis.
export function distributeItems(list: (Box & { id: string })[], axis: "x" | "y") {
  const size = axis === "x" ? "w" : "h";
  const sorted = [...list].sort((a, b) => a[axis] - b[axis]);
  if (sorted.length < 3) return sorted.map((i) => ({ id: i.id, x: i.x, y: i.y }));
  const first = sorted[0][axis];
  const last = sorted.at(-1)!;
  const total = sorted.reduce((sum, i) => sum + i[size], 0);
  const gap = (last[axis] + last[size] - first - total) / (sorted.length - 1);
  let at = first;
  return sorted.map((i) => {
    const pos = at;
    at += i[size] + gap;
    return { id: i.id, x: axis === "x" ? pos : i.x, y: axis === "y" ? pos : i.y };
  });
}
// A tidy row or column with a fixed gap, starting where the group starts.
export function stackItems(list: (Box & { id: string })[], axis: "x" | "y", gap = 24) {
  const sorted = [...list].sort((a, b) => a[axis] - b[axis] || a[axis === "x" ? "y" : "x"] - b[axis === "x" ? "y" : "x"]);
  const b = boundsOf(list);
  let at = axis === "x" ? b.x : b.y;
  return sorted.map((i) => {
    const pos = at;
    at += (axis === "x" ? i.w : i.h) + gap;
    return { id: i.id, x: axis === "x" ? pos : b.x, y: axis === "y" ? pos : b.y };
  });
}

// ---- Sorting and clustering sticky notes ----

export type ClusterMode = "color" | "author" | "votes" | "grid";
export function clusterItems(
  list: WhiteboardItem[],
  mode: ClusterMode,
  names: (id: string) => string = (id) => id,
  gap = 20,
) {
  if (!list.length) return { positions: [], labels: [] as { text: string; x: number; y: number }[] };
  const start = boundsOf(list);
  const size = Math.max(...list.map((i) => Math.max(i.w, i.h)));
  const cell = size + gap;
  const positions: { id: string; x: number; y: number }[] = [];
  const labels: { text: string; x: number; y: number }[] = [];
  if (mode === "grid" || mode === "votes") {
    const sorted =
      mode === "votes"
        ? [...list].sort((a, b) => Object.keys(b.votes || {}).length - Object.keys(a.votes || {}).length)
        : [...list].sort((a, b) => a.y - b.y || a.x - b.x);
    const columns = Math.max(1, Math.ceil(Math.sqrt(sorted.length)));
    sorted.forEach((item, n) =>
      positions.push({ id: item.id, x: start.x + (n % columns) * cell, y: start.y + Math.floor(n / columns) * cell }),
    );
    return { positions, labels };
  }
  const key = (i: WhiteboardItem) => (mode === "color" ? i.fill || "" : i.author || "");
  const groups = new Map<string, WhiteboardItem[]>();
  for (const item of [...list].sort((a, b) => a.y - b.y || a.x - b.x))
    groups.set(key(item), [...(groups.get(key(item)) || []), item]);
  // One column group per key, notes in a small grid inside it.
  let x = start.x;
  for (const [value, members] of groups) {
    const columns = members.length > 6 ? 2 : 1;
    if (mode === "author") labels.push({ text: value ? names(value) : "Unbekannt", x, y: start.y });
    const top = start.y + (mode === "author" ? 40 : 0);
    members.forEach((item, n) =>
      positions.push({ id: item.id, x: x + (n % columns) * cell, y: top + Math.floor(n / columns) * cell }),
    );
    x += columns * cell + gap * 2;
  }
  return { positions, labels };
}

// ---- Mind maps ----

type Edge = { from: string; to: string };
// Tree to the right of the root: children stacked vertically, each subtree
// as high as its leaves need; siblings keep their current order.
export function mindmapLayout(
  rootId: string,
  items: Map<string, Box>,
  edges: Edge[],
  hGap = 80,
  vGap = 24,
) {
  const children = new Map<string, string[]>();
  for (const e of edges) if (items.has(e.from) && items.has(e.to)) children.set(e.from, [...(children.get(e.from) || []), e.to]);
  const seen = new Set<string>([rootId]);
  const kids = (id: string) =>
    (children.get(id) || [])
      .filter((c) => !seen.has(c) && (seen.add(c), true))
      .sort((a, b) => items.get(a)!.y - items.get(b)!.y);
  const tree = new Map<string, string[]>();
  const build = (id: string) => {
    const list = kids(id);
    tree.set(id, list);
    list.forEach(build);
  };
  build(rootId);
  const height = new Map<string, number>();
  const measure = (id: string): number => {
    const own = items.get(id)!.h;
    const list = tree.get(id) || [];
    const sum = list.reduce((s, c) => s + measure(c), 0) + Math.max(0, list.length - 1) * vGap;
    const h = Math.max(own, sum);
    height.set(id, h);
    return h;
  };
  measure(rootId);
  const out = new Map<string, { x: number; y: number }>();
  const place = (id: string, x: number, top: number) => {
    const box = items.get(id)!;
    const h = height.get(id)!;
    out.set(id, { x, y: top + (h - box.h) / 2 });
    let y = top;
    const list = tree.get(id) || [];
    const sum = list.reduce((s, c) => s + height.get(c)!, 0) + Math.max(0, list.length - 1) * vGap;
    y = top + (h - sum) / 2;
    for (const child of list) {
      place(child, x + box.w + hGap, y);
      y += height.get(child)! + vGap;
    }
  };
  const root = items.get(rootId)!;
  place(rootId, root.x, root.y + root.h / 2 - height.get(rootId)! / 2);
  // Keep the root where it was.
  const moved = out.get(rootId)!;
  const shift = { x: root.x - moved.x, y: root.y - moved.y };
  for (const [id, p] of out) out.set(id, { x: Math.round(p.x + shift.x), y: Math.round(p.y + shift.y) });
  return out;
}
// The root of the tree an item belongs to (following connectors backwards).
export function mindmapRoot(id: string, edges: Edge[]) {
  const parent = new Map(edges.map((e) => [e.to, e.from]));
  let current = id;
  const seen = new Set([id]);
  while (parent.has(current) && !seen.has(parent.get(current)!)) {
    current = parent.get(current)!;
    seen.add(current);
  }
  return current;
}

// ---- Shape recognition ----

function simplify(points: Point[], epsilon: number): Point[] {
  if (points.length < 3) return points;
  const [a, b] = [points[0], points.at(-1)!];
  let index = 0;
  let max = 0;
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i];
    const d = Math.abs((b.y - a.y) * p.x - (b.x - a.x) * p.y + b.x * a.y - b.y * a.x) / len;
    if (d > max) {
      max = d;
      index = i;
    }
  }
  if (max <= epsilon) return [a, b];
  return [...simplify(points.slice(0, index + 1), epsilon).slice(0, -1), ...simplify(points.slice(index), epsilon)];
}
export type Recognized =
  | { kind: "line"; from: Point; to: Point }
  | { kind: "shape"; shape: ShapeKind; box: Box };
// A drawn stroke that looks like a line, rectangle, ellipse, triangle or
// diamond; null for anything else (the stroke stays as drawn).
export function recognizeStroke(points: Point[]): Recognized | null {
  if (points.length < 4) return null;
  const box = boundsOf(points.map((p) => ({ ...p, w: 0, h: 0 })));
  const size = Math.max(box.w, box.h);
  if (size < 24) return null;
  const start = points[0];
  const end = points.at(-1)!;
  const path = points.slice(1).reduce((s, p, i) => s + Math.hypot(p.x - points[i].x, p.y - points[i].y), 0);
  const closed = Math.hypot(start.x - end.x, start.y - end.y) < size * 0.25;
  if (!closed) {
    const straight = Math.hypot(end.x - start.x, end.y - start.y);
    return straight / path > 0.92 ? { kind: "line", from: start, to: end } : null;
  }
  // A closed loop has no chord for Douglas-Peucker: split it at the point
  // farthest from the start and simplify both halves.
  const loop = [...points, start];
  let far = 0;
  loop.forEach((p, i) => {
    if (Math.hypot(p.x - start.x, p.y - start.y) > Math.hypot(loop[far].x - start.x, loop[far].y - start.y)) far = i;
  });
  const corners = [
    ...simplify(loop.slice(0, far + 1), size * 0.1).slice(0, -1),
    ...simplify(loop.slice(far), size * 0.1),
  ];
  // The simplified loop repeats the start point at its end; a corner right
  // at the start may show up as two points close together.
  const merged = corners.filter(
    (c, i) => i === 0 || Math.hypot(c.x - corners[i - 1].x, c.y - corners[i - 1].y) > size * 0.08,
  );
  const count = merged.length - 1;
  const centre = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  const radii = points.map((p) => Math.hypot((p.x - centre.x) / (box.w / 2 || 1), (p.y - centre.y) / (box.h / 2 || 1)));
  const mean = radii.reduce((s, r) => s + r, 0) / radii.length;
  const spread = Math.sqrt(radii.reduce((s, r) => s + (r - mean) ** 2, 0) / radii.length);
  if (count === 3) return { kind: "shape", shape: "triangle", box };
  if (count === 4) {
    // Corners near the middle of the edges: a diamond; near the corners: a rectangle.
    const nearEdgeMiddle = merged.slice(0, 4).filter(
      (c) =>
        (Math.abs(c.x - centre.x) < box.w * 0.2 && (Math.abs(c.y - box.y) < box.h * 0.2 || Math.abs(c.y - box.y - box.h) < box.h * 0.2)) ||
        (Math.abs(c.y - centre.y) < box.h * 0.2 && (Math.abs(c.x - box.x) < box.w * 0.2 || Math.abs(c.x - box.x - box.w) < box.w * 0.2)),
    ).length;
    return { kind: "shape", shape: nearEdgeMiddle >= 3 ? "diamond" : "rectangle", box };
  }
  if (spread < 0.14) return { kind: "shape", shape: "ellipse", box };
  return null;
}

// ---- Pressure-sensitive pen ----

// Outline of a stroke whose width follows the pen pressure (0–1 per point),
// as a closed SVG path around the centre line.
export function pressureOutline(points: { x: number; y: number; p: number }[], width: number) {
  if (points.length < 2) {
    const p = points[0];
    if (!p) return "";
    const r = (width * (0.4 + p.p)) / 2;
    return `M ${p.x - r} ${p.y} a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0`;
  }
  const left: Point[] = [];
  const right: Point[] = [];
  for (let i = 0; i < points.length; i++) {
    const prev = points[Math.max(0, i - 1)];
    const next = points[Math.min(points.length - 1, i + 1)];
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    const len = Math.hypot(dx, dy) || 1;
    const r = (width * (0.35 + 0.9 * points[i].p)) / 2;
    const nx = (-dy / len) * r;
    const ny = (dx / len) * r;
    left.push({ x: points[i].x + nx, y: points[i].y + ny });
    right.push({ x: points[i].x - nx, y: points[i].y - ny });
  }
  const f = (n: number) => Math.round(n * 10) / 10;
  const outline = [...left, ...right.reverse()];
  return `M ${outline.map((p) => `${f(p.x)} ${f(p.y)}`).join(" L ")} Z`;
}
