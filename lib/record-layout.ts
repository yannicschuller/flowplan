import { z } from "zod";

// Layout of record pages, set per database: how records open, where the
// properties sit and which of them are shown.
// "full" shows the record as a page of its own in the main area, in place
// of the database (#231); where it is opened on top of something else (a
// linked database in a page, a related record) it is a dialog across the
// whole window with "Als Seite öffnen" leading to that page.
export const recordOpenModes = ["side", "center", "full"] as const;
export type RecordOpenMode = (typeof recordOpenModes)[number];
export const recordOpenLabels: Record<RecordOpenMode, string> = {
  center: "Mittig",
  side: "Seitenleiste",
  full: "Ganze Seite",
};
export const recordSubPagesPlaces = ["top", "bottom"] as const;
export type RecordSubPagesPlace = (typeof recordSubPagesPlaces)[number];
export const recordLayoutSchema = z.object({
  open: z.enum(recordOpenModes).default("center"),
  properties: z.enum(["top", "side"]).default("top"),
  hideEmpty: z.boolean().default(false),
  hidden: z.array(z.string().min(1).max(100)).max(500).default([]),
  // The order of the properties on the record page (#305), field ids
  // without the title; shared by everyone, independent of the views'
  // column order. Missing: the database's order. Properties not listed
  // (added later) follow at the end, unknown ids are ignored.
  order: z.array(z.string().min(1).max(100)).max(500).optional(),
  // A card above the properties: "contact" shows a profile card (photo or
  // initials, name, company, e-mail, phone, address) – contacts databases,
  // lib/contacts.ts.
  card: z.enum(["contact"]).optional(),
  // Where the record's sub-pages (#231, components/record-sub-pages.tsx)
  // sit (#449): "bottom" below its document (the default, as before),
  // "top" above it, directly below the properties – there an empty list
  // is only the "Add sub-page" action.
  subpages: z.enum(recordSubPagesPlaces).default("bottom"),
});
export type RecordLayout = z.infer<typeof recordLayoutSchema>;
export const defaultRecordLayout: RecordLayout = recordLayoutSchema.parse({});
export function parseRecordLayout(raw: unknown): RecordLayout {
  try {
    const value = typeof raw === "string" ? JSON.parse(raw || "{}") : raw;
    return recordLayoutSchema.parse(value ?? {});
  } catch {
    return defaultRecordLayout;
  }
}
// A layout as the server stores it for these fields: the title stays
// visible, unknown properties are dropped from the hidden ones and the
// order (#305) keeps known properties, each once.
export function cleanRecordLayout(layout: RecordLayout, fields: readonly { id: string }[]): RecordLayout {
  const next: RecordLayout = {
    ...layout,
    hidden: [...new Set(layout.hidden)].filter((fid) => fid !== fields[0]?.id && fields.some((f) => f.id === fid)),
  };
  const order = cleanRecordOrder(layout.order, fields);
  if (order) next.order = order;
  else delete next.order;
  return next;
}
// The fields in the record page's order: the title first, then the listed
// properties, then the rest in the database's order.
export function orderRecordFields<F extends { id: string }>(fields: F[], order: readonly string[] | undefined): F[] {
  if (!order?.length || fields.length < 2) return fields;
  const [title, ...rest] = fields;
  const rank = new Map<string, number>();
  for (const id of order) if (!rank.has(id)) rank.set(id, rank.size);
  const listed = rest.filter((f) => rank.has(f.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  return [title, ...listed, ...rest.filter((f) => !rank.has(f.id))];
}
// A stored order as the server keeps it: known properties only (not the
// title), each once; none when it says nothing.
export function cleanRecordOrder(order: readonly string[] | undefined, fields: readonly { id: string }[]) {
  const known = new Set(fields.slice(1).map((f) => f.id));
  const ids = [...new Set(order || [])].filter((id) => known.has(id));
  return ids.length ? ids : undefined;
}
// A property moved before or after another one; the new order of all
// properties (without the title). null when nothing changes.
export function moveRecordField(
  fields: readonly { id: string }[],
  order: readonly string[] | undefined,
  fieldId: string,
  targetId: string,
  place: "before" | "after",
): string[] | null {
  if (fieldId === targetId) return null;
  const current = orderRecordFields([...fields], order).slice(1).map((f) => f.id);
  if (!current.includes(fieldId)) return null;
  const ids = current.filter((id) => id !== fieldId);
  const at = ids.indexOf(targetId);
  if (at < 0) return null;
  ids.splice(place === "after" ? at + 1 : at, 0, fieldId);
  return ids.join("\n") === current.join("\n") ? null : ids;
}
export { isEmptyValue as emptyCell } from "./empty-value";
