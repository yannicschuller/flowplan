// The lasso's selection (lib/ink/selection.ts): picking, moving, scaling,
// turning (text keeps its turn in `rotation`), order, widths, placing next
// to it, pasting onto a page – and that turned text survives storage, SVG
// and merges, and older readers just drop the turn.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  besideBox,
  compose,
  cornerScale,
  fitOnPage,
  handleAt,
  isTap,
  itemAt,
  pinchTransform,
  reorderItems,
  rotation,
  rotationDegrees,
  selectionBounds,
  setItemsWidth,
  sharedWidthStep,
  transformItem,
  transformSelected,
  translation,
  applyPoint,
} from "../lib/ink/selection";
import { itemBounds, textBox } from "../lib/ink/geometry";
import { normalRotation, parseInk, serializeInk, type InkItem, type InkStroke, type InkText } from "../lib/ink/model";
import { mergePage } from "../lib/ink/merge";
import { inkSvg } from "../lib/ink/svg";
import { HIGHLIGHTER_WIDTHS, PEN_WIDTHS, TEXT_SIZES } from "../lib/ink/presets";

const pen = (id: string, pts: number[][], width = 1.6): InkStroke => ({ id, type: "pen", color: "#1f1f1f", width, points: pts.flatMap(([x, y]) => [x, y, 0.5]) });
const hl = (id: string, pts: number[][]): InkStroke => ({ id, type: "highlighter", color: "#ffd43b", width: 14, points: pts.flatMap(([x, y]) => [x, y, 0.5]) });
const text = (id: string, x: number, y: number, extra: Partial<InkText> = {}): InkText => ({ id, type: "text", color: "#1f1f1f", size: 14, x, y, text: "Hallo", ...extra });
const close = (a: number, b: number, eps = 0.05) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

test("affine helpers: compose, rotate a point clockwise on the page", () => {
  const m = compose(translation(10, 0), rotation(Math.PI / 2, { x: 0, y: 0 }));
  const p = applyPoint(m, { x: 0, y: 0 });
  close(p.x, 0);
  close(p.y, 10, 1e-9);
  assert.equal(normalRotation(370), 10);
  assert.equal(normalRotation(-190), 170);
  assert.equal(normalRotation(180), 180);
  assert.equal(normalRotation(0.001), 0);
});

test("moving and scaling strokes; widths and sizes follow the scale", () => {
  const items: InkItem[] = [pen("a", [[0, 0], [10, 0]]), text("t", 0, 20)];
  const moved = transformSelected(items, new Set(["a"]), translation(5, 5));
  assert.deepEqual((moved[0] as InkStroke).points, [5, 5, 0.5, 15, 5, 0.5]);
  assert.equal(moved[1], items[1], "unselected items are untouched");
  const scaled = transformSelected(items, new Set(["a", "t"]), { a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 });
  assert.equal((scaled[0] as InkStroke).width, 3.2);
  assert.equal((scaled[1] as InkText).size, 28);
  assert.equal((scaled[1] as InkText).y, 40);
});

test("turning text keeps a rotation; a full turn back drops it", () => {
  const t = text("t", 100, 100);
  const turned = transformItem(t, rotation(Math.PI / 2, { x: 100, y: 100 })) as InkText;
  assert.equal(turned.rotation, 90);
  close(turned.x, 100);
  close(turned.y, 100);
  const back = transformItem(turned, rotation(-Math.PI / 2, { x: 100, y: 100 })) as InkText;
  assert.equal(back.rotation, undefined);
  // The box of turned text stands up: as wide as the text was high.
  const box = textBox(turned);
  close(box.w, textBox(t).h, 0.01);
  close(box.x, 100 - textBox(t).h, 0.01);
});

test("corner handles scale around the opposite corner, freely or keeping the aspect", () => {
  const box = { x: 0, y: 0, w: 100, h: 50 };
  const free = cornerScale(box, "se", { x: 200, y: 50 }, false);
  assert.deepEqual([free.a, free.d, free.e + 0, free.f + 0], [2, 1, 0, 0]);
  const kept = cornerScale(box, "se", { x: 200, y: 50 }, true);
  assert.deepEqual([kept.a, kept.d], [2, 2]);
  const nw = cornerScale(box, "nw", { x: 50, y: 25 }, false);
  // Around (100, 50): half the size.
  assert.deepEqual([nw.a, nw.d], [0.5, 0.5]);
  assert.deepEqual(applyPoint(nw, { x: 100, y: 50 }), { x: 100, y: 50 });
  const flipped = cornerScale(box, "se", { x: -50, y: -50 }, false);
  assert.ok(flipped.a > 0 && flipped.d > 0, "never flips");
  // A horizontal line scales along its length only.
  const line = cornerScale({ x: 0, y: 0, w: 100, h: 0 }, "se", { x: 150, y: 30 }, false);
  assert.deepEqual([line.a, line.d], [1.5, 1]);
});

test("handles: rotation above the middle, corners", () => {
  const box = { x: 0, y: 0, w: 100, h: 50 };
  assert.equal(handleAt(box, { x: 50, y: -20 }, 5, 20), "rotate");
  assert.equal(handleAt(box, { x: 99, y: 51 }, 5, 20), "se");
  assert.equal(handleAt(box, { x: 1, y: 1 }, 5, 20), "nw");
  assert.equal(handleAt(box, { x: 50, y: 25 }, 5, 20), null);
});

