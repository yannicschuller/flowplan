// "An diesem Tag erledigt" (#169): the database records that became done on
// a journal day, computed from the status log the sprint charts use
// (row_status_log, written by lib/automations.ts recordStatusChange) –
// nothing is copied into the day. A record counts on the day of its latest
// change to done, and only while it is still done by its database's done
// rule: ticking it off again takes it out of the list. Only records the
// reader may see: readable databases outside locked journals and encrypted
// spaces, no private records of others, no hidden title or status field.
//
// "Nur meine" (the default) narrows the list to the reader's records: those
// they made done themselves (row_status_log.user_id, schema 96; an
// automation counts for the person who set it up) and those a person
// property assigns to them, whoever ticked them off. Entries from before
// schema 96 have no user and count as the reader's only by the assignment.
// The choice is the reader's per journal (page_view_prefs.completed_mine).
import { z } from "zod";
import { all, one, run } from "./db";
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
export type CompletedList = {
  items: CompletedRecord[];
  // How many beyond the first COMPLETED_LIMIT of the list.
  more: number;
  // Whether the list is "Nur meine"; `all`: how many "Alle" would list.
  mine: boolean;
  all: number;
};
export const COMPLETED_LIMIT = 100;

// A record the reader made done, or one a person property assigns to them.
function isMine(user: Identity, by: string | null, fields: Field[], cells: Record<string, unknown>) {
  if (by && by === user.id) return true;
  return fields.some((f) => {
    if (f.type !== "person") return false;
    const value = cells[f.id];
    return value === user.id || (Array.isArray(value) && value.includes(user.id));
  });
}

// Start and end (exclusive) of a calendar day in a time zone, in ms.
export function dayBounds(date: string, zone: string) {
  const day = Temporal.PlainDate.from(date);
  return {
    start: day.toZonedDateTime({ timeZone: zone }).epochMilliseconds,
    end: day.add({ days: 1 }).toZonedDateTime({ timeZone: zone }).epochMilliseconds,
  };
}

// `dayId`: databases placed on the day page itself show there already.
// `mine`: only the reader's records (see above); everything they may see
// otherwise.
export async function completedOn(
  user: Identity,
  workspaceId: string,
  date: string,
  zone: string,
  options: { dayId?: string; mine?: boolean } = {},
): Promise<CompletedList> {
  const { dayId } = options;
  const mine = !!options.mine;
  if (!validZone(zone)) zone = "UTC";
  const { start, end } = dayBounds(date, zone);
  // The latest change of each record, when it is a change to done on this day.
  const entries = await all<{ page_id: string; row_id: string; at: number; user_id: string | null }>(
    `SELECT l.page_id,l.row_id,l.at,l.user_id FROM row_status_log l JOIN pages p ON p.id=l.page_id
     WHERE p.workspace_id=? AND p.deleted_at IS NULL AND l.done=1 AND l.at>=? AND l.at<?
       AND NOT EXISTS(SELECT 1 FROM row_status_log n WHERE n.page_id=l.page_id AND n.row_id=l.row_id AND n.at>l.at)
     ORDER BY l.at LIMIT 2000`,
    workspaceId,
    start,
    end,
  );
  if (!entries.length) return { items: [], more: 0, mine, all: 0 };
  const locked = await lockedPageIds(user, workspaceId);
  const byPage = new Map<string, Map<string, { at: number; by: string | null }>>();
  for (const e of entries) {
    const rows = byPage.get(e.page_id) || new Map<string, { at: number; by: string | null }>();
    // Two changes in the same millisecond: the one written last counts.
    if (Number(e.at) >= (rows.get(e.row_id)?.at || 0)) rows.set(e.row_id, { at: Number(e.at), by: e.user_id ?? null });
    byPage.set(e.page_id, rows);
  }
  const items: CompletedRecord[] = [];
  let everything = 0;
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
      everything++;
      // Visible cells only: a hidden person property assigns nobody here.
      if (mine && !isMine(user, times.get(row.id)!.by, fields, row.cells)) continue;
      items.push({
        pageId,
        rowId: row.id,
        title: cellText(row.cells[fields[0]?.id || ""]).slice(0, 200),
        database: page.title,
        icon: page.icon,
        at: times.get(row.id)!.at,
      });
    }
  }
  items.sort((a, b) => a.at - b.at);
  return { items: items.slice(0, COMPLETED_LIMIT), more: Math.max(0, items.length - COMPLETED_LIMIT), mine, all: everything };
}

// The reader's choice "Alle / Nur meine" for a journal (null: never chosen).
export async function completedMineChoice(user: Pick<Identity, "id">, journalId: string): Promise<boolean | null> {
  const row = await one<{ completed_mine: number | null }>(
    "SELECT completed_mine FROM page_view_prefs WHERE user_id=? AND page_id=?",
    user.id,
    journalId,
  );
  return row && row.completed_mine !== null && row.completed_mine !== undefined ? Number(row.completed_mine) === 1 : null;
}

const choiceInput = z.object({ pageId: z.uuid(), mine: z.boolean() });

// The command `journal.completedMine`: { pageId (the journal), mine }. Like
// the property bar (lib/page-view-prefs.ts) a way of looking: anyone who may
// open the journal may choose, for themselves, on all their devices.
export async function setCompletedMine(user: Identity, body: unknown) {
  const b = choiceInput.parse(body);
  const journal = await requirePage(user, b.pageId);
  if (journal.kind !== "journal") throw new HttpError(400, "Kein Journal.");
  await run(
    `INSERT INTO page_view_prefs(user_id,page_id,completed_mine,updated_at) VALUES(?,?,?,?)
     ON CONFLICT(user_id,page_id) DO UPDATE SET completed_mine=excluded.completed_mine,updated_at=excluded.updated_at`,
    user.id,
    journal.id,
    b.mine ? 1 : 0,
    Date.now(),
  );
  return { mine: b.mine };
}

// GET /api/journals/<day>/completed: a stored day or today's draft
// (lib/journal-days.ts), empty when the journal switched the list off.
// `mine` undefined: the reader's choice for the journal, "Nur meine" when
// they never chose.
export async function journalDayCompleted(user: Identity, pageId: string, zone: string, mine?: boolean): Promise<CompletedList> {
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
  const only = mine ?? (await completedMineChoice(user, journalId)) ?? true;
  if (!(await journalSettings(journalId)).options.completed) return { items: [], more: 0, mine: only, all: 0 };
  return await completedOn(user, workspaceId, date, zone, { dayId, mine: only });
}
