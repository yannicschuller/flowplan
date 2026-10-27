// Data and actions of the start page's widgets (components/home), for the
// signed-in person and one workspace:
//
//   POST /api/home/data      { workspaceId, today, zone, widgets: [{ id, kind, config }] }
//   POST /api/home/action    task.complete, habit.check, focus.*, timer.stop, journal.note
//   GET  /api/home/options   calendars, habit databases, a database's views and properties
//
// The data comes from the builders of the mobile widgets (lib/mobile-widgets.ts)
// – the same permissions, nothing of pages behind a journal PIN that was not
// entered, only a status for end-to-end encrypted spaces –, limited to the
// workspace the start page belongs to. Actions go through the mobile widget
// actions and so through the web app's commands.
import { z } from "zod";
import { Fragment } from "@tiptap/pm/model";
import { Temporal } from "@js-temporal/polyfill";
import { all, audit, one, transaction } from "./db";
import { HttpError } from "./auth";
import { allow } from "./action-limits";
import { command } from "./api";
import { cellText } from "./cell-text";
import { ct } from "./content-locale";
import { myTasks, taskKey } from "./doc-tasks";
import { rewriteDocument, rewriteSchema } from "./document-rewrite";
import { visibleFields } from "./field-access";
import { lockedPageIds, requireUnlocked } from "./journal-extras";
import { recordPageEdit } from "./page-activity";
import { pagePreview } from "./page-preview";
import { pageRole, requireMember, requirePage } from "./permissions";
import { hiddenRowIds } from "./row-access";
import { htmlText } from "./search-index";
import { sortTasks } from "./task-order";
import {
  calendarSourceList,
  habitDatabases,
  pageAccess,
  widgetContext,
  widgetData,
  widgetOptions,
  writerOf,
  type Context,
  type WidgetTask,
} from "./mobile-widgets";
import { widgetAction } from "./mobile-widget-actions";
import { MAX_HOME_WIDGETS, serverWidgetKinds, widgetConfigs, type ServerWidgetKind, type WidgetConfig } from "./home-layout-schema";
import type { Field, Identity, Page } from "./types";

// Bytes per widget answer (the phone's widgets get 2 KB).
export const HOME_WIDGET_BYTES = 12_000;
const uuid = z.uuid();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const rank: Record<string, number> = { viewer: 1, editor: 2, owner: 3 };
const clip = (text: string, max: number) => {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
};
const untitled = () => ct("Ohne Titel", "Untitled");

// Per person and minute: one start page asks once per load and after changes.
function limit(user: Pick<Identity, "id">, what: "data" | "action" | "options") {
  const max = what === "data" ? 120 : 60;
  if (!allow(`home-${what}:${user.id}`, max, 60_000))
    throw new HttpError(429, ct("Zu viele Anfragen in kurzer Zeit. Bitte später erneut versuchen.", "Too many requests in a short time. Please try again later."));
}

// Pages of this workspace only: a layout shared across workspaces may name
// pages of another one, which then simply do not show here.
type Scope = { user: Identity; workspaceId: string; inside: (pageId: string | null | undefined) => boolean; need: (pageId: string | null | undefined) => string };
function scopeOf(user: Identity, workspaceId: string): Scope {
  const cache = new Map<string, string | null>();
  const inside = (pageId: string | null | undefined) => {
    if (!pageId) return false;
    if (!cache.has(pageId)) cache.set(pageId, one<{ workspace_id: string }>("SELECT workspace_id FROM pages WHERE id=? AND deleted_at IS NULL", pageId)?.workspace_id ?? null);
    return cache.get(pageId) === workspaceId;
  };
  const need = (pageId: string | null | undefined) => {
    if (!inside(pageId)) throw new HttpError(404, ct("Seite nicht gefunden.", "Page not found."));
    return pageId!;
  };
  return { user, workspaceId, inside, need };
}
// Whether the person can tick off tasks in a page.
function editableIn(user: Identity) {
  const cache = new Map<string, boolean>();
  return (pageId: string) => {
    if (!cache.has(pageId)) {
      const access = pageAccess(user, pageId);
      cache.set(pageId, !!access && rank[access.role] >= 2 && !access.page.locked && !access.locked && !access.encrypted);
    }
    return cache.get(pageId)!;
  };
}

// ---- Builders ----

type Builder<K extends ServerWidgetKind> = (ctx: Context, scope: Scope, config: WidgetConfig<K>) => Record<string, unknown>;

