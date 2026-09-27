import { test } from "node:test";
import assert from "node:assert/strict";
import {
  snapBox,
  alignItems,
  distributeItems,
  stackItems,
  clusterItems,
  mindmapLayout,
  mindmapRoot,
  recognizeStroke,
  pressureOutline,
} from "../lib/whiteboard-tools";
import type { WhiteboardItem } from "../lib/whiteboard-model";

test("moving boxes snap to edges and centres of others, else to the grid", () => {
  const other = { x: 100, y: 100, w: 100, h: 50 };
  const snapped = snapBox({ x: 203, y: 300, w: 40, h: 40 }, [other], 6);
  assert.equal(snapped.dx, -3, "left edge onto the other's right edge");
  assert.deepEqual(snapped.guides.map((g) => [g.axis, g.at]), [["x", 200]]);
  const centre = snapBox({ x: 132, y: 104, w: 40, h: 40 }, [other], 6);
  assert.equal(centre.dx, -2, "centres line up");
  assert.equal(centre.dy, 1);
  const grid = snapBox({ x: 507, y: 413, w: 40, h: 40 }, [other], 6, 20);
  assert.deepEqual([grid.dx, grid.dy], [-7, 7]);
  assert.deepEqual(grid.guides, []);
});

test("align, distribute and stack", () => {
  const list = [
    { id: "a", x: 0, y: 0, w: 50, h: 20 },
    { id: "b", x: 100, y: 40, w: 30, h: 20 },
    { id: "c", x: 400, y: 10, w: 50, h: 60 },
  ];
  assert.deepEqual(alignItems(list, "right").map((p) => p.x), [400, 420, 400]);
  assert.deepEqual(alignItems(list, "top").map((p) => p.y), [0, 0, 0]);
  const spread = distributeItems(list, "x");
  assert.deepEqual(spread.map((p) => Math.round(p.x)), [0, 210, 400]);
  const stacked = stackItems(list, "y", 10);
  assert.deepEqual(stacked.map((p) => [p.id, p.x, p.y]), [["a", 0, 0], ["c", 0, 30], ["b", 0, 100]]);
});

test("sticky notes cluster by colour and author, or sort by votes", () => {
  const note = (id: string, fill: string, author: string, votes = 0, x = 0) =>
    ({ id, type: "sticky", x, y: 0, w: 100, h: 100, z: 0, fill, author, votes: Object.fromEntries(Array.from({ length: votes }, (_, i) => [`u${i}`, true])) }) as WhiteboardItem;
  const list = [note("1", "yellow", "anna", 1, 0), note("2", "pink", "ben", 3, 300), note("3", "yellow", "ben", 0, 600)];
  const byColor = clusterItems(list, "color");
  const x = (id: string) => byColor.positions.find((p) => p.id === id)!.x;
  assert.equal(x("1"), x("3"), "same colour, same column");
  assert.notEqual(x("1"), x("2"));
  const byAuthor = clusterItems(list, "author", (id) => id.toUpperCase());
  assert.deepEqual(byAuthor.labels.map((l) => l.text), ["ANNA", "BEN"]);
  const votes = clusterItems(list, "votes");
  assert.deepEqual(votes.positions.map((p) => p.id), ["2", "1", "3"]);
});

test("mind maps lay out children to the right, centred on their parent", () => {
  const boxes = new Map([
    ["root", { x: 0, y: 0, w: 100, h: 40 }],
    ["a", { x: 500, y: -500, w: 80, h: 40 }],
    ["b", { x: 500, y: 500, w: 80, h: 40 }],
    ["a1", { x: 0, y: 900, w: 80, h: 40 }],
  ]);
  const edges = [
    { from: "root", to: "a" },
    { from: "root", to: "b" },
    { from: "a", to: "a1" },
  ];
  const out = mindmapLayout("root", boxes, edges, 60, 20);
  assert.deepEqual(out.get("root"), { x: 0, y: 0 });
  assert.equal(out.get("a")!.x, 160);
  assert.equal(out.get("a1")!.x, 300);
  assert.ok(out.get("a")!.y < out.get("b")!.y);
  // The root sits in the middle of its children.
  const mid = (out.get("a")!.y + out.get("b")!.y + 40) / 2;
  assert.equal(Math.round(mid), 20);
  assert.equal(mindmapRoot("a1", edges), "root");
});

test("drawn strokes become lines and shapes", () => {
  const line = Array.from({ length: 20 }, (_, i) => ({ x: i * 10, y: i * 2 + (i % 2) }));
  assert.equal(recognizeStroke(line)?.kind, "line");
  const circle = Array.from({ length: 40 }, (_, i) => ({ x: 100 + 50 * Math.cos((i / 40) * 2 * Math.PI), y: 100 + 50 * Math.sin((i / 40) * 2 * Math.PI) }));
  assert.equal((recognizeStroke(circle) as { shape: string }).shape, "ellipse");
  const edge = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Array.from({ length: 10 }, (_, i) => ({ x: a.x + ((b.x - a.x) * i) / 10, y: a.y + ((b.y - a.y) * i) / 10 }));
  const rect = [...edge({ x: 0, y: 0 }, { x: 200, y: 0 }), ...edge({ x: 200, y: 0 }, { x: 200, y: 100 }), ...edge({ x: 200, y: 100 }, { x: 0, y: 100 }), ...edge({ x: 0, y: 100 }, { x: 0, y: 2 })];
  assert.equal((recognizeStroke(rect) as { shape: string }).shape, "rectangle");
  const tri = [...edge({ x: 100, y: 0 }, { x: 200, y: 150 }), ...edge({ x: 200, y: 150 }, { x: 0, y: 150 }), ...edge({ x: 0, y: 150 }, { x: 98, y: 3 })];
  assert.equal((recognizeStroke(tri) as { shape: string }).shape, "triangle");
  const diamond = [...edge({ x: 100, y: 0 }, { x: 200, y: 80 }), ...edge({ x: 200, y: 80 }, { x: 100, y: 160 }), ...edge({ x: 100, y: 160 }, { x: 0, y: 80 }), ...edge({ x: 0, y: 80 }, { x: 99, y: 2 })];
  assert.equal((recognizeStroke(diamond) as { shape: string }).shape, "diamond");
  const scribble = Array.from({ length: 30 }, (_, i) => ({ x: (i * 37) % 100, y: (i * 53) % 90 }));
  assert.equal(recognizeStroke(scribble), null);
});

test("pen pressure widens the stroke outline", () => {
  const thin = pressureOutline([{ x: 0, y: 0, p: 0 }, { x: 100, y: 0, p: 0 }], 10);
  const thick = pressureOutline([{ x: 0, y: 0, p: 1 }, { x: 100, y: 0, p: 1 }], 10);
  const width = (path: string) => Math.max(...path.match(/-?\d+(\.\d+)?/g)!.map(Number).filter((_, i) => i % 2 === 1).map(Math.abs));
  assert.ok(width(thick) > width(thin) * 2);
  assert.match(thin, /^M .* Z$/);
});
