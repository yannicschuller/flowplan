// Everything a journal offers beyond one page per day: a template for new
// days, trackers per day (mood, sleep, sport …), place and photos, reviews
// of a week or month, the day's appointments and a PIN lock.
import * as Y from "yjs";
import { Node as PMNode } from "@tiptap/pm/model";
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from "y-prosemirror";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { all, one, run } from "./db";
import { documentSchema } from "./document-schema";
import { htmlState, stateHtml } from "./document-server";
import { HttpError } from "./auth";
import { pageRole } from "./permissions";
import { calendarRange } from "./database-calendar";
import { visibleRows } from "./row-access";
import { cellText } from "./cell-text";
import {
  occurrenceDates,
  parseRecurrence,
  recurrenceSchema,
  type Recurrence,
} from "./recurrence";
import { Temporal, validZone } from "./date-values";
import { safeFetch } from "./safe-fetch";
import type { Field, Identity, Page, Row, View } from "./types";

let cachedSchema: ReturnType<typeof documentSchema> | undefined;
const schema = () => (cachedSchema ??= documentSchema());

export const trackerSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/),
  name: z.string().trim().min(1).max(40),
  // mood: 1–5 faces; scale: 1–5 points; number: a value with unit; check: yes/no
  kind: z.enum(["mood", "scale", "number", "check"]),
  unit: z.string().trim().max(12).optional(),
});
export type Tracker = z.infer<typeof trackerSchema>;
export const defaultTrackers: Tracker[] = [
  { id: "mood", name: "Stimmung", kind: "mood" },
];
export const TEMPLATE_LIMIT = 50_000;

type SettingsRow = {
  page_id: string;
  template: string;
  trackers: string;
  lock_hash: string | null;
  ics_url: string | null;
};
function settingsRow(journalId: string) {
  return one<SettingsRow>(
    "SELECT * FROM journal_settings WHERE page_id=?",
    journalId,
  );
}
export function journalSettings(journalId: string) {
  const row = settingsRow(journalId);
  let trackers = defaultTrackers;
  try {
    if (row) trackers = z.array(trackerSchema).parse(JSON.parse(row.trackers));
  } catch {}
  return {
    template: row?.template || "",
    trackers,
    locked: !!row?.lock_hash,
    icsUrl: row?.ics_url || "",
  };
}
function ensureSettings(journalId: string) {
  run(
    "INSERT OR IGNORE INTO journal_settings(page_id,trackers) VALUES(?,?)",
    journalId,
    JSON.stringify(defaultTrackers),
  );
}
// The journal a page belongs to: the journal itself or the one of a day.
export function journalOf(page: Page) {
  if (page.kind === "journal") return page;
  if (!page.journal_date || !page.parent_id) return null;
  return one<Page>(
    "SELECT * FROM pages WHERE id=? AND kind='journal'",
    page.parent_id,
  ) || null;
}

// ---- Template ----

