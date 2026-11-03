// The arithmetic of dragging with the pointer (components/pointer-drag.ts):
// when a press becomes a drag, how fast the edges scroll, where a dragged
// record lands and how the keyboard moves it. No DOM here, so it can be
// tested on its own (tests/pointer-drag.test.ts).
//
// Database records, cards, columns, views and calendar entries are dragged
// with pointer events rather than the browser's own drag and drop: during a
// native drag the browser owns the cursor (Safari shows the arrow, #100) and
// a touch screen cannot start one at all.

/** Mouse and pen: how far the pointer moves before a press becomes a drag. */
export const MOUSE_THRESHOLD = 4;
/** Touch on a handle that does not scroll (`touch-action: none`). */
export const TOUCH_THRESHOLD = 8;
/** Touch: how long a finger rests on a handle before it lifts the record. */
export const LONG_PRESS_MS = 300;
/** …and how far it may wander meanwhile; further, it is a swipe that scrolls. */
export const TOUCH_SLOP = 8;
/** Within this distance of an edge the container scrolls, faster nearer. */
export const SCROLL_EDGE = 48;
/** Pixels per frame at the very edge (or beyond it). */
export const SCROLL_MAX = 14;

export type Rect = { left: number; top: number; right: number; bottom: number };
export type Placement = "before" | "after";

/** Whether a press has moved far enough (more than `threshold`) to drag. */
export function pastThreshold(dx: number, dy: number, threshold: number) {
  return Math.hypot(dx, dy) > threshold;
}

/**
 * Scroll speed in pixels per frame for a pointer `distance` px inside an
 * edge: 0 outside the edge zone, up to `max` at the edge and beyond.
 */
export function edgeSpeed(
  distance: number,
  edge = SCROLL_EDGE,
  max = SCROLL_MAX,
): number {
  if (!(edge > 0) || distance >= edge) return 0;
  return Math.ceil(((edge - Math.max(distance, 0)) / edge) * max);
}

/**
 * How far a box scrolls in this frame with the pointer at (x, y): negative
 * towards the start (left, top), positive towards the end. The edge zone
 * shrinks for small boxes so the middle always stays calm.
 */
export function autoScrollStep(
  box: Rect,
  x: number,
  y: number,
  edge = SCROLL_EDGE,
  max = SCROLL_MAX,
): { x: number; y: number } {
  const axis = (from: number, to: number, at: number) => {
    const zone = Math.min(edge, (to - from) / 4);
    const start = edgeSpeed(at - from, zone, max),
      end = edgeSpeed(to - at, zone, max);
    return start > end ? -start : end > start ? end : 0;
  };
  return {
    x: axis(box.left, box.right, x),
    y: axis(box.top, box.bottom, y),
  };
}

/**
 * Whether an edge may scroll by `step`: only towards where the pointer has
 * gone since the drag began (`moved`, more than a few pixels that way).
 */
export function towards(step: number, moved: number, slack = 4) {
  return step < 0 ? moved < -slack : step > 0 ? moved > slack : false;
}

/** Before or after an item: which half of it (along `axis`) the pointer is in. */
export function placementIn(box: Rect, x: number, y: number, axis: "x" | "y" = "y"): Placement {
  return axis === "x"
    ? x < (box.left + box.right) / 2
      ? "before"
      : "after"
    : y < (box.top + box.bottom) / 2
      ? "before"
      : "after";
}

/** Distance from a point to a box (0 inside it). */
export function distanceTo(box: Rect, x: number, y: number) {
  const dx = Math.max(box.left - x, 0, x - box.right),
    dy = Math.max(box.top - y, 0, y - box.bottom);
  return Math.hypot(dx, dy);
}

/**
 * The index of the box nearest to (x, y) within `reach` px, or -1: the
 * pointer in the gap between two cards still has a target.
 */
export function nearestIndex(boxes: Rect[], x: number, y: number, reach = 40) {
  let best = -1,
    bestDistance = reach;
  boxes.forEach((box, index) => {
    const d = distanceTo(box, x, y);
    if (d <= bestDistance) {
      best = index;
      bestDistance = d;
    }
  });
  return best;
}

/**
 * The index the dragged item takes among the others (the list without it),
 * from the middle of each of their boxes along `axis`.
 */
export function dropIndex(others: Rect[], x: number, y: number, axis: "x" | "y" = "y") {
  const index = others.findIndex((box) =>
    axis === "x" ? x < (box.left + box.right) / 2 : y < (box.top + box.bottom) / 2,
  );
  return index < 0 ? others.length : index;
}

export type Slot<Id = string> =
  | { targetId: Id; placement: Placement }
  | { targetId?: undefined; placement: "end" };

/**
 * The move for an item put at `index` among `others` (the list without the
 * item): before the record at that place, after the last one, or at the end
 * of an empty list. These are the placements of the `row.move` action.
 */
export function slotFor<Id>(others: Id[], index: number): Slot<Id> {
  if (!others.length) return { placement: "end" };
  if (index < others.length) return { targetId: others[Math.max(0, index)], placement: "before" };
  return { targetId: others[others.length - 1], placement: "after" };
}

// Keyboard: Space lifts the focused handle's record, arrows move it, Space
// or Enter drops it, Escape puts it back.
export type KeyPosition = { list: number; index: number };
export type KeyCommand = "drop" | "cancel" | "move" | "none";

/**
 * The next position of a record lifted with the keyboard. `sizes[i]` is
 * how many places list `i` has for it (the other records plus one, the
 * lifted one counted only once): up/down move within a list, left/right
 * (when `across`) to the neighbouring list at the same height. Home/End go
 * to the first or last place.
 */
export function keyboardStep(
  position: KeyPosition,
  key: string,
  sizes: number[],
  across = false,
): { command: KeyCommand; position: KeyPosition } {
  const clamp = (list: number, index: number) => ({
    list,
    index: Math.max(0, Math.min(index, Math.max(0, (sizes[list] ?? 1) - 1))),
  });
  const { list, index } = position;
  switch (key) {
    case " ":
    case "Enter":
      return { command: "drop", position };
    case "Escape":
      return { command: "cancel", position };
    case "ArrowUp":
      return { command: "move", position: clamp(list, index - 1) };
    case "ArrowDown":
      return { command: "move", position: clamp(list, index + 1) };
    case "Home":
      return { command: "move", position: clamp(list, 0) };
    case "End":
      return { command: "move", position: clamp(list, Infinity) };
    case "ArrowLeft":
    case "ArrowRight": {
      if (!across) return { command: "none", position };
      const next = list + (key === "ArrowLeft" ? -1 : 1);
      if (next < 0 || next >= sizes.length) return { command: "move", position };
      return { command: "move", position: clamp(next, index) };
    }
  }
  return { command: "none", position };
}
