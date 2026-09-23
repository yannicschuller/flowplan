import { remapViewRows } from "./row-order";
import { transformFilterGroup } from "./database-filters";
import type { Field, Filter, View } from "./types";
export function remapViewReferences(
  views: View[],
  fields: Field[],
  mapping: Map<string, string>,
  scope?: { id: string }[],
): View[] {
  const relations = new Set(
    fields.filter((f) => f.type === "relation").map((f) => f.id),
  );
  const remap = (f: Filter) =>
    relations.has(f.field) && mapping.has(f.value)
      ? { ...f, value: mapping.get(f.value)! }
      : f;
  return remapViewRows(views, mapping, scope).map((v) => ({
    ...v,
    filters: v.filters.map(remap),
    ...(v.groupSettings && v.groupBy && relations.has(v.groupBy)
      ? {
          groupSettings: {
            ...v.groupSettings,
            collapsed: v.groupSettings.collapsed.map((key) => {
              try {
                const value = JSON.parse(key);
                return typeof value === "string" && mapping.has(value)
                  ? JSON.stringify(mapping.get(value))
                  : key;
              } catch {
                return key;
              }
            }),
          },
        }
      : {}),
    ...(v.filterGroup
      ? { filterGroup: transformFilterGroup(v.filterGroup, remap) }
      : {}),
  }));
}
