// Where a menu next to the caret goes (the "/" block menu): below the caret's
// line when it fits there, above it otherwise, always inside the part of the
// screen the person sees – and only as high as that part allows, the rest
// scrolls inside the menu. Plain numbers in client coordinates, no DOM.
//
// With the on-screen keyboard open, iOS (Safari and the app's WKWebView)
// keeps the layout at its full height and only shrinks the visual viewport,
// and may move the visible area down the page (visualViewport.offsetTop); a
// toolbar docks on the keyboard (lib/keyboard-caret.ts, #120, #181). Placed
// against innerHeight, the menu went below the caret behind the keyboard and
// the docked toolbar, or above it up under the status bar, out of reach of
// the finger that should scroll it.

export type Area = { top: number; bottom: number };
export type Placement = { top: number; maxHeight: number; below: boolean };

// The area a popover may use: the visible area (visual viewport), without
// the status bar / notch inset at its top and above a toolbar docked on the
// keyboard (its top edge, when it lies inside the visible area).
export function visibleArea(
  viewport: { offsetTop: number; height: number },
  { safeTop = 0, toolbarTop = null }: { safeTop?: number; toolbarTop?: number | null } = {},
): Area {
  const top = Math.max(0, viewport.offsetTop) + Math.max(0, safeTop);
  let bottom = viewport.offsetTop + viewport.height;
  if (toolbarTop != null && toolbarTop > top && toolbarTop < bottom) bottom = toolbarTop;
  return { top, bottom };
}

// `height`: what the menu would take in full (capped by `max`). Below when
// that fits below, else above when it fits above, else on the side with more
// room, as high as that room. `gap` between the line and the menu, `margin`
// to the area's edges.
export function placeAtCaret(
  caret: { top: number; bottom: number },
  height: number,
  area: Area,
  { gap = 6, margin = 8, max = 360 }: { gap?: number; margin?: number; max?: number } = {},
): Placement {
  const want = Math.max(0, Math.min(height, max));
  const roomBelow = Math.max(0, area.bottom - margin - (caret.bottom + gap));
  const roomAbove = Math.max(0, caret.top - gap - (area.top + margin));
  const below = roomBelow >= want || (roomAbove < want && roomBelow >= roomAbove);
  // Hardly any room on either side (a short visible area): a few entries
  // still show, over the line if need be, rather than none.
  const room = Math.max(0, area.bottom - area.top - 2 * margin);
  const floor = Math.min(want, 120, room);
  const maxHeight = Math.round(Math.max(floor, Math.min(max, room, below ? roomBelow : roomAbove)));
  const shown = Math.min(want, maxHeight);
  let top = below ? caret.bottom + gap : caret.top - gap - shown;
  // A caret out of the area (scrolled away): the menu still stays inside it.
  top = Math.min(Math.max(top, area.top + margin), Math.max(area.top + margin, area.bottom - margin - shown));
  return { top: Math.round(top), maxHeight, below };
}
