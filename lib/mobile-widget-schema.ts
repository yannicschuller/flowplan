// The shapes of the mobile widget API (lib/mobile-widgets.ts and
// lib/mobile-widget-actions.ts): kinds, their configuration per widget
// instance, the data request and the actions. Only zod, so the OpenAPI
// document (lib/openapi.ts) describes the API from the same schemas.
import { z } from "zod";

export const widgetKinds = [
  "capture",
  "tasks",
  "calendar",
  "pinned",
  "counter",
  "journal",
  "time",
  "mentions",
  "forms",
  "focus",
  "meeting",
  "jobs",
  "incident",
] as const;
export type WidgetKind = (typeof widgetKinds)[number];

// Caps of every widget answer.
export const MAX_ITEMS = 10;
export const MAX_WIDGET_BYTES = 2048;
export const MAX_WIDGETS = 16;

const uuid = z.uuid();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const viewId = z.string().min(1).max(100);
const source = z.object({ pageId: uuid, viewId: viewId.optional() });

// ---- Configuration per kind (what the app stores per widget instance) ----

export const widgetConfigs = {
  capture: z.object({ targetId: uuid.optional() }),
  tasks: z.object({
    source: z.enum(["mine", "view", "page"]).default("mine"),
    pageId: uuid.optional(),
    viewId: viewId.optional(),
    filter: z.enum(["today", "overdue", "open"]).default("open"),
    max: z.number().int().min(1).max(MAX_ITEMS).default(5),
  }),
  calendar: z.object({
    sources: z.array(source).max(10).default([]),
    range: z.enum(["today", "3days", "week"]).default("today"),
    tasks: z.boolean().default(true),
    max: z.number().int().min(1).max(MAX_ITEMS).default(MAX_ITEMS),
  }),
  pinned: z.object({
    mode: z.enum(["favorites", "page"]).default("favorites"),
    pageId: uuid.optional(),
    viewId: viewId.optional(),
    properties: z.array(z.string().min(1).max(100)).max(3).default([]),
    max: z.number().int().min(1).max(MAX_ITEMS).default(6),
  }),
  counter: z.object({
    pageId: uuid,
    viewId: viewId.optional(),
    aggregate: z.enum(["count", "sum", "average"]).default("count"),
    fieldId: z.string().min(1).max(100).optional(),
    groupFieldId: z.string().min(1).max(100).optional(),
    groupValue: z.string().max(500).optional(),
    history: z.boolean().default(true),
  }),
  journal: z.object({ journalId: uuid.optional(), habitsId: uuid.optional() }),
  time: z.object({}),
  mentions: z.object({
    show: z.enum(["all", "mentions", "assignments"]).default("all"),
    unreadOnly: z.boolean().default(true),
    max: z.number().int().min(1).max(MAX_ITEMS).default(5),
  }),
  forms: z.object({
    pageId: uuid,
    // The app's "last seen" (ms or ISO); default: the last 24 hours.
    since: z.union([z.number().int().min(0), z.iso.datetime({ offset: true })]).optional(),
    max: z.number().int().min(1).max(5).default(3),
  }),
  focus: z.object({}),
  meeting: z.object({ sources: z.array(source).max(10).default([]), journalId: uuid.optional() }),
  jobs: z.object({}),
  incident: z.object({}),
} satisfies Record<WidgetKind, z.ZodType>;
export type WidgetConfig<K extends WidgetKind> = z.infer<(typeof widgetConfigs)[K]>;

export const dataRequestSchema = z.object({
  // The phone's day and time zone: "today" is the person's day.
  today: day.optional(),
  zone: z.string().max(100).optional(),
  lang: z.string().max(10).optional(),
  widgets: z
    .array(z.object({ id: z.string().max(100).optional(), kind: z.enum(widgetKinds), config: z.record(z.string(), z.unknown()).default({}) }))
    .min(1)
    .max(MAX_WIDGETS),
});

// ---- Actions of widgets, Live Activities and Shortcuts ----

export const widgetActions = [
  "capture.note",
  "capture.task",
  "capture.upload",
  "task.complete",
  "habit.check",
  "journal.track",
  "timer.start",
  "timer.stop",
  "focus.start",
  "focus.stop",
  "mention.read",
  "mention.readAll",
  "meeting.note",
] as const;
export type WidgetAction = (typeof widgetActions)[number];

export const actionSchemas = {
  "capture.note": z.object({ targetId: uuid, title: z.string().trim().min(1).max(300), text: z.string().max(20_000).optional(), due: day.optional() }),
  "capture.task": z.object({ targetId: uuid, title: z.string().trim().min(1).max(300), text: z.string().max(20_000).optional(), due: day.optional() }),
  "capture.upload": z.object({
    targetId: uuid,
    type: z.enum(["photo", "voice"]),
    title: z.string().trim().max(300).optional(),
    transcribe: z.boolean().default(true),
  }),
  "task.complete": z.object({
    source: z.enum(["doc", "row"]),
    pageId: uuid,
    rowId: uuid.nullable().optional(),
    index: z.number().int().min(0).max(5000).optional(),
    text: z.string().max(500).optional(),
    done: z.boolean().default(true),
  }),
  "habit.check": z.object({ pageId: uuid, fieldId: z.string().min(1).max(100), done: z.boolean(), today: day }),
  "journal.track": z.object({
    journalId: uuid,
    today: day,
    trackerId: z.string().regex(/^[a-z0-9-]{1,40}$/),
    value: z.union([z.number().min(-1e6).max(1e6), z.boolean(), z.null()]),
  }),
  "timer.start": z.object({ pageId: uuid, rowId: uuid, fieldId: z.string().min(1).max(500) }),
  "timer.stop": z.object({}),
  "focus.start": z.object({
    minutes: z.number().int().min(1).max(180).default(25),
    breakMinutes: z.number().int().min(0).max(60).default(5),
    pageId: uuid.optional(),
    rowId: uuid.optional(),
    fieldId: z.string().min(1).max(500).optional(),
  }),
  "focus.stop": z.object({}),
  "mention.read": z.object({ notificationId: z.string().min(1).max(100), read: z.boolean().default(true) }),
  "mention.readAll": z.object({}),
  "meeting.note": z.object({
    pageId: uuid,
    rowId: uuid,
    date: day,
    start: z.string().max(40),
    end: z.string().max(40).default(""),
    timed: z.boolean().default(true),
    zone: z.string().max(100).optional(),
    journalId: uuid.optional(),
  }),
} satisfies Record<WidgetAction, z.ZodType>;
