// #100: database records are dragged with pointer events (the browser's own
// drag and drop showed the arrow cursor in Safari). The arithmetic behind
// it: when a press becomes a drag, how fast the edges scroll, where a
// record lands and how the keyboard moves it.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  autoScrollStep,
  distanceTo,
  dropIndex,
  edgeSpeed,
  keyboardStep,
  LONG_PRESS_MS,
  MOUSE_THRESHOLD,
  nearestIndex,
  pastThreshold,
  placementIn,
  SCROLL_EDGE,
  SCROLL_MAX,
  slotFor,
  TOUCH_SLOP,
  towards,
} from "../lib/pointer-drag";

const box = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });

test("a press becomes a drag only past the threshold, so clicks still open records", () => {
  assert.equal(pastThreshold(0, 0, MOUSE_THRESHOLD), false);
  assert.equal(pastThreshold(3, 2, MOUSE_THRESHOLD), false);
  assert.equal(pastThreshold(MOUSE_THRESHOLD, 0, MOUSE_THRESHOLD), false);
  assert.equal(pastThreshold(4, 1, MOUSE_THRESHOLD), true);
  assert.equal(pastThreshold(-3, -3, MOUSE_THRESHOLD), true);
  // A finger that wanders this far during the long press scrolls instead.
  assert.equal(pastThreshold(6, 5, TOUCH_SLOP), false);
  assert.equal(pastThreshold(7, 5, TOUCH_SLOP), true);
  assert.ok(LONG_PRESS_MS >= 250 && LONG_PRESS_MS <= 400);
});

test("the edges scroll faster the nearer the pointer, at most SCROLL_MAX", () => {
  assert.equal(edgeSpeed(SCROLL_EDGE), 0);
  assert.equal(edgeSpeed(200), 0);
  assert.equal(edgeSpeed(0), SCROLL_MAX);
  // Beyond the edge (outside the box) still at full speed.
  assert.equal(edgeSpeed(-30), SCROLL_MAX);
  assert.equal(edgeSpeed(SCROLL_EDGE / 2), SCROLL_MAX / 2);
  assert.ok(edgeSpeed(10) > edgeSpeed(30));
  assert.ok(edgeSpeed(47) >= 1);
  assert.equal(edgeSpeed(5, 0), 0);
});

test("auto-scroll goes both ways on both axes and stays calm in the middle", () => {
  const b = box(100, 100, 900, 700);
  assert.deepEqual(autoScrollStep(b, 500, 400), { x: 0, y: 0 });
  assert.deepEqual(autoScrollStep(b, 100, 400), { x: -SCROLL_MAX, y: 0 });
  assert.deepEqual(autoScrollStep(b, 900, 400), { x: SCROLL_MAX, y: 0 });
  assert.deepEqual(autoScrollStep(b, 500, 100), { x: 0, y: -SCROLL_MAX });
  assert.deepEqual(autoScrollStep(b, 500, 690), { x: 0, y: edgeSpeed(10) });
  // A corner scrolls diagonally.
  const corner = autoScrollStep(b, 890, 110);
  assert.ok(corner.x > 0 && corner.y < 0);
  // In a small box the edge zone shrinks to a quarter of it.
  const small = box(0, 0, 100, 60);
  assert.deepEqual(autoScrollStep(small, 50, 30), { x: 0, y: 0 });
  assert.equal(autoScrollStep(small, 50, 16).y, 0);
  assert.ok(autoScrollStep(small, 50, 5).y < 0);
});

test("an edge scrolls only towards where the pointer went", () => {
  assert.equal(towards(-8, -30), true);
  assert.equal(towards(-8, 0), false);
  assert.equal(towards(-8, 3), false);
  assert.equal(towards(8, 30), true);
  assert.equal(towards(8, -30), false);
  assert.equal(towards(0, 30), false);
});

test("before or after: the half of the item the pointer is in", () => {
  const b = box(0, 100, 200, 140);
  assert.equal(placementIn(b, 10, 105), "before");
  assert.equal(placementIn(b, 10, 119), "before");
  assert.equal(placementIn(b, 10, 121), "after");
  assert.equal(placementIn(b, 50, 120, "x"), "before");
  assert.equal(placementIn(b, 150, 120, "x"), "after");
});

