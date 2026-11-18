// Zooming the picture of an image occlusion card inside its frame (#343,
// lib/pinch-zoom.ts "frame" functions, components/study/occlusion-zoom.ts):
// the point under the fingers stays there, the picture always covers the
// frame, a small zoom settles back, double taps are near in time and place.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FRAME_VIEW, clampPan, framePan, framePinch, isDoubleTap, settleView } from "../lib/pinch-zoom";

const size = { width: 400, height: 300 };
const limits = { min: 1, max: 5 };

test("a pinch keeps the point under the fingers and pans with them", () => {
  // Fingers around (100, 100), twice as far apart: that point stays under them.
  const start = { ...FRAME_VIEW, mid: { x: 100, y: 100 } };
  const view = framePinch(start, { x: 100, y: 100 }, 2, limits, size);
  assert.deepEqual(view, { scale: 2, pan: { x: -100, y: -100 } });
  // The content point under the fingers: (mid - pan) / scale.
  assert.deepEqual({ x: (100 - view.pan.x) / view.scale, y: (100 - view.pan.y) / view.scale }, { x: 100, y: 100 });
  // Moving the fingers 20 px to the left pans the picture with them.
  assert.deepEqual(framePinch(start, { x: 80, y: 100 }, 2, limits, size).pan, { x: -120, y: -100 });
  // From a zoomed view: measured against the start, not multiplied up.
  const again = framePinch({ ...view, mid: { x: 200, y: 150 } }, { x: 200, y: 150 }, 1.5, limits, size);
  assert.equal(again.scale, 3);
  assert.deepEqual({ x: (200 - again.pan.x) / 3, y: (150 - again.pan.y) / 3 }, { x: (200 + 100) / 2, y: (150 + 100) / 2 });
});

test("within the limits, and the picture always covers its frame", () => {
  assert.equal(framePinch({ ...FRAME_VIEW, mid: { x: 0, y: 0 } }, { x: 0, y: 0 }, 20, limits, size).scale, 5);
  assert.deepEqual(framePinch({ ...FRAME_VIEW, mid: { x: 50, y: 50 } }, { x: 50, y: 50 }, 0.3, limits, size), FRAME_VIEW, "not smaller than the frame");
  // Pulled past an edge: stopped at it.
  assert.deepEqual(clampPan({ x: 50, y: -1000 }, 2, size), { x: 0, y: -300 });
  assert.deepEqual(framePan({ scale: 2, pan: { x: -100, y: -100 } }, { x: 500, y: -30 }, size), { scale: 2, pan: { x: 0, y: -130 } });
  assert.deepEqual(clampPan({ x: -10, y: 10 }, 1, size), { x: 0, y: 0 }, "unzoomed it does not move");
});

test("the end of a gesture and double taps", () => {
  assert.deepEqual(settleView({ scale: 1.03, pan: { x: -5, y: -2 } }, limits), FRAME_VIEW, "hardly zoomed is not zoomed");
  assert.deepEqual(settleView({ scale: 2, pan: { x: -5, y: -2 } }, limits), { scale: 2, pan: { x: -5, y: -2 } });
  const first = { at: 1000, x: 100, y: 100 };
  assert.equal(isDoubleTap(null, first), false);
  assert.equal(isDoubleTap(first, { at: 1200, x: 110, y: 95 }), true);
  assert.equal(isDoubleTap(first, { at: 1500, x: 100, y: 100 }), false, "too late");
  assert.equal(isDoubleTap(first, { at: 1100, x: 200, y: 100 }), false, "too far");
});
