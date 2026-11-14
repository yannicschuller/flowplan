// The sticky header row of a database table (#287, components/
// sticky-table-head.ts). The table scrolls sideways in its own scroller
// (.data-table-scroll), which makes that scroller the containing block of
// `position: sticky` in both directions – a sticky `th` would stick to a box
// that never scrolls vertically. So the header cells are moved down with a
// translate instead, by as much as the table's top has passed the top of
// the area that scrolls vertically, and never past the table's last row.

/** One bar stuck to the top of the vertical scroller (toolbar, dialog heading). */
export type TopBar = { top: number; bottom: number };

// A bar sticks a little below the top (the formatting toolbar: 8 px).
const GAP = 12;

/**
 * The line the header sticks to: the scroller's visible top, pushed down by
 * the bars that are stuck there, one below the other (a sheet's handle and
 * the dialog heading under it). Bars further down are ignored.
 */
export function stickLine(top: number, bars: TopBar[]): number {
  let line = top;
  for (const bar of [...bars].sort((a, b) => a.top - b.top))
    if (bar.bottom > line && bar.top <= line + GAP) line = bar.bottom;
  return line;
}

/**
 * How far (px) the header row is moved down: 0 while the header's top is
 * below the stick line, then as far as it has passed it, at most until the
 * header's bottom reaches `bodyEnd` (the top of the calculation row, or the
 * table's bottom) – so the header leaves together with the table.
 */
export function stickyHeadOffset(input: {
  /** The header row's top (viewport px, without the offset itself). */
  headTop: number;
  /** The header row's height. */
  headHeight: number;
  /** Where the rows end (viewport px). */
  bodyEnd: number;
  /** The line to stick to (viewport px), see stickLine. */
  line: number;
}): number {
  const { headTop, headHeight, bodyEnd, line } = input;
  const max = bodyEnd - headTop - headHeight;
  if (!(max > 0)) return 0;
  const passed = line - headTop;
  if (!(passed > 0)) return 0;
  return Math.min(passed, max);
}