// Template HTML goes through the document schema, so it is as safe as any
// stored document. Tasks start unchecked and without a day of origin.
export function normalizeTemplate(html: string) {
  if (html.length > TEMPLATE_LIMIT)
    throw new HttpError(413, "Die Vorlage ist zu lang.");
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, htmlState(html));
  const doc = PMNode.fromJSON(schema(), yDocToProsemirrorJSON(ydoc, "default"));
  ydoc.destroy();
  const fresh = resetTasks(doc);
  if (!fresh.textContent.trim() && !hasAtoms(fresh)) return "";
  const built = prosemirrorJSONToYDoc(schema(), fresh.toJSON(), "default");
  const result = stateHtml(built);
  built.destroy();
  return result;
}
function hasAtoms(doc: PMNode) {
  let found = false;
  doc.descendants((node) => {
    if (node.isAtom && node.type.name !== "hardBreak") found = true;
    return !found;
  });
  return found;
}
function resetTasks(doc: PMNode): PMNode {
  const walk = (node: PMNode): PMNode => {
    if (node.isText || node.isLeaf) return node;
    const children: PMNode[] = [];
    node.forEach((child) => children.push(walk(child)));
    const attrs =
      node.type.name === "taskItem"
        ? { ...node.attrs, checked: false, journalSince: null }
        : node.attrs;
    return node.type.create(attrs, children, node.marks);
  };
  return walk(doc);
}
// The template as document nodes, for a new day.
export function templateNodes(
  journalId: string,
  target: ReturnType<typeof documentSchema> = schema(),
): PMNode[] {
  const html = journalSettings(journalId).template;
  if (!html) return [];
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, htmlState(html));
  const doc = PMNode.fromJSON(target, yDocToProsemirrorJSON(ydoc, "default"));
  ydoc.destroy();
  const nodes: PMNode[] = [];
  doc.forEach((node) => nodes.push(node));
  return nodes;
}
// Texts of the template's tasks: they come back every day by themselves and
// are not carried over as well.
export function templateTaskTexts(journalId: string) {
  const texts = new Set<string>();
  for (const node of templateNodes(journalId))
    node.descendants((child) => {
      if (child.type.name === "taskItem") texts.add(child.textContent.trim());
      return true;
    });
  return texts;
}
// A day that still reads exactly like the template (plus carried tasks).
export function onlyTemplate(journalId: string, doc: PMNode, date: string) {
  const nodes = templateNodes(journalId);
  if (!nodes.length) return false;
  const tasks = templateTaskTexts(journalId);
  const strip = (node: PMNode): unknown => {
    if (node.isText) return node.text;
    const kids: unknown[] = [];
    node.forEach((child) => {
      if (child.type.name === "taskItem") {
        const carried =
          typeof child.attrs.journalSince === "string" &&
          child.attrs.journalSince < date;
        if (!child.attrs.checked && (carried || tasks.has(child.textContent.trim())))
          return;
      }
      if (child.type.name === "paragraph" && !child.content.size) return;
      const kept = strip(child);
      if (Array.isArray(kept) && !kept.length && child.type.name === "taskList")
        return;
      kids.push(child.isText ? kept : [child.type.name, kept]);
    });
    return kids;
  };
  const template = schema().node("doc", null, nodes);
  return JSON.stringify(strip(doc)) === JSON.stringify(strip(template));
}
export function setJournalTemplate(journal: Page, html: string) {
  ensureSettings(journal.id);
  run(
    "UPDATE journal_settings SET template=? WHERE page_id=?",
    html ? normalizeTemplate(html) : "",
    journal.id,
  );
}
// The template from an existing day: its content with unchecked tasks.
export function templateFromDay(journal: Page, dayId: string) {
  const day = one<Page>(
    "SELECT * FROM pages WHERE id=? AND parent_id=? AND journal_date IS NOT NULL",
    dayId,
    journal.id,
  );
  if (!day) throw new HttpError(404, "Tag nicht gefunden.");
  const html = String(
    one("SELECT html FROM documents WHERE page_id=?", day.id)?.html || "",
  );
  setJournalTemplate(journal, html);
}

// ---- Trackers, place ----

