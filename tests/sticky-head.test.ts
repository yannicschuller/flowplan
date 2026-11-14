// The sticky header row of database tables (#287, lib/sticky-head.ts): how
// far the header cells move down, and the line they stick to.
import { test } from "node:test";
import assert from "node:assert/strict";
import { stickLine, stickyHeadOffset } from "../lib/sticky-head";

const offset = (headTop: number, line = 0, bodyEnd = headTop + 2000, headHeight = 36) =>
  stickyHeadOffset({ headTop, headHeight, bodyEnd, line });

test("unscrolled the header stays where it is", () => {
  assert.equal(offset(120), 0);
  assert.equal(offset(0), 0);
  assert.equal(offset(300, 64), 0);
});

test("once the table's top passes the line the header follows it exactly", () => {
  assert.equal(offset(-1), 1);
  assert.equal(offset(-480.5), 480.5);
  assert.equal(offset(40, 64), 24);
});

test("the header never leaves the table: it stops when its bottom reaches the rows' end", () => {
  // Rows end 500 px below the table's top, the header is 36 px high.
  assert.equal(offset(-400, 0, 100), 400);
  assert.equal(offset(-480, 0, 20), 464);
  assert.equal(offset(-2000, 0, -1500), 464);
  // A table with no rows below the header has nowhere to move.
  assert.equal(offset(-100, 0, -64), 0);
  assert.equal(offset(-100, 0, -200), 0);
});

test("a broken measurement does not move the header", () => {
  assert.equal(offset(Number.NaN), 0);
  assert.equal(stickyHeadOffset({ headTop: -50, headHeight: Number.NaN, bodyEnd: 400, line: 0 }), 0);
});

test("the line: the scroller's top, below the bars stuck there, one under the other", () => {
  assert.equal(stickLine(80, []), 80);
  // A sheet's handle at the top and the dialog heading right below it.
  assert.equal(stickLine(80, [{ top: 98, bottom: 150 }, { top: 80, bottom: 98 }]), 150);
  // The formatting toolbar sticks 8 px below the top.
  assert.equal(stickLine(0, [{ top: 8, bottom: 45 }]), 45);
  // A bar further down the page (not stuck) and one scrolled out above.
  assert.equal(stickLine(0, [{ top: 300, bottom: 340 }]), 0);
  assert.equal(stickLine(0, [{ top: -60, bottom: -10 }]), 0);
});
