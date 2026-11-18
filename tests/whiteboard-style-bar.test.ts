import { test } from "node:test";
import assert from "node:assert/strict";
import { placeStyleBar, type ScreenRect } from "../lib/whiteboard-style-bar";

const board = { w: 600, h: 420 };
const bar = { w: 560, h: 110 }; // a wrapped bar: three rows
const rect = (left: number, top: number, w: number, h: number): ScreenRect => ({ left, top, right: left + w, bottom: top + h });
const overlaps = (a: ScreenRect, b: ScreenRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const barRect = (p: { left: number; top: number }) => rect(p.left, p.top, bar.w, bar.h);

test("the style bar goes above the selection when it fits there", () => {
  const sel = rect(20, 200, 120, 60);
  const p = placeStyleBar(bar, board, sel);
  assert.equal(p.top + bar.h, sel.top - 6);
  assert.equal(p.left, 20);
  assert.ok(!overlaps(barRect(p), sel));
});

test("near the board's top it goes below the selection, measured by its real height", () => {
  const sel = rect(40, 30, 200, 24);
  const p = placeStyleBar(bar, board, sel);
  assert.equal(p.top, sel.bottom + 6);
  assert.ok(!overlaps(barRect(p), sel));
  // A one-row bar still fits above lower down; three rows do not.
  const low = rect(40, 100, 200, 24);
  assert.equal(placeStyleBar({ w: 300, h: 40 }, board, low).top, 100 - 6 - 40);
  assert.equal(placeStyleBar(bar, board, low).top, low.bottom + 6);
});

test("it never runs past the board's right edge", () => {
  const sel = rect(520, 200, 60, 40);
  const p = placeStyleBar(bar, board, sel);
  assert.equal(p.left, board.w - 8 - bar.w);
  assert.ok(p.left >= 8);
  // Wider than the board: from its left margin.
  assert.equal(placeStyleBar({ w: 700, h: 40 }, board, sel).left, 8);
  // Left of the board (scrolled away): at its margin.
  assert.equal(placeStyleBar(bar, board, rect(-80, 200, 40, 40)).left, 8);
});

test("when neither side fits, the side with more room; the text field being edited stays free", () => {
  const tall = rect(40, 60, 200, 300);
  const p = placeStyleBar(bar, board, tall);
  // 60 px above, 60 px below: above (ties go up), on the board.
  assert.equal(p.top, 8);
  const lower = rect(40, 40, 200, 300);
  assert.equal(placeStyleBar(bar, board, lower).top, board.h - 8 - bar.h);
  // Editing a text at the top of a tall selection: the field decides.
  const field = rect(40, 40, 200, 30);
  const q = placeStyleBar(bar, board, lower, field);
  assert.equal(q.top, field.bottom + 6);
  assert.ok(!overlaps(barRect(q), field));
});

test("a selection out of view keeps the bar on the board", () => {
  const p = placeStyleBar(bar, board, rect(40, 900, 100, 40));
  assert.ok(p.top >= 8 && p.top + bar.h <= board.h - 8);
  const q = placeStyleBar(bar, board, rect(40, -400, 100, 40));
  assert.equal(q.top, 8);
});
