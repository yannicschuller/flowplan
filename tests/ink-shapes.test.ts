// Shapes and the ruler of the ink engine: recognising hand-drawn shapes
// (lib/ink/shape-recognize.ts), shape geometry, editing and snapping
// (lib/ink/shapes.ts), the stored form with its fallback for versions
// without shapes, exports, and the ruler, protractor and compass (lib/ink/ruler.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";
import { recognizeShape, dragShape, followPen } from "../lib/ink/shape-recognize";
import {
  cleanShape,
  dragHandle,
  magnetShape,
  shapeAnchors,
  shapeHandles,
  shapeOutline,
  shapeParts,
  shapePoints,
  shapeVertices,
  snapAngle,
  snapLineEnd,
  affineShape,
  type InkShape,
  type XY,
} from "../lib/ink/shapes";
import { erasePartial, hitItem, itemBounds, snapShape, snapStroke, toFreehand, transformItems, withShape } from "../lib/ink/geometry";
import { parseInk, serializeInk, type InkDoc, type InkStroke } from "../lib/ink/model";
import { keepShapes, mergeInk } from "../lib/ink/merge";
import { inkSvg } from "../lib/ink/svg";
import { drawInk, inkPdfContext } from "../lib/ink/pdf-export";
import {
  PT_PER_CM,
  anglesBetween,
  arcPoints,
  defaultUnit,
  edgeNear,
  measure,
  projectOnLine,
  protractorReading,
  raysThrough,
  rulerEdges,
  rulerTicks,
  shownAngle,
  snapRadius,
  snapRulerAngle,
  straightSegments,
  unwrapAngle,
  type RulerState,
} from "../lib/ink/ruler";
import { cornerScale, isShape, itemAt, pinchTransform, rotation, setItemsWidth, transformSelected, translation } from "../lib/ink/selection";
import { eraseWith } from "../lib/ink/eraser";

// ---- Synthetic hand drawing ----
let seed = 1;
const rnd = () => {
  seed = (seed * 16807) % 2147483647;
  return seed / 2147483647;
};
const along = (pts: XY[], closed = true, steps = 20) => {
  const out: XY[] = [];
  const list = closed ? [...pts, pts[0]] : pts;
  for (let i = 1; i < list.length; i++)
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      out.push({ x: list[i - 1].x + (list[i].x - list[i - 1].x) * t, y: list[i - 1].y + (list[i].y - list[i - 1].y) * t });
    }
  out.push(list[list.length - 1]);
  return out;
};
// A shaky hand: smoothed random drift.
const wobble = (pts: XY[], amp: number) => {
  let ox = 0,
    oy = 0;
  return pts.map((p) => {
    ox = ox * 0.8 + (rnd() - 0.5) * amp;
    oy = oy * 0.8 + (rnd() - 0.5) * amp;
    return { x: p.x + ox, y: p.y + oy };
  });
};
const ellipse = (cx: number, cy: number, a: number, b: number, rot = 0, sweep = 1, n = 80) =>
  Array.from({ length: Math.round(n * sweep) + 1 }, (_, i) => {
    const t = (i / n) * Math.PI * 2;
    const [c, s] = [Math.cos(rot), Math.sin(rot)];
    const [x, y] = [Math.cos(t) * a, Math.sin(t) * b];
    return { x: cx + x * c - y * s, y: cy + x * s + y * c };
  });
const regularPts = (n: number, r: number, start: number) =>
  Array.from({ length: n }, (_, i) => ({ x: 100 + Math.cos(start + (i * 2 * Math.PI) / n) * r, y: 100 + Math.sin(start + (i * 2 * Math.PI) / n) * r }));
const starPts = (R: number, r: number) =>
  Array.from({ length: 10 }, (_, i) => {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    return { x: 100 + Math.cos(a) * (i % 2 ? r : R), y: 100 + Math.sin(a) * (i % 2 ? r : R) };
  });
const round = (x: number, d = 1) => Math.round(x * 10 ** d) / 10 ** d;

