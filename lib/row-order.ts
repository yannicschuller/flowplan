import type { Row, View } from "./types";
export const MAX_ORDERED_ROWS = 50000;
export function rowOrderRanks(order?: string[]) {
  return new Map((order || []).map((id, index) => [id, index]));
}
export function orderedRowIds(
  rows: Pick<Row, "id" | "position">[],
  view: Pick<View, "rowOrder">,
) {
  const ranks = rowOrderRanks(view.rowOrder);
  return [...rows]
    .sort(
      (a, b) =>
        (ranks.get(a.id) ?? Infinity) - (ranks.get(b.id) ?? Infinity) ||
        a.position - b.position,
    )
    .map((r) => r.id);
}
export function remapViewRows(
  views: View[],
  mapping: Map<string, string>,
  scope?: { id: string }[],
): View[] {
  const allowed = scope ? new Set(scope.map((r) => r.id)) : undefined;
  return views.map((v) =>
    v.rowOrder
      ? {
          ...v,
          rowOrder: [
            ...new Set(
              v.rowOrder.flatMap((r) =>
                mapping.has(r) && (!allowed || allowed.has(r))
                  ? [mapping.get(r)!]
                  : [],
              ),
            ),
          ],
        }
      : v,
  );
}
