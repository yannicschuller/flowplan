// Meeting notes from an appointment of a journal day: a database record
// with a date (also one synced from Google or Microsoft 365, lib/calendar-
// sync.ts) or an event of the journal's ICS calendar. The note is a page
// below the journal (so a PIN on the journal covers it) built like the
// "Besprechungsnotiz" template: date, attendees – a mention for everyone
// whose e-mail belongs to a member –, agenda, notes and a task list. Tasks
// with @person there show up in "Meine Aufgaben" right away. The note is
// remembered per journal and appointment, so the day shows "Notiz öffnen"
// afterwards.
import { createHash } from "node:crypto";
import { z } from "zod";
import { Temporal } from "@js-temporal/polyfill";
import { all, one, run } from "./db";
import { HttpError } from "./auth";
import { pageRole, requirePage } from "./permissions";
import { requireRow } from "./row-documents";
import { requireUnlocked, type DayEvent } from "./journal-extras";
import { createPage } from "./seed";
import { escaped, htmlState } from "./document-server";
import { indexPageTasks } from "./doc-tasks";
import { syncedAttendees, type Attendee } from "./calendar-sync";
import { cellText } from "./cell-text";
import { visibleFields } from "./field-access";
import { contentLocale, ct } from "./content-locale";
import { localeTag } from "./i18n";
import { validZone } from "./date-values";
import { task, tasks } from "./template-catalog";
import type { Field, Identity, Page } from "./types";

// The appointment on a given day: records by id (a repeating record has a
// note per occurrence), calendar events by UID.
export function meetingEventKey(event: Pick<DayEvent, "rowId" | "uid" | "title" | "start">, date: string) {
  if (event.rowId) return `row:${event.rowId}@${date}`;
  const uid = event.uid || createHash("sha256").update(`${event.title}\u0000${event.start}`).digest("hex").slice(0, 32);
  return `ics:${uid.slice(0, 300)}@${date}`;
}

// The notes this person can open, for the appointments of a journal day.
export function withMeetingNotes<E extends DayEvent>(user: Identity, day: Pick<Page, "parent_id" | "journal_date">, events: E[]): (E & { noteId?: string })[] {
  if (!day.parent_id || !day.journal_date) return events;
  const notes = new Map(
    all<{ event_key: string; page_id: string }>("SELECT event_key,page_id FROM meeting_notes WHERE journal_id=?", day.parent_id).map((n) => [n.event_key, n.page_id]),
  );
  if (!notes.size) return events;
  return events.map((event) => {
    const noteId = notes.get(meetingEventKey(event, day.journal_date!));
    if (!noteId) return event;
    const page = one<Page>("SELECT * FROM pages WHERE id=? AND deleted_at IS NULL", noteId);
    return page && pageRole(user, page) ? { ...event, noteId } : event;
  });
}

const attendeeSchema = z.object({ email: z.string().max(254), name: z.string().max(200).default("") });
export const meetingNoteInput = z.object({
  pageId: z.uuid(),
  zone: z.string().max(100).optional(),
  event: z.object({
    title: z.string().max(500).default(""),
    start: z.string().max(40),
    end: z.string().max(40).default(""),
    timed: z.boolean().default(false),
    pageId: z.uuid().optional(),
    rowId: z.uuid().optional(),
    uid: z.string().max(500).optional(),
    attendees: z.array(attendeeSchema).max(200).optional(),
  }),
});

type Person = { userId?: string; name: string; email?: string };
function members(workspaceId: string) {
  return all<{ id: string; name: string; email: string }>(
    "SELECT u.id,u.name,u.email FROM members m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? AND u.disabled=0",
    workspaceId,
  );
}
// Attendees as people: members (by e-mail or id) become mentions.
function people(workspaceId: string, attendees: Attendee[], userIds: string[]): Person[] {
  const team = members(workspaceId);
  const byMail = new Map(team.filter((m) => m.email).map((m) => [m.email.toLowerCase(), m]));
  const out: Person[] = [];
  const seen = new Set<string>();
  for (const uid of userIds) {
    const member = team.find((m) => m.id === uid);
    if (member && !seen.has(member.id)) {
      seen.add(member.id);
      out.push({ userId: member.id, name: member.name });
    }
  }
  for (const a of attendees) {
    const email = a.email.trim().toLowerCase();
    if (!email) continue;
    const member = byMail.get(email);
    if (member) {
      if (seen.has(member.id)) continue;
      seen.add(member.id);
      out.push({ userId: member.id, name: member.name });
    } else if (!seen.has(email)) {
      seen.add(email);
      out.push({ name: a.name.trim(), email });
    }
  }
  return out.slice(0, 100);
}

