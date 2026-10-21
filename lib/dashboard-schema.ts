// Dashboard pages: a grid of tiles the person arranges. The tiles are stored
// as JSON in dashboards.tiles; this schema checks them on every save and
// again when they are read (older or hand-edited JSON never breaks a page).
import { z } from "zod";

export const tileSizes = ["small", "medium", "large", "full"] as const;
export type TileSize = (typeof tileSizes)[number];
// Columns of the 12-column desktop grid per size.
export const tileColumns: Record<TileSize, number> = { small: 3, medium: 6, large: 8, full: 12 };
export const MAX_TILES = 48;

const source = z.string().uuid();
const viewId = z.string().max(80).default("");
const fieldId = z.string().max(500).default("");
const base = {
  id: z.string().min(1).max(40),
  size: z.enum(tileSizes).default("medium"),
  title: z.string().max(120).default(""),
};

export const tileSchema = z.discriminatedUnion("type", [
  // A view of a database, as the linked-database block shows it.
  z.object({ ...base, type: z.literal("view"), source, view: viewId, interactive: z.boolean().default(false) }),
  // One number: how many records a view shows, or a rollup of a number
  // property, with an optional target (progress bar).
  z.object({
    ...base,
    type: z.literal("number"),
    source,
    view: viewId,
    aggregate: z.enum(["count", "sum", "average", "min", "max"]).default("count"),
    field: fieldId,
    target: z.number().finite().nullable().default(null),
  }),
  // A chart over a property, drawn like the chart view.
  z.object({
    ...base,
    type: z.literal("chart"),
    source,
    view: viewId,
    kind: z.enum(["bar", "horizontal", "line", "donut"]).default("bar"),
    xField: fieldId,
    aggregate: z.enum(["count", "sum", "average", "min", "max"]).default("count"),
    yField: fieldId,
  }),
  // Writing streak of a journal and today's entry.
  z.object({ ...base, type: z.literal("journal"), source }),
  // Tasks due today or overdue for the viewer ("Meine Aufgaben").
  z.object({ ...base, type: z.literal("tasks") }),
  // Recently changed pages and the number of unread notifications.
  z.object({ ...base, type: z.literal("recent"), limit: z.number().int().min(1).max(20).default(6) }),
  // Free text in Markdown.
  z.object({ ...base, type: z.literal("text"), text: z.string().max(20_000).default("") }),
]);
export type Tile = z.infer<typeof tileSchema>;
export type TileType = Tile["type"];
export const tileTypes = ["view", "number", "chart", "journal", "tasks", "recent", "text"] as const satisfies readonly TileType[];

export const tilesSchema = z
  .array(tileSchema)
  .max(MAX_TILES)
  .refine((tiles) => new Set(tiles.map((t) => t.id)).size === tiles.length, "Kachel-IDs doppelt.");

// Stored JSON to tiles; tiles that no longer validate are left out.
export function parseTiles(json: string | null | undefined): Tile[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json || "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const tiles: Tile[] = [];
  for (const item of raw.slice(0, MAX_TILES)) {
    const parsed = tileSchema.safeParse(item);
    if (parsed.success && !seen.has(parsed.data.id)) {
      seen.add(parsed.data.id);
      tiles.push(parsed.data);
    }
  }
  return tiles;
}