export function setJournalTrackers(journal: Page, trackers: Tracker[]) {
  const list = z.array(trackerSchema).max(12).parse(trackers);
  if (new Set(list.map((t) => t.id)).size !== list.length)
    throw new HttpError(400, "Tracker doppelt.");
  ensureSettings(journal.id);
  run(
    "UPDATE journal_settings SET trackers=? WHERE page_id=?",
    JSON.stringify(list),
    journal.id,
  );
}
export const entrySchema = z.object({
  values: z
    .record(
      z.string().regex(/^[a-z0-9-]{1,40}$/),
      z.union([z.number().min(-1e6).max(1e6), z.boolean(), z.null()]),
    )
    .optional(),
  place: z.string().trim().max(120).optional(),
  lat: z.number().min(-90).max(90).nullable().optional(),
  lon: z.number().min(-180).max(180).nullable().optional(),
});
export type EntryData = {
  values: Record<string, number | boolean>;
  place: string;
  lat: number | null;
  lon: number | null;
};
export function dayEntry(dayId: string): EntryData {
  const row = one<{ data: string; place: string; lat: number | null; lon: number | null }>(
    "SELECT data,place,lat,lon FROM journal_entries WHERE page_id=?",
    dayId,
  );
  let values: Record<string, number | boolean> = {};
  try {
    values = row ? JSON.parse(row.data) : {};
  } catch {}
  return { values, place: row?.place || "", lat: row?.lat ?? null, lon: row?.lon ?? null };
}
export function hasEntryData(dayId: string) {
  const entry = dayEntry(dayId);
  return !!(Object.keys(entry.values).length || entry.place || entry.lat !== null);
}
export function saveDayEntry(journal: Page, day: Page, input: unknown) {
  const patch = entrySchema.parse(input);
  const current = dayEntry(day.id);
  const trackers = new Map(journalSettings(journal.id).trackers.map((t) => [t.id, t]));
  const values = { ...current.values };
  for (const [key, value] of Object.entries(patch.values || {})) {
    const tracker = trackers.get(key);
    if (!tracker) throw new HttpError(400, "Unbekannter Tracker.");
    if (value === null) {
      delete values[key];
      continue;
    }
    if (tracker.kind === "check" ? typeof value !== "boolean" : typeof value !== "number")
      throw new HttpError(400, `Ungültiger Wert für „${tracker.name}“.`);
    if ((tracker.kind === "mood" || tracker.kind === "scale") && ![1, 2, 3, 4, 5].includes(value as number))
      throw new HttpError(400, `„${tracker.name}“ geht von 1 bis 5.`);
    values[key] = value;
  }
  const next = {
    values,
    place: patch.place ?? current.place,
    lat: patch.lat === undefined ? current.lat : patch.lat,
    lon: patch.lon === undefined ? current.lon : patch.lon,
  };
  if ((next.lat === null) !== (next.lon === null))
    throw new HttpError(400, "Breite und Länge gehören zusammen.");
  run(
    "INSERT INTO journal_entries(page_id,data,place,lat,lon,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(page_id) DO UPDATE SET data=excluded.data,place=excluded.place,lat=excluded.lat,lon=excluded.lon,updated_at=excluded.updated_at",
    day.id,
    JSON.stringify(next.values),
    next.place,
    next.lat,
    next.lon,
    Date.now(),
  );
  run("UPDATE pages SET updated_at=CURRENT_TIMESTAMP WHERE id=?", day.id);
  return next;
}

// ---- Overview ----

const imagePattern = /<img[^>]*\ssrc="(\/api\/files\/[0-9a-f-]{36})"/i;
function plainText(html: string) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;|&#39;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
export function words(html: string) {
  const text = plainText(html);
  return text ? text.split(" ").length : 0;
}
// The days with what the journal page shows about them: trackers, place,
// first photo, number of words.
export function journalDayDetails(journalId: string) {
  return all<{
    id: string;
    title: string;
    icon: string;
    journal_date: string;
    updated_at: string;
    html: string | null;
    data: string | null;
    place: string | null;
  }>(
    `SELECT p.id,p.title,p.icon,p.journal_date,p.updated_at,d.html,e.data,e.place
     FROM pages p LEFT JOIN documents d ON d.page_id=p.id LEFT JOIN journal_entries e ON e.page_id=p.id
     WHERE p.parent_id=? AND p.journal_date IS NOT NULL AND p.deleted_at IS NULL ORDER BY p.journal_date DESC`,
    journalId,
  ).map(({ html, data, place, ...day }) => {
    let values: Record<string, number | boolean> = {};
    try {
      values = data ? JSON.parse(data) : {};
    } catch {}
    return {
      ...day,
      values,
      place: place || "",
      image: html?.match(imagePattern)?.[1] || null,
      words: words(html || ""),
      excerpt: plainText(html || "").slice(0, 160),
    };
  });
}

// ---- Review of a week or month ----