// The date (and times) of the appointment as people read them.
function whenText(start: string, end: string, timed: boolean, date: string, zone: string) {
  const tag = localeTag(contentLocale());
  const day = new Intl.DateTimeFormat(tag, { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(`${date}T12:00:00Z`),
  );
  if (!timed) return day;
  try {
    const time = (value: string) =>
      new Intl.DateTimeFormat(tag, { hour: "2-digit", minute: "2-digit", timeZone: zone }).format(new Date(Temporal.Instant.from(value).epochMilliseconds));
    return `${day}, ${time(start)}${end ? `–${time(end)}` : ""}`;
  } catch {
    return day;
  }
}
export const noteTitle = (title: string, date: string) =>
  `${title || ct("Besprechung", "Meeting")} – ${new Intl.DateTimeFormat(localeTag(contentLocale()), { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`))}`;

// The note's content, in the sections of the "Besprechungsnotiz" template.
export function meetingNoteHtml(o: { when: string; attendees: Person[]; link?: { href: string; label: string } }) {
  const person = (p: Person) =>
    p.userId ? `<span data-mention="${escaped(p.userId)}" class="mention">@${escaped(p.name)}</span>` : escaped(p.name ? `${p.name} <${p.email}>` : p.email || "");
  const list = o.attendees.length ? `<ul>${o.attendees.map((p) => `<li><p>${person(p)}</p></li>`).join("")}</ul>` : "<ul><li><p></p></li></ul>";
  return (
    `<p><strong>${escaped(ct("Termin", "Date"))}:</strong> ${escaped(o.when)}${o.link ? ` · <a href="${escaped(o.link.href)}">${escaped(o.link.label)}</a>` : ""}</p>` +
    `<h2>${escaped(ct("Teilnehmende", "Attendees"))}</h2>${list}` +
    `<h2>${escaped(ct("Agenda", "Agenda"))}</h2><ol><li><p></p></li></ol>` +
    `<h2>${escaped(ct("Notizen", "Notes"))}</h2><p></p>` +
    `<h2>${escaped(ct("Aufgaben", "Tasks"))}</h2>${tasks(task(""))}`
  );
}

// Creates the note (or returns the one already there).
export function createMeetingNote(user: Identity, input: unknown) {
  const b = meetingNoteInput.parse(input);
  const day = requirePage(user, b.pageId);
  if (!day.journal_date || !day.parent_id) throw new HttpError(400, "Kein Journaltag.");
  const journal = requirePage(user, day.parent_id, true);
  requireUnlocked(user, journal);
  if (journal.locked) throw new HttpError(409, "Diese Seite ist gesperrt.");
  const date = day.journal_date;
  const zone = b.zone && validZone(b.zone) ? b.zone : "UTC";
  let { title, start, end, timed } = b.event;
  let attendees: Attendee[] = b.event.attendees || [];
  const userIds: string[] = [];
  let link: { href: string; label: string } | undefined;
  if (b.event.rowId) {
    // A record: what the server knows about it, not what the browser says.
    if (!b.event.pageId) throw new HttpError(400, "Datensatz nicht gefunden.");
    const { page, row } = requireRow(user, b.event.pageId, b.event.rowId);
    // Only properties the person may read.
    const declared = JSON.parse(one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", page.id)!.fields) as Field[];
    const fields = visibleFields(user, page, declared);
    const cells = JSON.parse(row.cells as unknown as string) as Record<string, unknown>;
    if (declared[0] && fields.includes(declared[0])) title = cellText(cells[declared[0].id]) || title;
    for (const f of fields.filter((f) => f.type === "person")) {
      const value = cells[f.id];
      for (const v of Array.isArray(value) ? value : [value]) if (typeof v === "string" && v) userIds.push(v);
    }
    attendees = syncedAttendees(row.id);
    link = { href: `/#page=${page.id}&row=${row.id}`, label: ct("Eintrag öffnen", "Open record") };
  }
  const key = meetingEventKey({ rowId: b.event.rowId, uid: b.event.uid, title, start }, date);
  const existing = one<{ page_id: string }>("SELECT page_id FROM meeting_notes WHERE journal_id=? AND event_key=?", journal.id, key);
  if (existing) {
    const page = one<Page>("SELECT * FROM pages WHERE id=? AND deleted_at IS NULL", existing.page_id);
    if (page && pageRole(user, page)) return { id: page.id, existing: true };
  }
  const html = meetingNoteHtml({ when: whenText(start, end, timed, date, zone), attendees: people(journal.workspace_id, attendees, userIds), link });
  const created = createPage(journal.workspace_id, journal.space_id, user.id, noteTitle(title, date).slice(0, 500), "document", journal.id);
  run("UPDATE pages SET icon=? WHERE id=?", "📝", created);
  run("UPDATE documents SET html=?,state=? WHERE page_id=?", html, htmlState(html), created);
  // Assigned tasks count for "Meine Aufgaben" without waiting for the first edit.
  indexPageTasks(created, false);
  run(
    "INSERT OR REPLACE INTO meeting_notes(journal_id,event_key,page_id,created_by,created_at) VALUES(?,?,?,?,?)",
    journal.id,
    key,
    created,
    user.id,
    Date.now(),
  );
  return { id: created, existing: false };
}