test("the drop index among the other records follows their middles", () => {
  const others = [box(0, 0, 100, 40), box(0, 50, 100, 90), box(0, 100, 100, 140)];
  assert.equal(dropIndex(others, 10, -20), 0);
  assert.equal(dropIndex(others, 10, 19), 0);
  assert.equal(dropIndex(others, 10, 21), 1);
  assert.equal(dropIndex(others, 10, 95), 2);
  assert.equal(dropIndex(others, 10, 130), 3);
  assert.equal(dropIndex([], 10, 10), 0);
  const row = [box(0, 0, 100, 50), box(110, 0, 210, 50)];
  assert.equal(dropIndex(row, 120, 10, "x"), 1);
  assert.equal(dropIndex(row, 300, 10, "x"), 2);
});

test("in the gap between cards the nearest one within reach is the target", () => {
  const cards = [box(0, 0, 100, 100), box(120, 0, 220, 100)];
  assert.equal(distanceTo(cards[0], 50, 50), 0);
  assert.equal(distanceTo(cards[0], 103, 50), 3);
  assert.equal(nearestIndex(cards, 105, 50), 0);
  assert.equal(nearestIndex(cards, 115, 50), 1);
  assert.equal(nearestIndex(cards, 500, 50), -1);
  assert.equal(nearestIndex(cards, 500, 50, 400), 1);
  assert.equal(nearestIndex([], 0, 0), -1);
});

test("a place among the others becomes the row.move placement", () => {
  assert.deepEqual(slotFor(["a", "b", "c"], 0), { targetId: "a", placement: "before" });
  assert.deepEqual(slotFor(["a", "b", "c"], 2), { targetId: "c", placement: "before" });
  assert.deepEqual(slotFor(["a", "b", "c"], 3), { targetId: "c", placement: "after" });
  assert.deepEqual(slotFor(["a", "b", "c"], 9), { targetId: "c", placement: "after" });
  assert.deepEqual(slotFor([], 0), { placement: "end" });
});

test("the keyboard lifts, moves within and across lists, drops and cancels", () => {
  const sizes = [3, 1, 4];
  const at = { list: 0, index: 1 };
  assert.deepEqual(keyboardStep(at, "ArrowUp", sizes), { command: "move", position: { list: 0, index: 0 } });
  assert.deepEqual(keyboardStep({ list: 0, index: 0 }, "ArrowUp", sizes).position, { list: 0, index: 0 });
  assert.deepEqual(keyboardStep(at, "ArrowDown", sizes).position, { list: 0, index: 2 });
  assert.deepEqual(keyboardStep({ list: 0, index: 2 }, "ArrowDown", sizes).position, { list: 0, index: 2 });
  assert.deepEqual(keyboardStep(at, "Home", sizes).position, { list: 0, index: 0 });
  assert.deepEqual(keyboardStep(at, "End", sizes).position, { list: 0, index: 2 });
  // Left and right only between lists (board columns), at the same height.
  assert.equal(keyboardStep(at, "ArrowRight", sizes).command, "none");
  assert.deepEqual(keyboardStep(at, "ArrowRight", sizes, true).position, { list: 1, index: 0 });
  assert.deepEqual(keyboardStep({ list: 1, index: 0 }, "ArrowRight", sizes, true).position, { list: 2, index: 0 });
  assert.deepEqual(keyboardStep({ list: 0, index: 2 }, "ArrowRight", sizes, true).position, { list: 1, index: 0 });
  assert.deepEqual(keyboardStep({ list: 2, index: 3 }, "ArrowRight", sizes, true).position, { list: 2, index: 3 });
  assert.deepEqual(keyboardStep(at, "ArrowLeft", sizes, true).position, at);
  assert.equal(keyboardStep(at, " ", sizes).command, "drop");
  assert.equal(keyboardStep(at, "Enter", sizes).command, "drop");
  assert.equal(keyboardStep(at, "Escape", sizes).command, "cancel");
  assert.equal(keyboardStep(at, "a", sizes).command, "none");
});