function loadDoc(pageId: string) {
  const row = one<{ state: Uint8Array | null; html: string }>(
    "SELECT state,html FROM documents WHERE page_id=?",
    pageId,
  );
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, row?.state || htmlState(row?.html || ""));
  const doc = PMNode.fromJSON(schema(), yDocToProsemirrorJSON(ydoc, "default"));
  ydoc.destroy();
  return { doc, html: row?.html || "" };
}
export function journalReview(journal: Page, from: string, to: string) {
  if (from > to) throw new HttpError(400, "Der Zeitraum ist ungültig.");
  const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 864e5;
  if (span > 92) throw new HttpError(400, "Höchstens drei Monate auf einmal.");
  const settings = journalSettings(journal.id);
  const days = all<Page>(
    "SELECT * FROM pages WHERE parent_id=? AND journal_date BETWEEN ? AND ? AND deleted_at IS NULL ORDER BY journal_date",
    journal.id,
    from,
    to,
  );
  const done: { text: string; date: string; dayId: string }[] = [];
  const images: { src: string; date: string; dayId: string }[] = [];
  const places = new Set<string>();
  let wordCount = 0;
  let open = 0;
  const trackerValues = new Map<string, { date: string; value: number | boolean }[]>();
  for (const day of days) {
    const date = day.journal_date!;
    const { doc, html } = loadDoc(day.id);
    wordCount += words(html);
    doc.descendants((node) => {
      if (node.type.name !== "taskItem") return true;
      const text = node.firstChild?.textContent.trim() || node.textContent.trim();
      if (node.attrs.checked && text) done.push({ text, date, dayId: day.id });
      return !node.attrs.checked;
    });
    if (date === days.at(-1)?.journal_date)
      doc.descendants((node) => {
        if (node.type.name === "taskItem" && !node.attrs.checked) open++;
        return true;
      });
    for (const match of html.matchAll(new RegExp(imagePattern, "gi")))
      if (images.length < 24) images.push({ src: match[1], date, dayId: day.id });
    const entry = dayEntry(day.id);
    if (entry.place) places.add(entry.place);
    for (const [key, value] of Object.entries(entry.values))
      trackerValues.set(key, [...(trackerValues.get(key) || []), { date, value }]);
  }
  return {
    from,
    to,
    days: days.map((d) => ({ id: d.id, date: d.journal_date!, title: d.title })),
    words: wordCount,
    done,
    open,
    images,
    places: [...places],
    trackers: settings.trackers.map((tracker) => {
      const values = trackerValues.get(tracker.id) || [];
      const numbers = values.map((v) => (typeof v.value === "boolean" ? (v.value ? 1 : 0) : v.value));
      return {
        ...tracker,
        count: values.length,
        average: numbers.length ? numbers.reduce((a, b) => a + b, 0) / numbers.length : null,
        values,
      };
    }),
  };
}

// ---- PIN lock ----

