import { test } from "node:test";
import assert from "node:assert/strict";
import { area, penPath, penPieces, penPolygons, type PenPoint } from "../lib/pen-outline";
import { strokeOutline, type Pt } from "../lib/ink/geometry";
import { pressurePieces } from "../lib/whiteboard-tools";

// #548: Apple Pencil strokes had gaps – pressure strokes are filled shapes
// (finger strokes are plain lines), and one outline around the centre line
// crossed itself at tight turns, so the non-zero fill left holes.

// The non-zero winding number of a point over several polygons.
function winding(polys: [number, number][][], x: number, y: number) {
  let w = 0;
  for (const poly of polys)
    for (let i = 0; i < poly.length; i++) {
      const [x1, y1] = poly[i];
      const [x2, y2] = poly[(i + 1) % poly.length];
      const side = (x2 - x1) * (y - y1) - (x - x1) * (y2 - y1);
      if (y1 <= y) {
        if (y2 > y && side > 0) w++;
      } else if (y2 <= y && side < 0) w--;
    }
  return w;
}
const segDist = (x: number, y: number, a: { x: number; y: number }, b: { x: number; y: number }) => {
  const dx = b.x - a.x,
    dy = b.y - a.y,
    l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l)) : 0;
  return Math.hypot(x - a.x - t * dx, y - a.y - t * dy);
};
// Grid cells near the centre line (within `core` of it) the fill misses.
function holes(polys: [number, number][][], pts: { x: number; y: number }[], core: number) {
  const xs = pts.map((p) => p.x),
    ys = pts.map((p) => p.y);
  let missed = 0,
    checked = 0;
  for (let x = Math.min(...xs) - core; x <= Math.max(...xs) + core; x += 0.13)
    for (let y = Math.min(...ys) - core; y <= Math.max(...ys) + core; y += 0.13) {
      let near = false;
      for (let i = 0; i + 1 < pts.length && !near; i++) near = segDist(x, y, pts[i], pts[i + 1]) < core;
      if (!near) continue;
      checked++;
      if (winding(polys, x, y) === 0) missed++;
    }
  return { missed, checked };
}
// A shaky "W" with sharp reversals, its points a fraction of a pixel apart
// and on a half-pixel grid, as an Apple Pencil reports them.
function shakyW(): Pt[] {
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const corners = [
    [0, 0],
    [6, 20],
    [12, 0],
    [18, 20],
    [24, 0],
    [24.5, 15],
    [25, 0],
  ];
  const pts: Pt[] = [];
  for (let c = 0; c + 1 < corners.length; c++) {
    const [ax, ay] = corners[c];
    const [bx, by] = corners[c + 1];
    const n = Math.ceil(Math.hypot(bx - ax, by - ay) / 0.1);
    for (let i = 0; i < n; i++)
      pts.push({
        x: Math.round((ax + ((bx - ax) * i) / n + (rnd() - 0.5) * 0.3) * 3) / 3,
        y: Math.round((ay + ((by - ay) * i) / n + (rnd() - 0.5) * 0.3) * 3) / 3,
        p: 0.3 + 0.2 * rnd(),
      });
  }
  return pts;
}

test("a shaky pen stroke with sharp turns is filled without holes (notebook, PDF)", () => {
  const pts = shakyW();
  const polys = penPolygons(strokeOutline(pts, 1.6), 32);
  const { missed, checked } = holes(polys, pts, 0.4);
  assert.ok(checked > 1000);
  assert.equal(missed, 0, `${missed} of ${checked} points on the line not filled`);
});

test("a shaky pen stroke with sharp turns is filled without holes (whiteboard)", () => {
  const pts = shakyW();
  const polys = penPolygons(pressurePieces(pts, 4.8), 32);
  const { missed, checked } = holes(polys, pts, 1);
  assert.ok(checked > 1000);
  assert.equal(missed, 0, `${missed} of ${checked} points on the line not filled`);
});

test("every piece runs the same way round, so overlaps never cancel out", () => {
  const pieces = penPieces(shakyW().map((p) => ({ x: p.x, y: p.y, r: 1 })));
  assert.ok(pieces.length > 10);
  for (const poly of penPolygons(pieces)) assert.ok(area(poly) > 0);
});

test("pen pieces: repeated points, a single point, bad readings", () => {
  const still: PenPoint[] = Array.from({ length: 10 }, () => ({ x: 5, y: 5, r: 1 }));
  // The pen held still: one dot, with the largest radius.
  still[4] = { x: 5, y: 5, r: 2 };
  assert.deepEqual(penPieces(still), [{ kind: "disc", x: 5, y: 5, r: 2 }]);
  assert.deepEqual(penPieces([{ x: 1, y: 2, r: Number.NaN }, { x: Number.NaN, y: 0, r: 1 }]), []);
  // A straight line: discs at its ends only, bands in between.
  const line = penPieces([0, 1, 2, 3].map((x) => ({ x: x * 10, y: 0, r: 1 })));
  assert.equal(line.filter((p) => p.kind === "disc").length, 2);
  assert.equal(line.filter((p) => p.kind === "band").length, 3);
  const d = penPath(line);
  assert.match(d, /^M.*Z$/);
  assert.equal((d.match(/A/g) || []).length, 4);
});
