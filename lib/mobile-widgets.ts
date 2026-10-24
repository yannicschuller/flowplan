// Configurable widgets, Live Activities and Shortcuts of the mobile apps
// (flowplan-app), on top of the device token of lib/mobile-devices.ts:
//
//   GET  /api/mobile/widgets/options?kind=…   what a widget instance can be set to
//   POST /api/mobile/widgets/data             the data of all configured widgets at once
//   POST /api/mobile/widgets/action           what a widget, Live Activity or Shortcut does
//                                             (lib/mobile-widget-actions.ts)
//
// Every answer is small (at most 10 items and about 2 KB per widget) and
// holds only what the person may see in the web app: the same page, record
// and property permissions, nothing of pages behind a journal PIN they have
// not entered ("locked") and only a status for end-to-end encrypted spaces,
// whose content the server cannot read anyway. Titles follow the language
// of the profile, else the app's (`lang`, Accept-Language).
import { createHash } from "node:crypto";
import { z } from "zod";
import { Temporal } from "@js-temporal/polyfill";
import { all, db, one, run } from "./db";
import { adminGroup, HttpError } from "./auth";
import { allow } from "./action-limits";
import { cellText } from "./cell-text";
import { contentLocale, ct } from "./content-locale";
import { calendarRange } from "./database-calendar";
import { queryRows } from "./database";
import { doneRule, isDone } from "./database-settings-schema";
import { scheduleFields } from "./database-timeline";
import { validZone } from "./date-values";
import { openTasksEverywhere, taskKey } from "./doc-tasks";
import { rewriteStoredDocument } from "./document-rewrite";
import { visibleFields } from "./field-access";
import { formatNumber } from "./field-format";
import { localizedMessage } from "./i18n-errors";
import { isLocale, localeTag, pickLocale, type Locale } from "./i18n";
import { hasEntryData, journalLocked, journalSettings, lockedPageIds, dayEntry } from "./journal-extras";
import { hasOwnEntry } from "./journal";
import { pageLocationHash } from "./page-location";
import { pageRole } from "./permissions";
import { occurrenceDates, parseRecurrence } from "./recurrence";
import { relatedData } from "./related-data";
import { hiddenRowIds, visibleRows } from "./row-access";
import { fixedLanguage } from "./user-locale";
import { personJobs } from "./background-jobs";
import { activeAlerts, workerStatuses } from "./admin-ops";
import { diskUsage, liveNumbers } from "./metrics";
import { scheduledBackupStatus } from "./scheduled-backup";
import { stopRunning } from "./time-tracking";
import { transcriptionEnabled } from "./transcribe";
import { identityFromDeviceToken } from "./mobile-devices";
import type { Field, Identity, Page, Row, View } from "./types";
import {
  dataRequestSchema,
  MAX_ITEMS,
  MAX_WIDGET_BYTES,
  widgetConfigs,
  widgetKinds,
  type WidgetConfig,
  type WidgetKind,
} from "./mobile-widget-schema";

export { MAX_ITEMS, MAX_WIDGET_BYTES, MAX_WIDGETS, widgetKinds, type WidgetKind } from "./mobile-widget-schema";
const TITLE = 80;
const DETAIL = 60;
const uuid = z.uuid();

// ---- Device, language, limits ----

// The person behind the device token, with the rights of their session
// (reading only; actions get writing rights for exactly what they do).
export function widgetUser(authorization: string | null) {
  return identityFromDeviceToken(authorization);
}
export const writerOf = (user: Identity): Identity => ({ ...user, apiScope: "write" });

// The profile's language wins; then what the app sends.
export function widgetLocale(user: Pick<Identity, "id">, lang: string | null | undefined, acceptLanguage: string | null): Locale {
  return fixedLanguage(user.id) ?? (isLocale(lang) ? lang : pickLocale(null, acceptLanguage));
}

// Per person and minute: data refreshes of all widgets, option lists,
// actions; uploads per hour (they may reach the transcription service).
const LIMITS = { data: [60, 60_000], options: [60, 60_000], action: [30, 60_000], upload: [20, 3_600_000] } as const;
export function limitWidgets(user: Pick<Identity, "id">, what: keyof typeof LIMITS) {
  const [max, windowMs] = LIMITS[what];
  if (!allow(`widgets-${what}:${user.id}`, max, windowMs))
    throw new HttpError(429, ct("Zu viele Anfragen in kurzer Zeit. Bitte später erneut versuchen.", "Too many requests in a short time. Please try again later."));
}

// ---- Shared helpers ----

const clip = (text: string, max = TITLE) => {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
};
const url = (pageId: string, rowId?: string | null) => `/${pageLocationHash({ pageId, ...(rowId ? { rowId } : {}) })}`;
const untitled = () => ct("Ohne Titel", "Untitled");
const parse = <T>(text: string | null | undefined, fallback: T): T => {
  try {
    return text ? (JSON.parse(text) as T) : fallback;
  } catch {
    return fallback;
  }
};
function localToday(zone: string) {
  return Temporal.Now.plainDateISO(zone).toString();
}
const shift = (date: string, days: number) => Temporal.PlainDate.from(date).add({ days }).toString();

export type Context = { user: Identity; today: string; zone: string; now: number };
export function widgetContext(user: Identity, today?: string, zone?: string, now = Date.now()): Context {
  const tz = zone && validZone(zone) ? zone : "UTC";
  return { user, today: today || localToday(tz), zone: tz, now };
}

type SpaceInfo = { encrypted: number; encrypt_titles: number; name: string };
const spaceInfo = (spaceId: string) =>
  one<SpaceInfo>("SELECT name,COALESCE(encrypted,0) encrypted,COALESCE(encrypt_titles,0) encrypt_titles FROM spaces WHERE id=?", spaceId);
const workspaceIds = (user: Identity) =>
  all<{ workspace_id: string }>("SELECT workspace_id FROM members WHERE user_id=?", user.id).map((m) => m.workspace_id);

// What a page is for this person: readable, behind a PIN, encrypted.
export type Access = { page: Page; role: NonNullable<ReturnType<typeof pageRole>>; locked: boolean; encrypted: boolean };
export function pageAccess(user: Identity, pageId: string | null | undefined): Access | null {
  if (!pageId) return null;
  const page = one<Page>("SELECT * FROM pages WHERE id=? AND deleted_at IS NULL", pageId);
  if (!page) return null;
  const role = pageRole(user, page);
  if (!role) return null;
  return { page, role, locked: journalLocked(user, page), encrypted: !!spaceInfo(page.space_id)?.encrypted };
}
function requireAccess(user: Identity, pageId: string | null | undefined) {
  const access = pageAccess(user, pageId);
  if (!access) throw new HttpError(404, ct("Seite nicht gefunden.", "Page not found."));
  return access;
}
// A page only as a status, never with content.
const status = (a: Access) => (a.encrypted ? { encrypted: true as const } : { locked: true as const });
// The page's title as a heading: none for encrypted pages, and behind a PIN
// only the journal's own name (the sidebar shows it too).
const headingOf = (a: Access, max = 40) =>
  a.encrypted || (a.locked && a.page.kind !== "journal") ? "" : clip(a.page.title || untitled(), max);

// Readable pages across the person's workspaces (for option lists).
type Listed = Page & { space_name: string; workspace_name: string; encrypted: number };
function readablePages(user: Identity, kinds: Page["kind"][], limit = 300) {
  const out: (Listed & { pinLocked: boolean })[] = [];
  for (const wid of workspaceIds(user)) {
    const locked = lockedPageIds(user, wid);
    const pages = all<Listed>(
      `SELECT p.*,s.name space_name,w.name workspace_name,COALESCE(s.encrypted,0) encrypted FROM pages p
         JOIN spaces s ON s.id=p.space_id JOIN workspaces w ON w.id=p.workspace_id
       WHERE p.workspace_id=? AND p.deleted_at IS NULL AND s.deleted_at IS NULL AND COALESCE(p.synced,0)=0
         AND p.kind IN (${kinds.map(() => "?").join(",")})
       ORDER BY p.title COLLATE NOCASE LIMIT 2000`,
      wid,
      ...kinds,
    );
    for (const page of pages) {
      if (out.length >= limit) return out;
      if (!pageRole(user, page)) continue;
      out.push({ ...page, pinLocked: locked.has(page.id) && !page.encrypted });
    }
  }
  return out;
}
const listedPage = (p: Listed & { pinLocked: boolean }) => ({
  id: p.id,
  // Nothing of encrypted spaces; titles stay where the sidebar shows them.
  name: p.encrypted ? "" : clip(p.title || untitled()),
  icon: p.encrypted ? "" : p.icon,
  kind: p.kind,
  space: clip(p.space_name, 40),
  workspace: clip(p.workspace_name, 40),
  ...(p.encrypted ? { encrypted: true } : {}),
  ...(p.pinLocked ? { locked: true } : {}),
});