const UNLOCK_MS = 15 * 60_000;
const attempts = new Map<string, number[]>();
function pinHash(pin: string, salt = randomBytes(16).toString("hex")) {
  return `${salt}:${scryptSync(pin, salt, 32).toString("hex")}`;
}
export const pinSchema = z.string().regex(/^\d{4,8}$/, "Die PIN hat 4 bis 8 Ziffern.");
export function setJournalLock(user: Identity, journal: Page, pin: string | null, current?: string) {
  ensureSettings(journal.id);
  const row = settingsRow(journal.id);
  // Changing or removing an existing lock needs the PIN.
  if (row?.lock_hash && !checkPin(row.lock_hash, current || ""))
    throw new HttpError(403, "Die bisherige PIN stimmt nicht.");
  run(
    "UPDATE journal_settings SET lock_hash=? WHERE page_id=?",
    pin ? pinHash(pinSchema.parse(pin)) : null,
    journal.id,
  );
  run("DELETE FROM journal_unlocks WHERE page_id=?", journal.id);
  if (pin) unlockUntil(user, journal);
}
function checkPin(stored: string, pin: string) {
  const [salt, expected] = stored.split(":");
  if (!salt || !expected) return false;
  const actual = scryptSync(pin, salt, 32);
  return timingSafeEqual(actual, Buffer.from(expected, "hex"));
}
function unlockUntil(user: Identity, journal: Page) {
  run(
    "INSERT INTO journal_unlocks(user_id,page_id,until) VALUES(?,?,?) ON CONFLICT(user_id,page_id) DO UPDATE SET until=excluded.until",
    user.id,
    journal.id,
    Date.now() + UNLOCK_MS,
  );
}
export function unlockJournal(user: Identity, journal: Page, pin: string) {
  const row = settingsRow(journal.id);
  if (!row?.lock_hash) return;
  const key = `${user.id}:${journal.id}`;
  const recent = (attempts.get(key) || []).filter((t) => t > Date.now() - 5 * 60_000);
  if (recent.length >= 5)
    throw new HttpError(429, "Zu viele Versuche. Warte ein paar Minuten.");
  if (!checkPin(row.lock_hash, pin)) {
    attempts.set(key, [...recent, Date.now()]);
    throw new HttpError(403, "Die PIN stimmt nicht.");
  }
  attempts.delete(key);
  unlockUntil(user, journal);
}
export function lockJournalNow(user: Identity, journal: Page) {
  run("DELETE FROM journal_unlocks WHERE user_id=? AND page_id=?", user.id, journal.id);
}
// Whether the page is behind a journal PIN the person has not entered.
export function journalLocked(user: Identity, page: Page) {
  const journal = journalOf(page);
  if (!journal) return false;
  const row = settingsRow(journal.id);
  if (!row?.lock_hash) return false;
  return !one(
    "SELECT 1 FROM journal_unlocks WHERE user_id=? AND page_id=? AND until>?",
    user.id,
    journal.id,
    Date.now(),
  );
}
export function requireUnlocked(user: Identity, page: Page) {
  if (journalLocked(user, page))
    throw new HttpError(423, "Dieses Journal ist gesperrt.");
}
// Ids of all pages behind a PIN the person has not entered (for search).
export function lockedPageIds(user: Identity, workspaceId: string) {
  const locked = all<{ id: string }>(
    `SELECT p.id FROM pages p JOIN journal_settings s ON s.page_id=p.id
     WHERE p.workspace_id=? AND s.lock_hash IS NOT NULL
     AND NOT EXISTS(SELECT 1 FROM journal_unlocks u WHERE u.page_id=p.id AND u.user_id=? AND u.until>?)`,
    workspaceId,
    user.id,
    Date.now(),
  ).map((r) => r.id);
  if (!locked.length) return new Set<string>();
  const ids = new Set(locked);
  for (const journalId of locked)
    for (const day of all<{ id: string }>("SELECT id FROM pages WHERE parent_id=?", journalId))
      ids.add(day.id);
  return ids;
}

// ---- Appointments of a day ----

