import { timelineSchema } from "./database-timeline";
import { calendarSchema } from "./database-calendar";
import { gallerySchema } from "./database-gallery";
import { feedSchema } from "./database-feed";
import { chartSchema } from "./database-chart";
import { filterSchema, filterGroupSchema } from "./database-filters";
import { z } from "zod";
import { MAX_ORDERED_ROWS } from "./row-order";
import { rollupAggregates } from "./rollups";
import { calculationsSchema } from "./database-summary";
const str = z.string().min(1).max(500);
export const field = z.object({
  id: str,
  name: str,
  type: z.enum([
    "text",
    "number",
    "date",
    "select",
    "multiselect",
    "checkbox",
    "url",
    "email",
    "phone",
    "checklist",
    "person",
    "relation",
    "rollup",
    "formula",
    "created_at",
    "updated_at",
    "created_by",
    "updated_by",
    "files",
    "id",
    "progress",
  ]),
  options: z.array(z.string().max(100)).max(100).optional(),
  formula: z.string().max(2000).optional(),
  relationPage: z.string().optional(),
  relationField: z.string().optional(),
  rollupField: z.string().optional(),
  aggregate: z.enum(rollupAggregates).optional(),
  rollupDisplay: z.enum(["number", "bar", "ring", "rating"]).optional(),
  rollupMax: z.number().positive().finite().max(1e15).optional(),
  format: z.string().max(40).optional(),
  timeFormat: z.enum(["24", "12"]).optional(),
  decimals: z.number().int().min(0).max(10).optional(),
  parent: z.boolean().optional(),
  parentField: z.string().max(500).optional(),
  doneField: z.string().max(500).optional(),
  doneValues: z.array(z.string().max(100)).max(50).optional(),
  prefix: z.string().regex(/^[A-Z][A-Z0-9]{0,9}$/, "Präfix: Großbuchstaben und Ziffern, z. B. WEB.").optional(),
});
export const view = z
  .object({
    id: str,
    name: str,
    type: z.enum([
      "table",
      "board",
      "calendar",
      "gallery",
      "list",
      "timeline",
      "form",
      "chart",
      "feed",
    ]),
    chart: chartSchema.optional(),
    feed: feedSchema.optional(),
    gallery: gallerySchema.optional(),
    timeline: timelineSchema.optional(),
    calendar: calendarSchema.optional(),
    filters: z.array(filterSchema).max(30),
    filterGroup: filterGroupSchema.optional(),
    sorts: z
      .array(z.object({ field: str, direction: z.enum(["asc", "desc"]) }))
      .max(20),
    groupBy: z.string().optional(),
    tree: z.boolean().optional(),
    subGroupBy: z.string().max(200).optional(),
    groupLevels: z.array(z.string().max(200)).max(3).optional(),
    groupSettings: z
      .object({
        hideEmpty: z.boolean(),
        sort: z.enum(["manual", "asc", "desc"]),
        collapsed: z
          .array(z.string().max(2000))
          .max(1000)
          .refine((keys) => new Set(keys).size === keys.length),
        order: z
          .array(z.string().max(2000))
          .max(1000)
          .refine((keys) => new Set(keys).size === keys.length)
          .optional(),
      })
      .optional(),
    dateField: z.string().optional(),
    endDateField: z.string().optional(),
    hiddenFields: z.array(z.string()).max(80).optional(),
    fieldOrder: z
      .array(z.string())
      .max(80)
      .refine((values) => new Set(values).size === values.length)
      .optional(),
    rowOrder: z
      .array(z.string().uuid())
      .max(MAX_ORDERED_ROWS)
      .refine((values) => new Set(values).size === values.length)
      .optional(),
    groupRowOrder: z
      .record(
        z.string().max(2000),
        z
          .array(z.string().uuid())
          .max(MAX_ORDERED_ROWS)
          .refine((values) => new Set(values).size === values.length),
      )
      .refine((order) => Object.keys(order).length <= 1000)
      .optional(),
    columnWidths: z
      .record(z.string(), z.number().int().min(80).max(800))
      .optional(),
    calculations: calculationsSchema.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.filterGroup && v.filters.length)
      ctx.addIssue({
        code: "custom",
        message:
          "Einfache Filter und Filtergruppen nicht gleichzeitig angeben.",
      });
  });
