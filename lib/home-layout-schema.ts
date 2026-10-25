// The personal start page (components/home): which widgets it shows, in
// which order and size, with what settings, and how it looks. Only zod and
// plain data, so the browser and the server (lib/home-layout.ts) check a
// layout with the same rules.
//
// Stored per person and workspace (or as the person's default for all
// workspaces, or as a workspace's default for its members) as JSON with a
// `version`. parseLayout() reads every stored version and never throws:
// unknown widgets are dropped, broken settings fall back to their defaults.
// saveSchema() is the strict check for what the browser sends.
import { z } from "zod";

export const LAYOUT_VERSION = 1;
// Caps: widgets per start page, bytes of a stored layout, text of a note.
export const MAX_HOME_WIDGETS = 24;
export const MAX_LAYOUT_BYTES = 24_000;
export const MAX_NOTE_LENGTH = 4000;
export const MAX_LINKS = 20;

// Widgets; new kinds go at the end. Server kinds get their data from
// POST /api/home/data (lib/home-widgets.ts), the others from the bootstrap.
export const homeWidgetKinds = [
  "greeting",
  "recent",
  "quick",
  "pages",
  "favorites",
  "tasks",
  "inbox",
  "journal",
  "calendar",
  "database",
  "pinned",
  "capture",
  "focus",
  "habits",
  "counter",
  "notes",
  "activity",
  "stats",
  "links",
  "instance",
] as const;
export type HomeWidgetKind = (typeof homeWidgetKinds)[number];
export const serverWidgetKinds = ["tasks", "journal", "calendar", "database", "pinned", "focus", "habits", "counter", "activity", "stats", "instance"] as const satisfies readonly HomeWidgetKind[];
export type ServerWidgetKind = (typeof serverWidgetKinds)[number];
export const isServerKind = (kind: HomeWidgetKind): kind is ServerWidgetKind => (serverWidgetKinds as readonly string[]).includes(kind);

// Width in the grid: one column, two, three, or the whole row. The grid has
// one column on phones, two on tablets and three or four on wide screens;
// a widget never gets wider than the grid.
export const widgetSizes = ["s", "m", "l", "full"] as const;
export type WidgetSize = (typeof widgetSizes)[number];

const uuid = z.uuid();
const viewId = z.string().min(1).max(100);
const title = z.string().trim().max(60).optional();
const count = (min: number, max: number, fallback: number) => z.number().int().min(min).max(max).default(fallback);
// Links of a bookmarks widget: web and mail addresses only.
export const linkUrl = z
  .string()
  .trim()
  .max(2000)
  .refine((value) => /^(https?:\/\/[^\s]+|mailto:[^\s]+)$/i.test(value), "Ungültige Adresse.");

export const widgetConfigs = {
  greeting: z.object({
    title,
    showDate: z.boolean().default(true),
    showMessage: z.boolean().default(true),
    // Own words under the greeting instead of the default line.
    message: z.string().trim().max(140).default(""),
  }),
  recent: z.object({
    title,
    mode: z.enum(["edited", "viewed"]).default("edited"),
    style: z.enum(["cards", "list"]).default("cards"),
    max: count(2, 12, 4),
  }),
  quick: z.object({
    title,
    actions: z
      .array(z.enum(["page", "capture", "database", "journal", "whiteboard"]))
      .max(5)
      .default(["page", "capture", "database"]),
  }),
  pages: z.object({ title, spaceId: uuid.optional() }),
  favorites: z.object({ title, max: count(3, 20, 8) }),
  tasks: z.object({
    title,
    // "mine": the tasks of "My tasks" in this workspace; "view": the open
    // records of a database view (done by the database's done rule).
    source: z.enum(["mine", "view"]).default("mine"),
    pageId: uuid.optional(),
    viewId: viewId.optional(),
    // "due": overdue and due today.
    filter: z.enum(["due", "today", "overdue", "open"]).default("due"),
    max: count(1, 10, 6),
  }),
  inbox: z.object({ title, unreadOnly: z.boolean().default(false), max: count(1, 10, 5) }),
  journal: z.object({ title, journalId: uuid.optional(), quickWrite: z.boolean().default(true) }),
  calendar: z.object({
    title,
    range: z.enum(["today", "3days", "week"]).default("week"),
    // Calendar and timeline views (also those synced with CalDAV, Google or
    // Microsoft 365); none: all of this workspace.
    sources: z.array(z.object({ pageId: uuid, viewId: viewId.optional() })).max(10).default([]),
    tasks: z.boolean().default(true),
    max: count(1, 10, 8),
  }),
  database: z.object({
    title,
    pageId: uuid.optional(),
    viewId: viewId.optional(),
    properties: z.array(z.string().min(1).max(100)).max(3).default([]),
    style: z.enum(["list", "table", "board"]).default("list"),
    max: count(1, 10, 6),
  }),
  pinned: z.object({ title, pageId: uuid.optional(), preview: z.boolean().default(true) }),
  capture: z.object({ title, targetId: uuid.optional() }),
  focus: z.object({ title, minutes: count(5, 120, 25) }),
  habits: z.object({ title, pageId: uuid.optional() }),
  counter: z.object({
    title,
    pageId: uuid.optional(),
    viewId: viewId.optional(),
    aggregate: z.enum(["count", "sum", "average"]).default("count"),
    fieldId: z.string().min(1).max(100).optional(),
    history: z.boolean().default(true),
  }),
  notes: z.object({ title, text: z.string().max(MAX_NOTE_LENGTH).default("") }),
  activity: z.object({ title, max: count(3, 15, 8), records: z.boolean().default(true) }),
  stats: z.object({ title }),
  links: z.object({
    title,
    links: z
      .array(z.object({ title: z.string().trim().max(80).default(""), url: linkUrl }))
      .max(MAX_LINKS)
      .default([]),
  }),
  instance: z.object({ title }),
} satisfies Record<HomeWidgetKind, z.ZodType>;
export type WidgetConfig<K extends HomeWidgetKind> = z.infer<(typeof widgetConfigs)[K]>;

