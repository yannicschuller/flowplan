// Pinch zoom of notebook sheets (lib/pinch-zoom.ts): the factor comes from the
// whole gesture, the point under the fingers stays put, limits hold.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  anchorIndex,
  anchorScroll,
  boundedFactor,
  clampZoom,
  distance,
  fractionIn,
  midpoint,
  pinchFactor,
  pinchTranslate,
  settleZoom,
  stepZoom,
  wheelFactor,
} from "../lib/pinch-zoom";

const limits = { min: 0.5, max: 3 };
const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test("the factor is the distance now over the distance at the start – not compounded per event", () => {
  assert.equal(pinchFactor(100, 150), 1.5);
  assert.equal(pinchFactor(200, 100), 0.5);
  // Many small moves end at the same factor as one big one: it only depends on the fingers now.
  const moves = [102, 105, 110, 120, 135, 150];
  const factors = moves.map((d) => pinchFactor(100, d));
  assert.equal(factors.at(-1), 1.5);
  // Multiplying the zoom by each of these as they come would overshoot by far.
  assert.ok(factors.reduce((z, f) => z * f, 1) > 2.5);
  // Fingers too close to measure, or nonsense, change nothing.
  assert.equal(pinchFactor(0, 50), 1);
  assert.equal(pinchFactor(3, 50), 1);
  assert.equal(pinchFactor(100, Number.NaN), 1);
  assert.equal(pinchFactor(100, 0), 1);
});

test("small pinches zoom a little (no steps while the fingers move), limits hold", () => {
  // The old code rounded zoom × factor to quarters at the end: a pinch of 10 % did nothing.
  assert.equal(Math.round(1 * pinchFactor(100, 110) * 4) / 4, 1);
  close(boundedFactor(1, pinchFactor(100, 110), limits), 1.1);
  assert.equal(boundedFactor(2, 2, limits), 1.5);
  assert.equal(boundedFactor(1, 0.1, limits), 0.5);
  assert.equal(clampZoom(5, limits), 3);
  assert.equal(clampZoom(0.1, limits), 0.5);
  assert.equal(settleZoom(1.23456, limits), 1.23);
  assert.equal(settleZoom(9, limits), 3);
});

test("the point under the pinch midpoint stays under the fingers; moving them pans", () => {
  const a = { x: 100, y: 300 },
    b = { x: 300, y: 500 };
  const from = midpoint(a, b);
  assert.deepEqual(from, { x: 200, y: 400 });
  assert.equal(distance(a, b), Math.hypot(200, 200));
  const origin = { x: 40, y: 60 }; // the content's top left on the screen
  const local = { x: from.x - origin.x, y: from.y - origin.y };
  const shown = (t: { x: number; y: number }, k: number, o = origin) => ({ x: o.x + t.x + k * local.x, y: o.y + t.y + k * local.y });
  // Zoom only: the anchored point stays at the midpoint.
  for (const k of [0.5, 1, 1.37, 3]) assert.deepEqual(shown(pinchTranslate(local, origin, from, k), k), from);
  assert.deepEqual(pinchTranslate(local, origin, from, 1), { x: 0, y: 0 });
  // Zoom and pan: the point follows the midpoint.
  const to = { x: 260, y: 350 };
  assert.deepEqual(shown(pinchTranslate(local, origin, to, 2), 2), to);
  // A scroll the browser still runs moved the content: the transform makes up for it.
  const scrolled = { x: origin.x, y: origin.y - 80 };
  assert.deepEqual(shown(pinchTranslate(local, scrolled, to, 2), 2, scrolled), to);
});

test("after the relayout the scroll puts the anchored spot of the sheet back under the fingers", () => {
  const before = { left: 100, top: 50, width: 400, height: 560 };
  const at = { x: 300, y: 330 };
  const f = fractionIn(before, at);
  assert.deepEqual(f, { x: 0.5, y: 0.5 });
  // Laid out at 1.5×, the sheet now starts elsewhere; scrolling by the result brings the spot back.
  const after = { left: 0, top: 80, width: 600, height: 840 };
  const d = anchorScroll(after, f, at);
  assert.deepEqual(d, { x: 0, y: 170 });
  assert.equal(after.left - d.x + f.x * after.width, at.x);
  assert.equal(after.top - d.y + f.y * after.height, at.y);
  // Panned while zooming: scroll so the spot is under the fingers' new place.
  assert.deepEqual(anchorScroll(after, f, { x: 250, y: 300 }), { x: 50, y: 200 });
  // Between two sheets the nearer one keeps the anchor; outside fractions are fine.
  const sheets = [
    { left: 0, top: 0, width: 400, height: 500 },
    { left: 0, top: 522, width: 400, height: 500 },
  ];
  assert.equal(anchorIndex(sheets, { x: 10, y: 100 }), 0);
  assert.equal(anchorIndex(sheets, { x: 10, y: 515 }), 1);
  assert.equal(anchorIndex(sheets, { x: 10, y: 505 }), 0);
  assert.equal(anchorIndex(sheets, { x: 10, y: 5000 }), 1);
  assert.equal(anchorIndex([], { x: 0, y: 0 }), -1);
  assert.ok(fractionIn(sheets[0], { x: 10, y: 510 }).y > 1);
});

test("trackpad pinch (ctrl + wheel) is smooth; buttons go in steps from wherever a pinch left the zoom", () => {
  close(wheelFactor(0), 1);
  assert.ok(wheelFactor(-2) > 1 && wheelFactor(-2) < 1.05, "a trackpad delta zooms in a little");
  assert.ok(wheelFactor(2) < 1);
  close(wheelFactor(-3) * wheelFactor(3), 1);
  // A wheel notch in lines, or a huge delta, is capped to a moderate step.
  close(wheelFactor(-3, 1), Math.exp(0.48));
  close(wheelFactor(-5000), Math.exp(0.6));
  assert.equal(stepZoom(1, 1, 0.25, limits), 1.25);
  assert.equal(stepZoom(1, -1, 0.25, limits), 0.75);
  assert.equal(stepZoom(1.13, 1, 0.25, limits), 1.25);
  assert.equal(stepZoom(1.13, -1, 0.25, limits), 1);
  assert.equal(stepZoom(3, 1, 0.25, limits), 3);
  assert.equal(stepZoom(0.5, -1, 0.25, limits), 0.5);
  assert.equal(stepZoom(1.2500000001, 1, 0.25, limits), 1.5);
});