export type DayEvent = {
  title: string;
  start: string;
  end: string;
  timed: boolean;
  source: string;
  pageId?: string;
  rowId?: string;
};
function shift(date: string, days: number) {
  return Temporal.PlainDate.from(date).add({ days }).toString();
}
function zonedDay(ms: number, zone: string) {
  return Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(zone).toPlainDate().toString();
}
function covers(range: { timed: boolean; start: string; end: string; startMs: number; endMs: number }, date: string, zone: string) {
  if (!range.timed) return range.start <= date && date <= range.end;
  const first = zonedDay(range.startMs, zone);
  const last = zonedDay(Math.max(range.startMs, range.endMs - 1), zone);
  return first <= date && date <= last;
}
// Entries of all databases the person may read whose date falls on the day.
export function databaseEvents(user: Identity, workspaceId: string, date: string, zone: string) {
  if (!validZone(zone)) zone = "UTC";
  const events: DayEvent[] = [];
  const pages = all<Page & { fields: string; views: string }>(
    "SELECT p.*,d.fields,d.views FROM pages p JOIN databases d ON d.page_id=p.id WHERE p.workspace_id=? AND p.deleted_at IS NULL",
    workspaceId,
  );
  for (const page of pages) {
    if (!pageRole(user, page) || journalLocked(user, page)) continue;
    const fields = JSON.parse(page.fields) as Field[];
    const views = JSON.parse(page.views) as View[];
    const view =
      views.find((v) => v.type === "calendar") ||
      views.find((v) => v.type === "timeline") ||
      ({ id: "", type: "table", name: "" } as unknown as View);
    const start = view.dateField
      ? fields.find((f) => f.id === view.dateField && f.type === "date")
      : fields.find((f) => f.type === "date");
    if (!start) continue;
    const end = view.endDateField ? fields.find((f) => f.id === view.endDateField) : undefined;
    const path = (id: string) => `$."${id.replace(/"/g, "")}"`;
    // A generous prefilter in SQL; the exact check follows below.
    const candidates = all<Row & { cells: string; recurrence: string | null }>(
      `SELECT * FROM rows WHERE page_id=? AND (
        (recurrence IS NOT NULL AND recurrence!='') OR
        substr(json_extract(cells,?),1,10) BETWEEN ? AND ? OR
        (? != '' AND substr(json_extract(cells,?),1,10) <= ? AND substr(json_extract(cells,?),1,10) >= ?)
      ) LIMIT 2000`,
      page.id,
      path(start.id),
      shift(date, -1),
      shift(date, 1),
      end?.id || "",
      path(start.id),
      shift(date, 1),
      path(end?.id || start.id),
      shift(date, -1),
    ).map((r) => ({ ...r, cells: JSON.parse(r.cells as unknown as string) }) as Row & { recurrence: string | null });
    const title = fields[0];
    for (const row of visibleRows(user, page, candidates)) {
      const range = calendarRange(row, fields, { ...view, dateField: start.id } as View, zone);
      if (!range) continue;
      let hit = covers(range, date, zone);
      const rule = parseRecurrence(row.recurrence);
      if (!hit && rule && !range.timed) {
        const length = Temporal.PlainDate.from(range.start).until(range.end, { largestUnit: "days" }).days;
        hit = occurrenceDates(range.start, rule, shift(date, -length), date, 50).some(
          (d) => d <= date && shift(d, length) >= date,
        );
      } else if (!hit && rule && range.timed) {
        const first = zonedDay(range.startMs, zone);
        hit = first < date && occurrenceDates(first, rule, date, date, 2).includes(date);
      }
      if (!hit) continue;
      events.push({
        title: cellText(row.cells[title?.id || ""]) || "Ohne Titel",
        start: range.start,
        end: range.end,
        timed: range.timed,
        source: page.title || "Datenbank",
        pageId: page.id,
        rowId: row.id,
      });
      if (events.length >= 100) return events;
    }
  }
  return events;
}