// A database with the rows of one view as the person sees them.
type Loaded = { page: Page; fields: Field[]; shown: Field[]; views: View[]; view: View; rows: Row[]; settings: unknown };
function loadView(user: Identity, page: Page, viewKey?: string, now = new Date()): Loaded {
  if (page.kind !== "database") throw new HttpError(400, ct("Keine Datenbank.", "Not a database."));
  const raw = one<{ fields: string; views: string; settings: string | null }>("SELECT fields,views,settings FROM databases WHERE page_id=?", page.id);
  if (!raw) throw new HttpError(404, ct("Datenbank nicht gefunden.", "Database not found."));
  const fields = parse<Field[]>(raw.fields, []);
  const views = parse<View[]>(raw.views, []);
  const view =
    (viewKey ? views.find((v) => v.id === viewKey) : views.find((v) => v.default) || views.find((v) => v.type !== "form")) ||
    ({ id: "", name: "", type: "table", filters: [], sorts: [] } as View);
  if (viewKey && view.id !== viewKey) throw new HttpError(404, ct("Ansicht nicht gefunden.", "View not found."));
  const rows = all<Row & { cells: string }>("SELECT * FROM rows WHERE page_id=? LIMIT 5000", page.id).map(
    (r) => ({ ...r, cells: parse<Record<string, unknown>>(r.cells as unknown as string, {}) }) as Row,
  );
  const { related, relatedSchemas } = relatedData(user, page);
  const shown = visibleFields(user, page, fields);
  return {
    page,
    fields,
    shown,
    views,
    view,
    rows: queryRows(visibleRows(user, page, rows), fields, view, "", related, relatedSchemas, now),
    settings: parse(raw.settings, undefined),
  };
}

// A property value as a short text.
const names = new Map<string, string>();
function personName(id: string) {
  if (!names.has(id)) names.set(id, one<{ name: string }>("SELECT name FROM users WHERE id=?", id)?.name || "");
  if (names.size > 2000) names.clear();
  return names.get(id) || "";
}
export function valueText(field: Field, value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  switch (field.type) {
    case "person":
    case "created_by":
    case "updated_by":
      return (Array.isArray(value) ? value : [value]).map((v) => personName(String(v))).filter(Boolean).join(", ");
    case "checkbox":
      return value === true ? "✓" : "";
    case "number":
      return typeof value === "number" ? formatNumber(value, field.format, field.decimals) : cellText(value);
    case "time":
      return typeof value === "number" ? `${Math.round((value / 3600) * 10) / 10} h` : "";
    case "relation":
    case "files":
    case "checklist":
      return Array.isArray(value) && value.length ? String(value.length) : "";
    case "date":
      return typeof value === "string" ? value.slice(0, 16).replace("T", " ") : "";
    default:
      return typeof value === "object" && !Array.isArray(value) ? "" : cellText(value);
  }
}
const rowTitle = (loaded: Pick<Loaded, "fields" | "shown">, row: Row) => {
  const first = loaded.fields[0];
  return first && loaded.shown.includes(first) ? clip(cellText(row.cells[first.id])) || untitled() : untitled();
};

// What an action sends back unchanged: links and identities are never cut.
const KEEP_WHOLE = new Set(["url", "id", "pageId", "rowId", "fieldId", "viewId", "notificationId", "key", "source", "due", "day", "start", "end", "createdAt"]);
// Makes an answer fit: the longest list loses its last entries, then texts
// get shorter, until the JSON is at most MAX_WIDGET_BYTES.
export function capped<T extends Record<string, unknown>>(data: T): T & { truncated?: true } {
  const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  if (size(data) <= MAX_WIDGET_BYTES) return data;
  const copy = structuredClone(data) as Record<string, unknown>;
  const lists = () =>
    Object.entries(copy)
      .filter((e): e is [string, unknown[]] => Array.isArray(e[1]) && e[1].length > 0)
      .sort((a, b) => size(b[1]) - size(a[1]));
  let guard = 0;
  while (size(copy) > MAX_WIDGET_BYTES && guard++ < 200) {
    const longest = lists()[0];
    if (!longest || longest[1].length <= 1) break;
    longest[1].pop();
    copy.truncated = true;
  }
  const shorten = (node: unknown, max: number): unknown => {
    if (typeof node === "string") return node.length > max ? `${node.slice(0, max - 1)}…` : node;
    if (Array.isArray(node)) return node.map((v) => shorten(v, max));
    if (node && typeof node === "object") return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, KEEP_WHOLE.has(k) ? v : shorten(v, max)]));
    return node;
  };
  for (const max of [60, 40, 24, 12]) {
    if (size(copy) <= MAX_WIDGET_BYTES) break;
    Object.assign(copy, shorten(copy, max) as object);
    copy.truncated = true;
  }
  while (size(copy) > MAX_WIDGET_BYTES && lists()[0]) {
    lists()[0][1].pop();
    copy.truncated = true;
  }
  return copy as T;
}

// ---- 1. Quick capture ----

const rank: Record<string, number> = { viewer: 1, editor: 2, owner: 3 };
// Where the person may capture to: databases (a record) and documents (a
// sub page, or a task appended to the page).
export function captureTargetList(user: Identity) {
  return readablePages(user, ["database", "document"], 400)
    .filter((p) => !p.encrypted && !p.pinLocked && !p.locked && !p.journal_date && rank[pageRole(user, p) || ""] >= 2)
    .slice(0, 200)
    .map(listedPage);
}
function captureData(ctx: Context, config: WidgetConfig<"capture">) {
  const targetId =
    config.targetId ||
    one<{ page_id: string }>("SELECT page_id FROM capture_targets WHERE user_id=? ORDER BY rowid LIMIT 1", ctx.user.id)?.page_id;
  const access = pageAccess(ctx.user, targetId);
  const usable = !!access && !access.locked && !access.encrypted && !access.page.locked && rank[access.role] >= 2;
  const space = access && spaceInfo(access.page.space_id);
  return {
    title: ct("Schnell erfassen", "Quick capture"),
    target: usable
      ? { id: access!.page.id, name: clip(access!.page.title || untitled()), icon: access!.page.icon, kind: access!.page.kind, space: clip(space?.name || "", 40) }
      : null,
    voice: transcriptionEnabled(),
    actions: ["capture.note", "capture.task", "capture.upload"],
  };
}

// ---- 2. Interactive tasks ----

export type WidgetTask = {
  // Everything the "task.complete" action needs back: for document tasks
  // the position and the key (the text is shortened for showing).
  source: "doc" | "row";
  pageId: string;
  rowId: string | null;
  index?: number;
  key?: string;
  text: string;
  due: string | null;
  done: boolean;
  page: string;
  url: string;
  canEdit: boolean;
};
const dueFilter = (filter: "today" | "overdue" | "open", today: string) => (due: string | null) =>
  filter === "open" ? true : filter === "today" ? due === today : !!due && due < today;

