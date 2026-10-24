import { test } from "node:test";
import assert from "node:assert/strict";
import { drawsWith, forgetPen, isEraser, nearBox, notePenActivity, PALM_MS, palmLikely, pushPressure, SCRIBBLE_MARGIN, writingInField, type PressureTrack } from "../lib/stylus";
import { pressureOutline } from "../lib/whiteboard-tools";

const track = (): PressureTrack => ({ pressures: [], measured: false });

test("pen pressure: 0–1 per point, the first real reading fills in the points before it", () => {
  const stroke = track();
  // Apple Pencil often reports 0 at first contact.
  pushPressure(stroke, 0);
  pushPressure(stroke, 0);
  assert.deepEqual(stroke.pressures, [0.5, 0.5]);
  pushPressure(stroke, 0.8);
  assert.deepEqual(stroke.pressures, [0.8, 0.8, 0.8]);
  assert.equal(stroke.measured, true);
  // A 0 in between keeps the last value instead of a thin notch.
  pushPressure(stroke, 0);
  assert.equal(stroke.pressures.at(-1), 0.8);
  // Readings outside 0–1 or not a number are clamped or kept.
  pushPressure(stroke, 7);
  assert.ok(stroke.pressures.at(-1)! <= 1);
  pushPressure(stroke, Number.NaN);
  assert.equal(stroke.pressures.length, 6);
  assert.equal(stroke.pressures.at(-1), stroke.pressures.at(-2));
  // Very light touches still leave a visible line.
  const light = track();
  pushPressure(light, 0.001);
  assert.equal(light.pressures[0], 0.05);
});

test("pen pressure follows the pen, smoothed: no wobble from sensor noise", () => {
  const stroke = track();
  pushPressure(stroke, 0.2);
  for (let i = 0; i < 12; i++) pushPressure(stroke, 0.9);
  // Rises towards the pen's pressure without jumping there at once …
  assert.ok(stroke.pressures[1] > 0.2 && stroke.pressures[1] < 0.9);
  assert.ok(stroke.pressures.every((p, i) => i === 0 || p >= stroke.pressures[i - 1]), "monotonic");
  // … and arrives.
  assert.ok(stroke.pressures.at(-1)! >= 0.89);
  // Alternating noise is damped.
  const noisy = track();
  for (let i = 0; i < 20; i++) pushPressure(noisy, i % 2 ? 0.7 : 0.5);
  const tail = noisy.pressures.slice(10);
  assert.ok(Math.max(...tail) - Math.min(...tail) < 0.2 * 0.7, "smaller swing than the readings");
  // Two decimals, as stored in the board.
  assert.ok(noisy.pressures.every((p) => Number(p.toFixed(2)) === p));
  // The width follows: a firm stroke is wider than a light one.
  const firm = track(),
    soft = track();
  for (let i = 0; i < 5; i++) {
    pushPressure(firm, 1);
    pushPressure(soft, 0.1);
  }
  const outline = (p: number[]) => pressureOutline(p.map((v, i) => ({ x: i * 20, y: 0, p: v })), 10);
  const spread = (path: string) => Math.max(...path.match(/-?\d+(\.\d+)?/g)!.map(Number).filter((_, i) => i % 2 === 1).map(Math.abs));
  assert.ok(spread(outline(firm.pressures)) > spread(outline(soft.pressures)) * 2);
});

test("palm rejection: a touch while the pen is near never draws", () => {
  forgetPen();
  const now = 1_000_000;
  assert.equal(palmLikely({ pointerType: "touch" }, now), false, "no pen seen: a finger");
  notePenActivity({ pointerType: "mouse" }, now);
  assert.equal(palmLikely({ pointerType: "touch" }, now), false, "a mouse is no pen");
  // Drawing, hovering or just lifted: the hand holding the pen.
  notePenActivity({ pointerType: "pen" }, now);
  assert.equal(palmLikely({ pointerType: "touch" }, now + 10), true);
  assert.equal(palmLikely({ pointerType: "touch" }, now + PALM_MS - 1), true);
  assert.equal(palmLikely({ pointerType: "pen" }, now + 10), false, "the pen itself");
  assert.equal(palmLikely({ pointerType: "mouse" }, now + 10), false);
  // A moment later a finger is a finger again.
  assert.equal(palmLikely({ pointerType: "touch" }, now + PALM_MS), false);
  // Switching pen-only drawing starts over.
  notePenActivity({ pointerType: "pen" }, now);
  forgetPen();
  assert.equal(palmLikely({ pointerType: "touch" }, now + 10), false);
  // Pen-only drawing: fingers never draw, pens and mice do.
  assert.equal(drawsWith({ pointerType: "touch" }, true), false);
  assert.equal(drawsWith({ pointerType: "pen" }, true), true);
  assert.equal(drawsWith({ pointerType: "touch" }, false), true);
  assert.equal(isEraser({ pointerType: "pen", buttons: 32, button: -1 }), true);
  assert.equal(isEraser({ pointerType: "touch", buttons: 32, button: -1 }), false);
});

test("Scribble: the pen next to the focused field writes into it", () => {
  const field = { left: 100, top: 100, right: 300, bottom: 140 };
  assert.equal(nearBox(200, 120, field), true, "inside");
  assert.equal(nearBox(300 + SCRIBBLE_MARGIN, 140 + SCRIBBLE_MARGIN, field), true, "past the edge, within the margin");
  assert.equal(nearBox(300 + SCRIBBLE_MARGIN + 1, 120, field), false);
  assert.equal(nearBox(200, 100 - SCRIBBLE_MARGIN - 1, field), false);
  assert.equal(nearBox(200, 120, null), false, "no field");
  // Without a document (server) or with a finger: nothing to protect.
  assert.equal(writingInField({ pointerType: "pen", clientX: 200, clientY: 120 }), false);
  assert.equal(writingInField({ pointerType: "touch", clientX: 200, clientY: 120 }), false);
});