// External calendar (ICS link) of a journal.
const icsCache = new Map<string, { at: number; events: IcsEvent[] }>();
type IcsEvent = {
  title: string;
  start: string;
  end: string;
  timed: boolean;
  startMs: number;
  endMs: number;
  rule: Recurrence | null;
  exclude: string[];
};
export const icsUrlSchema = z
  .string()
  .trim()
  .max(1000)
  .refine((v) => v === "" || /^(https|webcal):\/\//i.test(v), "Nur https- oder webcal-Adressen.");
export function setJournalCalendar(journal: Page, url: string) {
  ensureSettings(journal.id);
  run(
    "UPDATE journal_settings SET ics_url=? WHERE page_id=?",
    icsUrlSchema.parse(url).replace(/^webcal:/i, "https:") || null,
    journal.id,
  );
}
function unfold(text: string) {
  return text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
}
function icsText(value: string) {
  return value.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1").trim();
}
function icsDate(value: string, params: string, fallbackZone: string) {
  const date = value.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (date || /VALUE=DATE(?!-)/i.test(params)) {
    const d = value.slice(0, 8);
    const plain = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
    return { value: plain, timed: false, ms: 0 };
  }
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return null;
  const local = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
  let instant: Temporal.Instant;
  if (m[7]) instant = Temporal.Instant.from(`${local}Z`);
  else {
    const zone = params.match(/TZID=([^;:]+)/i)?.[1]?.replace(/^"|"$/g, "");
    const use = zone && validZone(zone) ? zone : fallbackZone;
    instant = Temporal.PlainDateTime.from(local).toZonedDateTime(use).toInstant();
  }
  return { value: instant.toString(), timed: true, ms: instant.epochMilliseconds };
}
export function parseIcs(text: string, zone = "UTC"): IcsEvent[] {
  const events: IcsEvent[] = [];
  let current: Record<string, { params: string; value: string }[]> | null = null;
  for (const line of unfold(text)) {
    if (line === "BEGIN:VEVENT") current = {};
    else if (line === "END:VEVENT" && current) {
      const get = (k: string) => current![k]?.[0];
      const startRaw = get("DTSTART");
      const start = startRaw && icsDate(startRaw.value, startRaw.params, zone);
      if (start) {
        const endRaw = get("DTEND");
        const endParsed = endRaw && icsDate(endRaw.value, endRaw.params, zone);
        let end = endParsed || start;
        // All-day events end on the following day in ICS (exclusive).
        if (!start.timed && endParsed && !endParsed.timed && endParsed.value > start.value)
          end = { ...endParsed, value: shift(endParsed.value, -1) };
        let rule: Recurrence | null = null;
        const rrule = get("RRULE")?.value;
        if (rrule) {
          const parts = Object.fromEntries(rrule.split(";").map((p) => p.split("=")));
          const freq = String(parts.FREQ || "").toLowerCase();
          const until = parts.UNTIL ? `${parts.UNTIL.slice(0, 4)}-${parts.UNTIL.slice(4, 6)}-${parts.UNTIL.slice(6, 8)}` : undefined;
          const parsed = recurrenceSchema.safeParse({
            freq,
            interval: Number(parts.INTERVAL || 1),
            ...(until ? { until } : parts.COUNT ? { count: Math.max(2, Number(parts.COUNT)) } : {}),
          });
          rule = parsed.success ? parsed.data : null;
        }
        const exclude = (current.EXDATE || []).flatMap((e) =>
          e.value.split(",").map((v) => `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`),
        );
        events.push({
          title: icsText(get("SUMMARY")?.value || "") || "Termin",
          start: start.value,
          end: end.value,
          timed: start.timed,
          startMs: start.ms,
          endMs: end.ms,
          rule,
          exclude,
        });
      }
      current = null;
    } else if (current) {
      const colon = line.indexOf(":");
      if (colon < 0) continue;
      const [name, ...params] = line.slice(0, colon).split(";");
      const key = name.toUpperCase();
      (current[key] ||= []).push({ params: params.join(";"), value: line.slice(colon + 1) });
    }
    if (events.length >= 5000) break;
  }
  return events;
}
export function icsEventsOn(events: IcsEvent[], date: string, zone: string): DayEvent[] {
  const out: DayEvent[] = [];
  for (const event of events) {
    const range = { ...event };
    let hit = covers(range, date, zone);
    if (!hit && event.rule) {
      const first = event.timed ? zonedDay(event.startMs, zone) : event.start;
      const length = event.timed
        ? 0
        : Temporal.PlainDate.from(event.start).until(event.end, { largestUnit: "days" }).days;
      hit =
        first < date &&
        occurrenceDates(first, event.rule, shift(date, -length), date, 50).some(
          (d) => d <= date && shift(d, length) >= date && !event.exclude.includes(d),
        );
    }
    if (hit)
      out.push({ title: event.title, start: event.start, end: event.end, timed: event.timed, source: "Kalender" });
  }
  return out.slice(0, 100);
}
export async function calendarEvents(journalId: string, date: string, zone: string) {
  const url = journalSettings(journalId).icsUrl;
  if (!url) return [];
  let cached = icsCache.get(url);
  if (!cached || cached.at < Date.now() - 30 * 60_000) {
    const fetched = await safeFetch(url, {
      maxBytes: 3_000_000,
      timeout: 8000,
      accept: "text/calendar, text/plain;q=0.8",
    });
    const body = fetched.data.toString("utf8");
    if (!body.includes("BEGIN:VCALENDAR"))
      throw new HttpError(502, "Die Adresse liefert keinen Kalender.");
    cached = { at: Date.now(), events: parseIcs(body, validZone(zone) ? zone : "UTC") };
    icsCache.set(url, cached);
    if (icsCache.size > 200) icsCache.delete(icsCache.keys().next().value!);
  }
  return icsEventsOn(cached.events, date, validZone(zone) ? zone : "UTC");
}
