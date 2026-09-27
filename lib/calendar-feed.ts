// Calendar subscriptions: a calendar view as an iCalendar feed for Apple,
// Google or Outlook calendars. Each person gets their own secret link per
// view (only its hash is stored); every request checks that the account is
// active and may still read the database, and shows only records visible
// to that person. Repeating entries become RRULE/EXDATE, so calendar apps
// show the series themselves.
import { createHash, randomBytes } from "node:crypto";
import { all, id, one, run } from "./db";
import { HttpError } from "./auth";
import { pageRole, requirePage } from "./permissions";
import { queryRows } from "./database";
import { calendarRange, calendarSchema } from "./database-calendar";
import { visibleRows } from "./row-access";
import { cellText } from "./cell-text";
import { parseRecurrence } from "./recurrence";
import type { Field, Identity, Page, Row, View } from "./types";

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const appUrl = () => (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");

function calendarView(pageId: string, viewId: string) {
  const db = one<{ fields: string; views: string }>(
    "SELECT fields,views FROM databases WHERE page_id=?",
    pageId,
  );
  if (!db) throw new HttpError(404, "Datenbank nicht gefunden.");
  const fields = JSON.parse(db.fields) as Field[];
  const view = (JSON.parse(db.views) as View[]).find((v) => v.id === viewId);
  if (!view || view.type !== "calendar")
    throw new HttpError(404, "Kalenderansicht nicht gefunden.");
  return { fields, view };
}

// A new secret link for this person and view; an older one stops working.
export function createCalendarFeed(user: Identity, pageId: string, viewId: string) {
  const page = requirePage(user, pageId);
  calendarView(page.id, viewId);
  const token = randomBytes(24).toString("base64url");
  run("DELETE FROM calendar_feeds WHERE user_id=? AND page_id=? AND view_id=?", user.id, page.id, viewId);
  run(
    "INSERT INTO calendar_feeds(id,user_id,page_id,view_id,token_hash,created_at) VALUES(?,?,?,?,?,?)",
    id(),
    user.id,
    page.id,
    viewId,
    hashToken(token),
    Date.now(),
  );
  return { url: `${appUrl()}/api/calendar/${token}.ics` };
}
export function revokeCalendarFeed(user: Identity, pageId: string, viewId: string) {
  run("DELETE FROM calendar_feeds WHERE user_id=? AND page_id=? AND view_id=?", user.id, pageId, viewId);
}
export function hasCalendarFeed(user: Identity, pageId: string, viewId: string) {
  return !!one("SELECT 1 FROM calendar_feeds WHERE user_id=? AND page_id=? AND view_id=?", user.id, pageId, viewId);
}

// RFC 5545 text: escape, then fold lines at 75 octets.
const text = (s: string) =>
  s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
function fold(line: string) {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let current = "";
  for (const char of line) {
    if (Buffer.byteLength(current + char, "utf8") > (parts.length ? 74 : 75)) {
      parts.push(current);
      current = "";
    }
    current += char;
  }
  parts.push(current);
  return parts.join("\r\n ");
}
const utc = (iso: string) =>
  new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const day = (date: string) => date.slice(0, 10).replace(/-/g, "");
function nextDay(date: string) {
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function calendarFeed(token: string) {
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(token)) throw new HttpError(404, "Unbekannter Kalender.");
  const feed = one<{ user_id: string; page_id: string; view_id: string }>(
    "SELECT user_id,page_id,view_id FROM calendar_feeds WHERE token_hash=?",
    hashToken(token),
  );
  if (!feed) throw new HttpError(404, "Unbekannter Kalender.");
  const account = one<Identity>(
    "SELECT * FROM users WHERE id=? AND disabled=0 AND demo_until IS NULL",
    feed.user_id,
  );
  if (!account) throw new HttpError(404, "Unbekannter Kalender.");
  const user = { ...account, groups: [], isAdmin: false } as Identity;
  const page = one<Page>("SELECT * FROM pages WHERE id=? AND deleted_at IS NULL", feed.page_id);
  if (!page || !pageRole(user, page)) throw new HttpError(404, "Unbekannter Kalender.");
  const { fields, view } = calendarView(page.id, feed.view_id);
  const zone = calendarSchema.safeParse(view.calendar).success
    ? (view.calendar as { timeZone: string }).timeZone
    : "UTC";
  const rows = all<Row & { cells: string }>("SELECT * FROM rows WHERE page_id=?", page.id).map(
    (r) => ({ ...r, cells: JSON.parse(r.cells as unknown as string) }) as Row,
  );
  const shown = queryRows(visibleRows(user, page, rows), fields, view);
  const titleField = fields[0];
  const host = new URL(appUrl()).host;
  const stamp = utc(new Date().toISOString());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Flowplan//Kalender//DE",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${text(`${page.title || "Kalender"} – ${view.name}`)}`,
    `X-WR-TIMEZONE:${zone}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT30M",
    "X-PUBLISHED-TTL:PT30M",
  ];
  for (const row of shown) {
    const range = calendarRange(row, fields, view, zone);
    if (!range) continue;
    const title = cellText(row.cells[titleField?.id || ""]) || "Ohne Titel";
    lines.push(
      "BEGIN:VEVENT",
      `UID:${row.id}@${host}`,
      `DTSTAMP:${stamp}`,
      `SUMMARY:${text(title)}`,
      `URL:${appUrl()}/#page=${page.id}&row=${row.id}`,
      `DESCRIPTION:${text(`${appUrl()}/#page=${page.id}&row=${row.id}`)}`,
    );
    if (range.timed)
      lines.push(`DTSTART:${utc(range.start)}`, `DTEND:${utc(range.end)}`);
    else
      lines.push(`DTSTART;VALUE=DATE:${day(range.start)}`, `DTEND;VALUE=DATE:${day(nextDay(range.end))}`);
    const rule = parseRecurrence((row as Row & { recurrence?: string }).recurrence);
    if (rule) {
      const parts = [`FREQ=${rule.freq.toUpperCase()}`, `INTERVAL=${rule.interval}`];
      if (rule.count) parts.push(`COUNT=${rule.count}`);
      if (rule.until) parts.push(`UNTIL=${day(rule.until)}${range.timed ? "T235959Z" : ""}`);
      lines.push(`RRULE:${parts.join(";")}`);
      for (const skipped of rule.exclude || [])
        lines.push(
          range.timed
            ? `EXDATE:${utc(`${skipped}${range.start.slice(10)}`)}`
            : `EXDATE;VALUE=DATE:${day(skipped)}`,
        );
    }
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