const DRAWINGS: [string, (amp: number) => XY[]][] = [
  ["line", (a) => wobble(along([{ x: 10, y: 10 }, { x: 200, y: 16 }], false, 60), a)],
  ["arrow", (a) => wobble(along([{ x: 10, y: 100 }, { x: 200, y: 100 }, { x: 180, y: 88 }, { x: 200, y: 100 }, { x: 181, y: 113 }], false, 20), a / 2)],
  ["circle", (a) => wobble(ellipse(100, 100, 60, 62, 0, 1.05), a)],
  ["ellipse", (a) => wobble(ellipse(100, 100, 90, 45, 0.05, 1.03), a)],
  ["rectangle", (a) => wobble(along([{ x: 10, y: 10 }, { x: 210, y: 12 }, { x: 208, y: 110 }, { x: 12, y: 108 }]), a)],
  ["triangle", (a) => wobble(along([{ x: 100, y: 10 }, { x: 190, y: 160 }, { x: 10, y: 160 }]), a)],
  ["diamond", (a) => wobble(along([{ x: 100, y: 0 }, { x: 170, y: 100 }, { x: 100, y: 200 }, { x: 30, y: 100 }]), a)],
  ["polygon", (a) => wobble(along(regularPts(6, 80, 0)), a * 0.7)],
  ["star", (a) => wobble(along(starPts(90, 38), true, 10), a * 0.7)],
];

test("recognises lines, arrows, circles, ellipses, rectangles, triangles, diamonds, polygons and stars – shaky hands too", () => {
  for (const [name, draw] of DRAWINGS) {
    let hits = 0;
    for (let run = 0; run < 12; run++) {
      seed = 1000 + run * 7919;
      const r = recognizeShape(draw(3));
      if (r?.name === name || (name === "circle" && r?.name === "circle")) hits++;
    }
    assert.ok(hits >= 10, `${name}: ${hits}/12`);
  }
});

test("leaves scribbles, zigzags, spirals and open arcs as drawn", () => {
  const scribble = Array.from({ length: 100 }, (_, i) => ({ x: i * 2, y: Math.sin(i / 5) * 30 }));
  const zigzag = along([{ x: 0, y: 0 }, { x: 50, y: 60 }, { x: 100, y: 0 }, { x: 150, y: 60 }], false);
  const spiral = Array.from({ length: 200 }, (_, i) => ({ x: 100 + Math.cos(i / 10) * (20 + i / 2), y: 100 + Math.sin(i / 10) * (20 + i / 2) }));
  const arc = ellipse(100, 100, 60, 60, 0, 0.7);
  for (const pts of [scribble, zigzag, spiral, arc]) assert.equal(recognizeShape(pts), null);
  // Too small to mean a shape.
  assert.equal(recognizeShape([{ x: 0, y: 0 }, { x: 3, y: 1 }, { x: 6, y: 0 }]), null);
});

