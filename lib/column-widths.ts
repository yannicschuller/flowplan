import type { Field } from "./types";

// Default widths of a table view's columns (px) when the view has none saved
// (view.columnWidths). Dragging or typing a width in "Configure view" stays
// between COLUMN_MIN and COLUMN_MAX.
export const COLUMN_MIN = 80;
export const COLUMN_MAX = 800;
export const TITLE_COLUMN = 280;
export const OTHER_COLUMN = 180;

// Date columns (#523) start as wide as their format needs: measured in the
// table (11 px text, the calendar icon and its gap, 24 px padding and the
// border) with some room to spare. "24. Sept. 2026" needs about 117 px,
// "24. September 2026" 147, "24.09.2026" / "2026-09-24" / "09/24/2026"
// 102–108. A time adds ", 14:05" (about 35 px) or ", 2:05 PM" (about 55);
// the time zone after it, "(UTC+02:00)", is cut off with an ellipsis.
const DATE_COLUMN: Record<string, number> = {
  "": 130,
  long: 160,
  eu: 120,
  iso: 120,
  us: 120,
};
const TIME_EXTRA = { "24": 40, "12": 60 } as const;

export function defaultColumnWidth(
  field: Pick<Field, "type" | "format" | "timeFormat" | "noTime">,
  title: boolean,
): number {
  if (title) return TITLE_COLUMN;
  const timestamp = field.type === "created_at" || field.type === "updated_at";
  if (field.type !== "date" && !timestamp) return OTHER_COLUMN;
  const date = DATE_COLUMN[field.format || ""] ?? DATE_COLUMN[""];
  // A date property may have a time unless "Mit Uhrzeit" is off (#327);
  // created and edited time always have one.
  const timed = timestamp || !field.noTime;
  return timed ? date + TIME_EXTRA[field.timeFormat === "12" ? "12" : "24"] : date;
}