// The size a widget gets when it is added.
export const defaultSizes: Record<HomeWidgetKind, WidgetSize> = {
  greeting: "full",
  recent: "full",
  quick: "full",
  pages: "full",
  favorites: "s",
  tasks: "m",
  inbox: "m",
  journal: "m",
  calendar: "m",
  database: "m",
  pinned: "m",
  capture: "s",
  focus: "s",
  habits: "s",
  counter: "s",
  notes: "s",
  activity: "m",
  stats: "m",
  links: "s",
  instance: "s",
};

const widgetId = z.string().regex(/^[a-z0-9-]{1,40}$/i);
export const widgetSchema = z.discriminatedUnion(
  "kind",
  homeWidgetKinds.map((kind) =>
    z.object({ id: widgetId, kind: z.literal(kind), size: z.enum(widgetSizes), config: widgetConfigs[kind] }),
  ) as unknown as [z.ZodObject<{ kind: z.ZodLiteral<HomeWidgetKind> }>],
);
export type HomeWidget = { [K in HomeWidgetKind]: { id: string; kind: K; size: WidgetSize; config: WidgetConfig<K> } }[HomeWidgetKind];

// Header: nothing, a colour, a gradient or an image the person may see
// (a page cover or other image of this instance, /api/files/<id>).
export const headerGradients = ["dawn", "ocean", "forest", "dusk", "sand", "slate"] as const;
const fileUrl = /^\/api\/files\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const headerSchema = z
  .object({
    type: z.enum(["none", "color", "gradient", "image"]).default("none"),
    value: z.string().max(120).default(""),
    // Vertical crop of an image, as with page covers.
    position: z.number().min(0).max(100).default(50),
  })
  .refine(
    (h) =>
      h.type === "none" ||
      (h.type === "color" && /^#[0-9a-f]{6}$/i.test(h.value)) ||
      (h.type === "gradient" && (headerGradients as readonly string[]).includes(h.value)) ||
      (h.type === "image" && fileUrl.test(h.value)),
    "Ungültiger Kopfbereich.",
  );
export const appearanceSchema = z.object({
  header: headerSchema.default({ type: "none", value: "", position: 50 }),
  density: z.enum(["comfortable", "compact"]).default("comfortable"),
  background: z.enum(["none", "dots", "grid", "tint"]).default("none"),
  // An emoji for the start page (shown with the header), "" for none.
  icon: z
    .string()
    .max(32)
    .refine((v) => v === "" || (!/[<>"'`\\/]/.test(v) && [...v].length <= 8), "Ungültiges Symbol.")
    .default(""),
  width: z.enum(["normal", "wide"]).default("normal"),
});
export type HomeAppearance = z.infer<typeof appearanceSchema>;

export const layoutSchema = z.object({
  version: z.literal(LAYOUT_VERSION),
  widgets: z.array(widgetSchema).max(MAX_HOME_WIDGETS),
  appearance: appearanceSchema,
});
export type HomeLayout = { version: typeof LAYOUT_VERSION; widgets: HomeWidget[]; appearance: HomeAppearance };

const appearanceDefaults = (): HomeAppearance => appearanceSchema.parse({});

export function makeWidget<K extends HomeWidgetKind>(kind: K, id: string, config: Partial<WidgetConfig<K>> = {}, size?: WidgetSize): HomeWidget {
  return { id, kind, size: size ?? defaultSizes[kind], config: widgetConfigs[kind].parse(config) } as HomeWidget;
}

// What everybody starts with: the start page as it always was – greeting,
// recently edited and viewed pages, quick starts and the workspace's pages.
export function defaultLayout(): HomeLayout {
  return {
    version: LAYOUT_VERSION,
    widgets: [
      makeWidget("greeting", "greeting"),
      makeWidget("recent", "recent"),
      makeWidget("recent", "visited", { mode: "viewed", style: "list", max: 8 }),
      makeWidget("quick", "quick"),
      makeWidget("pages", "pages"),
    ],
    appearance: appearanceDefaults(),
  };
}

// Any stored or received value as a valid layout. Version 0 (before the
// version field) was a plain list of widgets; a newer version than this
// code knows falls back to the default instead of losing data on save.
export function parseLayout(raw: unknown): HomeLayout {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return defaultLayout();
    }
  }
  if (Array.isArray(value)) value = { version: LAYOUT_VERSION, widgets: value };
  if (!value || typeof value !== "object") return defaultLayout();
  const input = value as { version?: unknown; widgets?: unknown; appearance?: unknown };
  if (input.version !== undefined && input.version !== LAYOUT_VERSION) return defaultLayout();
  const widgets: HomeWidget[] = [];
  const ids = new Set<string>();
  for (const item of Array.isArray(input.widgets) ? input.widgets : []) {
    if (widgets.length >= MAX_HOME_WIDGETS) break;
    const widget = parseWidget(item);
    if (!widget) continue;
    // Two widgets with one id would share their data and settings.
    let id = widget.id;
    for (let n = 2; ids.has(id); n++) id = `${widget.id.slice(0, 36)}-${n}`;
    ids.add(id);
    widgets.push({ ...widget, id });
  }
  const appearance = appearanceSchema.safeParse(input.appearance ?? {});
  return {
    version: LAYOUT_VERSION,
    widgets,
    appearance: appearance.success ? appearance.data : repairAppearance(input.appearance),
  };
}
function parseWidget(item: unknown): HomeWidget | null {
  const parsed = widgetSchema.safeParse(item);
  if (parsed.success) return parsed.data as HomeWidget;
  if (!item || typeof item !== "object") return null;
  const w = item as { id?: unknown; kind?: unknown; size?: unknown; config?: unknown };
  if (!(homeWidgetKinds as readonly unknown[]).includes(w.kind)) return null;
  const kind = w.kind as HomeWidgetKind;
  const id = widgetId.safeParse(w.id).success ? (w.id as string) : `${kind}-${Math.random().toString(36).slice(2, 8)}`;
  const size = (widgetSizes as readonly unknown[]).includes(w.size) ? (w.size as WidgetSize) : defaultSizes[kind];
  // Keep the settings that are still valid, one by one.
  const schema = widgetConfigs[kind] as unknown as z.ZodObject<Record<string, z.ZodType>>;
  const source = w.config && typeof w.config === "object" ? (w.config as Record<string, unknown>) : {};
  const kept: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(schema.shape))
    if (key in source && field.safeParse(source[key]).success) kept[key] = source[key];
  const config = schema.safeParse(kept);
  return config.success ? ({ id, kind, size, config: config.data } as HomeWidget) : null;
}
function repairAppearance(raw: unknown): HomeAppearance {
  const out = appearanceDefaults();
  if (!raw || typeof raw !== "object") return out;
  const shape = appearanceSchema.shape as Record<string, z.ZodType>;
  for (const [key, field] of Object.entries(shape)) {
    const parsed = field.safeParse((raw as Record<string, unknown>)[key]);
    if (parsed.success) (out as Record<string, unknown>)[key] = parsed.data;
  }
  return out;
}

// What the browser sends when the person saves: strictly checked.
export const saveSchema = z.object({
  workspaceId: uuid,
  // "workspace": this workspace only; "personal": the person's default for
  // every workspace they have not set up on its own.
  scope: z.enum(["workspace", "personal"]).default("workspace"),
  layout: layoutSchema,
});
export function layoutBytes(layout: HomeLayout) {
  return new TextEncoder().encode(JSON.stringify(layout)).length;
}