const tasks: Builder<"tasks"> = (ctx, scope, config) => {
  const { today } = ctx;
  const keep = (due: string | null) =>
    config.filter === "open" ? true : config.filter === "today" ? due === today : config.filter === "overdue" ? !!due && due < today : !!due && due <= today;
  if (config.source === "view") {
    if (!config.pageId) return { unconfigured: true, items: [], total: 0 };
    scope.need(config.pageId);
    // The phone's filters know "today", "overdue" and "open"; "due" is both.
    const data = widgetData(ctx, "tasks", { source: "view", pageId: config.pageId, viewId: config.viewId, filter: config.filter === "due" ? "open" : config.filter, max: 10 }, HOME_WIDGET_BYTES);
    const items = ((data.items as WidgetTask[] | undefined) || []).filter((t) => keep(t.due));
    return { ...data, items: items.slice(0, config.max), total: config.filter === "due" ? items.length : data.total };
  }
  const canEdit = editableIn(ctx.user);
  const mine = myTasks(ctx.user, scope.workspaceId).filter((t) => keep(t.due));
  const sorted = sortTasks(
    mine.map((t) => ({ due: t.due, page: t.title, pageId: t.pageId, rowId: t.rowId, index: t.index, task: t })),
    today,
  );
  return {
    title: ct("Meine Aufgaben", "My tasks"),
    total: sorted.length,
    items: sorted.slice(0, config.max).map(({ task: t }) => ({
      source: "doc",
      pageId: t.pageId,
      rowId: t.rowId,
      index: t.index,
      key: taskKey(t.text),
      text: clip(t.text, 200),
      due: t.due,
      done: false,
      page: clip(t.title || untitled(), 80),
      icon: t.icon,
      canEdit: canEdit(t.pageId),
    })),
  };
};

const calendar: Builder<"calendar"> = (ctx, scope, config) => {
  const sources = (config.sources.length ? config.sources : calendarSourceList(ctx.user, 60))
    .filter((s) => scope.inside(s.pageId))
    .slice(0, 10)
    .map((s) => ({ pageId: s.pageId, ...(s.viewId ? { viewId: s.viewId } : {}) }));
  const length = config.range === "today" ? 1 : config.range === "3days" ? 3 : 7;
  const last = Temporal.PlainDate.from(ctx.today).add({ days: length - 1 }).toString();
  // No calendar here: an empty source list would mean "all workspaces".
  const data = sources.length
    ? widgetData(ctx, "calendar", { sources, range: config.range, tasks: false, max: 10 }, HOME_WIDGET_BYTES)
    : { from: ctx.today, to: last, items: [] as Record<string, unknown>[], total: 0 };
  const items = [...((data.items as Record<string, unknown>[]) || [])];
  if (config.tasks)
    for (const t of myTasks(ctx.user, scope.workspaceId).filter((t) => t.due && t.due >= ctx.today && t.due <= last))
      items.push({ type: "task", title: clip(t.text, 120), day: t.due, start: t.due, end: t.due, timed: false, calendar: clip(t.title || untitled(), 40), pageId: t.pageId, rowId: t.rowId });
  items.sort((a, b) => String(a.day).localeCompare(String(b.day)) || Number(b.type === "event") - Number(a.type === "event") || String(a.start).localeCompare(String(b.start)));
  return { from: ctx.today, to: last, calendars: sources.length, total: items.length, items: items.slice(0, config.max) };
};

