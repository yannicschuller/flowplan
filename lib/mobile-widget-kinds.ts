// The widgets of 2026 (lib/mobile-widgets.ts builds on the same helpers and
// loads this file when one of them is asked for):
//
//   event     "Nächster Termin" – the next 1–3 appointments of the person's
//             calendars, with "Join" for links of known video-meeting services
//   reading   "Weiterlesen" – pages opened last, or the library's books with
//             how far the person read
//   metric    "Kennzahl" – one number tile of a dashboard, with a sparkline
//   deadline  "Frist" – the due date of one record or document task
//
// The same rules as every widget: only what the person may see in the web
// app, pages behind a journal PIN and end-to-end encrypted spaces as a
// state only (`locked` / `encrypted`), at most about 2 KB per answer.
import { createHash } from "node:crypto";
import { Temporal } from "@js-temporal/polyfill";
import { all, one, run } from "./db";
import { HttpError } from "./auth";
import { ct } from "./content-locale";
import { computeMetric } from "./dashboard-metric";
import { parseTiles } from "./dashboard-schema";
import { doneRule, dueField, isDone, type DatabaseSettings } from "./database-settings-schema";
import { hasOffset, instantOf, isTimed, validDateValue } from "./date-values";
import { openTasksEverywhere, taskKey } from "./doc-tasks";
import { visibleFields } from "./field-access";
import { readingNow } from "./library";
import { libraryPages } from "./library-server";
import { hiddenRowIds, visibleRows } from "./row-access";
import { toPlain } from "./inline-markdown";
import { cellText } from "./cell-text";
import type { Field, Identity, Page, Row } from "./types";
import { mapAsync } from "./each-async";
import {
  calendarSourceList,
  chosenSources,
  clip,
  headingOf,
  listedPage,
  pageAccess,
  parse,
  readablePages,
  requireAccess,
  rowTitle,
  shift,
  sourceEvents,
  spaceInfo,
  status,
  untitled,
  url,
  workspaceIds,
  zonedDay,
  type Context,
  type WidgetEvent,
} from "./mobile-widgets";
import type { WidgetConfig, WidgetKind } from "./mobile-widget-schema";

const iso = (ms: number) => new Date(ms).toISOString();

// ---- Join links of video meetings ----

