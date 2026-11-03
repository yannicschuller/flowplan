// The pinned first column of a database table (components/database-view.tsx).
// On phones it takes at most --pinned-column-max (about 60 % of the table's
// width, app/globals.css) and the title is cut short with an ellipsis: wider, it
// covered the whole table, and a swipe sideways scrolled the other columns
// underneath it where nobody could see them (#98). Elsewhere the variable is
// not set and the column keeps its own width.

export const SELECTION_COLUMN = "var(--selection-column, 76px)";
// The add-property column at the end of an editable table.
const ADD_COLUMN = 42;

/** The CSS width of the pinned column whose own width is `width` px. */
export function pinnedColumnWidth(width: number): string {
  const own = `${Math.max(0, Math.round(width))}px`;
  return `min(${own}, var(--pinned-column-max, ${own}))`;
}

/**
 * The CSS width of the whole table: the pinned column (capped on phones),
 * the other columns and, when the table is editable, the selection column
 * in front and the add-property column at the end.
 */
export function tableWidth(widths: number[], editable: boolean): string {
  const [pinned, ...rest] = widths;
  const fixed =
    rest.reduce((sum, width) => sum + width, 0) + (editable ? ADD_COLUMN : 0);
  const parts = [`${fixed}px`];
  if (editable) parts.push(SELECTION_COLUMN);
  if (pinned !== undefined) parts.push(pinnedColumnWidth(pinned));
  return `calc(${parts.join(" + ")})`;
}

/** Where the pinned column sticks: after the selection column, if any. */
export function pinnedColumnLeft(editable: boolean): string | number {
  // Phones set --pinned-column-left to 0: the selection column scrolls away
  // there and leaves the room to the content.
  return editable ? `var(--pinned-column-left, ${SELECTION_COLUMN})` : 0;
}
