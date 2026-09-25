import { z } from "zod";

// Layout of record pages, set per database: how records open, where the
// properties sit and which of them are shown.
export const recordOpenModes = ["center", "side", "full"] as const;
export type RecordOpenMode = (typeof recordOpenModes)[number];
export const recordOpenLabels: Record<RecordOpenMode, string> = {
  center: "Dialog",
  side: "Seitenleiste",
  full: "Ganze Seite",
};
export const recordLayoutSchema = z.object({
  open: z.enum(recordOpenModes).default("center"),
  properties: z.enum(["top", "side"]).default("top"),
  hideEmpty: z.boolean().default(false),
  hidden: z.array(z.string().min(1).max(100)).max(500).default([]),
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
