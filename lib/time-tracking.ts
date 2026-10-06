// Time tracking: a "time" property sums the time worked on a record. People
// start and stop a timer (one running timer per person – starting another
// stops the first) or add time by hand; the property holds the total in
// seconds, the entries keep who worked when (weekly report).
import { z } from "zod";
import { all, id, one, run } from "./db";
import { HttpError } from "./auth";
import { pageRole, requirePage } from "./permissions";
import { hiddenRowIds } from "./row-access";
import { requireRow } from "./row-documents";
import { cellText } from "./cell-text";
import type { Field, Identity, Page } from "./types";

type Entry = { id: string; page_id: string; row_id: string; field_id: string; user_id: string; start: number; end: number | null; note: string };

const fieldsOf = (pageId: string) =>
  JSON.parse(one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", pageId)?.fields || "[]") as Field[];
function timeField(pageId: string, fieldId: string) {
  const field = fieldsOf(pageId).find((f) => f.id === fieldId && f.type === "time");
  if (!field) throw new HttpError(400, "Keine Eigenschaft für Zeiterfassung.");
  return field;
}
// The local calendar day (weeks start on Monday in the server's time zone).
const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const seconds = (e: Pick<Entry, "start" | "end">, now = Date.now()) => Math.max(0, Math.round(((e.end ?? now) - e.start) / 1000));

// The property's value: all finished entries of the record.
function refreshTotal(pageId: string, rowId: string, fieldId: string) {
  const total = all<Entry>("SELECT * FROM time_entries WHERE row_id=? AND field_id=? AND end IS NOT NULL", rowId, fieldId).reduce(
    (sum, e) => sum + seconds(e),
    0,
  );
  const row = one<{ cells: string }>("SELECT cells FROM rows WHERE id=? AND page_id=?", rowId, pageId);
  if (!row) return;
  const cells = JSON.parse(row.cells);
  cells[fieldId] = total;
  run("UPDATE rows SET cells=?,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=?", JSON.stringify(cells), rowId);
}

function stopRunning(userId: string, now = Date.now()) {
  for (const e of all<Entry>("SELECT * FROM time_entries WHERE user_id=? AND end IS NULL", userId)) {
    run("UPDATE time_entries SET end=? WHERE id=?", Math.max(now, e.start), e.id);
    refreshTotal(e.page_id, e.row_id, e.field_id);
  }
}

const target = z.object({ rowId: z.uuid(), fieldId: z.string().min(1).max(500) });

export function timeCommand(user: Identity, page: Page, action: string, input: Record<string, unknown>) {
  if (action === "time.start") {
    const { rowId, fieldId } = target.parse(input);
    requireRow(user, page.id, rowId, true);
    timeField(page.id, fieldId);
    stopRunning(user.id);
    run("INSERT INTO time_entries(id,page_id,row_id,field_id,user_id,start) VALUES(?,?,?,?,?,?)", id(), page.id, rowId, fieldId, user.id, Date.now());
    return recordTime(user, page, rowId, fieldId);
  }
  if (action === "time.stop") {
    const { rowId, fieldId } = target.parse(input);
    requireRow(user, page.id, rowId, true);
    stopRunning(user.id);
    return recordTime(user, page, rowId, fieldId);
  }
  if (action === "time.add") {
    const b = target
      .extend({
        minutes: z.number().int().min(1).max(24 * 60),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        note: z.string().trim().max(300).default(""),
      })
      .parse(input);
    requireRow(user, page.id, b.rowId, true);
    timeField(page.id, b.fieldId);
    const start = new Date(`${b.date}T09:00:00`).getTime();
    if (!Number.isFinite(start)) throw new HttpError(400, "Ungültiges Datum.");
    run(
      "INSERT INTO time_entries(id,page_id,row_id,field_id,user_id,start,end,note) VALUES(?,?,?,?,?,?,?,?)",
      id(),
      page.id,
      b.rowId,
      b.fieldId,
      user.id,
      start,
      start + b.minutes * 60_000,
      b.note,
    );
    refreshTotal(page.id, b.rowId, b.fieldId);
    return recordTime(user, page, b.rowId, b.fieldId);
  }
  if (action === "time.delete") {
    const entryId = z.uuid().parse(input.entryId);
    const entry = one<Entry>("SELECT * FROM time_entries WHERE id=? AND page_id=?", entryId, page.id);
    if (!entry) throw new HttpError(404, "Zeiteintrag nicht gefunden.");
    requireRow(user, page.id, entry.row_id, true);
    // Own entries; owners of the database may correct everyone's.
    if (entry.user_id !== user.id && pageRole(user, page) !== "owner")
      throw new HttpError(403, "Nur eigene Zeiteinträge löschen.");
    run("DELETE FROM time_entries WHERE id=?", entryId);
    refreshTotal(page.id, entry.row_id, entry.field_id);
    return recordTime(user, page, entry.row_id, entry.field_id);
  }
  throw new HttpError(400, "Unbekannte Aktion.");
}

// Entries of one record, newest first, and whether my timer runs here.
export function recordTime(user: Identity, page: Page, rowId: string, fieldId: string) {
  requireRow(user, page.id, rowId);
  const entries = all<Entry & { name: string }>(
    "SELECT e.*,u.name FROM time_entries e LEFT JOIN users u ON u.id=e.user_id WHERE e.row_id=? AND e.field_id=? ORDER BY e.start DESC LIMIT 200",
    rowId,
    fieldId,
  );
  const now = Date.now();
  return {
    total: entries.reduce((sum, e) => sum + seconds(e, now), 0),
    running: entries.find((e) => e.end === null && e.user_id === user.id)?.start ?? null,
    others: entries.filter((e) => e.end === null && e.user_id !== user.id).map((e) => e.name),
    entries: entries.map((e) => ({
      id: e.id,
      name: e.name || "",
      mine: e.user_id === user.id,
      start: e.start,
      end: e.end,
      seconds: seconds(e, now),
      note: e.note,
    })),
  };
}

// Hours per person and week (Monday) over the last weeks, for a database.
export function timeReport(user: Identity, pageId: string, weeks = 8) {
  const page = requirePage(user, pageId);
  const hidden = hiddenRowIds(user, page);
  const monday = (ms: number) => {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return d;
  };
  const first = monday(Date.now());
  first.setDate(first.getDate() - 7 * (weeks - 1));
  const entries = all<Entry & { name: string; cells: string }>(
    "SELECT e.*,u.name,r.cells FROM time_entries e JOIN rows r ON r.id=e.row_id LEFT JOIN users u ON u.id=e.user_id WHERE e.page_id=? AND e.start>=?",
    pageId,
    first.getTime(),
  ).filter((e) => !hidden.has(e.row_id));
  const fields = fieldsOf(pageId);
  const title = fields[0];
  const weekKeys = Array.from({ length: weeks }, (_, i) => {
    const d = new Date(first);
    d.setDate(d.getDate() + 7 * i);
    return localDay(d);
  });
  const people = new Map<string, { name: string; weeks: Record<string, number>; total: number }>();
  const records = new Map<string, { title: string; seconds: number; estimate: number | null }>();
  for (const e of entries) {
    const week = localDay(monday(e.start));
    const person = people.get(e.user_id) || { name: e.name || "?", weeks: {}, total: 0 };
    const s = seconds(e);
    person.weeks[week] = (person.weeks[week] || 0) + s;
    person.total += s;
    people.set(e.user_id, person);
    const cells = JSON.parse(e.cells);
    const field = fields.find((f) => f.id === e.field_id);
    const estimate = field?.estimateField ? Number(cells[field.estimateField]) : NaN;
    const record = records.get(e.row_id) || { title: cellText(cells[title?.id || "title"]), seconds: 0, estimate: Number.isFinite(estimate) ? estimate * 3600 : null };
    record.seconds += s;
    records.set(e.row_id, record);
  }
  return {
    weeks: weekKeys,
    people: [...people.values()].sort((a, b) => b.total - a.total),
    records: [...records.values()].sort((a, b) => b.seconds - a.seconds).slice(0, 50),
  };
}