test("tidies: perfect circles and squares within 8 %, straight edges, 15° lines, regular polygons", () => {
  seed = 42;
  const circle = recognizeShape(wobble(ellipse(100, 100, 60, 64, 0, 1.04), 2))!;
  assert.equal(circle.name, "circle");
  assert.equal(circle.shape.box![2], circle.shape.box![3]);
  const square = recognizeShape(along([{ x: 0, y: 0 }, { x: 100, y: 1 }, { x: 101, y: 96 }, { x: 1, y: 95 }]))!;
  assert.equal(square.name, "square");
  assert.equal(square.shape.kind, "rect");
  assert.equal(square.shape.box![2], square.shape.box![3]);
  assert.equal(square.shape.box![4], 0);
  // An ellipse clearly wider than high stays one.
  assert.equal(recognizeShape(ellipse(100, 100, 80, 50, 0, 1.02))!.name, "ellipse");
  // A rectangle turned by 44° lies at 45°.
  const turned = recognizeShape(along([{ x: 100, y: 0 }, { x: 200, y: 100 }, { x: 150, y: 150 }, { x: 50, y: 50 }]))!;
  assert.equal(turned.shape.box![4], 45);
  // A line at 43° goes to 45°, its start stays.
  const line = recognizeShape(along([{ x: 0, y: 0 }, { x: 100, y: 93.25 }], false))!;
  const [x1, y1, x2, y2] = line.shape.pts!;
  assert.equal(round((Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI), 45);
  // A rough hexagon becomes a regular one.
  const hex = recognizeShape(along(regularPts(6, 80, 0.03).map((p, i) => ({ x: p.x + (i % 2) * 2, y: p.y })), true))!;
  const v = shapeVertices(hex.shape);
  const sides = v.map((p, i) => Math.hypot(p.x - v[(i + 1) % 6].x, p.y - v[(i + 1) % 6].y));
  assert.ok(Math.max(...sides) - Math.min(...sides) < 0.01);
  // Rounded corners are kept as a radius.
  const r = 25;
  const rounded: XY[] = [];
  for (const [cx, cy, s] of [[200 - r, r, -90], [200 - r, 120 - r, 0], [r, 120 - r, 90], [r, r, 180]])
    for (let k = 0; k <= 10; k++) rounded.push({ x: cx + Math.cos(((s + k * 9) * Math.PI) / 180) * r, y: cy + Math.sin(((s + k * 9) * Math.PI) / 180) * r });
  const rr = recognizeShape(along(rounded, true, 3))!;
  assert.equal(rr.name, "rounded");
  assert.ok(Math.abs(rr.shape.radius! - r) < 6);
  // A pentagram drawn in one go is a star.
  const pentagram = [0, 2, 4, 1, 3].map((i) => ({ x: 100 + Math.cos(-Math.PI / 2 + (i * 2 * Math.PI) / 5) * 90, y: 100 + Math.sin(-Math.PI / 2 + (i * 2 * Math.PI) / 5) * 90 }));
  const star = recognizeShape(along(pentagram, true, 25))!;
  assert.equal(star.shape.kind, "star");
  assert.equal(star.shape.n, 5);
});

test("snapping helpers: angles, line ends, magnets", () => {
  assert.equal(snapAngle(43), 45);
  assert.equal(snapAngle(28), 30);
  assert.equal(snapAngle(25), 25);
  const end = snapLineEnd({ x: 0, y: 0 }, { x: 100, y: 3 });
  assert.equal(round(end.y), 0);
  assert.equal(round(end.x), 100);
  const line: InkShape = { kind: "line", pts: [0, 0, 98, 2] };
  assert.deepEqual(magnetShape(line, [{ x: 100, y: 0 }], 5).pts, [0, 0, 100, 0]);
  assert.equal(magnetShape(line, [{ x: 200, y: 0 }], 5), line);
  const rect: InkShape = { kind: "rect", box: [50, 50, 100, 60, 0] };
  assert.deepEqual(shapeAnchors(rect).map((p) => [round(p.x), round(p.y)]), [[0, 20], [100, 20], [100, 80], [0, 80]]);
  // The stroke snaps onto a corner of another shape.
  const pen = (pts: XY[]): InkStroke => ({ id: "s", type: "pen", color: "#1f1f1f", width: 2, points: pts.flatMap((p) => [p.x, p.y, 0.5]) });
  const snapped = snapStroke(pen(along([{ x: 3, y: 18 }, { x: 0, y: 150 }], false)), { anchors: shapeAnchors(rect), tolerance: 6 })!;
  assert.deepEqual(snapped.shape!.pts!.slice(0, 2), [0, 20]);
  assert.equal(snapShape(pen(along([{ x: 3, y: 18 }, { x: 0, y: 150 }], false)))!.name, "line");
});

test("the shape tool: drags from corner to corner", () => {
  const rect = dragShape("rect", { x: 10, y: 10 }, { x: 110, y: 70 });
  assert.deepEqual(rect.box, [60, 40, 100, 60, 0]);
  // Almost square: square.
  assert.deepEqual(dragShape("ellipse", { x: 0, y: 0 }, { x: 100, y: 95 }).box!.slice(2, 4), [100, 100]);
  // Dragged up and left.
  assert.deepEqual(dragShape("rect", { x: 100, y: 100 }, { x: 40, y: 70 }).box, [70, 85, 60, 30, 0]);
  assert.equal(dragShape("double", { x: 0, y: 0 }, { x: 50, y: 1 }).arrow, "both");
  assert.equal(shapeVertices(dragShape("hexagon", { x: 0, y: 0 }, { x: 100, y: 80 })).length, 6);
  assert.equal(dragShape("star", { x: 0, y: 0 }, { x: 100, y: 100 }).kind, "star");
  // Moving on after snapping: lines follow with their end, shapes grow.
  const grown = followPen({ kind: "ellipse", box: [0, 0, 20, 20, 0] }, { x: 10, y: 0 }, { x: 20, y: 0 });
  assert.deepEqual(grown.box!.slice(2, 4), [40, 40]);
  const longer = followPen({ kind: "line", pts: [0, 0, 100, 0] }, { x: 100, y: 0 }, { x: 150, y: 2 });
  assert.deepEqual(longer.pts!.map((v) => round(v)), [0, 0, 150, 0]);
});

test("editing: corners resize (squares within 8 %), rotate snaps to 15°, ends move with magnets", () => {
  const rect: InkShape = { kind: "rect", box: [50, 50, 100, 60, 0] };
  // Bottom right corner dragged by (20, 10): the top left stays.
  const bigger = dragHandle(rect, "c2", { x: 100, y: 80 }, { x: 120, y: 90 });
  assert.deepEqual(bigger.box, [60, 55, 120, 70, 0]);
  const square = dragHandle(rect, "c2", { x: 100, y: 80 }, { x: 100, y: 116 });
  assert.equal(square.box![2], square.box![3]);
  // Rotating by about 43°: 45°.
  const handle = shapeHandles(rect, 20).find((h) => h.id === "rotate")!;
  const c = { x: 50, y: 50 };
  const a = (43 * Math.PI) / 180;
  const to = { x: c.x + (handle.x - c.x) * Math.cos(a) - (handle.y - c.y) * Math.sin(a), y: c.y + (handle.x - c.x) * Math.sin(a) + (handle.y - c.y) * Math.cos(a) };
  assert.equal(dragHandle(rect, "rotate", handle, to).box![4], 45);
  const line: InkShape = { kind: "line", pts: [0, 0, 100, 0] };
  assert.deepEqual(dragHandle(line, "v1", { x: 100, y: 0 }, { x: 100, y: 4 }).pts!.map((v) => round(v)), [0, 0, 100.1, 0]);
  assert.deepEqual(dragHandle(line, "v1", { x: 100, y: 0 }, { x: 140, y: 38 }, { anchors: [{ x: 142, y: 40 }], tolerance: 5 }).pts, [0, 0, 142, 40]);
  // Moving the whole shape pulls a corner onto an anchor nearby.
  const moved = dragHandle(rect, "move", { x: 0, y: 0 }, { x: 10, y: 10 }, { anchors: [{ x: 12, y: 32 }], tolerance: 5 });
  assert.deepEqual(moved.box!.slice(0, 2), [62, 62]);
  const tri: InkShape = { kind: "polygon", pts: [0, 0, 100, 0, 50, 80] };
  assert.deepEqual(dragHandle(tri, "v2", { x: 50, y: 80 }, { x: 60, y: 90 }).pts, [0, 0, 100, 0, 60, 90]);
  assert.equal(shapeHandles(tri, 20).length, 5);
});

test("stored form: a pen stroke with `shape`; older versions keep the outline", () => {
  const shape: InkShape = { kind: "rect", box: [50, 50, 100, 60, 0], fill: "#1c5fd6", dash: "dash", radius: 8 };
  const stroke = withShape({ id: "r1", type: "pen", color: "#e03131", width: 2, points: [] }, shape);
  assert.ok(stroke.points.length > 12);
  const doc = parseInk(serializeInk({ format: "flowplan-ink", version: 1, unit: "pt", pages: { "1": [stroke] } }));
  assert.deepEqual(doc.pages["1"][0], stroke);
  // Junk in a shape: the stroke stays, without the shape.
  const junk = parseInk({ pages: { "1": [{ ...stroke, shape: { kind: "blob" } }] } });
  assert.equal((junk.pages["1"][0] as InkStroke).shape, undefined);
  assert.equal((junk.pages["1"][0] as InkStroke).points.length, stroke.points.length);
  // A highlighter carries no shape.
  assert.equal((parseInk({ pages: { "1": [{ ...stroke, type: "highlighter" }] } }).pages["1"][0] as InkStroke).shape, undefined);
  assert.equal(cleanShape({ kind: "polygon", pts: [0, 0, 1, 1] }), undefined);
  assert.equal(cleanShape({ kind: "star", box: [0, 0, 10, 10, 370], n: 50 })!.n, 12);
  assert.equal(cleanShape({ kind: "star", box: [0, 0, 10, 10, 370] })!.box![4], 10);
  // The outline runs closed; arrow heads are drawn there and back.
  const outline = shapeOutline({ kind: "line", pts: [0, 0, 100, 0], arrow: "both" });
  assert.equal(outline.length, 2 + 3 + 4);
  assert.equal(shapePoints({ kind: "rect", box: [0, 0, 10, 10, 0] }).length, 5 * 3);
});

test("a save from a version without shapes gets them back when the stroke is unchanged", () => {
  const shaped = withShape({ id: "r1", type: "pen", color: "#e03131", width: 2, points: [] }, { kind: "ellipse", box: [50, 50, 40, 40, 0], fill: "#2f9e44" });
  const stored: InkDoc = { format: "flowplan-ink", version: 1, unit: "pt", pages: { s: [shaped] } };
  const { shape: _shape, ...plain } = shaped;
  void _shape;
  const old: InkDoc = { ...stored, pages: { s: [plain, { id: "n1", type: "pen", color: "#1f1f1f", width: 1, points: [0, 0, 0.5, 5, 5, 0.5] }] } };
  const kept = keepShapes(stored, old);
  assert.deepEqual((kept.pages.s[0] as InkStroke).shape, shaped.shape);
  assert.equal(kept.pages.s.length, 2);
  // Moved by the older version: stays a plain stroke at the new place.
  const moved = { ...plain, points: plain.points.map((v, i) => (i % 3 === 0 ? v + 10 : v)) };
  assert.equal((keepShapes(stored, { ...stored, pages: { s: [moved] } }).pages.s[0] as InkStroke).shape, undefined);
  assert.equal(keepShapes(null, old), old);
  // Merging keeps shape edits as whole items.
  const edited = withShape(shaped, { ...shaped.shape!, fill: "#7048e8" });
  const merged = mergeInk(stored, { ...stored, pages: { s: [edited] } }, stored);
  assert.equal((merged.pages.s[0] as InkStroke).shape!.fill, "#7048e8");
});

test("shapes move, scale, erase, hit and export like strokes", async () => {
  const shaped = withShape({ id: "r1", type: "pen", color: "#e03131", width: 2, points: [] }, { kind: "rect", box: [50, 50, 100, 60, 0], fill: "#1c5fd6", dash: "dot" });
  const [scaled] = transformItems([shaped], new Set(["r1"]), { scale: 2, ox: 0, oy: 0, dx: 5 }) as InkStroke[];
  assert.deepEqual(scaled.shape!.box, [105, 100, 200, 120, 0]);
  assert.equal(scaled.width, 4);
  assert.deepEqual(scaled.points.slice(0, 2), [5, 40]);
  // Filled: a tap inside hits; unfilled: only the outline.
  assert.ok(hitItem(shaped, { x: 50, y: 50 }, 2));
  assert.ok(!hitItem(toFreehand(shaped), { x: 50, y: 50 }, 2));
  assert.deepEqual(itemBounds(shaped).w > 100, true);
  // The partial eraser leaves freehand pieces.
  const pieces = erasePartial([shaped], [{ x: 50, y: 20 }], 5) as InkStroke[];
  assert.ok(pieces.length >= 1 && pieces.every((p) => !p.shape));
  const svg = inkSvg([shaped, withShape({ id: "l", type: "pen", color: "#1f1f1f", width: 1, points: [] }, { kind: "line", pts: [0, 0, 50, 50], arrow: "end" })], { width: 200, height: 200 });
  assert.match(svg, /fill="#1c5fd6" fill-opacity="0.25"/);
  assert.match(svg, /stroke-dasharray="0\.01 /);
  assert.equal(svg.match(/<path/g)!.length, 3);
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([200, 200]);
  await drawInk(inkPdfContext(pdf), page, [shaped], [1, 0, 0, -1, 0, 200]);
  assert.ok((await pdf.save()).length > 500);
  assert.equal(shapeParts({ kind: "star", box: [0, 0, 10, 10, 0], n: 6, inner: 0.5 }).body.length, 12);
});

test("ruler: edges, straightening along them, angles, scale in the paper's units", () => {
  const size = { width: 595.28, height: 841.89 };
  const state: RulerState = { page: "1", x: 300, y: 400, angle: 0, mode: "ruler", radius: 85, unit: "cm" };
  const [top, bottom] = rulerEdges(state, size);
  assert.equal(round(top.a.y), round(400 - 1.1 * PT_PER_CM));
  assert.ok(Math.abs(bottom.b.x - top.b.x) < 1e-9);
  assert.deepEqual(edgeNear(state, size, { x: 300, y: top.a.y - 5 }, 10), top);
  assert.equal(edgeNear(state, size, { x: 300, y: 300 }, 10), null);
  assert.deepEqual(projectOnLine({ x: 10, y: 7 }, { x: 0, y: 0 }, { x: 100, y: 0 }), { x: 10, y: 0 });
  assert.equal(snapRulerAngle(43.5), 45);
  assert.equal(snapRulerAngle(61), 60);
  assert.equal(snapRulerAngle(52), 52);
  assert.equal(snapRulerAngle(-1), 0);
  assert.equal(shownAngle(135), 45);
  assert.equal(measure(PT_PER_CM * 12.34, "cm"), 12.3);
  assert.equal(measure(72 * 2.5, "in"), 2.5);
  assert.equal(defaultUnit({ width: 612, height: 792 }), "in");
  assert.equal(defaultUnit(size), "cm");
  // Millimetres when there is room, labels each centimetre.
  const fine = rulerTicks(PT_PER_CM * 3, "cm", 2);
  assert.equal(fine.length, 31);
  assert.deepEqual(fine.filter((t) => t.label).map((t) => t.label), ["0", "1", "2", "3"]);
  assert.equal(rulerTicks(PT_PER_CM * 3, "cm", 0.5).length, 7);
  assert.equal(rulerTicks(72, "in", 2).length, 17);
  // The set square has three edges.
  assert.equal(rulerEdges({ ...state, mode: "protractor" }, size).length, 3);
});

test("protractor: angles between lines through the zero point", () => {
  const segments = straightSegments([
    withShape({ id: "a", type: "pen", color: "#1f1f1f", width: 1, points: [] }, { kind: "line", pts: [0, 100, 200, 100] }),
    withShape({ id: "b", type: "pen", color: "#1f1f1f", width: 1, points: [] }, { kind: "line", pts: [100, 100, 150, 100 - 50 * Math.tan(Math.PI / 3)] }),
    // A freehand straight stroke counts too; a curve does not.
    { id: "c", type: "pen", color: "#1f1f1f", width: 1, points: [0, 0, 0.5, 50, 1, 0.5, 100, 2, 0.5] },
    { id: "d", type: "pen", color: "#1f1f1f", width: 1, points: [0, 0, 0.5, 50, 40, 0.5, 100, 0, 0.5] },
  ]);
  assert.equal(segments.length, 3);
  const rays = raysThrough(segments, { x: 100, y: 100 }, 3);
  assert.deepEqual(rays.map((r) => round(r)), [0, 180, 300]);
  assert.deepEqual(anglesBetween(rays).map((a) => round(a.sweep)), [180, 120, 60]);
  assert.equal(protractorReading({ angle: 0 }, 300), 60);
  assert.equal(protractorReading({ angle: 0 }, 30), null);
});

test("compass: arcs without jumps, radius in millimetres", () => {
  assert.equal(unwrapAngle(170, -170), 190);
  assert.equal(unwrapAngle(-170, 170), -190);
  const arc = arcPoints({ x: 0, y: 0, radius: 50 }, 0, 90);
  assert.equal(arc.length, 46);
  assert.ok(arc.every((p) => Math.abs(Math.hypot(p.x, p.y) - 50) < 1e-9));
  assert.equal(round(snapRadius(PT_PER_CM * 3.04, "cm") / PT_PER_CM, 2), 3);
  assert.equal(snapRadius(0, "cm"), PT_PER_CM / 10);
});

test("the lasso's selection moves, scales and turns shapes as shapes", () => {
  const rect = withShape({ id: "r", type: "pen", color: "#1f1f1f", width: 2, points: [] }, { kind: "rect", box: [100, 100, 80, 40, 0], radius: 6 });
  const line = withShape({ id: "l", type: "pen", color: "#1f1f1f", width: 2, points: [] }, { kind: "line", pts: [0, 0, 40, 0], arrow: "end" });
  const ids = new Set(["r", "l"]);
  // Turned by 30° around (100, 100): the box keeps its size, the turn goes into its rotation.
  const [r1, l1] = transformSelected([rect, line], ids, rotation(Math.PI / 6, { x: 100, y: 100 })) as InkStroke[];
  assert.deepEqual(r1.shape!.box, [100, 100, 80, 40, 30]);
  assert.equal(r1.shape!.radius, 6);
  assert.equal(r1.shape!.kind, "rect");
  assert.ok(l1.shape!.arrow === "end" && l1.shape!.pts!.length === 4);
  // The outline follows the shape.
  assert.deepEqual(r1.points, withShape(r1, r1.shape!).points);
  // A corner drag scales the upright frame; a turned box takes the scale along its own axes.
  const box = { x: 60, y: 80, w: 80, h: 40 };
  const [r2] = transformSelected([rect], new Set(["r"]), cornerScale(box, "se", { x: 220, y: 120 }, false)) as InkStroke[];
  assert.deepEqual(r2.shape!.box, [140, 100, 160, 40, 0]);
  assert.equal(r2.shape!.radius, 6);
  const [r3] = transformSelected([r1], new Set(["r"]), translation(10, -5)) as InkStroke[];
  assert.deepEqual(r3.shape!.box, [110, 95, 80, 40, 30]);
  // Pinch: uniform scale and turn.
  const pinched = affineShape({ kind: "ellipse", box: [0, 0, 20, 10, 0] }, pinchTransform([{ x: -10, y: 0 }, { x: 10, y: 0 }], [{ x: 0, y: -20 }, { x: 0, y: 20 }]));
  assert.deepEqual(pinched.box, [0, 0, 40, 20, 90]);
  // Width steps redraw the outline (arrow heads depend on the width).
  const [wide] = setItemsWidth([line], new Set(["l"]), 2) as InkStroke[];
  assert.ok(wide.shape && wide.width !== line.width);
  assert.deepEqual(wide.points, withShape(wide, wide.shape!).points);
});

test("one picking for lasso taps and the shape tool; eraser kinds and shapes", () => {
  const rect = withShape({ id: "r", type: "pen", color: "#1f1f1f", width: 2, points: [] }, { kind: "rect", box: [100, 100, 80, 40, 0] });
  const stroke: InkStroke = { id: "s", type: "pen", color: "#1f1f1f", width: 2, points: [60, 80, 0.5, 140, 80, 0.5] };
  const mark: InkStroke = { id: "h", type: "highlighter", color: "#ffd43b", width: 12, points: [60, 120, 0.5, 140, 120, 0.5] };
  const items = [rect, stroke, mark];
  // The stroke lies on the rectangle's top edge and on top of it: the lasso takes it, the shape tool the shape.
  assert.equal(itemAt(items, { x: 100, y: 80 }, 4), "s");
  assert.equal(itemAt(items, { x: 100, y: 80 }, 4, isShape), "r");
  assert.equal(itemAt(items, { x: 100, y: 100 }, 4, isShape), null);
  const path = [{ x: 140, y: 100 }];
  // Whole strokes: the shape goes as a whole.
  assert.deepEqual(eraseWith(items, path, "stroke", 3).map((i) => i.id), ["s", "h"]);
  // Highlighter only: the shape stays.
  assert.equal(eraseWith(items, path, "highlighter", 3), items);
  // Parts: what is left of the shape is freehand.
  const parts = eraseWith(items, path, "partial", 3) as InkStroke[];
  const rest = parts.filter((i) => i.id !== "s" && i.id !== "h");
  assert.ok(rest.length >= 1 && rest.every((i) => !i.shape && i.type === "pen"));
});
