// "An diesem Tag erledigt" (#169): the database records that became done on
// a journal day – and the document tasks ticked off that day (#208, from any
// page, the own task page of My tasks included; completedTasks below) – computed from the status log the sprint charts use
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
import { hiddenRowIds, visibleRows } from "./row-access";
import { databaseSettings } from "./database-settings";
import { doneRule, isDone } from "./database-settings-schema";
import { cellText } from "./cell-text";
import { Temporal, validZone } from "./date-values";
import type { Field, Identity, Page } from "./types";

export type CompletedRecord = {
  // A database record, or a task ticked off in a document (#208).
  kind?: "record" | "task";
  pageId: string;
  // A task in a page: "" (one in a record's document: the record).
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
  const locked = await lockedPageIds(user, workspaceId);
  const tasks = await completedTasks(user, workspaceId, start, end, locked, dayId);
  if (!entries.length && !tasks.length) return { items: [], more: 0, mine, all: 0 };
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
  for (const task of tasks) {
    everything++;
    if (mine && !task.mine) continue;
    items.push(task.item);
  }
  items.sort((a, b) => a.at - b.at);
  return { items: items.slice(0, COMPLETED_LIMIT), more: Math.max(0, items.length - COMPLETED_LIMIT), mine, all: everything };
}

// Tasks ticked off in documents that day (task_done_log, written by
// syncDocTasks in lib/doc-tasks.ts) – from any page the reader may open,
// the own task page of My tasks included – while they are still done.
// Mine: ticked off by the reader, or given to them. Tasks of the day page
// itself show in the day already; journals behind a PIN and encrypted
// spaces stay out, as do private records of others.
async function completedTasks(user: Identity, workspaceId: string, start: number, end: number, locked: Set<string>, dayId?: string) {
  const entries = await all<{ page_id: string; row_id: string; text: string; user_id: string | null; at: number }>(
    `SELECT l.page_id,l.row_id,l.text,l.user_id,l.at FROM task_done_log l JOIN pages p ON p.id=l.page_id
     WHERE l.workspace_id=? AND p.deleted_at IS NULL AND l.at>=? AND l.at<?
       AND EXISTS(SELECT 1 FROM doc_tasks t WHERE t.page_id=l.page_id AND t.row_id=l.row_id AND t.text=l.text AND t.checked=1 AND t.status IS NULL)
     ORDER BY l.at LIMIT 2000`,
    workspaceId,
    start,
    end,
  );
  // The latest time a task was ticked off counts (ticked, unticked, ticked).
  const latest = new Map<string, (typeof entries)[number]>();
  for (const e of entries) latest.set(`${e.page_id}\u0000${e.row_id}\u0000${e.text}`, e);
  const pages = new Map<string, (Page & { hidden: Set<string> }) | null>();
  const out: { item: CompletedRecord; mine: boolean }[] = [];
  for (const e of latest.values()) {
    if (locked.has(e.page_id) || e.page_id === dayId) continue;
    if (!pages.has(e.page_id)) {
      const page = await one<Page>("SELECT * FROM pages WHERE id=? AND deleted_at IS NULL", e.page_id);
      const readable = !!page && !!(await pageRole(user, page));
      pages.set(e.page_id, readable ? { ...page!, hidden: page!.kind === "database" ? await hiddenRowIds(user, page!) : new Set() } : null);
    }
    const page = pages.get(e.page_id);
    if (!page || (e.row_id && page.hidden.has(e.row_id))) continue;
    if (e.row_id && !(await one("SELECT 1 FROM rows WHERE id=? AND page_id=?", e.row_id, e.page_id))) continue;
    const assigned = !!(await one(
      "SELECT 1 FROM doc_tasks WHERE page_id=? AND row_id=? AND text=? AND assignee=?",
      e.page_id,
      e.row_id,
      e.text,
      user.id,
    ));
    out.push({
      mine: e.user_id === user.id || assigned,
      item: { kind: "task", pageId: e.page_id, rowId: e.row_id, title: e.text.slice(0, 200), database: page.title, icon: page.icon, at: Number(e.at) },
    });
  }
  return out;
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