// The person's journal in this workspace: their own first.
function defaultJournal(user: Identity, workspaceId: string) {
  return all<Page>("SELECT * FROM pages WHERE workspace_id=? AND kind='journal' AND deleted_at IS NULL ORDER BY (created_by=?) DESC, position", workspaceId, user.id).find((p) => pageRole(user, p))?.id;
}
const journal: Builder<"journal"> = (ctx, scope, config) => {
  const journalId = config.journalId ?? defaultJournal(ctx.user, scope.workspaceId);
  if (!journalId) return { journal: null };
  scope.need(journalId);
  const data = widgetData(ctx, "journal", { journalId }, HOME_WIDGET_BYTES) as { journal: Record<string, unknown> | null };
  const entry = data.journal;
  let excerpt = "";
  if (entry && !entry.locked && !entry.encrypted) {
    const today = one<Page>("SELECT * FROM pages WHERE parent_id=? AND journal_date=? AND deleted_at IS NULL", journalId, ctx.today);
    if (today && pageRole(ctx.user, today)) excerpt = clip(htmlText(one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", today.id)?.html || ""), 280);
  }
  return { journal: entry ? { ...entry, excerpt } : null };
};

const database: Builder<"database"> = (ctx, scope, config) => {
  if (!config.pageId) return { unconfigured: true, items: [], total: 0 };
  scope.need(config.pageId);
  return widgetData(ctx, "pinned", { mode: "page", pageId: config.pageId, viewId: config.viewId, properties: config.properties, max: config.max }, HOME_WIDGET_BYTES);
};

const pinned: Builder<"pinned"> = (ctx, scope, config) => {
  if (!config.pageId) return { unconfigured: true };
  scope.need(config.pageId);
  const access = pageAccess(ctx.user, config.pageId);
  if (!access) throw new HttpError(404, ct("Seite nicht gefunden.", "Page not found."));
  const base = { id: access.page.id, kind: access.page.kind };
  // Behind a PIN or end-to-end encrypted: no content, the title comes from
  // the sidebar (decrypted in the browser).
  if (access.locked || access.encrypted) return { ...base, ...(access.encrypted ? { encrypted: true } : { locked: true }) };
  const children = config.preview ? widgetData(ctx, "pinned", { mode: "page", pageId: access.page.id, max: 5 }, HOME_WIDGET_BYTES) : null;
  const preview = config.preview && access.page.kind === "document" ? pagePreview(ctx.user, access.page.id) : null;
  return {
    ...base,
    title: clip(access.page.title || untitled(), 120),
    icon: access.page.icon,
    cover: access.page.cover,
    updatedAt: access.page.updated_at,
    excerpt: preview?.excerpt || "",
    ...(children ? { total: children.total, items: children.items, properties: children.properties } : {}),
  };
};

const focus: Builder<"focus"> = (ctx) => {
  const state = widgetData(ctx, "focus", {}, HOME_WIDGET_BYTES);
  const time = widgetData(ctx, "time", {}, HOME_WIDGET_BYTES);
  return { ...state, timer: time.timer, today: time.today, week: time.week, recent: time.recent };
};

const habits: Builder<"habits"> = (ctx, scope, config) => {
  const pageId = config.pageId ?? habitDatabases(ctx.user).find((d) => scope.inside(d.id))?.id;
  if (!pageId) return { habits: null };
  scope.need(pageId);
  // The journal part is not needed; any readable journal keeps it cheap.
  return { habits: (widgetData(ctx, "journal", { habitsId: pageId }, HOME_WIDGET_BYTES) as { habits: unknown }).habits };
};

const counter: Builder<"counter"> = (ctx, scope, config) => {
  if (!config.pageId) return { unconfigured: true };
  scope.need(config.pageId);
  return widgetData(ctx, "counter", { ...config, pageId: config.pageId }, HOME_WIDGET_BYTES);
};

// Who changed what lately: page edits (lib/page-activity.ts) and records,
// only where the person may read, never behind a PIN or encrypted.
const activity: Builder<"activity"> = (ctx, scope, config) => {
  const { user, workspaceId } = scope;
  const hidden = lockedPageIds(user, workspaceId);
  const readable = new Map<string, Page | null>();
  const page = (id: string) => {
    if (!readable.has(id)) {
      const p = one<Page>("SELECT * FROM pages WHERE id=? AND deleted_at IS NULL AND COALESCE(synced,0)=0", id);
      readable.set(id, p && !hidden.has(p.id) && pageRole(user, p) ? p : null);
    }
    return readable.get(id);
  };
  const names = new Map<string, string>();
  const nameOf = (id: string | null) => {
    if (!id) return "";
    if (!names.has(id)) names.set(id, one<{ name: string }>("SELECT name FROM users WHERE id=?", id)?.name || "");
    return names.get(id)!;
  };
  const items: { type: "page" | "record"; pageId: string; rowId?: string; title: string; page?: string; icon: string; by: string; mine: boolean; at: number }[] = [];
  for (const e of all<{ page_id: string; user_id: string; at: number }>(
    "SELECT e.page_id,e.user_id,e.at FROM page_edits e JOIN pages p ON p.id=e.page_id WHERE p.workspace_id=? ORDER BY e.at DESC LIMIT 200",
    workspaceId,
  )) {
    const p = page(e.page_id);
    if (!p) continue;
    items.push({ type: "page", pageId: p.id, title: clip(p.title || untitled(), 80), icon: p.icon, by: nameOf(e.user_id), mine: e.user_id === user.id, at: e.at });
    if (items.length >= config.max * 2) break;
  }
  if (config.records) {
    const fieldsOf = new Map<string, { fields: Field[]; shown: Field[]; hidden: Set<string> }>();
    const candidates = all<{ id: string; page_id: string; cells: string; updated_at: string; updated_by: string | null }>(
      `SELECT r.id,r.page_id,r.cells,r.updated_at,r.updated_by FROM rows r JOIN pages p ON p.id=r.page_id
       WHERE p.workspace_id=? AND p.deleted_at IS NULL ORDER BY r.updated_at DESC LIMIT 200`,
      workspaceId,
    );
    let records = 0;
    for (const r of candidates) {
      const p = page(r.page_id);
      if (!p || p.kind !== "database") continue;
      if (!fieldsOf.has(p.id)) {
        const fields = JSON.parse(one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", p.id)?.fields || "[]") as Field[];
        fieldsOf.set(p.id, { fields, shown: visibleFields(user, p, fields), hidden: hiddenRowIds(user, p) });
      }
      const { fields, shown, hidden: privateRows } = fieldsOf.get(p.id)!;
      // Private records of others stay hidden.
      if (privateRows.has(r.id)) continue;
      const first = fields[0];
      let cells: Record<string, unknown> = {};
      try {
        cells = JSON.parse(r.cells);
      } catch {}
      const title = (first && shown.includes(first) ? clip(cellText(cells[first.id]), 80) : "") || untitled();
      const at = Date.parse(`${r.updated_at.replace(" ", "T")}Z`);
      items.push({ type: "record", pageId: p.id, rowId: r.id, title, page: clip(p.title || untitled(), 60), icon: p.icon, by: nameOf(r.updated_by), mine: r.updated_by === user.id, at: Number.isFinite(at) ? at : 0 });
      if (++records >= config.max) break;
    }
  }
  items.sort((a, b) => b.at - a.at);
  return { items: items.slice(0, config.max) };
};

// This week in numbers (Monday to today, in the person's time zone).
const stats: Builder<"stats"> = (ctx, scope) => {
  const { user, workspaceId } = scope;
  const today = Temporal.PlainDate.from(ctx.today);
  const monday = today.subtract({ days: today.dayOfWeek - 1 });
  const from = monday.toZonedDateTime({ timeZone: ctx.zone }).epochMilliseconds;
  const hidden = lockedPageIds(user, workspaceId);
  const readable = new Map<string, boolean>();
  const canRead = (id: string) => {
    if (!readable.has(id)) {
      const p = one<Page>("SELECT * FROM pages WHERE id=? AND deleted_at IS NULL", id);
      readable.set(id, !!p && !hidden.has(id) && !!pageRole(user, p));
    }
    return readable.get(id)!;
  };
  const edits = all<{ page_id: string; user_id: string }>(
    "SELECT e.page_id,e.user_id FROM page_edits e JOIN pages p ON p.id=e.page_id WHERE p.workspace_id=? AND e.at>=? LIMIT 5000",
    workspaceId,
    from,
  ).filter((e) => canRead(e.page_id));
  // Records that became done this week (lib/automations.ts writes the log).
  const done = all<{ page_id: string; row_id: string }>(
    "SELECT l.page_id,l.row_id FROM row_status_log l JOIN pages p ON p.id=l.page_id WHERE p.workspace_id=? AND l.done=1 AND l.at>=? LIMIT 5000",
    workspaceId,
    from,
  ).filter((l) => canRead(l.page_id));
  const open = myTasks(user, workspaceId);
  const time = widgetData(ctx, "time", {}, HOME_WIDGET_BYTES) as { week?: number };
  return {
    from: monday.toString(),
    pagesEdited: new Set(edits.map((e) => e.page_id)).size,
    pagesEditedByMe: new Set(edits.filter((e) => e.user_id === user.id).map((e) => e.page_id)).size,
    recordsDone: new Set(done.map((d) => d.row_id)).size,
    openTasks: open.length,
    overdueTasks: open.filter((t) => t.due && t.due < ctx.today).length,
    hours: time.week ?? 0,
  };
};

const instance: Builder<"instance"> = (ctx) => widgetData(ctx, "incident", {}, HOME_WIDGET_BYTES);

const builders: { [K in ServerWidgetKind]: Builder<K> } = { tasks, calendar, journal, database, pinned, focus, habits, counter, activity, stats, instance };

export const homeDataSchema = z.object({
  workspaceId: uuid,
  // The browser's day and time zone: "today" is the person's day.
  today: day.optional(),
  zone: z.string().max(100).optional(),
  widgets: z
    .array(z.object({ id: z.string().regex(/^[a-z0-9-]{1,40}$/i), kind: z.enum(serverWidgetKinds), config: z.record(z.string(), z.unknown()).default({}) }))
    .max(MAX_HOME_WIDGETS),
});

// Each widget answers on its own: one that fails does not take the others.
export function homeData(user: Identity, input: unknown, now = Date.now()) {
  const request = homeDataSchema.parse(input);
  requireMember(user, request.workspaceId);
  limit(user, "data");
  const ctx = widgetContext(user, request.today, request.zone, now);
  const scope = scopeOf(user, request.workspaceId);
  return {
    at: now,
    today: ctx.today,
    widgets: request.widgets.map((w) => {
      try {
        const config = widgetConfigs[w.kind].parse(w.config);
        return { id: w.id, kind: w.kind, ok: true as const, data: (builders[w.kind] as Builder<typeof w.kind>)(ctx, scope, config as never) };
      } catch (error) {
        const status = error instanceof HttpError ? error.status : error instanceof z.ZodError ? 400 : 500;
        if (status === 500) console.error("Home widget", w.kind, error);
        return {
          id: w.id,
          kind: w.kind,
          ok: false as const,
          status,
          error: status === 500 ? ct("Fehler", "Error") : error instanceof z.ZodError ? ct("Ungültige Einstellung.", "Invalid setting.") : (error as Error).message,
        };
      }
    }),
  };
}

// ---- Actions ----

const homeActions = ["task.complete", "habit.check", "focus.start", "focus.stop", "timer.stop", "journal.note"] as const;
const journalNote = z.object({ action: z.literal("journal.note"), journalId: uuid, today: day, text: z.string().trim().min(1).max(4000) });

// A few lines at the end of today's journal entry, as if typed there.
function writeJournal(user: Identity, input: z.infer<typeof journalNote>) {
  const writer = writerOf(user);
  const access = pageAccess(user, input.journalId);
  if (!access || access.page.kind !== "journal") throw new HttpError(404, ct("Seite nicht gefunden.", "Page not found."));
  if (access.encrypted) throw new HttpError(409, ct("Für verschlüsselte Seiten nicht verfügbar.", "Not available for encrypted pages."));
  if (access.locked) throw new HttpError(423, ct("Dieses Journal ist gesperrt.", "This journal is locked."));
  const { dayId } = command(writer, { action: "journal.roll", pageId: input.journalId, date: input.today, write: true }) as { dayId: string };
  const dayPage = requirePage(writer, dayId, true);
  requireUnlocked(writer, dayPage);
  if (dayPage.locked) throw new HttpError(409, ct("Diese Seite ist gesperrt.", "This page is locked."));
  const schema = rewriteSchema();
  const paragraphs = input.text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) =>
      schema.nodeFromJSON({
        type: "paragraph",
        content: p.split("\n").flatMap((line, i) => [...(i ? [{ type: "hardBreak" }] : []), ...(line ? [{ type: "text", text: line }] : [])]),
      }),
    );
  let publish: () => void = () => {};
  transaction(() => {
    const result = rewriteDocument(dayPage.id, null, writer.id, (doc) => doc.type.create(doc.attrs, doc.content.append(Fragment.from(paragraphs)), doc.marks));
    if (result) publish = result.publish;
    recordPageEdit(writer, dayPage.id);
    audit(writer.id, "journal.note", dayPage.id);
  }, writer);
  publish();
  return { ok: true, action: "journal.note", dayId };
}

export async function homeAction(user: Identity, input: unknown) {
  const { action } = z.object({ action: z.enum(homeActions) }).passthrough().parse(input);
  limit(user, "action");
  if (user.apiScope === "read") throw new HttpError(403, "Dieses API-Token darf nur lesen.");
  if (action === "journal.note") return writeJournal(user, journalNote.parse(input));
  return widgetAction(user, input);
}

// ---- Options for the widget settings ----

export function homeOptions(user: Identity, query: { workspaceId: string | null; kind: string | null; pageId?: string | null }) {
  const workspaceId = uuid.parse(query.workspaceId);
  requireMember(user, workspaceId);
  limit(user, "options");
  const scope = scopeOf(user, workspaceId);
  switch (query.kind) {
    case "calendar":
      return { calendars: calendarSourceList(user, 60).filter((c) => scope.inside(c.pageId)) };
    case "habits":
      return { habits: habitDatabases(user).filter((d) => scope.inside(d.id)) };
    case "database": {
      // Views and properties of one database.
      const pageId = scope.need(uuid.parse(query.pageId));
      return { database: (widgetOptions(user, "pinned", { pageId }) as { database: unknown }).database };
    }
    default:
      throw new HttpError(400, ct("Ungültige Anfrage.", "Invalid request."));
  }
}
