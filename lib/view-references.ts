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
  const remapKey = (key: string): string => {
    try {
      const value = JSON.parse(key);
      // Collapsed subgroups are stored as ["sub", groupKey, subgroupKey].
      if (
        Array.isArray(value) &&
        value.length === 3 &&
        value[0] === "sub" &&
        value.every((part) => typeof part === "string")
      )
        return JSON.stringify(["sub", remapKey(value[1]), remapKey(value[2])]);
      return typeof value === "string" && mapping.has(value)
        ? JSON.stringify(mapping.get(value))
        : key;
    } catch {
      return key;
    }
  };
  return remapViewRows(views, mapping, scope).map((v) => ({
    ...v,
    filters: v.filters.map(remap),
    ...(v.groupSettings &&
    ((v.groupBy && relations.has(v.groupBy)) ||
      (v.subGroupBy && relations.has(v.subGroupBy)))
      ? {
          groupSettings: {
            ...v.groupSettings,
            collapsed: v.groupSettings.collapsed.map(remapKey),
            ...(v.groupSettings.order
              ? { order: v.groupSettings.order.map(remapKey) }
              : {}),
          },
        }
      : {}),
    ...(v.filterGroup
      ? { filterGroup: transformFilterGroup(v.filterGroup, remap) }
      : {}),
  }));
}
