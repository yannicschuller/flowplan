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
export const recordLayoutSchema = z.object({
  open: z.enum(recordOpenModes).default("center"),
  properties: z.enum(["top", "side"]).default("top"),
  hideEmpty: z.boolean().default(false),
  hidden: z.array(z.string().min(1).max(100)).max(500).default([]),
  // A card above the properties: "contact" shows a profile card (photo or
  // initials, name, company, e-mail, phone, address) – contacts databases,
  // lib/contacts.ts.
  card: z.enum(["contact"]).optional(),
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
export { isEmptyValue as emptyCell } from "./empty-value";
