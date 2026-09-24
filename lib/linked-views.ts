import { z } from "zod";
import { view } from "./database-schema";
import { transformFilterGroup } from "./database-filters";
import type { Field, View, Filter } from "./types";
import { mapGroupRowOrder } from "./row-order";
import { availableCalculations } from "./database-summary";
export function availableLinkedViews(
  views: View[],
  fields: Field[],
  rows: { id: string }[],
) {
  const fieldIds = new Set(fields.map((f) => f.id)),
    rowIds = new Set(rows.map((r) => r.id));
  const check = (f: Filter) => (fieldIds.has(f.field) ? f : null);
  return views.map((v) => ({
    ...v,
    ...(v.calculations
      ? { calculations: availableCalculations(v.calculations, fields) }
      : {}),
    filters: v.filters.filter((f) => check(f)),
    sorts: v.sorts.filter((s) => fieldIds.has(s.field)),
    ...(v.filterGroup
      ? { filterGroup: transformFilterGroup(v.filterGroup, check) }
      : {}),
    ...(v.rowOrder
      ? { rowOrder: v.rowOrder.filter((r) => rowIds.has(r)) }
      : {}),
    ...(v.groupRowOrder
      ? {
          groupRowOrder: mapGroupRowOrder(v.groupRowOrder, (ids) =>
            ids.filter((r) => rowIds.has(r)),
          ),
        }
      : {}),
    ...(v.gallery?.cover === "field" &&
    !fields.some((f) => f.id === v.gallery!.fieldId && f.type === "files")
      ? {
          gallery: { ...v.gallery, cover: "none" as const, fieldId: undefined },
        }
      : {}),
  }));
}
export const linkedViewsSchema = z
  .array(view)
  .min(1)
  .max(30)
  .refine(
    (views) => new Set(views.map((v) => v.id)).size === views.length,
    "Doppelte Ansicht.",
  );
export function parseLinkedAttributes(attrs: Record<string, unknown>) {
  return {
    id: z.string().uuid().parse(attrs.id),
    source: z.string().uuid().parse(attrs.source),
    version: z.coerce.number().int().positive().parse(attrs.version),
    views: linkedViewsSchema.parse(
      JSON.parse(z.string().max(2_000_000).parse(attrs.views)),
    ),
  };
}
