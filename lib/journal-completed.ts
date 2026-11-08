// "An diesem Tag erledigt" (#169): the database records that became done on
// a journal day, computed from the status log the sprint charts use
// (row_status_log, written by lib/automations.ts recordStatusChange) –
// nothing is copied into the day. A record counts on the day of its latest
// change to done, and only while it is still done by its database's done
// rule: ticking it off again takes it out of the list. Only records the
// reader may see: readable databases outside locked journals and encrypted
// spaces, no private records of others, no hidden title or status field.
import { all, one } from "./db";
import { HttpError } from "./auth";
import { pageRole, requirePage } from "./permissions";
import { journalSettings, lockedPageIds, requireUnlocked } from "./journal-extras";
import { dayOrDraft } from "./journal-days";
import { visibleRows } from "./row-access";
import { databaseSettings } from "./database-settings";
import { doneRule, isDone } from "./database-settings-schema";
import { cellText } from "./cell-text";
import { Temporal, validZone } from "./date-values";
import type { Field, Identity, Page } from "./types";

export type CompletedRecord = {
  pageId: string;
  rowId: string;
  // "" when the record has no title (the client says "Ohne Titel").
  title: string;
  database: string;
  icon: string;
  at: number;
};
export const COMPLETED_LIMIT = 100;

// Start and end (exclusive) of a calendar day in a time zone, in ms.
export function dayBounds(date: string, zone: string) {
  const day = Temporal.PlainDate.from(date);
  return {
    start: day.toZonedDateTime({ timeZone: zone }).epochMilliseconds,
    end: day.add({ days: 1 }).toZonedDateTime({ timeZone: zone }).epochMilliseconds,
  };
}

// `dayId`: databases placed on the day page itself show there already.
export async function completedOn(user: Identity, workspaceId: string, date: string, zone: string, dayId?: string) {
  if (!validZone(zone)) zone = "UTC";
  const { start, end } = dayBounds(date, zone);
  // The latest change of each record, when it is a change to done on this day.
  const entries = await all<{ page_id: string; row_id: string; at: number }>(
    `SELECT l.page_id,l.row_id,l.at FROM row_status_log l JOIN pages p ON p.id=l.page_id
     WHERE p.workspace_id=? AND p.deleted_at IS NULL AND l.done=1 AND l.at>=? AND l.at<?
       AND NOT EXISTS(SELECT 1 FROM row_status_log n WHERE n.page_id=l.page_id AND n.row_id=l.row_id AND n.at>l.at)
     ORDER BY l.at LIMIT 2000`,
    workspaceId,
    start,
    end,
  );
  if (!entries.length) return { items: [] as CompletedRecord[], more: 0 };
  const locked = await lockedPageIds(user, workspaceId);
  const byPage = new Map<string, Map<string, number>>();
  for (const e of entries) {
    const rows = byPage.get(e.page_id) || new Map<string, number>();
    rows.set(e.row_id, Math.max(rows.get(e.row_id) || 0, Number(e.at)));
    byPage.set(e.page_id, rows);
  }
  const items: CompletedRecord[] = [];
  for (const [pageId, times] of byPage) {
    if (locked.has(pageId)) continue;
    const page = await one<Page & { fields: string }>(
      "SELECT p.*,d.fields FROM pages p JOIN databases d ON d.page_id=p.id WHERE p.id=? AND p.deleted_at IS NULL",
      pageId,
    );
    if (!page || (dayId && page.parent_id === dayId) || !(await pageRole(user, page))) continue;
    const fields = JSON.parse(page.fields) as Field[];
    const rule = doneRule(fields, await databaseSettings(pageId));
    if (!rule) continue;
    const ids = [...times.keys()];
    const rows = (await all<{ id: string; cells: string; access: string; created_by: string | null }>(
      `SELECT id,cells,access,created_by FROM rows WHERE page_id=? AND id IN (${ids.map(() => "?").join(",")})`,
      pageId,
      ...ids,
    )).map((r) => ({ ...r, cells: JSON.parse(r.cells) as Record<string, unknown> }));
    // Hidden fields are stripped: a status the reader may not see is not done for them.
    for (const row of await visibleRows(user, page, rows)) {
      if (!isDone(rule, row.cells)) continue;
      items.push({
        pageId,
        rowId: row.id,
        title: cellText(row.cells[fields[0]?.id || ""]).slice(0, 200),
        database: page.title,
        icon: page.icon,
        at: times.get(row.id)!,
      });
    }
  }
  items.sort((a, b) => a.at - b.at);
  return { items: items.slice(0, COMPLETED_LIMIT), more: Math.max(0, items.length - COMPLETED_LIMIT) };
}

// GET /api/journals/<day>/completed: a stored day or today's draft
// (lib/journal-days.ts), empty when the journal switched the list off.
export async function journalDayCompleted(user: Identity, pageId: string, zone: string) {
  const draft = await dayOrDraft(user, pageId);
  let journalId: string, workspaceId: string, date: string, dayId: string | undefined;
  if (draft) {
    await requireUnlocked(user, draft.journal);
    [journalId, workspaceId, date] = [draft.journal.id, draft.journal.workspace_id, draft.date];
  } else {
    const day = await requirePage(user, pageId);
    if (!day.journal_date || !day.parent_id) throw new HttpError(400, "Kein Journaltag.");
    await requireUnlocked(user, day);
    [journalId, workspaceId, date, dayId] = [day.parent_id, day.workspace_id, day.journal_date, day.id];
  }
  if (!(await journalSettings(journalId)).options.completed) return { items: [] as CompletedRecord[], more: 0 };
  return await completedOn(user, workspaceId, date, zone, dayId);
}
