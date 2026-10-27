// Data of the diagramming features on whiteboards (shape libraries,
// connector ends, prototype links, timelines). Like every other property of
// a board item they are plain JSON values inside the item's Y.Map, so they
// travel with collaboration, copies and archives. Boards come from clients:
// everything here is validated with zod before it is drawn or exported, and
// invalid parts are dropped instead of breaking the board.
import { z } from "zod";
import type { WhiteboardItem } from "./whiteboard-model";

// ---- connector ends ----

// Arrowheads (UML, flowcharts) and crow's-foot ends (ERD).
export const markerKinds = [
  "none",
  "arrow",
  "open",
  "triangle",
  "diamond",
  "filledDiamond",
  "circle",
  "dot",
  "cross",
  "one",
  "onlyOne",
  "zeroOrOne",
  "many",
  "oneOrMany",
  "zeroOrMany",
] as const;
export type MarkerKind = (typeof markerKinds)[number];
export const markerSchema = z.enum(markerKinds);

// ---- shape libraries ----

// "<set>:<shape>", e.g. "flow:decision" (lib/whiteboard-shapes-library.ts).
export const libraryIdSchema = z.string().max(60).regex(/^[a-z]+:[a-z0-9-]+$/);

// ---- prototype links ----

// "frame:<id>" (go to that frame) or "back" (previous frame).
export const linkSchema = z.string().max(120).regex(/^(back|frame:[\w-]{1,100})$/);
export const linkTarget = (link: unknown): { frame: string } | { back: true } | null => {
  const parsed = linkSchema.safeParse(link);
  if (!parsed.success) return null;
  return parsed.data === "back" ? { back: true } : { frame: parsed.data.slice(6) };
};

// ---- timelines ----

export const timelineScales = ["week", "month", "quarter"] as const;
export type TimelineScale = (typeof timelineScales)[number];
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const t = Date.parse(`${v}T00:00:00Z`);
    return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v;
  });
const colorValue = z.string().max(40).regex(/^(#[0-9a-f]{3,8}|[a-z]{3,20})$/i);
export const timelineLaneSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().max(120),
});
export const timelineBarSchema = z.object({
  id: z.string().min(1).max(80),
  lane: z.string().max(80),
  title: z.string().max(200),
  start: day,
  end: day,
  color: colorValue.optional(),
  // Bars of a bound timeline: the record they show.
  rowId: z.string().max(80).optional(),
});
export const timelineSourceSchema = z.object({
  // The database and its properties: start date, optional end date, and an
  // optional select property whose options become the lanes.
  pageId: z.string().min(1).max(80),
  // Empty while it is being chosen.
  startField: z.string().max(80),
  endField: z.string().max(80).optional(),
  laneField: z.string().max(80).optional(),
});
export const timelineSchema = z.object({
  scale: z.enum(timelineScales),
  start: day,
  end: day,
  lanes: z.array(timelineLaneSchema).max(40),
  bars: z.array(timelineBarSchema).max(400),
  today: z.boolean().optional(),
  source: timelineSourceSchema.optional(),
});
export type TimelineLane = z.infer<typeof timelineLaneSchema>;
export type TimelineBar = z.infer<typeof timelineBarSchema>;
export type TimelineSource = z.infer<typeof timelineSourceSchema>;
export type TimelineData = z.infer<typeof timelineSchema>;

const MAX_TIMELINE_DAYS = 3 * 366;
// The timeline of an item, with invalid lanes and bars left out; null when
// nothing usable is there.
export function parseTimeline(raw: unknown): TimelineData | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const scale = z.enum(timelineScales).safeParse(value.scale);
  const start = day.safeParse(value.start),
    end = day.safeParse(value.end);
  if (!start.success || !end.success) return null;
  let a = start.data,
    b = end.data;
  if (b < a) [a, b] = [b, a];
  // At most about three years on one board element.
  const span = (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000;
  if (span > MAX_TIMELINE_DAYS) b = new Date(Date.parse(`${a}T00:00:00Z`) + MAX_TIMELINE_DAYS * 86400000).toISOString().slice(0, 10);
  const list = <T,>(input: unknown, schema: z.ZodType<T>, max: number) =>
    (Array.isArray(input) ? input : [])
      .slice(0, max)
      .map((entry) => schema.safeParse(entry))
      .filter((r) => r.success)
      .map((r) => r.data as T);
  const lanes = list(value.lanes, timelineLaneSchema, 40);
  const bars = list(value.bars, timelineBarSchema, 400).map((bar) =>
    bar.end < bar.start ? { ...bar, start: bar.end, end: bar.start } : bar,
  );
  const source = timelineSourceSchema.safeParse(value.source);
  return {
    scale: scale.success ? scale.data : "month",
    start: a,
    end: b,
    lanes,
    bars,
    ...(value.today === false ? { today: false } : {}),
    ...(source.success ? { source: source.data } : {}),
  };
}

// What a timeline shows to anyone who can read the board: a timeline bound
// to a database shows its records only live, for those who may read them
// (components/whiteboard/timeline-item.tsx), so exports and search leave
// its bars and lanes out.
export function publicTimeline(raw: unknown): TimelineData | null {
  const timeline = parseTimeline(raw);
  return timeline?.source ? { ...timeline, lanes: [], bars: [] } : timeline;
}

// ---- the item as a whole ----

// The diagram properties of an item, validated: what is not valid is gone.
export function cleanDiagramFields<T extends Partial<WhiteboardItem>>(item: T): T {
  const out = { ...item };
  if (out.lib !== undefined && !libraryIdSchema.safeParse(out.lib).success) delete out.lib;
  for (const key of ["startMarker", "endMarker"] as const)
    if (out[key] !== undefined && !markerSchema.safeParse(out[key]).success) delete out[key];
  if (out.link !== undefined && !linkSchema.safeParse(out.link).success) delete out.link;
  if (out.timeline !== undefined) {
    const timeline = parseTimeline(out.timeline);
    if (timeline) out.timeline = timeline;
    else delete out.timeline;
  }
  return out;
}

// Copies get new ids: links to frames that were copied along point to the
// copies, links to other frames stay as they are.
export function remapLink<T extends Partial<WhiteboardItem>>(item: T, ids: Map<string, string>): T {
  const target = linkTarget(item.link);
  if (!target || !("frame" in target)) return item;
  const next = ids.get(target.frame);
  return next ? { ...item, link: `frame:${next}` } : item;
}

// Words of the diagram properties for search and previews.
export function diagramText(item: Partial<WhiteboardItem>): string[] {
  if (item.type !== "timeline") return [];
  const timeline = publicTimeline(item.timeline);
  if (!timeline) return [];
  return [...timeline.lanes.map((l) => l.name), ...timeline.bars.map((b) => b.title)].filter(Boolean);
}
