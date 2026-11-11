// The reminder when a meeting starts (#199): a meeting block linked to a
// calendar event (the block's event picker, or the journal's meeting note
// for an appointment) reminds the person who linked it when the event
// starts – a few minutes before a timed event (5, one of the date
// reminders' offsets), at 09:00 on the day of an all-day one
// (lib/date-reminder-options.ts reminderTarget). The notification is a
// "reminder" (inbox, push, e-mail and chat apps as the person set it up for
// date reminders) and opens the page at the block.
//
//   meeting_reminders(meeting_id, user_id, page_id, row_id, event_key, title, remind_at, fired_at)
//
// One per block: linking another event replaces it. fired_at makes it fire
// once per event occurrence (the key carries the date). Before it fires the
// worker checks again that the block is still there with that event, that
// the person may still read the page (and the record) and that the account
// is active; a journal behind a PIN gets the general notice only (the push
// and the inbox hide the text while it is locked). Paused with the other
// workers while the instance moves or is read-only.
import { z } from "zod";
import * as Y from "yjs";
import { Node as PMNode } from "@tiptap/pm/model";
import { yDocToProsemirrorJSON } from "y-prosemirror";
import { all, id as newId, one, run, transaction } from "./db";
import { HttpError } from "./auth";
import { pageRole, requirePage } from "./permissions";
import { requireRow } from "./row-documents";
import { rowRole } from "./row-access";
import { requireUnlocked } from "./journal-extras";
import { htmlState } from "./document-server";
import { rewriteSchema } from "./document-rewrite";
import { validBlockId } from "./block-ids";
import { reminderTarget } from "./date-reminder-options";
import { validZone } from "./date-values";
import { isLeader } from "./cluster/leader";
import { workersPaused } from "./instance-read-only";
import type { Identity, Page } from "./types";

// Minutes before a timed event (one of the date reminders' offsets).
export const MEETING_REMINDER_MINUTES = 5;
// A reminder whose moment passed longer ago than this (server down) is
// not sent any more: the meeting is over.
const STALE_MS = 2 * 60 * 60_000;

// When the reminder is due, or null for a start the server cannot read.
export function meetingReminderAt(start: string, timed: boolean, zone: string) {
  const tz = validZone(zone) ? zone : "UTC";
  const target = reminderTarget(start, timed ? MEETING_REMINDER_MINUTES : 0, tz);
  if (target) return target.epochMilliseconds;
  const parsed = Date.parse(start);
  return Number.isFinite(parsed) ? parsed - (timed ? MEETING_REMINDER_MINUTES * 60_000 : 0) : null;
}

// Stores (or replaces) the block's reminder for `user`.
export async function setMeetingReminder(
  user: Pick<Identity, "id">,
  input: { meetingId: string; pageId: string; rowId: string | null; eventKey: string; title: string; start: string; timed: boolean; zone: string },
) {
  const at = meetingReminderAt(input.start, input.timed, input.zone);
  if (at === null) return null;
  await run(
    `INSERT INTO meeting_reminders(meeting_id,user_id,page_id,row_id,event_key,title,remind_at,fired_at,created_at) VALUES(?,?,?,?,?,?,?,NULL,?)
     ON CONFLICT(meeting_id) DO UPDATE SET user_id=excluded.user_id,page_id=excluded.page_id,row_id=excluded.row_id,title=excluded.title,remind_at=excluded.remind_at,
       fired_at=CASE WHEN meeting_reminders.event_key=excluded.event_key AND meeting_reminders.remind_at=excluded.remind_at THEN meeting_reminders.fired_at ELSE NULL END,
       event_key=excluded.event_key`,
    input.meetingId,
    user.id,
    input.pageId,
    input.rowId,
    input.eventKey.slice(0, 600),
    input.title.slice(0, 300),
    at,
    Date.now(),
  );
  return at;
}

const linkInput = z.object({
  pageId: z.uuid(),
  rowId: z.uuid().nullable().optional(),
  // null: the block has no event any more.
  event: z.string().min(1).max(600).nullable(),
  title: z.string().max(300).default(""),
  start: z.string().max(40).default(""),
  timed: z.boolean().default(false),
  zone: z.string().max(100).default("UTC"),
});
// The block's event picker (POST /api/meetings/{id}/event): the person who
// links the event is reminded. Needs edit rights on the page, like the link.
export async function linkMeetingEvent(user: Identity, meetingId: string, raw: unknown) {
  if (user.demo || user.apiScope) throw new HttpError(403, "Hier nicht verfügbar.");
  const id = z.uuid().parse(meetingId);
  const b = linkInput.parse(raw);
  const rowId = b.rowId || null;
  const page = rowId ? (await requireRow(user, b.pageId, rowId, true)).page : await requirePage(user, b.pageId, true);
  await requireUnlocked(user, page);
  const existing = await one<{ page_id: string; row_id: string | null }>("SELECT page_id,row_id FROM meeting_reminders WHERE meeting_id=?", id);
  // A block id belongs to one page (a copy gets its own in the editor).
  if (existing && (existing.page_id !== page.id || (existing.row_id || null) !== rowId)) throw new HttpError(409, "Dieser Besprechungsblock ist eine Kopie und bekommt eine eigene Aufnahme.");
  if (!b.event || !b.start) {
    await run("DELETE FROM meeting_reminders WHERE meeting_id=?", id);
    return { reminder: null };
  }
  const at = await setMeetingReminder(user, { meetingId: id, pageId: page.id, rowId, eventKey: b.event, title: b.title, start: b.start, timed: b.timed, zone: b.zone });
  return { reminder: at };
}