function tasksData(ctx: Context, config: WidgetConfig<"tasks">) {
  const { user, today } = ctx;
  const keep = dueFilter(config.filter, today);
  let items: WidgetTask[] = [];
  let heading = ct("Meine Aufgaben", "My tasks");
  if (config.source === "mine") {
    // A task given to the person can sit in a page they may only read.
    const editable = new Map<string, boolean>();
    const canEdit = (pageId: string) => {
      if (!editable.has(pageId)) {
        const access = pageAccess(user, pageId);
        editable.set(pageId, !!access && rank[access.role] >= 2 && !access.page.locked && !access.locked && !access.encrypted);
      }
      return editable.get(pageId)!;
    };
    items = openTasksEverywhere(user)
      .filter((t) => t.assigned || t.journal || t.due)
      .filter((t) => keep(t.due))
      .map((t) => ({
        source: "doc" as const,
        pageId: t.pageId,
        rowId: t.rowId,
        index: t.index,
        key: taskKey(t.text),
        text: clip(t.text, 120),
        due: t.due,
        done: false,
        page: clip(t.title || untitled(), DETAIL),
        url: url(t.pageId, t.rowId),
        canEdit: canEdit(t.pageId),
      }));
  } else if (config.source === "page") {
    const access = requireAccess(user, config.pageId);
    heading = headingOf(access);
    if (access.locked || access.encrypted) return { title: heading, ...status(access), items: [], total: 0 };
    const hidden = access.page.kind === "database" ? hiddenRowIds(user, access.page) : new Set<string>();
    const seen = new Set<string>();
    for (const t of all<{ row_id: string; idx: number; text: string; due: string | null }>(
      "SELECT row_id,idx,text,due FROM doc_tasks WHERE page_id=? AND checked=0 ORDER BY CASE WHEN due IS NULL THEN 1 ELSE 0 END,due,row_id,idx LIMIT 500",
      access.page.id,
    )) {
      const key = `${t.row_id}:${t.idx}`;
      if (seen.has(key) || (t.row_id && hidden.has(t.row_id)) || !keep(t.due)) continue;
      seen.add(key);
      items.push({
        source: "doc",
        pageId: access.page.id,
        rowId: t.row_id || null,
        index: t.idx,
        key: taskKey(t.text),
        text: clip(t.text, 120),
        due: t.due,
        done: false,
        page: heading,
        url: url(access.page.id, t.row_id || null),
        canEdit: rank[access.role] >= 2 && !access.page.locked,
      });
    }
  } else {
    const access = requireAccess(user, config.pageId);
    heading = headingOf(access);
    if (access.locked || access.encrypted) return { title: heading, ...status(access), items: [], total: 0 };
    const loaded = loadView(user, access.page, config.viewId);
    if (config.viewId) heading = clip(`${access.page.title || untitled()} · ${loaded.view.name}`, 40);
    const rule = doneRule(loaded.fields, loaded.settings as never);
    const ruleVisible = !!rule && loaded.shown.includes(rule.field);
    const { start } = scheduleFields(loaded.shown, loaded.view);
    for (const row of loaded.rows) {
      if (ruleVisible && isDone(rule, row.cells)) continue;
      const raw = start ? row.cells[start.id] : null;
      const due = typeof raw === "string" && /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : null;
      if (!keep(due)) continue;
      items.push({
        source: "row",
        pageId: access.page.id,
        rowId: row.id,
        text: rowTitle(loaded, row),
        due,
        done: false,
        page: heading,
        url: url(access.page.id, row.id),
        canEdit: ruleVisible && rank[row.role || access.role] >= 2 && !access.page.locked,
      });
    }
  }
  return { title: heading, total: items.length, items: items.slice(0, config.max) };
}

// ---- 3. Today / calendar and 11. Meeting now ----

