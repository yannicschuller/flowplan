import { isEmptyValue } from "./empty-value";
import type { Field } from "./types";

// The properties a board or gallery card (or a list item) shows: the view's
// visible properties in their order, without the title, the ones shown
// elsewhere on the card (its footer date, the board's group) and those
// without a value. Empty properties take no slot (issue #130); cards show
// every remaining property unless a limit is given.
export function cardFields(
  visible: readonly Field[],
  cells: Record<string, unknown>,
  skip: readonly (string | undefined)[] = [],
  limit = Infinity,
): Field[] {
  const skipped = new Set(skip.filter(Boolean));
  return visible
    .filter((f) => !skipped.has(f.id) && !isEmptyValue(cells[f.id], f.type))
    .slice(0, limit);
}
