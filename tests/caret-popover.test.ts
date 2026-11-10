// The "/" block menu on phones (lib/caret-popover.ts): placed inside the
// visible area – below the status bar, above the keyboard and the toolbar
// docked on it – below the caret when it fits, above it otherwise, and only
// as high as the room there (the rest scrolls in the menu).
import { test } from "node:test";
import assert from "node:assert/strict";
import { placeAtCaret, visibleArea } from "../lib/caret-popover";

// Measured on an iPhone with iOS 26 for #120: visual viewport 384 high at
// 186 (innerHeight reported 528); the toolbar docked on the keyboard 53 high;
// the status bar 47.
const iphone = { offsetTop: 186, height: 384 };
const area = visibleArea(iphone, { safeTop: 47, toolbarTop: 186 + 384 - 53 });

test("the visible area: below the status bar, above the docked toolbar", () => {
  assert.deepEqual(area, { top: 233, bottom: 517 });
  // A toolbar outside the visible area does not count.
  assert.deepEqual(visibleArea({ offsetTop: 0, height: 508 }, { toolbarTop: 700 }), { top: 0, bottom: 508 });
  assert.deepEqual(visibleArea({ offsetTop: 0, height: 844 }), { top: 0, bottom: 844 });
});

test("the caret on the last line above the docked toolbar: the menu right above it, never under the status bar", () => {
  const caret = { top: 488, bottom: 508 };
  const place = placeAtCaret(caret, 2000, area);
  assert.equal(place.below, false);
  // From the area's top (plus the margin) down to just above the line.
  assert.equal(place.top, 241);
  assert.equal(place.maxHeight, 488 - 6 - 241);
  assert.equal(place.top + place.maxHeight, caret.top - 6);
  // What it was: 360 high above the line, from 122 – 111 px out of view.
  assert.ok(caret.top - 6 - 360 < area.top);
});

test("a new document's first line with the keyboard open: above the line, not below it behind the keyboard", () => {
  // Not moved (offsetTop 0): the visible area ends at 328, the docked
  // toolbar at 275; the line at 239. innerHeight (664) had room below.
  const first = visibleArea({ offsetTop: 0, height: 328 }, { safeTop: 47, toolbarTop: 275 });
  const place = placeAtCaret({ top: 239, bottom: 259 }, 2000, first);
  assert.equal(place.below, false);
  assert.equal(place.top, 55);
  assert.equal(place.top + place.maxHeight, 233);
});

test("room below: below the caret, as high as the content or 360", () => {
  const desk = visibleArea({ offsetTop: 0, height: 1000 });
  assert.deepEqual(placeAtCaret({ top: 100, bottom: 120 }, 2000, desk), { top: 126, maxHeight: 360, below: true });
  // A short list keeps its own height and still fits below.
  assert.deepEqual(placeAtCaret({ top: 700, bottom: 720 }, 200, desk), { top: 726, maxHeight: 266, below: true });
  // Too little below for the whole list, more above: above, right at the line.
  const above = placeAtCaret({ top: 900, bottom: 920 }, 2000, desk);
  assert.equal(above.below, false);
  assert.equal(above.top + Math.min(360, above.maxHeight), 894);
});

test("neither side has the full height: the larger one, scrolled inside", () => {
  const short = { top: 233, bottom: 517 };
  const below = placeAtCaret({ top: 300, bottom: 320 }, 2000, short);
  assert.equal(below.below, true);
  assert.equal(below.top, 326);
  assert.equal(below.maxHeight, 517 - 8 - 326);
  // Hardly any room on both sides: a few entries still show, inside the area.
  const tiny = placeAtCaret({ top: 260, bottom: 280 }, 2000, { top: 233, bottom: 320 });
  assert.ok(tiny.maxHeight >= 40);
  assert.ok(tiny.top >= 233 + 8 && tiny.top + Math.min(tiny.maxHeight, 360) <= 320 - 8 + 1);
});

test("a caret scrolled out of the visible area: the menu still inside it", () => {
  const place = placeAtCaret({ top: 900, bottom: 920 }, 2000, area);
  assert.ok(place.top >= area.top + 8);
  assert.ok(place.top + place.maxHeight <= area.bottom);
});