test("rotation snaps to 15° near a multiple, always with steps", () => {
  const c = { x: 0, y: 0 };
  const at = (deg: number) => ({ x: Math.cos((deg * Math.PI) / 180) * 10, y: Math.sin((deg * Math.PI) / 180) * 10 });
  assert.equal(rotationDegrees(c, at(0), at(43)), 45);
  close(rotationDegrees(c, at(0), at(37)), 37, 0.01);
  assert.equal(rotationDegrees(c, at(0), at(37), true), 30);
  close(rotationDegrees(c, at(170), at(-170)), 20, 0.01);
  assert.equal(rotationDegrees(c, at(170), at(-164)), 30, "across ±180°");
});

test("pinch: middle moves, distance scales, angle turns – uniformly", () => {
  const m = pinchTransform(
    [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ],
    [
      { x: 10, y: 10 },
      { x: 10, y: 30 },
    ],
  );
  // Twice the distance, turned by 90°, middle from (5, 0) to (10, 20).
  const mid = applyPoint(m, { x: 5, y: 0 });
  close(mid.x, 10);
  close(mid.y, 20);
  close(Math.hypot(m.a, m.b), 2, 1e-9);
  close((Math.atan2(m.b, m.a) * 180) / Math.PI, 90, 1e-9);
});

test("picking: a tap takes the top ink item, highlighter only where nothing else is", () => {
  const items: InkItem[] = [pen("a", [[0, 0], [100, 0]]), hl("h", [[0, 0], [100, 0]]), pen("b", [[0, 0], [100, 0]]), hl("h2", [[0, 50], [100, 50]])];
  assert.equal(itemAt(items, { x: 50, y: 1 }, 3), "b");
  assert.equal(itemAt(items, { x: 50, y: 51 }, 3), "h2");
  assert.equal(itemAt(items, { x: 50, y: 30 }, 3), null);
  assert.ok(isTap([{ x: 1, y: 1 }, { x: 2, y: 1.5 }], 4));
  assert.ok(!isTap([{ x: 1, y: 1 }, { x: 20, y: 1 }], 4));
});

test("front and back keep the chosen items' own order", () => {
  const items: InkItem[] = ["a", "b", "c", "d"].map((id) => pen(id, [[0, 0]]));
  assert.deepEqual(reorderItems(items, new Set(["a", "c"]), "front").map((i) => i.id), ["b", "d", "a", "c"]);
  assert.deepEqual(reorderItems(items, new Set(["b", "d"]), "back").map((i) => i.id), ["b", "d", "a", "c"]);
  assert.equal(reorderItems(items, new Set(["c", "d"]), "front"), items, "already in front: unchanged");
});

test("widths by step for each kind; the shared step", () => {
  const items: InkItem[] = [pen("a", [[0, 0]]), hl("h", [[0, 0]]), text("t", 0, 0)];
  const next = setItemsWidth(items, new Set(["a", "h", "t"]), 2);
  assert.equal((next[0] as InkStroke).width, PEN_WIDTHS[2]);
  assert.equal((next[1] as InkStroke).width, HIGHLIGHTER_WIDTHS[2]);
  assert.equal((next[2] as InkText).size, TEXT_SIZES[2]);
  assert.equal(sharedWidthStep(next), 2);
  assert.equal(sharedWidthStep(items), 1);
  assert.equal(setItemsWidth(next, new Set(["a"]), 2), next, "no change, same list");
});

test("text next to the handwriting: right, else below; pasted items stay on the page", () => {
  const size = { width: 600, height: 800 };
  assert.deepEqual(besideBox({ x: 10, y: 10, w: 100, h: 40 }, size, { w: 80, h: 20 }), { x: 122, y: 10 });
  assert.deepEqual(besideBox({ x: 400, y: 10, w: 150, h: 40 }, size, { w: 80, h: 20 }), { x: 400, y: 62 });
  const off = [pen("a", [[580, 790], [640, 820]])];
  const fitted = fitOnPage(off, size);
  const box = itemBounds(fitted[0]);
  assert.ok(box.x + box.w <= 600.01 && box.y + box.h <= 800.01);
  assert.equal(fitOnPage([pen("b", [[10, 10]])], size)[0].id, "b");
  assert.ok(selectionBounds(fitted, new Set(["a"])));
});

test("turned text: stored, read back, drawn turned; older-style text without it unchanged", () => {
  const doc = parseInk({ pages: { s: [text("t", 10, 20, { rotation: 30 }), text("u", 0, 0, { rotation: 0 }), { ...text("v", 0, 0), rotation: "x" }] } });
  const [t, u, v] = doc.pages.s as InkText[];
  assert.equal(t.rotation, 30);
  assert.equal("rotation" in u, false);
  assert.equal("rotation" in v, false);
  assert.ok(serializeInk(doc).includes('"rotation":30'));
  assert.match(inkSvg(doc.pages.s, { width: 100, height: 100 }), /transform="rotate\(30 10 20\)"/);
});

test("merge: our bring-to-front survives a concurrent save that kept the order", () => {
  const base: InkItem[] = ["a", "b", "c"].map((id) => pen(id, [[0, 0]]));
  const ours = reorderItems(base, new Set(["a"]), "front");
  const theirs = [...base, pen("n", [[5, 5]])];
  assert.deepEqual(mergePage(base, ours, theirs).map((i) => i.id), ["b", "c", "a", "n"]);
  // Both reordered: theirs (the saved one) wins as before.
  const theirsOrder = reorderItems(base, new Set(["c"]), "back");
  assert.deepEqual(mergePage(base, ours, theirsOrder).map((i) => i.id), ["c", "a", "b"]);
});