type CalendarSource = { pageId: string; viewId: string; name: string; database: string; synced: string | null };
// Calendar and timeline views of readable databases, and the views synced
// with a Google or Microsoft 365 calendar.
export function calendarSourceList(user: Identity, limit = 60): CalendarSource[] {
  const synced = new Map(
    all<{ page_id: string; view_id: string; calendar_name: string }>(
      "SELECT page_id,view_id,calendar_name FROM calendar_sync_mappings WHERE user_id=?",
      user.id,
    ).map((m) => [`${m.page_id}:${m.view_id}`, m.calendar_name]),
  );
  const out: CalendarSource[] = [];
  for (const page of readablePages(user, ["database"], 400)) {
    if (page.pinLocked || page.encrypted) continue;
    const raw = one<{ fields: string; views: string }>("SELECT fields,views FROM databases WHERE page_id=?", page.id);
    const fields = parse<Field[]>(raw?.fields, []);
    for (const view of parse<View[]>(raw?.views, [])) {
      const key = `${page.id}:${view.id}`;
      if (!synced.has(key) && view.type !== "calendar" && view.type !== "timeline") continue;
      if (!scheduleFields(fields, view).start) continue;
      out.push({ pageId: page.id, viewId: view.id, name: clip(view.name, 40), database: clip(page.title || untitled(), 40), synced: synced.get(key) || null });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

export type WidgetEvent = {
  title: string;
  day: string;
  start: string;
  end: string;
  timed: boolean;
  startMs: number | null;
  endMs: number | null;
  pageId: string;
  rowId: string;
  calendar: string;
  url: string;
};
const zonedDay = (ms: number, zone: string) => Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(zone).toPlainDate().toString();

// Entries of one calendar source on the given days (repeating ones too).
function sourceEvents(user: Identity, src: { pageId: string; viewId?: string }, days: string[], zone: string, label?: string): WidgetEvent[] {
  const access = pageAccess(user, src.pageId);
  if (!access || access.locked || access.encrypted || access.page.kind !== "database") return [];
  let loaded: Loaded;
  try {
    loaded = loadView(user, access.page, src.viewId);
  } catch {
    return [];
  }
  const view = { ...loaded.view };
  const { start } = scheduleFields(loaded.shown, view);
  if (!start) return [];
  view.dateField = start.id;
  const events: WidgetEvent[] = [];
  const first = days[0],
    last = days[days.length - 1];
  for (const row of loaded.rows as (Row & { recurrence?: string | null })[]) {
    const range = calendarRange(row, loaded.shown, view, zone);
    if (!range) continue;
    const rule = parseRecurrence(row.recurrence);
    const startDay = range.timed ? zonedDay(range.startMs, zone) : range.start;
    const endDay = range.timed ? zonedDay(Math.max(range.startMs, range.endMs - 1), zone) : range.end;
    const occurrences: { from: string; shiftDays: number }[] = [];
    if (startDay <= last && endDay >= first) occurrences.push({ from: startDay, shiftDays: 0 });
    if (rule) {
      const length = Temporal.PlainDate.from(startDay).until(endDay, { largestUnit: "days" }).days;
      for (const d of occurrenceDates(startDay, rule, shift(first, -length), last, 60))
        if (d !== startDay && shift(d, length) >= first && d <= last)
          occurrences.push({ from: d, shiftDays: Temporal.PlainDate.from(startDay).until(d, { largestUnit: "days" }).days });
    }
    for (const o of occurrences) {
      const startMs = range.timed
        ? Temporal.Instant.fromEpochMilliseconds(range.startMs).toZonedDateTimeISO(zone).add({ days: o.shiftDays }).epochMilliseconds
        : null;
      const endMs = range.timed ? startMs! + (range.endMs - range.startMs) : null;
      for (const d of days) {
        const covered = range.timed ? zonedDay(startMs!, zone) <= d && d <= zonedDay(Math.max(startMs!, endMs! - 1), zone) : o.from <= d && d <= shift(o.from, Temporal.PlainDate.from(startDay).until(endDay, { largestUnit: "days" }).days);
        if (!covered) continue;
        events.push({
          title: rowTitle(loaded, row),
          day: d,
          start: range.timed ? new Date(startMs!).toISOString() : o.from,
          end: range.timed ? new Date(endMs!).toISOString() : shift(o.from, Temporal.PlainDate.from(startDay).until(endDay, { largestUnit: "days" }).days),
          timed: range.timed,
          startMs,
          endMs,
          pageId: access.page.id,
          rowId: row.id,
          calendar: clip(label || access.page.title || untitled(), 40),
          url: url(access.page.id, row.id),
        });
        // A multi-day entry shows once, on its first day in the range.
        break;
      }
    }
    if (events.length >= 200) break;
  }
  return events;
}
function chosenSources(user: Identity, sources: { pageId: string; viewId?: string }[]) {
  if (sources.length) return sources.map((s) => ({ ...s, label: undefined as string | undefined }));
  return calendarSourceList(user, 20).map((s) => ({ pageId: s.pageId, viewId: s.viewId, label: s.synced || s.database }));
}
const sortEvents = (a: WidgetEvent, b: WidgetEvent) =>
  a.day.localeCompare(b.day) || Number(a.timed) - Number(b.timed) || (a.startMs ?? 0) - (b.startMs ?? 0) || a.title.localeCompare(b.title);

function calendarData(ctx: Context, config: WidgetConfig<"calendar">) {
  const length = config.range === "today" ? 1 : config.range === "3days" ? 3 : 7;
  const days = Array.from({ length }, (_, i) => shift(ctx.today, i));
  const events = chosenSources(ctx.user, config.sources).flatMap((s) => sourceEvents(ctx.user, s, days, ctx.zone, s.label));
  const seen = new Set<string>();
  const items: Record<string, unknown>[] = events
    .filter((e) => {
      const key = `${e.rowId}:${e.day}:${e.start}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(sortEvents)
    .map((e) => ({ type: "event", title: e.title, day: e.day, start: e.start, end: e.end, timed: e.timed, calendar: e.calendar, url: e.url }));
  if (config.tasks) {
    const last = days[days.length - 1];
    for (const t of openTasksEverywhere(ctx.user).filter((t) => t.due && t.due >= ctx.today && t.due <= last && (t.assigned || t.journal || t.due)))
      items.push({ type: "task", title: clip(t.text), day: t.due, start: t.due, end: t.due, timed: false, calendar: clip(t.title || untitled(), 40), url: url(t.pageId, t.rowId) });
    items.sort((a, b) => String(a.day).localeCompare(String(b.day)) || Number(b.type === "event") - Number(a.type === "event"));
  }
  return {
    title: config.range === "today" ? ct("Heute", "Today") : config.range === "3days" ? ct("Nächste 3 Tage", "Next 3 days") : ct("Diese Woche", "This week"),
    from: days[0],
    to: days[days.length - 1],
    total: items.length,
    items: items.slice(0, config.max),
  };
}

// A meeting note of this appointment, if there is one the person can open.
function meetingNote(user: Identity, rowId: string, date: string) {
  for (const note of all<{ page_id: string }>("SELECT page_id FROM meeting_notes WHERE event_key=?", `row:${rowId}@${date}`)) {
    const access = pageAccess(user, note.page_id);
    if (access && !access.locked) return note.page_id;
  }
  return null;
}
// Journals the person may write to: where a meeting note can be created.
export function writableJournals(user: Identity, workspaceId?: string) {
  return readablePages(user, ["journal"], 100).filter(
    (j) => (!workspaceId || j.workspace_id === workspaceId) && !j.encrypted && !j.pinLocked && !j.locked && rank[pageRole(user, j) || ""] >= 2,
  );
}
function meetingData(ctx: Context, config: WidgetConfig<"meeting">) {
  const days = [ctx.today, shift(ctx.today, 1)];
  const events = chosenSources(ctx.user, config.sources)
    .flatMap((s) => sourceEvents(ctx.user, s, days, ctx.zone, s.label))
    .filter((e) => e.timed && e.endMs! > ctx.now)
    .sort((a, b) => a.startMs! - b.startMs!);
  const unique = events.filter((e, i) => events.findIndex((o) => o.rowId === e.rowId && o.startMs === e.startMs) === i);
  const view = (e: WidgetEvent | undefined) => {
    if (!e) return null;
    const date = zonedDay(e.startMs!, ctx.zone);
    const noteId = meetingNote(ctx.user, e.rowId, date);
    const page = one<{ workspace_id: string }>("SELECT workspace_id FROM pages WHERE id=?", e.pageId);
    return {
      title: e.title,
      start: e.start,
      end: e.end,
      startMs: e.startMs,
      endMs: e.endMs,
      calendar: e.calendar,
      url: e.url,
      pageId: e.pageId,
      rowId: e.rowId,
      date,
      note: noteId ? { id: noteId, url: url(noteId) } : null,
      canCreateNote:
        !noteId && (config.journalId ? !!writableJournals(ctx.user).find((j) => j.id === config.journalId) : writableJournals(ctx.user, page?.workspace_id).length > 0),
    };
  };
  const now = unique.find((e) => e.startMs! <= ctx.now && e.endMs! > ctx.now);
  const next = unique.find((e) => e.startMs! > ctx.now);
  return { title: ct("Besprechung", "Meeting"), now: view(now), next: view(next) };
}

// ---- 4. Pinned page / favorites ----

function pinnedData(ctx: Context, config: WidgetConfig<"pinned">) {
  const { user } = ctx;
  if (config.mode === "favorites") {
    const items: Record<string, unknown>[] = [];
    for (const f of all<{ page_id: string }>("SELECT page_id FROM favorites WHERE user_id=? ORDER BY rowid", user.id)) {
      const access = pageAccess(user, f.page_id);
      if (!access) continue;
      items.push(
        access.encrypted || access.locked
          ? { id: access.page.id, kind: access.page.kind, title: "", ...status(access), url: url(access.page.id) }
          : { id: access.page.id, kind: access.page.kind, title: clip(access.page.title || untitled()), icon: access.page.icon, url: url(access.page.id) },
      );
      if (items.length >= MAX_ITEMS * 2) break;
    }
    for (const f of all<{ page_id: string; row_id: string }>("SELECT page_id,row_id FROM row_favorites WHERE user_id=? ORDER BY rowid", user.id)) {
      const access = pageAccess(user, f.page_id);
      if (!access || access.locked || access.encrypted || hiddenRowIds(user, access.page).has(f.row_id)) continue;
      const fields = parse<Field[]>(one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", access.page.id)?.fields, []);
      const shown = visibleFields(user, access.page, fields);
      const row = one<{ cells: string }>("SELECT cells FROM rows WHERE id=? AND page_id=?", f.row_id, access.page.id);
      if (!row) continue;
      const title = fields[0] && shown.includes(fields[0]) ? clip(cellText(parse<Record<string, unknown>>(row.cells, {})[fields[0].id])) : "";
      items.push({ id: f.row_id, kind: "record", title: title || untitled(), detail: clip(access.page.title || untitled(), DETAIL), url: url(access.page.id, f.row_id) });
      if (items.length >= MAX_ITEMS * 2) break;
    }
    return { title: ct("Favoriten", "Favorites"), total: items.length, items: items.slice(0, config.max) };
  }
  if (config.mode === "recent") {
    // Last opened first; pages behind a PIN or end-to-end encrypted are left
    // out (their titles are not shown outside the app).
    const items: Record<string, unknown>[] = [];
    for (const v of all<{ page_id: string }>("SELECT page_id FROM page_visits WHERE user_id=? ORDER BY seen_at DESC LIMIT 100", user.id)) {
      const access = pageAccess(user, v.page_id);
      if (!access || access.locked || access.encrypted || access.page.journal_date) continue;
      items.push({ id: access.page.id, kind: access.page.kind, title: clip(access.page.title || untitled()), icon: access.page.icon, url: url(access.page.id) });
      if (items.length >= config.max) break;
    }
    return { title: ct("Zuletzt geöffnet", "Recently opened"), total: items.length, items };
  }
  const access = requireAccess(user, config.pageId);
  const heading = headingOf(access);
  if (access.locked || access.encrypted) return { title: heading, ...status(access), url: url(access.page.id), items: [] };
  if (access.page.kind === "database") {
    const loaded = loadView(user, access.page, config.viewId);
    const props = config.properties.map((id) => loaded.shown.find((f) => f.id === id)).filter((f): f is Field => !!f && f !== loaded.fields[0]);
    return {
      title: heading,
      view: loaded.view.name,
      url: url(access.page.id),
      total: loaded.rows.length,
      properties: props.map((f) => clip(f.name, 30)),
      items: loaded.rows.slice(0, config.max).map((row) => ({
        id: row.id,
        title: rowTitle(loaded, row),
        values: props.map((f) => clip(valueText(f, row.cells[f.id]), 40)),
        url: url(access.page.id, row.id),
      })),
    };
  }
  // Documents, journals, whiteboards: the pages below.
  const locked = lockedPageIds(user, access.page.workspace_id);
  const children = all<Page>(
    `SELECT * FROM pages WHERE parent_id=? AND deleted_at IS NULL AND COALESCE(synced,0)=0 ORDER BY ${access.page.kind === "journal" ? "journal_date DESC" : "position"} LIMIT 200`,
    access.page.id,
  ).filter((p) => pageRole(user, p) && !locked.has(p.id));
  return {
    title: heading,
    url: url(access.page.id),
    total: children.length,
    items: children.slice(0, config.max).map((p) => ({ id: p.id, kind: p.kind, title: clip(p.title || untitled()), icon: p.icon, url: url(p.id) })),
  };
}

// ---- 5. Database counter ----

// History: a tiny table with one value per widget configuration and day,
// written when the widget refreshes. Created/updated timestamps alone cannot
// tell how many records a filtered view showed on an earlier day (records
// change, move between groups, get deleted; only the last change is kept),
// so days before the first snapshot are estimated from the records shown
// now and their creation date ("estimated": true) – exact from then on.
const HISTORY_DAYS = 14;
const prepared = new WeakSet<object>();
function ensureTables() {
  const d = db();
  if (prepared.has(d)) return;
  d.exec(`CREATE TABLE IF NOT EXISTS widget_counter_days(
      key TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day TEXT NOT NULL, value REAL, at INTEGER NOT NULL, PRIMARY KEY(key,day));
    CREATE INDEX IF NOT EXISTS widget_counter_days_at ON widget_counter_days(at);
    CREATE TABLE IF NOT EXISTS widget_focus(
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      started_at INTEGER NOT NULL, focus_ms INTEGER NOT NULL, break_ms INTEGER NOT NULL,
      page_id TEXT, row_id TEXT, field_id TEXT, timer INTEGER NOT NULL DEFAULT 0, stopped_at INTEGER)`);
  prepared.add(d);
}
export { ensureTables as ensureWidgetTables };

function aggregate(values: number[], how: "count" | "sum" | "average", rows: number) {
  if (how === "count") return rows;
  if (!values.length) return null;
  const sum = values.reduce((a, b) => a + b, 0);
  return how === "sum" ? sum : sum / values.length;
}
const numberOf = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);

function counterData(ctx: Context, config: WidgetConfig<"counter">) {
  const access = requireAccess(ctx.user, config.pageId);
  const heading = headingOf(access);
  if (access.locked || access.encrypted) return { title: heading, ...status(access) };
  const loaded = loadView(ctx.user, access.page, config.viewId);
  const field = config.fieldId ? loaded.shown.find((f) => f.id === config.fieldId) : undefined;
  if (config.aggregate !== "count" && !field) throw new HttpError(400, ct("Eigenschaft fehlt.", "Property missing."));
  const group = config.groupFieldId ? loaded.shown.find((f) => f.id === config.groupFieldId) : undefined;
  if (config.groupFieldId && !group) throw new HttpError(400, ct("Eigenschaft fehlt.", "Property missing."));
  const inGroup = (row: Row) => {
    if (!group || config.groupValue === undefined) return true;
    const v = row.cells[group.id];
    if (group.type === "checkbox") return String(v === true) === config.groupValue;
    if (Array.isArray(v)) return v.map(String).includes(config.groupValue);
    return (v === null || v === undefined ? "" : String(v)) === config.groupValue;
  };
  const rows = loaded.rows.filter(inGroup);
  const numbers = (list: Row[]) => (field ? list.map((r) => numberOf(r.cells[field.id])).filter((n) => Number.isFinite(n)) : []);
  const value = aggregate(numbers(rows), config.aggregate, rows.length);
  const format = (v: number | null) =>
    v === null
      ? "–"
      : field?.type === "number" && config.aggregate !== "count"
        ? formatNumber(v, field.format, field.decimals)
        : v.toLocaleString(localeTag(contentLocale()), { maximumFractionDigits: 2 });
  let history: { day: string; value: number | null; estimated?: true }[] | undefined;
  if (config.history) {
    ensureTables();
    const key = createHash("sha256")
      .update(JSON.stringify([ctx.user.id, config.pageId, config.viewId || "", config.aggregate, config.fieldId || "", config.groupFieldId || "", config.groupValue ?? null]))
      .digest("hex");
    run(
      "INSERT INTO widget_counter_days(key,user_id,day,value,at) VALUES(?,?,?,?,?) ON CONFLICT(key,day) DO UPDATE SET value=excluded.value,at=excluded.at",
      key,
      ctx.user.id,
      ctx.today,
      value,
      ctx.now,
    );
    if (Math.random() < 0.05) run("DELETE FROM widget_counter_days WHERE at<?", ctx.now - 40 * 86_400_000);
    const stored = new Map(
      all<{ day: string; value: number | null }>("SELECT day,value FROM widget_counter_days WHERE key=? AND day>=?", key, shift(ctx.today, -(HISTORY_DAYS - 1))).map((r) => [r.day, r.value]),
    );
    history = Array.from({ length: HISTORY_DAYS }, (_, i) => shift(ctx.today, i - (HISTORY_DAYS - 1))).map((d) => {
      if (stored.has(d)) return { day: d, value: stored.get(d)! };
      // Records shown now that existed at the end of that day (created_at is UTC).
      const existed = rows.filter((r) => String(r.created_at).slice(0, 10) <= d);
      return { day: d, value: aggregate(numbers(existed), config.aggregate, existed.length), estimated: true as const };
    });
  }
  return {
    title: heading,
    view: loaded.view.name,
    label:
      config.aggregate === "count"
        ? ct("Einträge", "Records")
        : `${config.aggregate === "sum" ? ct("Summe", "Sum") : ct("Durchschnitt", "Average")} ${clip(field!.name, 30)}`,
    ...(group && config.groupValue !== undefined ? { group: clip(`${group.name}: ${config.groupValue || "–"}`, 40) } : {}),
    value,
    formatted: format(value),
    records: rows.length,
    url: url(access.page.id),
    ...(history ? { history } : {}),
  };
}

// ---- 6. Journal and habits ----

export function habitDatabases(user: Identity) {
  const out: { id: string; name: string; habits: { id: string; name: string }[] }[] = [];
  for (const page of readablePages(user, ["database"], 400)) {
    if (page.pinLocked || page.encrypted) continue;
    const fields = visibleFields(user, page, parse<Field[]>(one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", page.id)?.fields, []));
    const checks = fields.filter((f) => f.type === "checkbox");
    if (!checks.length || !fields.some((f) => f.type === "date")) continue;
    out.push({ id: page.id, name: clip(page.title || untitled(), 40), habits: checks.slice(0, 8).map((f) => ({ id: f.id, name: clip(f.name, 30) })) });
    if (out.length >= 50) break;
  }
  return out;
}
// The record of a habit database for a day: its date property is that day.
export function habitDay(user: Identity, page: Page, date: string) {
  const fields = parse<Field[]>(one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", page.id)?.fields, []);
  const shown = visibleFields(user, page, fields);
  const dateField = shown.find((f) => f.type === "date");
  const checks = shown.filter((f) => f.type === "checkbox").slice(0, 8);
  if (!dateField) return { fields, shown, dateField, checks, row: null as (Row & { role?: string }) | null };
  const candidates = all<Row & { cells: string }>(
    `SELECT * FROM rows WHERE page_id=? AND substr(json_extract(cells,?),1,10)=? ORDER BY created_at LIMIT 20`,
    page.id,
    `$."${dateField.id.replace(/"/g, "")}"`,
    date,
  ).map((r) => ({ ...r, cells: parse<Record<string, unknown>>(r.cells as unknown as string, {}) }) as Row);
  const row = visibleRows(user, page, candidates)[0] || null;
  return { fields, shown, dateField, checks, row };
}
const writtenOn = (dayPage: Page, date: string) => {
  const doc = one<{ state: Uint8Array | null; html: string }>("SELECT state,html FROM documents WHERE page_id=?", dayPage.id);
  let own = false;
  if (doc)
    rewriteStoredDocument(doc.state, doc.html, (node) => {
      own = hasOwnEntry(node, date);
      return null;
    });
  return own || hasEntryData(dayPage.id);
};
function journalData(ctx: Context, config: WidgetConfig<"journal">) {
  const { user, today } = ctx;
  const journals = readablePages(user, ["journal"], 100);
  const chosen = config.journalId
    ? journals.find((j) => j.id === config.journalId)
    : journals.find((j) => j.created_by === user.id) || journals[0];
  let journal: Record<string, unknown> | null = null;
  if (config.journalId && !chosen) throw new HttpError(404, ct("Seite nicht gefunden.", "Page not found."));
  if (chosen) {
    const access = requireAccess(user, chosen.id);
    if (access.locked) journal = { id: chosen.id, name: clip(chosen.title || untitled(), 40), locked: true, url: url(chosen.id) };
    else {
      const days = all<Page>("SELECT * FROM pages WHERE parent_id=? AND journal_date IS NOT NULL AND journal_date<=? AND deleted_at IS NULL ORDER BY journal_date DESC LIMIT 400", chosen.id, today);
      const todayPage = days.find((d) => d.journal_date === today);
      // E2EE: whether a day exists, never what it says.
      const written = !!todayPage && (access.encrypted || writtenOn(todayPage, today));
      const dates = new Set(days.map((d) => d.journal_date!));
      let streak = 0;
      for (let d = written ? today : shift(today, -1); dates.has(d); d = shift(d, -1)) streak++;
      const trackers =
        access.encrypted || !todayPage
          ? []
          : (() => {
              const values = dayEntry(todayPage.id).values;
              return journalSettings(chosen.id)
                .trackers.slice(0, 6)
                .map((t) => ({ id: t.id, name: clip(t.name, 30), kind: t.kind, value: values[t.id] ?? null }));
            })();
      journal = {
        id: chosen.id,
        name: access.encrypted ? "" : clip(chosen.title || untitled(), 40),
        ...(access.encrypted ? { encrypted: true } : {}),
        written,
        streak,
        today: todayPage ? url(todayPage.id) : url(chosen.id),
        canWrite: rank[access.role] >= 2 && !access.page.locked,
        trackers,
      };
    }
  }
  let habits: Record<string, unknown> | null = null;
  if (config.habitsId) {
    const access = requireAccess(user, config.habitsId);
    if (access.locked || access.encrypted) habits = { id: access.page.id, ...status(access) };
    else {
      const { checks, row } = habitDay(user, access.page, today);
      const done = checks.filter((f) => row?.cells[f.id] === true).length;
      habits = {
        id: access.page.id,
        name: clip(access.page.title || untitled(), 40),
        done,
        total: checks.length,
        items: checks.map((f) => ({ fieldId: f.id, name: clip(f.name, 30), done: row?.cells[f.id] === true })),
        canWrite: rank[(row?.role as string) || access.role] >= 2 && !access.page.locked,
        url: row ? url(access.page.id, row.id) : url(access.page.id),
      };
    }
  }
  return { title: ct("Journal", "Journal"), journal, habits };
}

// ---- 7. Time this week ----

// Records the person tracked time on recently, to start their timer again.
export function recentTimers(user: Identity, max = 8) {
  const out: { pageId: string; rowId: string; fieldId: string; title: string; database: string }[] = [];
  const seen = new Set<string>();
  for (const e of all<{ page_id: string; row_id: string; field_id: string }>(
    "SELECT page_id,row_id,field_id,MAX(start) last FROM time_entries WHERE user_id=? GROUP BY page_id,row_id,field_id ORDER BY last DESC LIMIT 50",
    user.id,
  )) {
    if (out.length >= max || seen.has(e.row_id)) continue;
    const timer = timerView(user, e.page_id, e.row_id, e.field_id);
    if (!timer) continue;
    seen.add(e.row_id);
    out.push({ pageId: e.page_id, rowId: e.row_id, fieldId: e.field_id, title: timer.title, database: timer.database });
  }
  return out;
}
function timerView(user: Identity, pageId: string, rowId: string, fieldId: string) {
  const access = pageAccess(user, pageId);
  if (!access || access.locked || access.encrypted || hiddenRowIds(user, access.page).has(rowId)) return null;
  const fields = parse<Field[]>(one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", pageId)?.fields, []);
  const shown = visibleFields(user, access.page, fields);
  if (!shown.some((f) => f.id === fieldId && f.type === "time")) return null;
  const row = one<{ cells: string }>("SELECT cells FROM rows WHERE id=? AND page_id=?", rowId, pageId);
  if (!row) return null;
  const title = fields[0] && shown.includes(fields[0]) ? clip(cellText(parse<Record<string, unknown>>(row.cells, {})[fields[0].id])) : "";
  return { title: title || untitled(), database: clip(access.page.title || untitled(), 40), url: url(pageId, rowId), canWrite: rank[access.role] >= 2 };
}
export function runningTimer(user: Identity) {
  const entry = one<{ page_id: string; row_id: string; field_id: string; start: number }>(
    "SELECT page_id,row_id,field_id,start FROM time_entries WHERE user_id=? AND end IS NULL ORDER BY start DESC LIMIT 1",
    user.id,
  );
  if (!entry) return null;
  const view = timerView(user, entry.page_id, entry.row_id, entry.field_id);
  // Still running, but no longer readable: the clock without a title.
  return { start: entry.start, pageId: entry.page_id, rowId: entry.row_id, fieldId: entry.field_id, title: view?.title || "", database: view?.database || "", url: view?.url || "/" };
}
function timeData(ctx: Context) {
  finishFocus(ctx.user, ctx.now);
  const monday = Temporal.PlainDate.from(ctx.today).subtract({ days: Temporal.PlainDate.from(ctx.today).dayOfWeek - 1 });
  const days = Array.from({ length: 7 }, (_, i) => monday.add({ days: i }).toString());
  const from = monday.toZonedDateTime({ timeZone: ctx.zone }).epochMilliseconds;
  const seconds = new Map(days.map((d) => [d, 0]));
  for (const e of all<{ start: number; end: number | null }>("SELECT start,end FROM time_entries WHERE user_id=? AND (end IS NULL OR end>=?) AND start<?", ctx.user.id, from, ctx.now + 1)) {
    // Split at midnight, so a late session counts for both days.
    let at = Math.max(e.start, from);
    const end = Math.min(e.end ?? ctx.now, ctx.now);
    while (at < end) {
      const d = zonedDay(at, ctx.zone);
      if (!seconds.has(d)) break;
      const next = Temporal.PlainDate.from(d).add({ days: 1 }).toZonedDateTime({ timeZone: ctx.zone }).epochMilliseconds;
      const until = Math.min(end, next);
      seconds.set(d, seconds.get(d)! + (until - at) / 1000);
      at = until;
    }
  }
  const hours = (s: number) => Math.round((s / 3600) * 100) / 100;
  const week = [...seconds.values()].reduce((a, b) => a + b, 0);
  return {
    title: ct("Zeit diese Woche", "Time this week"),
    today: hours(seconds.get(ctx.today) || 0),
    week: hours(week),
    days: days.map((d) => ({ day: d, hours: hours(seconds.get(d) || 0) })),
    timer: runningTimer(ctx.user),
    recent: recentTimers(ctx.user, 3),
  };
}

// ---- 8. Mentions and assignments ----

const ASSIGNMENT = /hat dir eine Aufgabe/;
function mentionsData(ctx: Context, config: WidgetConfig<"mentions">) {
  const { user } = ctx;
  const rows = all<{ id: string; body: string | null; page_id: string | null; row_id: string | null; thread_id: string | null; read_at: string | null; created_at: string }>(
    `SELECT id,body,page_id,row_id,thread_id,read_at,created_at FROM notifications
     WHERE user_id=? AND kind='mention' ${config.unreadOnly ? "AND read_at IS NULL" : ""} ORDER BY created_at DESC, rowid DESC LIMIT 100`,
    user.id,
  );
  const unread = all<{ body: string | null }>("SELECT body FROM notifications WHERE user_id=? AND kind='mention' AND read_at IS NULL LIMIT 1000", user.id);
  const locale = contentLocale();
  const items: Record<string, unknown>[] = [];
  for (const n of rows) {
    const type = ASSIGNMENT.test(n.body || "") ? "assignment" : "mention";
    if (config.show !== "all" && `${type}s` !== config.show) continue;
    const access = pageAccess(user, n.page_id);
    // Like the inbox: gone or hidden pages and records lead nowhere.
    if (!access || (n.row_id && hiddenRowIds(user, access.page).has(n.row_id))) continue;
    const secret = access.locked || access.encrypted;
    items.push({
      id: n.id,
      type,
      text: secret
        ? type === "assignment"
          ? ct("Neue Aufgabe in einer geschützten Seite", "New task in a protected page")
          : ct("Erwähnung in einer geschützten Seite", "Mention in a protected page")
        : clip(localizedMessage(n.body || "", locale), 160),
      ...(secret ? status(access) : {}),
      read: !!n.read_at,
      createdAt: `${n.created_at.replace(" ", "T")}Z`,
      url: `/${pageLocationHash({ pageId: access.page.id, ...(n.row_id ? { rowId: n.row_id } : {}), ...(n.thread_id ? { threadId: n.thread_id } : {}) })}`,
    });
    if (items.length >= config.max) break;
  }
  return {
    title: config.show === "assignments" ? ct("Neue Aufgaben", "New assignments") : ct("Erwähnungen", "Mentions"),
    unread: {
      mentions: unread.filter((n) => !ASSIGNMENT.test(n.body || "")).length,
      assignments: unread.filter((n) => ASSIGNMENT.test(n.body || "")).length,
    },
    items,
  };
}

// ---- 9. Form responses ----

export function formList(user: Identity) {
  const forms = new Set(all<{ page_id: string }>("SELECT page_id FROM forms").map((f) => f.page_id));
  return readablePages(user, ["database"], 400)
    .filter((p) => !p.pinLocked && !p.encrypted && (forms.has(p.id) || parse<View[]>(one<{ views: string }>("SELECT views FROM databases WHERE page_id=?", p.id)?.views, []).some((v) => v.type === "form")))
    .slice(0, 100)
    .map(listedPage);
}
function formsData(ctx: Context, config: WidgetConfig<"forms">) {
  const access = requireAccess(ctx.user, config.pageId);
  const heading = headingOf(access);
  if (access.locked || access.encrypted) return { title: heading, ...status(access) };
  if (access.page.kind !== "database") throw new HttpError(400, ct("Keine Datenbank.", "Not a database."));
  const since = config.since === undefined ? ctx.now - 86_400_000 : typeof config.since === "number" ? config.since : Date.parse(config.since);
  const sinceSql = new Date(since).toISOString().replace("T", " ").slice(0, 19);
  const fields = parse<Field[]>(one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", access.page.id)?.fields, []);
  const shown = visibleFields(ctx.user, access.page, fields);
  const rows = visibleRows(
    ctx.user,
    access.page,
    all<Row & { cells: string }>("SELECT * FROM rows WHERE page_id=? ORDER BY created_at DESC, rowid DESC LIMIT 2000", access.page.id),
  );
  const fresh = rows.filter((r) => String(r.created_at) >= sinceSql);
  return {
    title: heading,
    total: rows.length,
    new: fresh.length,
    since: new Date(since).toISOString(),
    url: url(access.page.id),
    items: rows.slice(0, config.max).map((r) => {
      const cells = parse<Record<string, unknown>>(r.cells as unknown as string, {});
      return {
        id: r.id,
        title: (fields[0] && shown.includes(fields[0]) ? clip(cellText(cells[fields[0].id])) : "") || untitled(),
        createdAt: `${String(r.created_at).replace(" ", "T")}Z`,
        new: String(r.created_at) >= sinceSql,
        url: url(access.page.id, r.id),
      };
    }),
  };
}

// ---- 10. Focus / Pomodoro ----

type FocusRow = { user_id: string; started_at: number; focus_ms: number; break_ms: number; page_id: string | null; row_id: string | null; field_id: string | null; timer: number; stopped_at: number | null };
export function focusRow(user: Identity) {
  ensureTables();
  return one<FocusRow>("SELECT * FROM widget_focus WHERE user_id=?", user.id) || null;
}
// A focus session whose focus time is over stops its timer at that moment,
// so the time recorded is the focus time (not when the phone asked next).
export function finishFocus(user: Identity, now = Date.now()) {
  const focus = focusRow(user);
  if (!focus || !focus.timer || focus.stopped_at) return;
  const end = focus.started_at + focus.focus_ms;
  if (now < end) return;
  const running = one<{ row_id: string; start: number }>("SELECT row_id,start FROM time_entries WHERE user_id=? AND end IS NULL", user.id);
  if (running && running.row_id === focus.row_id && running.start >= focus.started_at - 5000) stopRunning(user.id, end);
  run("UPDATE widget_focus SET stopped_at=? WHERE user_id=?", end, user.id);
}
export function focusState(user: Identity, now = Date.now()) {
  finishFocus(user, now);
  const focus = focusRow(user);
  const idle = { phase: "idle" as const, startedAt: null, focusEndsAt: null, breakEndsAt: null, task: null };
  if (!focus) return idle;
  const focusEnd = focus.started_at + focus.focus_ms,
    breakEnd = focusEnd + focus.break_ms;
  const stoppedEarly = focus.stopped_at !== null && focus.stopped_at < focusEnd;
  if (stoppedEarly || now >= breakEnd) return idle;
  const task = focus.page_id && focus.row_id && focus.field_id ? timerView(user, focus.page_id, focus.row_id, focus.field_id) : null;
  return {
    phase: now < focusEnd ? ("focus" as const) : ("break" as const),
    startedAt: focus.started_at,
    focusEndsAt: focusEnd,
    breakEndsAt: breakEnd,
    task: task ? { title: task.title, database: task.database, url: task.url } : null,
  };
}
function focusData(ctx: Context) {
  return { title: ct("Fokus", "Focus"), ...focusState(ctx.user, ctx.now), durations: [15, 25, 45, 50, 90], breaks: [0, 5, 10, 15] };
}

// ---- 12. Long-running jobs ----

function jobsData(ctx: Context) {
  const jobs = personJobs(ctx.user);
  const name = (kind: string) =>
    kind === "import" ? ct("Import", "Import") : kind === "export" ? ct("Export", "Export") : kind === "archive" ? ct("Archiv", "Archive") : ct("Git-Export", "Git export");
  return {
    title: ct("Laufende Aufgaben", "Running jobs"),
    running: jobs.filter((j) => j.status === "running").length,
    items: jobs.slice(0, MAX_ITEMS).map((j) => ({ ...j, name: name(j.kind), label: clip(j.label, 60), progress: j.progress === null ? null : Math.round(j.progress * 100) })),
  };
}

// ---- 13. Admin incident ----

// Whether this device's person administers the instance – decided anew on
// every request: the groups come fresh from the session behind this device
// token (widgetUser, lib/mobile-devices.ts) – removing the right ends that
// session –, the account must be active and a local account still an admin.
export function isInstanceAdmin(user: Identity) {
  if (user.demo || !user.groups.includes(adminGroup())) return false;
  if (!one("SELECT 1 FROM users WHERE id=? AND disabled=0", user.id)) return false;
  const local = one<{ is_admin: number }>("SELECT is_admin FROM local_accounts WHERE user_id=?", user.id);
  return !local || !!local.is_admin;
}
export const INCIDENT_ERROR_RATE = 0.05;
const INCIDENT_MIN_REQUESTS = 20;
export function incidentState(now = Date.now()) {
  const issues: { code: "backup_failed" | "error_rate" | "worker_failing" | "disk_full" | "storage_high" | "login_failures"; text: string; value?: number }[] = [];
  const backup = scheduledBackupStatus();
  if (backup.enabled && backup.last?.error) issues.push({ code: "backup_failed", text: ct("Backup fehlgeschlagen", "Backup failed") });
  const live = liveNumbers(now);
  if (live.requestsHour >= INCIDENT_MIN_REQUESTS && live.errorRate > INCIDENT_ERROR_RATE)
    issues.push({ code: "error_rate", text: ct("Fehlerquote erhöht", "Error rate raised"), value: Math.round(live.errorRate * 1000) / 10 });
  const failing = workerStatuses(now).filter((w) => w.active && w.error && (w.errorAt ?? 0) >= now - 86_400_000 && w.key !== "backup");
  if (failing.length) issues.push({ code: "worker_failing", text: ct("Hintergrunddienst fehlerhaft", "Background worker failing"), value: failing.length });
  const disk = diskUsage();
  if (disk && disk.total > 0 && (disk.total - disk.free) / disk.total > 0.9)
    issues.push({ code: "disk_full", text: ct("Speicherplatz über 90 %", "Disk over 90 %"), value: Math.round(((disk.total - disk.free) / disk.total) * 100) });
  for (const alert of activeAlerts(now)) {
    if (alert.event === "storage_high") issues.push({ code: "storage_high", text: ct("Arbeitsbereich fast voll", "Workspace nearly full") });
    if (alert.event === "login_failures") issues.push({ code: "login_failures", text: ct("Viele fehlgeschlagene Anmeldungen", "Many failed sign-ins"), value: Number(alert.detail) || undefined });
  }
  const critical = issues.some((i) => i.code === "backup_failed" || i.code === "disk_full" || i.code === "error_rate");
  return { level: !issues.length ? ("ok" as const) : critical ? ("critical" as const) : ("warning" as const), issues: issues.slice(0, 6) };
}
function incidentData(ctx: Context) {
  if (!isInstanceAdmin(ctx.user)) throw new HttpError(403, ct("Nur für die Administration.", "Administrators only."));
  return { title: ct("Instanz", "Instance"), ...incidentState(ctx.now), url: "/#settings=admin" };
}

// ---- Data of many widgets at once ----

const builders: { [K in WidgetKind]: (ctx: Context, config: WidgetConfig<K>) => Record<string, unknown> } = {
  capture: captureData,
  tasks: tasksData,
  calendar: calendarData,
  pinned: pinnedData,
  counter: counterData,
  journal: journalData,
  time: timeData,
  mentions: mentionsData,
  forms: formsData,
  focus: focusData,
  meeting: meetingData,
  jobs: jobsData,
  incident: incidentData,
};
export function widgetData<K extends WidgetKind>(ctx: Context, kind: K, config: unknown) {
  const parsed = widgetConfigs[kind].parse(config ?? {}) as WidgetConfig<K>;
  return capped(builders[kind](ctx, parsed));
}

// Each widget answers on its own: one that fails (a page gone, no access)
// does not take the others with it.
export function widgetsData(user: Identity, input: unknown, now = Date.now()) {
  const request = dataRequestSchema.parse(input);
  const ctx = widgetContext(user, request.today, request.zone, now);
  const locale = contentLocale();
  return {
    at: now,
    today: ctx.today,
    zone: ctx.zone,
    widgets: request.widgets.map((w) => {
      try {
        return { id: w.id ?? null, kind: w.kind, ok: true as const, data: widgetData(ctx, w.kind, w.config) };
      } catch (error) {
        const status = error instanceof HttpError ? error.status : error instanceof z.ZodError ? 400 : 500;
        if (status === 500) console.error("Widget", w.kind, error);
        return {
          id: w.id ?? null,
          kind: w.kind,
          ok: false as const,
          status,
          error:
            status === 500
              ? ct("Fehler", "Error")
              : error instanceof z.ZodError
                ? ct("Ungültige Einstellung.", "Invalid setting.")
                : localizedMessage((error as Error).message, locale),
        };
      }
    }),
  };
}

// ---- Option lists for configuring a widget ----

export function widgetOptions(user: Identity, kind: WidgetKind, query: { pageId?: string | null } = {}) {
  const pageId = query.pageId ? uuid.parse(query.pageId) : null;
  // Views and properties of one database, for the second step of a picker.
  const databaseDetail = () => {
    if (!pageId) return null;
    const access = requireAccess(user, pageId);
    if (access.locked || access.encrypted) return { id: pageId, ...status(access) };
    if (access.page.kind !== "database") return { id: pageId, kind: access.page.kind, name: clip(access.page.title || untitled()) };
    const raw = one<{ fields: string; views: string }>("SELECT fields,views FROM databases WHERE page_id=?", pageId);
    const fields = visibleFields(user, access.page, parse<Field[]>(raw?.fields, []));
    return {
      id: pageId,
      kind: "database",
      name: clip(access.page.title || untitled()),
      views: parse<View[]>(raw?.views, []).filter((v) => v.type !== "form").map((v) => ({ id: v.id, name: clip(v.name, 40), type: v.type })),
      properties: fields.map((f) => ({
        id: f.id,
        name: clip(f.name, 40),
        type: f.type,
        ...(["select", "multiselect"].includes(f.type) ? { values: (f.options || []).slice(0, 50) } : f.type === "checkbox" ? { values: ["true", "false"] } : {}),
      })),
    };
  };
  const t = (de: string, en: string) => ct(de, en);
  switch (kind) {
    case "capture":
      // share: the instance takes "capture.share" (apps fall back to the web share target).
      return { kind, targets: captureTargetList(user), voice: transcriptionEnabled(), share: true };
    case "tasks":
      return {
        kind,
        sources: [
          { id: "mine", name: t("Meine Aufgaben", "My tasks") },
          { id: "view", name: t("Ansicht einer Datenbank", "Database view") },
          { id: "page", name: t("Aufgaben einer Seite", "Tasks of a page") },
        ],
        filters: [
          { id: "today", name: t("Heute fällig", "Due today") },
          { id: "overdue", name: t("Überfällig", "Overdue") },
          { id: "open", name: t("Alle offenen", "All open") },
        ],
        max: MAX_ITEMS,
        databases: readablePages(user, ["database"]).filter((p) => !p.pinLocked && !p.encrypted).map(listedPage),
        pages: (() => {
          const ids = new Set(
            all<{ page_id: string }>(
              "SELECT DISTINCT page_id FROM doc_tasks WHERE checked=0 AND workspace_id IN (SELECT workspace_id FROM members WHERE user_id=?) LIMIT 2000",
              user.id,
            ).map((r) => r.page_id),
          );
          return readablePages(user, ["document", "database", "journal"], 2000)
            .filter((p) => ids.has(p.id) && !p.pinLocked && !p.encrypted)
            .slice(0, 100)
            .map(listedPage);
        })(),
        database: databaseDetail(),
      };
    case "calendar":
    case "meeting":
      return {
        kind,
        calendars: calendarSourceList(user),
        ...(kind === "calendar"
          ? {
              ranges: [
                { id: "today", name: t("Heute", "Today") },
                { id: "3days", name: t("Nächste 3 Tage", "Next 3 days") },
                { id: "week", name: t("Diese Woche", "This week") },
              ],
            }
          : { journals: writableJournals(user).map(listedPage) }),
      };
    case "pinned":
      return {
        kind,
        modes: [
          { id: "favorites", name: t("Favoriten", "Favorites") },
          { id: "page", name: t("Seite oder Ansicht", "Page or view") },
        ],
        pages: readablePages(user, ["document", "database", "journal", "whiteboard", "dashboard"]).filter((p) => !p.journal_date).map(listedPage),
        database: databaseDetail(),
      };
    case "counter":
      return {
        kind,
        aggregates: [
          { id: "count", name: t("Anzahl", "Count") },
          { id: "sum", name: t("Summe", "Sum") },
          { id: "average", name: t("Durchschnitt", "Average") },
        ],
        databases: readablePages(user, ["database"]).filter((p) => !p.pinLocked && !p.encrypted).map(listedPage),
        database: databaseDetail(),
      };
    case "journal":
      return { kind, journals: readablePages(user, ["journal"], 100).map(listedPage), habits: habitDatabases(user) };
    case "time":
      return { kind, recent: recentTimers(user) };
    case "mentions":
      return {
        kind,
        show: [
          { id: "all", name: t("Erwähnungen und Aufgaben", "Mentions and assignments") },
          { id: "mentions", name: t("Nur Erwähnungen", "Mentions only") },
          { id: "assignments", name: t("Nur neue Aufgaben", "New assignments only") },
        ],
        max: MAX_ITEMS,
      };
    case "forms":
      return { kind, forms: formList(user) };
    case "focus":
      return { kind, durations: [15, 25, 45, 50, 90], breaks: [0, 5, 10, 15], recent: recentTimers(user) };
    case "jobs":
      return { kind };
    case "incident":
      return { kind, available: isInstanceAdmin(user) };
  }
}
