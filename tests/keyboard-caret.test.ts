// Writing with the on-screen keyboard open (#181, lib/keyboard-caret.ts):
// the room a pane needs under its text and how far it scrolls to keep the
// caret above the keyboard and the docked toolbar.
import { test } from "node:test";
import assert from "node:assert/strict";
import { caretScroll, coveredBelow, visibleBand } from "../lib/keyboard-caret";

// Measured on an iPhone with iOS 26 for #120: the layout 714 high, the
// visual viewport 384 high at 186 (innerHeight reported 528).
const iphone = { offsetTop: 186, height: 384 };
const pane = { top: 57, bottom: 714 };

test("the keyboard's reach into a pane comes from the pane, not innerHeight", () => {
  assert.equal(coveredBelow(pane.bottom, iphone), 144);
  // What the inset from innerHeight gave there: nothing.
  assert.equal(Math.max(0, 528 - iphone.offsetTop - iphone.height), 0);
  // Not moved: the whole keyboard.
  assert.equal(coveredBelow(844, { offsetTop: 0, height: 508 }), 336);
  // A web view the app resizes (Android): the pane ends at the keyboard.
  assert.equal(coveredBelow(508, { offsetTop: 0, height: 508 }), 0);
});

test("the visible band: inside the pane and the visible area, above the docked toolbar", () => {
  assert.deepEqual(visibleBand(pane, iphone), { top: 186, bottom: 570 });
  assert.deepEqual(visibleBand(pane, iphone, 522), { top: 186, bottom: 522 });
  // A toolbar outside the visible area does not count.
  assert.deepEqual(visibleBand(pane, iphone, 690), { top: 186, bottom: 570 });
  assert.deepEqual(visibleBand({ top: 57, bottom: 844 }, { offsetTop: 0, height: 844 }), { top: 57, bottom: 844 });
});

test("the caret scrolls into the band with a margin, and only when it has to", () => {
  const band = { top: 186, bottom: 522 };
  assert.equal(caretScroll({ top: 300, bottom: 320 }, band), 0);
  // Behind the keyboard: up until 16 px above the toolbar.
  assert.equal(caretScroll({ top: 600, bottom: 620 }, band), 620 - 506);
  assert.equal(caretScroll({ top: 500, bottom: 520 }, band), 520 - 506);
  // Above the visible area: down.
  assert.equal(caretScroll({ top: 120, bottom: 140 }, band), 120 - 202);
  // A band barely taller than the line: the line at its top.
  assert.equal(caretScroll({ top: 400, bottom: 430 }, { top: 100, bottom: 120 }), 300);
  assert.equal(caretScroll({ top: 400, bottom: 420 }, { top: 100, bottom: 130 }, 16), 295);
});
