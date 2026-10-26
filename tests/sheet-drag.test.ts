// Dragging a sheet down to close it (lib/sheet-drag.ts): how far it follows,
// when letting go closes it, how long it settles, and the preview of
// Android's predictive back.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  backdropOpacity,
  backPreview,
  dismissDistance,
  dragOffset,
  FLING_VELOCITY,
  projectedOffset,
  releaseVelocity,
  settleDuration,
  shouldDismiss,
} from "../lib/sheet-drag";

test("down the sheet follows the finger, up it resists", () => {
  assert.equal(dragOffset(0), 0);
  assert.equal(dragOffset(120), 120);
  assert.equal(dragOffset(Number.NaN), 0);
  const up = [-10, -50, -200, -2000].map((d) => dragOffset(d));
  // Upwards less than the pull, more for a longer pull, never past the limit.
  for (const [i, value] of up.entries()) {
    assert.ok(value < 0 && value > -80, `${value}`);
    if (i) assert.ok(value < up[i - 1]);
  }
  assert.ok(Math.abs(dragOffset(-10)) < 10);
  assert.ok(dragOffset(-2000, 40) > -40);
});

test("letting go far enough closes the sheet; short of it springs back", () => {
  // A third of the height, at most 160 px, at least 48 px.
  assert.equal(dismissDistance(300), 90);
  assert.equal(dismissDistance(800), 160);
  assert.equal(dismissDistance(100), 48);
  assert.equal(shouldDismiss({ offset: 170, velocity: 0, height: 800 }), true);
  assert.equal(shouldDismiss({ offset: 150, velocity: 0, height: 800 }), false);
  assert.equal(shouldDismiss({ offset: 95, velocity: 0, height: 300 }), true);
  assert.equal(shouldDismiss({ offset: 0, velocity: 2, height: 300 }), false);
  assert.equal(shouldDismiss({ offset: -20, velocity: 2, height: 300 }), false);
});

test("a fast flick down closes from a short way, a flick up keeps the sheet", () => {
  assert.equal(shouldDismiss({ offset: 20, velocity: FLING_VELOCITY, height: 800 }), true);
  // Too short to count, even fast.
  assert.equal(shouldDismiss({ offset: 8, velocity: 1.5, height: 800 }), false);
  // Far down but flicked back up.
  assert.equal(shouldDismiss({ offset: 400, velocity: -0.8, height: 800 }), false);
  // A moderate release counts with its projection: 120 px at 0.45 px/ms
  // would come to rest beyond 160 px.
  assert.ok(projectedOffset(120, 0.45) > 160);
  assert.equal(shouldDismiss({ offset: 120, velocity: 0.45, height: 800 }), true);
  assert.equal(shouldDismiss({ offset: 120, velocity: 0.1, height: 800 }), false);
  assert.equal(projectedOffset(50, -1), 50);
});

test("the release velocity is the one of the last 100 ms", () => {
  assert.equal(releaseVelocity([]), 0);
  assert.equal(releaseVelocity([{ t: 0, y: 0 }]), 0);
  assert.equal(releaseVelocity([{ t: 0, y: 0 }, { t: 50, y: 50 }]), 1);
  // A slow start does not count against a fast end.
  const samples = [
    { t: 0, y: 0 },
    { t: 300, y: 30 },
    { t: 350, y: 80 },
    { t: 400, y: 130 },
  ];
  assert.equal(releaseVelocity(samples), 1);
  // Standing still before letting go: no speed.
  assert.equal(releaseVelocity([...samples, { t: 600, y: 130 }]), 0);
  // Upwards is negative.
  assert.equal(releaseVelocity([{ t: 0, y: 100 }, { t: 20, y: 80 }]), -1);
});

test("settling keeps the finger's speed within limits; nothing moves with reduced motion", () => {
  assert.equal(settleDuration(200, 1), 200);
  assert.equal(settleDuration(500, 0.5), 320);
  assert.equal(settleDuration(10, 2), 120);
  assert.equal(settleDuration(200, 0), 280);
  assert.equal(settleDuration(200, 1, true), 0);
});

test("the backdrop fades with the way down", () => {
  assert.equal(backdropOpacity(0, 400), 1);
  assert.equal(backdropOpacity(200, 400), 0.5);
  assert.equal(backdropOpacity(600, 400), 0);
  assert.equal(backdropOpacity(100, 0), 1);
});

test("predictive back: the preview grows with the gesture and towards its edge", () => {
  const none = backPreview(0, "sheet");
  assert.deepEqual(none, { x: 0, y: 0, scale: 1, opacity: 1 });
  const half = backPreview(0.5, "sheet"),
    full = backPreview(1, "sheet");
  assert.ok(half.y > 0 && half.y < full.y);
  assert.ok(full.scale < half.scale && full.scale >= 0.9);
  // Out of range is clamped.
  assert.deepEqual(backPreview(4, "sheet"), full);
  assert.deepEqual(backPreview(Number.NaN, "dialog"), backPreview(0, "dialog"));
  // From the left edge things move right, from the right edge left.
  assert.ok(backPreview(0.5, "dialog", "left").x > 0);
  assert.ok(backPreview(0.5, "dialog", "right").x < 0);
  const page = backPreview(1, "page");
  assert.ok(page.opacity < 1 && page.scale < 1);
});
