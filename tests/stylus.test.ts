import { test } from "node:test";
import assert from "node:assert/strict";
import { createPalmGuard, drawsWith, forgetPen, isEraser, nearBox, notePenActivity, PALM_MS, PALM_SIZE, palmLikely, palmSized, penNear, pushPressure, SCRIBBLE_MARGIN, stylusTouch, writingInField, type PressureTrack } from "../lib/stylus";
import { pressurePieces } from "../lib/whiteboard-tools";
import { penPolygons } from "../lib/pen-outline";

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
  const outline = (p: number[]) => pressurePieces(p.map((v, i) => ({ x: i * 20, y: 0, p: v })), 10);
  const spread = (pieces: ReturnType<typeof pressurePieces>) => Math.max(...penPolygons(pieces).flat().map(([, y]) => Math.abs(y)));
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

test("Scribble: a stylus touch is told from fingers (cancelled on a drawing block's canvas, #311)", () => {
  assert.equal(stylusTouch({ touches: [{ touchType: "stylus" }] }), true);
  assert.equal(stylusTouch({ touches: [{ touchType: "direct" }, { touchType: "stylus" }] }), true, "pen with the palm down");
  assert.equal(stylusTouch({ touches: [{ touchType: "direct" }] }), false);
  // Browsers without touchType (not WebKit): no pen known.
  assert.equal(stylusTouch({ touches: [{}] }), false);
  assert.equal(stylusTouch({ touches: [] }), false);
});

test("a drawing block inserted from the slash menu starts drawing once, when its view is there", async () => {
  const { queueDrawingStart, takeDrawingStart } = await import("../components/ink/drawing-start");
  assert.equal(takeDrawingStart("ink-a"), false, "not inserted: a block shown or loaded stays as it is");
  queueDrawingStart("ink-a");
  assert.equal(takeDrawingStart("ink-b"), false, "another block");
  assert.equal(takeDrawingStart("ink-a"), true);
  assert.equal(takeDrawingStart("ink-a"), false, "only once (a remount, undo/redo, a copy)");
});

test("palm rejection: a pen held still on the screen keeps the hand a palm (#441)", () => {
  forgetPen();
  const now = 2_000_000;
  // Down (buttons 1): near however long it rests without moving …
  notePenActivity({ pointerType: "pen", buttons: 1 }, now);
  assert.equal(palmLikely({ pointerType: "touch" }, now + PALM_MS * 3), true);
  assert.equal(penNear(now + PALM_MS * 3), true);
  // … but not for ever when its pointerup never came.
  assert.equal(penNear(now + 60_000), false);
  // The eraser end on the screen (buttons 32) is down too.
  notePenActivity({ pointerType: "pen", buttons: 32 }, now);
  assert.equal(penNear(now + PALM_MS * 2), true);
  // Lifted (buttons 0): only the moment after it.
  notePenActivity({ pointerType: "pen", buttons: 0 }, now);
  assert.equal(palmLikely({ pointerType: "touch" }, now + PALM_MS - 1), true);
  assert.equal(palmLikely({ pointerType: "touch" }, now + PALM_MS), false);
  // A window of its own.
  assert.equal(palmLikely({ pointerType: "touch" }, now + PALM_MS, PALM_MS * 2), true);
  assert.equal(penNear(now + PALM_MS * 2, PALM_MS * 2), false);
  // Events without buttons (a mouse-like call) leave the state alone.
  notePenActivity({ pointerType: "pen", buttons: 1 }, now);
  notePenActivity({ pointerType: "pen" }, now);
  assert.equal(penNear(now + PALM_MS * 2), true);
  forgetPen();
  assert.equal(penNear(now + 10), false, "forgotten: neither near nor down");
});

test("palm rejection: the hand stays the hand until it lifts; a finger with the pen away scrolls (#441)", () => {
  forgetPen();
  const now = 3_000_000;
  const guard = createPalmGuard();
  const finger = { identifier: 1, radiusX: 8, radiusY: 8 };
  const palm = { identifier: 2, radiusX: PALM_SIZE / 2 + 5, radiusY: 30 };
  // No pen yet: a fingertip is a finger, a contact as wide as a palm is not.
  assert.equal(guard.check([finger], now), false);
  assert.equal(guard.check([palm], now), true);
  assert.equal(palmSized(finger), false);
  assert.equal(palmSized({ width: PALM_SIZE + 1 }), true, "PointerEvent width counts too");
  guard.lift([palm]);
  // The pen draws: a touch coming down now is the hand …
  notePenActivity({ pointerType: "pen", buttons: 1 }, now);
  const resting = { identifier: 3, radiusX: 6, radiusY: 6 };
  assert.equal(guard.check([resting], now + 50), true);
  // … and stays it after the pen lifted and went away, while it slides on.
  notePenActivity({ pointerType: "pen", buttons: 0 }, now + 100);
  assert.equal(guard.check([resting], now + 100 + PALM_MS * 4), true);
  assert.equal(guard.has(3), true);
  // Lifted, it is forgotten; a new finger with the pen away scrolls again.
  guard.lift([resting]);
  assert.equal(guard.has(3), false);
  assert.equal(guard.check([{ identifier: 4 }], now + 100 + PALM_MS * 4), false);
  // A finger that was down before the pen came becomes the hand once it does.
  const early = { identifier: 5 };
  assert.equal(guard.check([early], now + 10_000), false);
  notePenActivity({ pointerType: "pen", buttons: 1 }, now + 10_010);
  assert.equal(guard.check([early], now + 10_020), true);
  guard.clear();
  forgetPen();
});

test("palm rejection never takes the pen itself, also while it draws (#548)", () => {
  forgetPen();
  const now = 2_000_000;
  // The pen down and drawing, with readings of 0 and buttons 0 in between.
  notePenActivity({ pointerType: "pen", buttons: 1 }, now);
  for (let t = 0; t < 3000; t += 16) {
    notePenActivity({ pointerType: "pen", buttons: t % 160 ? 1 : 0 }, now + t);
    assert.equal(palmLikely({ pointerType: "pen" }, now + t), false);
    assert.equal(drawsWith({ pointerType: "pen" }, true), true);
  }
  // The pen's own touch in the touch events counts as the hand there only
  // to cancel it (no scrolling), which the pen needs anyway.
  const guard = createPalmGuard();
  assert.equal(guard.check([{ identifier: 1 }], now + 3000), true);
  forgetPen();
});
