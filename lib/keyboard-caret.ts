// Writing with the on-screen keyboard open (#181): where the text may show
// and how far its scrolling pane has to move so the caret stays in view.
// Plain numbers in client coordinates (getBoundingClientRect), no DOM.
//
// iOS (Safari and the app's WKWebView) keeps the layout at its full height
// and only shrinks the visual viewport: a pane that ends at the bottom of the
// layout reaches behind the keyboard, and when iOS moves the visible area
// down the page (visualViewport.offsetTop) its upper part is out of view.
// The visible area is [offsetTop, offsetTop + height] – measured against
// the elements themselves, not innerHeight, which iOS 26 shortens by the
// offset (an iPhone for #120: innerHeight 528, visual viewport 384 high at
// 186, the layout 714 high).

export type Band = { top: number; bottom: number };

// How far the keyboard reaches into a pane: what of it lies below the
// visible area. The pane needs that much room under its content, or its end
// can never be scrolled into view.
export function coveredBelow(paneBottom: number, viewport: { offsetTop: number; height: number }) {
  return Math.max(0, Math.round(paneBottom - (viewport.offsetTop + viewport.height)));
}

// The part of a pane the person sees: inside the pane, inside the visible
// area and above a toolbar docked on the keyboard (its top edge, when it
// lies inside the visible area).
export function visibleBand(pane: Band, viewport: { offsetTop: number; height: number }, toolbarTop?: number | null): Band {
  const top = Math.max(pane.top, viewport.offsetTop);
  let bottom = Math.min(pane.bottom, viewport.offsetTop + viewport.height);
  if (toolbarTop != null && toolbarTop > top && toolbarTop < bottom) bottom = toolbarTop;
  return { top, bottom };
}

// How far to scroll the pane (positive: down) so the caret's line lies in
// the band with `margin` to spare; 0 when it already does. A band too short
// for line and margins shows the line at its top.
export function caretScroll(caret: Band, band: Band, margin = 16) {
  const room = band.bottom - band.top;
  const line = caret.bottom - caret.top;
  const gap = Math.max(0, Math.min(margin, (room - line) / 2));
  if (caret.top < band.top + gap || line > room) return Math.round(caret.top - (band.top + gap));
  if (caret.bottom > band.bottom - gap) return Math.round(caret.bottom - (band.bottom - gap));
  return 0;
}