type Due = { meeting_id: string; user_id: string; page_id: string; row_id: string | null; event_key: string; title: string; remind_at: number; disabled: number };

// The meeting block in the stored document (page or record), or null.
async function storedMeeting(pageId: string, rowId: string | null, meetingId: string) {
  const stored = rowId
    ? await one<{ state: Uint8Array | null; html: string }>("SELECT state,html FROM row_documents WHERE row_id=?", rowId)
    : await one<{ state: Uint8Array | null; html: string }>("SELECT state,html FROM documents WHERE page_id=?", pageId);
  if (!stored) return null;
  const ydoc = new Y.Doc();
  try {
    Y.applyUpdate(ydoc, stored.state || htmlState(stored.html));
    let found: PMNode | null = null;
    PMNode.fromJSON(rewriteSchema(), yDocToProsemirrorJSON(ydoc, "default")).descendants((node) => {
      if (found) return false;
      if (node.type.name === "meeting" && node.attrs.meetingId === meetingId) found = node;
      return !found;
    });
    return found as PMNode | null;
  } finally {
    ydoc.destroy();
  }
}

export async function processMeetingReminders(now = Date.now()) {
  let fired = 0;
  const due = await all<Due>(
    `SELECT r.*,u.disabled FROM meeting_reminders r JOIN users u ON u.id=r.user_id
     WHERE r.fired_at IS NULL AND r.remind_at<=? ORDER BY r.remind_at LIMIT 500`,
    now,
  );
  for (const reminder of due) {
    // Too late (the server was down): dropped without a message.
    if (reminder.remind_at < now - STALE_MS) {
      await run("UPDATE meeting_reminders SET fired_at=? WHERE meeting_id=? AND fired_at IS NULL", now, reminder.meeting_id);
      continue;
    }
    if (reminder.disabled) continue;
    const page = await one<Page>("SELECT * FROM pages WHERE id=? AND deleted_at IS NULL", reminder.page_id);
    const person = { id: reminder.user_id } as Identity;
    // Missing access keeps the reminder; it may fire after access returns.
    if (!page || !(await pageRole(person, page))) continue;
    if (reminder.row_id) {
      const row = await one<{ id: string; access: string; created_by: string }>("SELECT id,access,created_by FROM rows WHERE id=? AND page_id=?", reminder.row_id, page.id);
      if (!row || !(await rowRole(person, page, row))) continue;
    }
    // The block removed, or linked to another event since: no reminder.
    const block = await storedMeeting(page.id, reminder.row_id, reminder.meeting_id);
    if (!block || String(block.attrs.event || "") !== reminder.event_key) {
      await run("DELETE FROM meeting_reminders WHERE meeting_id=? AND event_key=?", reminder.meeting_id, reminder.event_key);
      continue;
    }
    const title = String(block.attrs.title || reminder.title || "").trim().slice(0, 200) || "Besprechung";
    const blockId = validBlockId(block.attrs.blockId);
    await transaction(async () => {
      // Once per event occurrence, also with two workers at once.
      if (!(await run("UPDATE meeting_reminders SET fired_at=? WHERE meeting_id=? AND event_key=? AND fired_at IS NULL", now, reminder.meeting_id, reminder.event_key)).changes) return;
      await run(
        "INSERT INTO notifications(id,user_id,body,page_id,row_id,kind,link) VALUES(?,?,?,?,?,'reminder',?)",
        newId(),
        reminder.user_id,
        `Die Besprechung „${title}“ beginnt gleich.`,
        page.id,
        reminder.row_id,
        blockId ? `block:${blockId}` : null,
      );
      fired++;
    });
  }
  return fired;
}

const runtime = globalThis as typeof globalThis & { flowplanMeetingReminderTimer?: ReturnType<typeof setInterval> };
export function startMeetingReminderWorker(onFired: () => void) {
  if (runtime.flowplanMeetingReminderTimer) return;
  const tick = async () => {
    // Cluster mode: the leader only; nothing while the instance moves.
    if (!isLeader() || (await workersPaused())) return;
    try {
      if (await processMeetingReminders()) onFired();
    } catch (error) {
      console.error("Besprechungserinnerungen fehlgeschlagen", error);
    }
  };
  runtime.flowplanMeetingReminderTimer = setInterval(() => void tick(), 30_000);
  runtime.flowplanMeetingReminderTimer.unref();
  void tick();
}
