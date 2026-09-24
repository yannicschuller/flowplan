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
// Rows listed in a saved column order take their saved slots; the others keep
// their natural position, so new cards never disappear or jump around.
export function orderedGroupRows<T extends { id: string }>(
  rows: T[],
  order: string[] = [],
) {
  if (!order.length) return rows;
  const rank = rowOrderRanks(order);
  const listed = rows
    .filter((r) => rank.has(r.id))
    .sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  let next = 0;
  return rows.map((r) => (rank.has(r.id) ? listed[next++] : r));
}
export function mapGroupRowOrder(
  order: Record<string, string[]> | undefined,
  map: (ids: string[]) => string[],
) {
  if (!order) return undefined;
  const entries = Object.entries(order)
    .map(([key, ids]) => [key, map(ids)] as const)
    .filter(([, ids]) => ids.length);
  return Object.fromEntries(entries);
}
export function remapViewRows(
  views: View[],
  mapping: Map<string, string>,
  scope?: { id: string }[],
): View[] {
  const allowed = scope ? new Set(scope.map((r) => r.id)) : undefined;
  const remap = (ids: string[]) => [
    ...new Set(
      ids.flatMap((r) =>
        mapping.has(r) && (!allowed || allowed.has(r)) ? [mapping.get(r)!] : [],
      ),
    ),
  ];
  return views.map((v) => ({
    ...v,
    ...(v.rowOrder ? { rowOrder: remap(v.rowOrder) } : {}),
    ...(v.groupRowOrder
      ? { groupRowOrder: mapGroupRowOrder(v.groupRowOrder, remap) }
      : {}),
  }));
}