// Known services only, by host and the shape of a meeting's path – never
// any other address, so a widget never offers "Join" for a link that is
// not a meeting. MEETING_HOSTS adds the hosts of the instance's own
// meeting service (a self-hosted Jitsi or BigBlueButton), comma-separated.
const MEETING_SERVICES: { host: RegExp; path: RegExp }[] = [
  // Zoom: /j/<id>, /w/<id>, /my/<name>, /s/<id>, /wc/<id>
  { host: /(^|\.)zoom\.us$/, path: /^\/(j|w|my|s|wc)\/[\w.-]+/ },
  { host: /(^|\.)zoomgov\.com$/, path: /^\/(j|w|my|s|wc)\/[\w.-]+/ },
  // Microsoft Teams
  { host: /^teams\.microsoft\.com$/, path: /^\/(l\/meetup-join|meet)\// },
  { host: /^teams\.live\.com$/, path: /^\/meet\// },
  // Google Meet: /abc-defg-hij, /lookup/…
  { host: /^meet\.google\.com$/, path: /^\/([a-z]{3}-[a-z]{4}-[a-z]{3}|lookup\/[\w-]+)/ },
  // Webex: <site>.webex.com/meet/…, /join/…, /<site>/j.php…
  { host: /(^|\.)webex\.com$/, path: /^\/[^/]+/ },
  // Jitsi Meet (the public service) and 8x8
  { host: /^meet\.jit\.si$/, path: /^\/[^/]+/ },
  { host: /^8x8\.vc$/, path: /^\/[^/]+/ },
  // Whereby
  { host: /^(?:[\w-]+\.)?whereby\.com$/, path: /^\/[^/]+/ },
];
export function meetingHosts(): string[] {
  return (process.env.MEETING_HOSTS || "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(h));
}
const LINK = /https:\/\/[^\s<>"'`()[\]{}]+/gi;
// The first link of a known meeting service in these texts, or null.
export function joinUrl(texts: (string | null | undefined)[], extra: string[] = meetingHosts()): string | null {
  for (const text of texts) {
    if (!text) continue;
    for (const match of text.replace(/&amp;/g, "&").matchAll(LINK)) {
      const raw = match[0].replace(/[.,;:!?]+$/, "");
      let parsed: URL;
      try {
        parsed = new URL(raw);
      } catch {
        continue;
      }
      if (parsed.protocol !== "https:" || parsed.username || parsed.password || (parsed.port && parsed.port !== "443")) continue;
      const host = parsed.hostname.toLowerCase();
      const known = MEETING_SERVICES.some((s) => s.host.test(host) && s.path.test(parsed.pathname)) || (extra.includes(host) && parsed.pathname.length > 1);
      if (known && parsed.href.length <= 1000) return parsed.href;
    }
  }
  return null;
}
const LOCATION = /^(ort|location|lieu|place|venue|raum|room|adresse|address|地点|地址|会议室)$/i;
const stripHtml = (html: string) => html.replace(/<a\b[^>]*href="([^"]*)"[^>]*>/gi, " $1 ").replace(/<[^>]+>/g, " ");

// The location and join link of one appointment: from its visible
// properties (a property named like a location, links, texts) and its
// description (the record's text – synced calendars put it there).
async function eventDetails(user: Identity, pageId: string, rowId: string, withJoin: boolean) {
  const page = await one<Page>("SELECT * FROM pages WHERE id=?", pageId);
  const row = await one<{ cells: string; content: string | null }>("SELECT cells,content FROM rows WHERE id=? AND page_id=?", rowId, pageId);
  if (!page || !row) return {};
  const fields = await visibleFields(user, page, parse<Field[]>((await one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", pageId))?.fields, []));
  const cells = parse<Record<string, unknown>>(row.cells, {});
  const place = fields.find((f) => (f.type === "text" || f.type === "url") && LOCATION.test(f.name.trim()));
  const location = place ? clip(toPlain(cellText(cells[place.id])).replace(/\s+/g, " "), 80) : "";
  let join: string | null = null;
  if (withJoin) {
    const texts = [
      place ? cellText(cells[place.id]) : "",
      ...fields.filter((f) => f.type === "url" || f.type === "text").map((f) => cellText(cells[f.id])),
      row.content ? stripHtml(row.content) : "",
    ];
    join = joinUrl(texts);
    if (!join) {
      const doc = await one<{ html: string }>("SELECT html FROM row_documents WHERE row_id=?", rowId);
      if (doc?.html) join = joinUrl([stripHtml(doc.html)]);
    }
  }
  return { ...(location ? { location } : {}), ...(join ? { joinUrl: join } : {}) };
}

// ---- event: next appointment ----

const calendarRef = (ref: string) => {
  const at = ref.indexOf(":");
  return at < 0 ? { pageId: ref } : { pageId: ref.slice(0, at), viewId: ref.slice(at + 1) };
};

export async function eventData(ctx: Context, config: WidgetConfig<"event">) {
  const length = config.within === "today" ? 1 : config.within === "48h" ? 3 : 7;
  const days = Array.from({ length }, (_, i) => shift(ctx.today, i));
  const horizon = config.within === "48h" ? ctx.now + 48 * 3_600_000 : null;
  const lastDay = horizon ? zonedDay(horizon, ctx.zone) : days[days.length - 1];
  const sources = await chosenSources(ctx.user, (config.calendars ?? []).map(calendarRef));
  const events: WidgetEvent[] = [];
  for (const s of sources) events.push(...(await sourceEvents(ctx.user, s, days, ctx.zone, s.label)));
  // Not over yet, and within the range; an all-day entry counts on its days
  // and sorts after the timed ones of its first day.
  const endOfDay = (d: string) => Temporal.PlainDate.from(d).add({ days: 1 }).toZonedDateTime({ timeZone: ctx.zone }).epochMilliseconds - 1;
  const upcoming = events
    .filter((e) => (e.timed ? e.endMs! > ctx.now && (!horizon || e.startMs! < horizon) : e.end >= ctx.today && e.day <= lastDay))
    .map((e) => ({ e, at: e.timed ? e.startMs! : endOfDay(e.day < ctx.today ? ctx.today : e.day) }))
    .sort((a, b) => a.at - b.at || a.e.title.localeCompare(b.e.title));
  const seen = new Set<string>();
  const next = upcoming.filter(({ e }) => {
    const key = `${e.rowId}@${e.start}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const items = await mapAsync(next.slice(0, config.max), async ({ e }) => ({
    id: `${e.rowId}@${e.timed ? e.start : e.day}`,
    title: e.title,
    start: e.start,
    end: e.end,
    allDay: !e.timed,
    ...(await eventDetails(ctx.user, e.pageId, e.rowId, config.showJoin)),
    calendarName: e.calendar,
    url: e.url,
  }));
  return { title: ct("Nächster Termin", "Next appointment"), total: next.length, items };
}

// ---- reading: continue reading ----

type ReadingItem = { id: string; title: string; icon: string; kind: string; url: string; lastOpened: string; progress?: number; detail?: string; locked?: true; encrypted?: true };

async function recentReading(ctx: Context, max: number) {
  const items: ReadingItem[] = [];
  for (const v of await all<{ page_id: string; seen_at: number }>("SELECT page_id,seen_at FROM page_visits WHERE user_id=? ORDER BY seen_at DESC LIMIT 100", ctx.user.id)) {
    const access = await pageAccess(ctx.user, v.page_id);
    if (!access || access.page.journal_date) continue;
    const base = { id: access.page.id, kind: access.page.kind, url: url(access.page.id), lastOpened: iso(Number(v.seen_at)) };
    // Behind a PIN or end-to-end encrypted: that it is there, nothing of it.
    items.push(access.locked || access.encrypted ? { ...base, title: "", icon: "", ...status(access) } : { ...base, title: clip(access.page.title || untitled()), icon: access.page.icon });
    if (items.length >= max) break;
  }
  return items;
}

async function libraryReading(ctx: Context, max: number) {
  const found: (ReadingItem & { at: number })[] = [];
  for (const wid of await workspaceIds(ctx.user)) {
    const { spaces, pages } = await libraryPages(ctx.user, wid);
    if (!spaces.length) continue;
    const visits = (await all<{ page_id: string; seen_at: number }>(
      `SELECT v.page_id,v.seen_at FROM page_visits v JOIN pages p ON p.id=v.page_id WHERE v.user_id=? AND p.workspace_id=? AND p.deleted_at IS NULL ORDER BY v.seen_at DESC LIMIT 300`,
      ctx.user.id,
      wid,
    )).map((v) => ({ pageId: v.page_id, seenAt: Number(v.seen_at) }));
    const encrypted = new Set<string>();
    for (const s of spaces) if ((await spaceInfo(s.id))?.encrypted) encrypted.add(s.id);
    for (const r of readingNow(pages, spaces.map((s) => s.id), visits, max)) {
      const base = { id: r.page.id, kind: "book", url: url(r.page.id), lastOpened: iso(r.seenAt), at: r.seenAt };
      found.push(
        encrypted.has(r.spaceId)
          ? { ...base, title: "", icon: "", encrypted: true }
          : {
              ...base,
              title: clip(r.book.title || untitled()),
              icon: r.book.icon,
              // How far into the book: the page read last of all its pages.
              progress: Math.round((r.position / Math.max(1, r.total)) * 100) / 100,
              ...(r.page.id !== r.book.id ? { detail: clip(r.page.title || untitled(), 60) } : {}),
            },
      );
    }
  }
  return found
    .sort((a, b) => b.at - a.at)
    .slice(0, max)
    .map(({ at: _at, ...item }) => item);
}

export async function readingData(ctx: Context, config: WidgetConfig<"reading">) {
  const items = config.source === "library" ? await libraryReading(ctx, config.max) : await recentReading(ctx, config.max);
  return { title: config.source === "library" ? ct("Weiterlesen", "Continue reading") : ct("Zuletzt geöffnet", "Recently opened"), source: config.source, items };
}

// ---- metric: a dashboard's key figure ----

const SERIES_DAYS = 30;

export async function metricData(ctx: Context, config: WidgetConfig<"metric">) {
  const access = await requireAccess(ctx.user, config.dashboardId);
  if (access.page.kind !== "dashboard") throw new HttpError(400, ct("Kein Dashboard.", "Not a dashboard."));
  const heading = headingOf(access);
  if (access.locked || access.encrypted) return { title: heading, ...status(access), url: url(access.page.id) };
  const tile = parseTiles((await one<{ tiles: string }>("SELECT tiles FROM dashboards WHERE page_id=?", access.page.id))?.tiles).find((t) => t.id === config.widgetId);
  if (!tile || tile.type !== "number") throw new HttpError(404, ct("Kachel nicht gefunden.", "Tile not found."));
  // The source as the dashboard shows it: readable, in the dashboard's
  // workspace, not behind a PIN (lib/dashboard.ts); otherwise nothing of it.
  const source = await pageAccess(ctx.user, tile.source);
  if (!source || source.page.kind !== "database" || source.page.workspace_id !== access.page.workspace_id || source.locked)
    return { title: heading, label: clip(tile.title || "", 40), available: false, url: url(access.page.id) };
  if (source.encrypted) return { title: heading, label: clip(tile.title || "", 40), encrypted: true, url: url(access.page.id) };
  const metric = await computeMetric(ctx.user, { source: tile.source, view: tile.view, aggregate: tile.aggregate, field: tile.field });
  // One value per day, as the counter widget keeps it (widget_counter_days).
  const key = createHash("sha256").update(JSON.stringify(["metric", ctx.user.id, config.dashboardId, config.widgetId])).digest("hex");
  await run(
    "INSERT INTO widget_counter_days(key,user_id,day,value,at) VALUES(?,?,?,?,?) ON CONFLICT(key,day) DO UPDATE SET value=excluded.value,at=excluded.at",
    key,
    ctx.user.id,
    ctx.today,
    metric.value,
    ctx.now,
  );
  const stored = await all<{ day: string; value: number | null }>(
    "SELECT day,value FROM widget_counter_days WHERE key=? AND day>=? AND day<=? ORDER BY day",
    key,
    shift(ctx.today, -(SERIES_DAYS - 1)),
    ctx.today,
  );
  const series = stored.map((r) => r.value).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const before = stored.filter((r) => r.day < ctx.today && typeof r.value === "number").pop();
  const label = tile.title || [metric.source, metric.view].filter(Boolean).join(" · ") || untitled();
  const percent = metric.field && tile.aggregate !== "count" && (await visibleFields(ctx.user, source.page, parse<Field[]>((await one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", source.page.id))?.fields, []))).find((f) => f.id === tile.field)?.format === "percent";
  return {
    title: heading,
    label: clip(label, 60),
    value: metric.value,
    ...(percent ? { unit: "%" } : {}),
    formatted: metric.formatted,
    ...(series.length > 1 ? { series } : {}),
    ...(before && metric.value !== null ? { delta: Math.round((metric.value - Number(before.value)) * 1e6) / 1e6 } : {}),
    ...(tile.target !== null ? { target: tile.target } : {}),
    url: url(access.page.id),
  };
}

// ---- deadline: one due date ----

// A stored date as the answer gives it: a day as it is, a time as an
// instant (UTC ISO; a time without offset in the phone's zone).
function dueOf(value: unknown, zone: string): { due: string; allDay: boolean; ms: number } | null {
  if (typeof value !== "string" || !validDateValue(value)) return null;
  if (!isTimed(value)) return { due: value.slice(0, 10), allDay: true, ms: Temporal.PlainDate.from(value.slice(0, 10)).add({ days: 1 }).toZonedDateTime({ timeZone: zone }).epochMilliseconds };
  try {
    const instant = hasOffset(value) ? Temporal.Instant.from(value) : instantOf(value, zone);
    return { due: instant.toString(), allDay: false, ms: instant.epochMilliseconds };
  } catch {
    return null;
  }
}

export async function deadlineData(ctx: Context, config: WidgetConfig<"deadline">) {
  const access = await requireAccess(ctx.user, config.pageId);
  const heading = headingOf(access);
  if (access.locked || access.encrypted) return { title: heading, ...status(access), url: url(access.page.id, config.rowId) };
  const answer = (title: string, due: ReturnType<typeof dueOf>, done: boolean, link: string) => ({
    title,
    page: heading,
    due: due?.due ?? null,
    allDay: due?.allDay ?? true,
    done,
    overdue: !done && !!due && due.ms <= ctx.now,
    url: link,
  });
  if (config.taskKey) {
    // A document task (the page's own document, or a record's with rowId).
    if (config.rowId && access.page.kind === "database" && (await hiddenRowIds(ctx.user, access.page)).has(config.rowId))
      throw new HttpError(404, ct("Eintrag nicht gefunden.", "Record not found."));
    const tasks = (await all<{ idx: number; text: string; due: string | null; checked: number }>(
      "SELECT idx,text,due,checked FROM doc_tasks WHERE page_id=? AND row_id=? ORDER BY idx LIMIT 5000",
      access.page.id,
      config.rowId ?? "",
    )).filter((t) => taskKey(t.text) === config.taskKey);
    const task = tasks.find((t) => t.idx === config.index) ?? tasks[0];
    if (!task) throw new HttpError(404, ct("Aufgabe nicht gefunden.", "Task not found."));
    return answer(clip(task.text, 120), task.due ? dueOf(task.due, ctx.zone) : null, !!task.checked, url(access.page.id, config.rowId));
  }
  if (access.page.kind !== "database") throw new HttpError(400, ct("Keine Datenbank.", "Not a database."));
  const raw = await one<{ fields: string; settings: string | null }>("SELECT fields,settings FROM databases WHERE page_id=?", access.page.id);
  const fields = parse<Field[]>(raw?.fields, []);
  const settings = parse<DatabaseSettings | undefined>(raw?.settings, undefined);
  const shown = await visibleFields(ctx.user, access.page, fields);
  const stored = await one<Row & { cells: string }>("SELECT * FROM rows WHERE id=? AND page_id=?", config.rowId ?? "", access.page.id);
  const [row] = stored ? await visibleRows(ctx.user, access.page, [{ ...stored, cells: parse<Record<string, unknown>>(stored.cells, {}) } as Row]) : [];
  if (!row) throw new HttpError(404, ct("Eintrag nicht gefunden.", "Record not found."));
  // The database's due date and done state, only when the person may read them.
  const dueFound = dueField(fields, settings);
  const due = dueFound && shown.some((f) => f.id === dueFound.id) ? dueOf(row.cells[dueFound.id], ctx.zone) : null;
  const rule = doneRule(fields, settings);
  const done = !!rule && shown.includes(rule.field) && isDone(rule, row.cells);
  return answer(rowTitle({ fields, shown }, row), due, done, url(access.page.id, row.id));
}

// ---- Option lists ----

async function dashboardChoices(user: Identity) {
  const out: (ReturnType<typeof listedPage> & { widgets: { id: string; name: string }[] })[] = [];
  for (const page of await readablePages(user, ["dashboard"], 200)) {
    if (page.encrypted || page.pinLocked) continue;
    const tiles = parseTiles((await one<{ tiles: string }>("SELECT tiles FROM dashboards WHERE page_id=?", page.id))?.tiles).filter((t) => t.type === "number");
    if (!tiles.length) continue;
    const widgets = await mapAsync(tiles, async (t) => {
      if (t.title) return { id: t.id, name: clip(t.title, 40) };
      const source = await pageAccess(user, "source" in t ? t.source : null);
      return { id: t.id, name: source && !source.locked && !source.encrypted ? clip(source.page.title || untitled(), 40) : ct("Kennzahl", "Key figure") };
    });
    out.push({ ...listedPage(page), widgets });
    if (out.length >= 100) break;
  }
  return out;
}

async function deadlineChoices(user: Identity, pageId: string | null) {
  const databases: ReturnType<typeof listedPage>[] = [];
  for (const page of await readablePages(user, ["database"], 400)) {
    if (page.encrypted || page.pinLocked) continue;
    const raw = await one<{ fields: string; settings: string | null }>("SELECT fields,settings FROM databases WHERE page_id=?", page.id);
    const fields = parse<Field[]>(raw?.fields, []);
    const due = dueField(fields, parse<DatabaseSettings | undefined>(raw?.settings, undefined));
    if (due && (await visibleFields(user, page, fields)).some((f) => f.id === due.id)) databases.push(listedPage(page));
    if (databases.length >= 100) break;
  }
  // The records of one database with a due date, the next first.
  let records: { id: string; title: string; due: string; done: boolean }[] | undefined;
  if (pageId) {
    const access = await requireAccess(user, pageId);
    if (access.page.kind === "database" && !access.locked && !access.encrypted) {
      const raw = await one<{ fields: string; settings: string | null }>("SELECT fields,settings FROM databases WHERE page_id=?", pageId);
      const fields = parse<Field[]>(raw?.fields, []);
      const settings = parse<DatabaseSettings | undefined>(raw?.settings, undefined);
      const shown = await visibleFields(user, access.page, fields);
      const due = dueField(fields, settings);
      const rule = doneRule(fields, settings);
      if (due && shown.some((f) => f.id === due.id)) {
        const rows = await visibleRows(
          user,
          access.page,
          (await all<Row & { cells: string }>("SELECT * FROM rows WHERE page_id=? ORDER BY position LIMIT 2000", pageId)).map((r) => ({ ...r, cells: parse<Record<string, unknown>>(r.cells, {}) }) as Row),
        );
        records = rows
          .filter((r) => typeof r.cells[due.id] === "string" && validDateValue(r.cells[due.id]))
          .map((r) => ({ id: r.id, title: rowTitle({ fields, shown }, r), due: String(r.cells[due.id]), done: !!rule && shown.includes(rule.field) && isDone(rule, r.cells) }))
          .sort((a, b) => Number(a.done) - Number(b.done) || a.due.localeCompare(b.due))
          .slice(0, 50);
      } else records = [];
    }
  }
  // The person's open document tasks with a due date ("Meine Aufgaben").
  const tasks = (await openTasksEverywhere(user))
    .filter((t) => t.due)
    .slice(0, 50)
    .map((t) => ({ pageId: t.pageId, rowId: t.rowId, index: t.index, taskKey: taskKey(t.text), text: clip(t.text, 80), due: t.due, page: clip(t.title || untitled(), 40) }));
  return { databases, ...(records ? { records } : {}), tasks };
}

export async function kindOptions(user: Identity, kind: Extract<WidgetKind, "event" | "reading" | "metric" | "deadline">, pageId: string | null) {
  const t = (de: string, en: string) => ct(de, en);
  switch (kind) {
    case "event":
      return {
        kind,
        calendars: (await calendarSourceList(user)).map((c) => ({ id: `${c.pageId}:${c.viewId}`, ...c })),
        within: [
          { id: "today", name: t("Heute", "Today") },
          { id: "48h", name: t("Nächste 48 Stunden", "Next 48 hours") },
          { id: "week", name: t("Diese Woche", "This week") },
        ],
        max: 3,
      };
    case "reading":
      return {
        kind,
        sources: [
          { id: "recent", name: t("Zuletzt geöffnet", "Recently opened") },
          { id: "library", name: t("Bücher der Bibliothek", "Library books") },
        ],
        max: 6,
      };
    case "metric":
      return { kind, dashboards: await dashboardChoices(user) };
    case "deadline":
      return { kind, ...(await deadlineChoices(user, pageId)) };
  }
}
