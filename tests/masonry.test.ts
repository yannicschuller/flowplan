// Masonry for the start page and dashboards (#218, lib/masonry.ts): items in
// their configured order, the first row left to right, then each into the
// shortest column; wide items under the lowest of the columns they cover.
import { test } from "node:test";
import assert from "node:assert/strict";
import { masonrySpan, placeMasonry } from "../lib/masonry";

const at = (layout: ReturnType<typeof placeMasonry>) => layout.placements.map(({ column, top }) => [column, top]);

test("the first row reads left to right in the configured order", () => {
  const layout = placeMasonry(
    [
      { span: 1, height: 100 },
      { span: 1, height: 40 },
      { span: 1, height: 60 },
    ],
    3,
    10,
  );
  assert.deepEqual(at(layout), [
    [0, 0],
    [1, 0],
    [2, 0],
  ]);
  assert.equal(layout.height, 100);
});

test("a tall widget next to a short one: the next ones fill the gap below the short one", () => {
  // "Meine Aktivität" tall on the left, "Termine" short on the right.
  const layout = placeMasonry(
    [
      { span: 1, height: 400 },
      { span: 1, height: 120 },
      { span: 1, height: 100 },
      { span: 1, height: 80 },
      { span: 1, height: 300 },
    ],
    2,
    16,
  );
  assert.deepEqual(at(layout), [
    [0, 0],
    [1, 0],
    [1, 136],
    [1, 252],
    // The right column is now lower (348) than the left one (416).
    [1, 348],
  ]);
  assert.equal(layout.height, 648);
  // No gap larger than the gutter anywhere in a column.
  for (const column of [0, 1]) {
    const stack = layout.placements
      .map((p, i) => ({ ...p, height: [400, 120, 100, 80, 300][i] }))
      .filter((p) => p.column === column)
      .sort((a, b) => a.top - b.top);
    for (let i = 1; i < stack.length; i++) assert.equal(stack[i].top - (stack[i - 1].top + stack[i - 1].height), 16);
  }
});

test("each item goes into the shortest column; equal heights keep the leftmost", () => {
  const layout = placeMasonry(
    [
      { span: 1, height: 200 },
      { span: 1, height: 50 },
      { span: 1, height: 120 },
      { span: 1, height: 10 },
      { span: 1, height: 10 },
    ],
    3,
    0,
  );
  assert.deepEqual(at(layout), [
    [0, 0],
    [1, 0],
    [2, 0],
    [1, 50],
    [1, 60],
  ]);
  // Within a pixel counts as equal: the left column wins.
  assert.deepEqual(at(placeMasonry([{ span: 1, height: 100.4 }, { span: 1, height: 100 }, { span: 1, height: 5 }], 2, 0)), [
    [0, 0],
    [1, 0],
    [0, 100.4],
  ]);
});

test("wide widgets sit under the lowest of the columns they cover; full width ones under everything", () => {
  const layout = placeMasonry(
    [
      { span: 4, height: 60 }, // greeting, the whole row
      { span: 1, height: 300 },
      { span: 1, height: 100 },
      { span: 2, height: 80 },
      { span: 2, height: 50 }, // under the previous one: columns 3–4 are the lowest pair
      { span: 4, height: 40 },
    ],
    4,
    10,
  );
  assert.deepEqual(at(layout), [
    [0, 0],
    [0, 70],
    [1, 70],
    [2, 70],
    [2, 160],
    [0, 380],
  ]);
  assert.equal(layout.height, 420);
});

test("a span never exceeds the grid, odd input stays safe", () => {
  assert.deepEqual(placeMasonry([{ span: 3, height: 10 }], 2, 8).placements, [{ column: 0, top: 0, span: 2 }]);
  assert.deepEqual(placeMasonry([{ span: 0, height: -5 }], 0, -3), { placements: [{ column: 0, top: 0, span: 1 }], height: 0 });
  assert.deepEqual(placeMasonry([], 4, 10), { placements: [], height: 0 });
});

test("spans from the stylesheet's grid-column values", () => {
  assert.equal(masonrySpan("span 2", "auto", 4), 2);
  assert.equal(masonrySpan("auto", "span 3", 4), 3);
  assert.equal(masonrySpan("span 3", "auto", 2), 2);
  assert.equal(masonrySpan("1", "-1", 4), 4);
  assert.equal(masonrySpan("1", "-1", 12), 12);
  assert.equal(masonrySpan("2", "4", 4), 2);
  assert.equal(masonrySpan("auto", "auto", 3), 1);
  assert.equal(masonrySpan("", "", 3), 1);
});
