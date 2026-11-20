// Zooming the image being marked up (#404, lib/image-markup-view.ts and the
// "frame" functions of lib/pinch-zoom.ts): zoom about a point, the limits
// fit … 8×, panning stays on the image, and screen ↔ image coordinates – the
// view never changes where a marking lies in the image.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FRAME_VIEW, frameZoom, framePinch, resizeView, settleView, toContent, toFrame, wheelFactor } from "../lib/pinch-zoom";
import { MARKUP_ZOOM, clampView, imageToScreen, pixelScale, screenToImage, stepView, wheelPan } from "../lib/image-markup-view";

// A 1600 × 1200 image shown at 0.5: a frame of 800 × 600 CSS pixels.
const fit = 0.5;
const size = { width: 800, height: 600 };
const near = (a: { x: number; y: number }, b: { x: number; y: number }) => {
  assert.ok(Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6, `${JSON.stringify(a)} ≈ ${JSON.stringify(b)}`);
};

test("zooming about a point keeps that point of the image under it", () => {
  const at = { x: 200, y: 150 };
  const before = screenToImage(FRAME_VIEW, fit, at);
  assert.deepEqual(before, { x: 400, y: 300 });
  const view = frameZoom(FRAME_VIEW, at, 2, MARKUP_ZOOM, size);
  assert.deepEqual(view, { scale: 2, pan: { x: -200, y: -150 } });
  near(screenToImage(view, fit, at), before);
  // Again, from the zoomed view, about another point.
  const at2 = { x: 600, y: 400 };
  const image2 = screenToImage(view, fit, at2);
  const more = frameZoom(view, at2, 1.5, MARKUP_ZOOM, size);
  assert.equal(more.scale, 3);
  near(screenToImage(more, fit, at2), image2);
  // A wheel notch (⌘/Ctrl + wheel, a trackpad pinch) is such a factor too.
  const wheel = frameZoom(FRAME_VIEW, at, wheelFactor(-50), MARKUP_ZOOM, size);
  assert.ok(wheel.scale > 1.64 && wheel.scale < 1.65);
  near(screenToImage(wheel, fit, at), before);
});

test("from fit to 8×, and the image always covers its frame", () => {
  assert.equal(frameZoom(FRAME_VIEW, { x: 0, y: 0 }, 50, MARKUP_ZOOM, size).scale, 8);
  assert.deepEqual(frameZoom({ scale: 2, pan: { x: -300, y: -200 } }, { x: 400, y: 300 }, 0.1, MARKUP_ZOOM, size), FRAME_VIEW, "not smaller than fit");
  // A pinch measured against its start, limited as well.
  assert.equal(framePinch({ ...FRAME_VIEW, mid: { x: 400, y: 300 } }, { x: 400, y: 300 }, 12, MARKUP_ZOOM, size).scale, 8);
  // Panning stops at the edges of the image.
  const zoomed = { scale: 2, pan: { x: -400, y: -300 } };
  assert.deepEqual(wheelPan(zoomed, -1000, 0, 0, size).pan, { x: 0, y: -300 });
  assert.deepEqual(wheelPan(zoomed, 1000, 1000, 0, size).pan, { x: -800, y: -600 });
  assert.deepEqual(wheelPan(zoomed, 0, 3, 1, size).pan, { x: -400, y: -348 }, "lines are 16 px");
  assert.deepEqual(wheelPan(FRAME_VIEW, 40, 40, 0, size), FRAME_VIEW, "unzoomed nothing moves");
  assert.deepEqual(clampView({ scale: 20, pan: { x: 100, y: -99999 } }, size), { scale: 8, pan: { x: 0, y: -4200 } });
  // Hardly zoomed is not zoomed at the end of a pinch.
  assert.deepEqual(settleView({ scale: 1.03, pan: { x: -4, y: -3 } }, MARKUP_ZOOM), FRAME_VIEW);
});

test("zoom keys and buttons step by halves around the middle", () => {
  let view = stepView(FRAME_VIEW, 1, size);
  assert.equal(view.scale, 1.5);
  near(screenToImage(view, fit, { x: 400, y: 300 }), { x: 800, y: 600 });
  view = stepView(view, 1, size);
  assert.equal(view.scale, 2);
  // From wherever a pinch left it: 2.3 → 2.5 or 2.
  assert.equal(stepView({ scale: 2.3, pan: { x: -500, y: -400 } }, 1, size).scale, 2.5);
  assert.equal(stepView({ scale: 2.3, pan: { x: -500, y: -400 } }, -1, size).scale, 2);
  assert.equal(stepView({ scale: 8, pan: { x: 0, y: 0 } }, 1, size).scale, 8);
  assert.deepEqual(stepView({ scale: 1.5, pan: { x: -200, y: -150 } }, -1, size), FRAME_VIEW);
});

test("screen and image coordinates convert both ways in every view", () => {
  for (const view of [FRAME_VIEW, { scale: 2, pan: { x: -200, y: -150 } }, { scale: 7.25, pan: { x: -3000, y: -1111 } }]) {
    for (const p of [{ x: 0, y: 0 }, { x: 123.5, y: 456.25 }, { x: 1600, y: 1200 }]) near(screenToImage(view, fit, imageToScreen(view, fit, p)), p);
    near(toContent(view, toFrame(view, { x: 10, y: 20 })), { x: 10, y: 20 });
  }
  // A stroke drawn zoomed lies where the same spot of the image is unzoomed.
  const zoomed = { scale: 4, pan: { x: -1200, y: -900 } };
  const spot = screenToImage(zoomed, fit, { x: 400, y: 300 });
  near(spot, { x: 800, y: 600 });
  near(imageToScreen(FRAME_VIEW, fit, spot), { x: 400, y: 300 });
  // Screen pixels per image pixel: line widths and the eraser's reach.
  assert.equal(pixelScale(zoomed, fit), 2);
});

test("a resized window keeps the same part of the image in view", () => {
  const view = { scale: 2, pan: { x: -400, y: -300 } };
  const resized = resizeView(view, size, { width: 400, height: 300 });
  assert.deepEqual(resized, { scale: 2, pan: { x: -200, y: -150 } });
  near(screenToImage(view, 0.5, { x: 400, y: 300 }), screenToImage(resized, 0.25, { x: 200, y: 150 }));
  assert.deepEqual(resizeView(view, { width: 0, height: 0 }, size), FRAME_VIEW);
});
