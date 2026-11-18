// Where the selection's style bar goes on the board (components/whiteboard/
// whiteboard.tsx), kept free of React so it can be tested. On a narrow board
// the bar wraps to two or three rows; placed as if it were one row, it lay
// on the connector or the text being edited.
//
// All values are in pixels relative to the board's top left corner.

export type ScreenRect = { left: number; top: number; right: number; bottom: number };

// Distance to the board's edges and to the selection.
const MARGIN = 8;
const GAP = 6;

// Above the selection if the bar fits there, else below its bottom edge.
// When neither fits (a tall selection or a short board), the side with more
// room; while a text is edited, its field (`focus`) is what has to stay
// visible, so it is tried on its own before giving up on the selection.
// Horizontally the bar starts at the selection's left edge and never runs
// past the board's right edge.
export function placeStyleBar(
  bar: { w: number; h: number },
  board: { w: number; h: number },
  avoid: ScreenRect,
  focus?: ScreenRect | null,
): { left: number; top: number } {
  const above = (r: ScreenRect) => r.top - GAP - bar.h;
  const below = (r: ScreenRect) => r.bottom + GAP;
  const fit = (r: ScreenRect) =>
    above(r) >= MARGIN ? above(r) : below(r) + bar.h <= board.h - MARGIN ? below(r) : null;
  let top = fit(avoid) ?? (focus ? fit(focus) : null);
  if (top === null) {
    const r = focus ?? avoid;
    top = r.top >= board.h - r.bottom ? above(r) : below(r);
  }
  // On the board, its top edge first (a selection out of view, or no room).
  top = Math.max(MARGIN, Math.min(top, board.h - MARGIN - bar.h));
  const left = Math.max(MARGIN, Math.min(avoid.left, board.w - MARGIN - bar.w));
  return { left: Math.round(left), top: Math.round(top) };
}
