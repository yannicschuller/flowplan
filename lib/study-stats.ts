// Flashcards across decks (docs/specs/flashcards.md §10.1, §11): what is due
// in all decks of a person (the screen #study, the start page's widget
// "Fällige Karten", MCP), their statistics, and the journal's line
// "32 Karten gelernt in Spanisch A1".
//
// - Due counts come from a few grouped queries over all decks at once
//   (card_states_user_due, study_cards, review_log_user_day) – never from a
//   queue per deck. They follow the daily limits and the person's own
//   settings, leave out private records of others and decks with a side
//   the person may not see; they do not apply a view's filters (a sub-deck)
//   or the burying of siblings, so a session may show a few cards less.
// - Statistics are the person's own only: review_log and card_states are
//   always read with `user_id = the person` (§13.3). Days are study days
//   (review_log.day, 04:00 local); the journal uses the calendar day
//   instead (§11.2, decided: calendar day).
// - SQL stays portable (SQLite and PostgreSQL): COUNT/SUM(CASE …), no
//   FILTER, numbers read through Number().
import { z } from "zod";
import { all, one } from "./db";
import { HttpError } from "./auth";
import { pageRole, requirePage } from "./permissions";
import { lockedPageIds, requireUnlocked } from "./journal-extras";
import { databaseSettings } from "./database-settings";
import { hiddenFieldsFor } from "./field-access";
import { hiddenRowIds } from "./row-access";
import { drainStudyCards } from "./study";
import { studyFieldIds } from "./study-content";
import { DEFAULT_DAY_START, addDays, studyClock, studyZone } from "./study-day";
import { STUDY_DEFAULTS, type StudySettings } from "./study-schema";
import { personalWeights } from "./study-params";
import type { Field, Identity, Page } from "./types";

const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(",");
const chunks = <T>(list: T[], size: number) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, i * size + size));
type Deck = { page: Page; settings: StudySettings; hidden: Set<string> };

// The zone of the request, else the one the person's study settings
// remember, else UTC; and their day start.
async function clockOf(user: Identity, zone: unknown) {
  const prefs = await one<{ time_zone: string | null; day_start: number | null }>("SELECT time_zone,day_start FROM study_prefs WHERE user_id=? AND page_id=''", user.id);
  return { zone: studyZone(zone, prefs?.time_zone), dayStart: prefs?.day_start ?? DEFAULT_DAY_START };
}

// The decks of a workspace the person may study now: readable databases
// with a card mapping, outside journals behind a PIN, without a side the
// person may not see.
export async function readableDecks(user: Identity, workspaceId: string, only?: string[]): Promise<Deck[]> {
  const pages = await all<{ id: string }>(
    "SELECT p.id FROM pages p JOIN databases d ON d.page_id=p.id WHERE p.workspace_id=? AND p.deleted_at IS NULL AND p.kind='database' AND d.settings LIKE ? ORDER BY p.title,p.id LIMIT 500",
    workspaceId,
    '%"study"%',
  );
  const locked = await lockedPageIds(user, workspaceId);
  const out: Deck[] = [];
  for (const { id } of pages) {
    if (locked.has(id) || (only && !only.includes(id))) continue;
    let page: Page;
    try {
      page = await requirePage(user, id);
      await requireUnlocked(user, page);
    } catch (error) {
      if (error instanceof HttpError) continue;
      throw error;
    }
    const settings = (await databaseSettings(id)).study;
    if (!settings) continue;
    const raw = await one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", id);
    const fields = JSON.parse(raw?.fields || "[]") as Field[];
    const hiddenFields = await hiddenFieldsFor(user, page, fields);
    if (studyFieldIds(settings).some((f) => hiddenFields.has(f) || !fields.some((x) => x.id === f))) continue;
    out.push({ page, settings, hidden: await hiddenRowIds(user, page) });
  }
  // Records changed since the index was read last.
  const ids = out.map((d) => d.page.id);
  for (const part of chunks(ids, 400)) {
    if (!part.length) continue;
    for (const d of await all<{ page_id: string }>(`SELECT DISTINCT page_id FROM study_dirty WHERE page_id IN (${placeholders(part.length)})`, ...part)) await drainStudyCards(d.page_id);
  }
  return out;
}

// Counts per deck of cards in records the person may not see (private
// records of others), to take off the totals.
async function hiddenCounts(user: Identity, decks: Deck[], dayEnd: number) {
  const out = new Map<string, { new: number; learning: number; review: number; total: number }>();
  for (const deck of decks) {
    const ids = [...deck.hidden];
    if (!ids.length) continue;
    const sum = { new: 0, learning: 0, review: 0, total: 0 };
    for (const part of chunks(ids, 400)) {
      const rows = await all<{ state: number | null; due: number | null; suspended: number | null; orphaned_at: number | null }>(
        `SELECT s.state,s.due,s.suspended,s.orphaned_at FROM study_cards c LEFT JOIN card_states s ON s.user_id=? AND s.row_id=c.row_id AND s.sub=c.sub
          WHERE c.page_id=? AND c.row_id IN (${placeholders(part.length)})`,
        user.id,
        deck.page.id,
        ...part,
      );
      for (const r of rows) {
        sum.total++;
        if (r.state === null || r.state === undefined) sum.new++;
        else if (!Number(r.suspended) && r.orphaned_at === null && Number(r.due) < dayEnd) sum[Number(r.state) === 2 ? "review" : "learning"]++;
      }
    }
    out.set(deck.page.id, sum);
  }
  return out;
}

export type DueDeck = { pageId: string; title: string; icon: string; new: number; learning: number; review: number; total: number };
const dueInput = z.object({ workspaceId: z.uuid(), zone: z.string().max(100).optional(), pageIds: z.array(z.uuid()).max(50).optional() });

// What is left today in each deck of a workspace, within the limits.
export async function studyDue(user: Identity, raw: unknown) {
  const input = dueInput.parse(raw);
  const clock = await clockOf(user, input.zone);
  const now = Date.now();
  const today = studyClock(now, clock.zone, clock.dayStart);
  const decks = await readableDecks(user, input.workspaceId, input.pageIds);
  const ids = decks.map((d) => d.page.id);
  const counts = new Map<string, { new: number; learning: number; review: number; total: number; doneNew: number; doneReview: number }>();
  const entry = (id: string) => {
    if (!counts.has(id)) counts.set(id, { new: 0, learning: 0, review: 0, total: 0, doneNew: 0, doneReview: 0 });
    return counts.get(id)!;
  };
  for (const part of chunks(ids, 400)) {
    if (!part.length) continue;
    const list = placeholders(part.length);
    for (const r of await all<{ page_id: string; state: number; n: number }>(
      `SELECT s.page_id,s.state,COUNT(*) n FROM card_states s JOIN study_cards c ON c.page_id=s.page_id AND c.row_id=s.row_id AND c.sub=s.sub
        WHERE s.user_id=? AND s.page_id IN (${list}) AND s.suspended=0 AND s.orphaned_at IS NULL AND s.due<? GROUP BY s.page_id,s.state`,
      user.id,
      ...part,
      today.end,
    ))
      entry(r.page_id)[Number(r.state) === 2 ? "review" : "learning"] += Number(r.n);
    for (const r of await all<{ page_id: string; total: number; fresh: number }>(
      `SELECT c.page_id,COUNT(*) total,SUM(CASE WHEN NOT EXISTS(SELECT 1 FROM card_states s WHERE s.user_id=? AND s.row_id=c.row_id AND s.sub=c.sub) THEN 1 ELSE 0 END) fresh
         FROM study_cards c WHERE c.page_id IN (${list}) GROUP BY c.page_id`,
      user.id,
      ...part,
    )) {
      const e = entry(r.page_id);
      e.total = Number(r.total);
      e.new = Number(r.fresh || 0);
    }
    for (const r of await all<{ page_id: string; fresh: number; reviewed: number }>(
      `SELECT page_id,SUM(CASE WHEN state_before=0 THEN 1 ELSE 0 END) fresh,SUM(CASE WHEN state_before=2 THEN 1 ELSE 0 END) reviewed
         FROM review_log WHERE user_id=? AND day=? AND undone_at IS NULL AND page_id IN (${list}) GROUP BY page_id`,
      user.id,
      today.day,
      ...part,
    )) {
      const e = entry(r.page_id);
      e.doneNew = Number(r.fresh || 0);
      e.doneReview = Number(r.reviewed || 0);
    }
  }
  const hidden = await hiddenCounts(user, decks, today.end);
  const prefs = new Map(
    (await all<{ page_id: string; new_per_day: number | null; reviews_per_day: number | null; extra: string }>("SELECT page_id,new_per_day,reviews_per_day,extra FROM study_prefs WHERE user_id=? AND page_id<>''", user.id)).map((p) => [p.page_id, p]),
  );
  const out: DueDeck[] = decks.map((deck) => {
    const c = entry(deck.page.id);
    const h = hidden.get(deck.page.id);
    const own = prefs.get(deck.page.id);
    let more: { new?: number; review?: number } = {};
    try {
      more = (JSON.parse(own?.extra || "{}") as Record<string, { new?: number; review?: number }>)[today.day] || {};
    } catch {
      more = {};
    }
    const limitNew = (own?.new_per_day ?? deck.settings.newPerDay ?? STUDY_DEFAULTS.newPerDay) + (more.new || 0);
    const limitReview = (own?.reviews_per_day ?? deck.settings.reviewsPerDay ?? STUDY_DEFAULTS.reviewsPerDay) + (more.review || 0);
    const fresh = Math.max(0, c.new - (h?.new || 0)),
      review = Math.max(0, c.review - (h?.review || 0));
    return {
      pageId: deck.page.id,
      title: deck.page.title,
      icon: deck.page.icon,
      new: Math.min(fresh, Math.max(0, limitNew - c.doneNew)),
      learning: Math.max(0, c.learning - (h?.learning || 0)),
      review: Math.min(review, Math.max(0, limitReview - c.doneReview)),
      total: Math.max(0, c.total - (h?.total || 0)),
    };
  });
  out.sort((a, b) => b.review + b.learning + b.new - (a.review + a.learning + a.new) || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
  // The daily reminder (lib/study-reminders.ts), a setting of the person.
  const reminder = (await one<{ remind_at: string | null }>("SELECT remind_at FROM study_prefs WHERE user_id=? AND page_id=''", user.id))?.remind_at ?? null;
  return { day: today.day, zone: clock.zone, decks: out, streak: await streakOf(user, input.workspaceId, today.day), reminder };
}

// What is due in every workspace of the person (the app's summary and
// widget, the study reminder – lib/study-reminders.ts): the decks of all
// workspaces with their counts, the totals and the streak across them.
// `only`: these decks only (the app widget's choice).
export type DueEverywhere = { day: string; zone: string; decks: (DueDeck & { workspaceId: string })[]; due: number; new: number; streak: number; remindAt: string | null };
export async function studyDueEverywhere(user: Identity, zone?: string, only?: string[]): Promise<DueEverywhere> {
  const clock = await clockOf(user, zone);
  const today = studyClock(Date.now(), clock.zone, clock.dayStart);
  const workspaces = await all<{ workspace_id: string }>("SELECT workspace_id FROM members WHERE user_id=? ORDER BY workspace_id", user.id);
  const decks: (DueDeck & { workspaceId: string })[] = [];
  for (const { workspace_id } of workspaces) {
    const has = await one(
      "SELECT 1 FROM pages p JOIN databases d ON d.page_id=p.id WHERE p.workspace_id=? AND p.deleted_at IS NULL AND p.kind='database' AND d.settings LIKE ? LIMIT 1",
      workspace_id,
      '%"study"%',
    );
    if (!has) continue;
    const due = await studyDue(user, { workspaceId: workspace_id, zone: clock.zone, ...(only?.length ? { pageIds: only.slice(0, 50) } : {}) });
    decks.push(...due.decks.filter((d) => d.total > 0).map((d) => ({ ...d, workspaceId: workspace_id })));
  }
  decks.sort((a, b) => b.review + b.learning + b.new - (a.review + a.learning + a.new) || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
  return {
    day: today.day,
    zone: clock.zone,
    decks,
    due: decks.reduce((sum, d) => sum + d.new + d.learning + d.review, 0),
    new: decks.reduce((sum, d) => sum + d.new, 0),
    streak: decks.length ? await streakOf(user, null, today.day) : 0,
    remindAt: (await one<{ remind_at: string | null }>("SELECT remind_at FROM study_prefs WHERE user_id=? AND page_id=''", user.id))?.remind_at ?? null,
  };
}

// The decks for MCP (study_decks).
export async function studyDecks(user: Identity, workspaceId: string, zone?: string) {
  return (await studyDue(user, { workspaceId, zone })).decks.map(({ icon: _icon, ...d }) => d);
}

// Consecutive study days with a rating up to today – today counts once
// studied; studied yesterday but not yet today keeps the streak.
// Without a workspace: across all of the person's workspaces.
async function streakOf(user: Identity, workspaceId: string | null, today: string, pageId?: string) {
  const days = new Set(
    (
      await all<{ day: string }>(
        `SELECT DISTINCT day FROM review_log WHERE user_id=?${workspaceId ? " AND workspace_id=?" : ""} AND undone_at IS NULL AND day>=?${pageId ? " AND page_id=?" : ""}`,
        user.id,
        ...(workspaceId ? [workspaceId] : []),
        addDays(today, -800),
        ...(pageId ? [pageId] : []),
      )
    ).map((d) => d.day),
  );
  let day = days.has(today) ? today : addDays(today, -1);
  let streak = 0;
  while (days.has(day)) {
    streak++;
    day = addDays(day, -1);
  }
  return streak;
}

const statsInput = z.object({ workspaceId: z.uuid().optional(), pageId: z.uuid().optional(), zone: z.string().max(100).optional() });
export const HEATMAP_DAYS = 365;
export const FORECAST_DAYS = 30;
const MATURE_DAYS = 21;

// The statistics of one deck (pageId) or of all decks of a workspace:
// today, streak, ratings per study day (a year), due cards per day (30
// days), true retention (share of reviews not rated Again) over 7/30/365
// days against the target, cards by state, time per day.
export async function studyStats(user: Identity, raw: unknown) {
  const input = statsInput.parse(raw);
  let workspaceId = input.workspaceId;
  let decks: Deck[];
  if (input.pageId) {
    const page = await requirePage(user, input.pageId);
    await requireUnlocked(user, page);
    workspaceId = page.workspace_id;
    decks = await readableDecks(user, workspaceId, [page.id]);
  } else {
    if (!workspaceId) throw new HttpError(400, "Arbeitsbereich fehlt.");
    if (!(await one("SELECT 1 FROM members WHERE workspace_id=? AND user_id=?", workspaceId, user.id))) throw new HttpError(404, "Arbeitsbereich nicht gefunden.");
    decks = await readableDecks(user, workspaceId);
  }
  const clock = await clockOf(user, input.zone);
  const now = Date.now();
  const today = studyClock(now, clock.zone, clock.dayStart);
  const from = addDays(today.day, -(HEATMAP_DAYS - 1));
  const scope = input.pageId ? " AND page_id=?" : "";
  const scoped = input.pageId ? [input.pageId] : [];
  // The log: the person's own, of decks they may still read for a deck,
  // and of the whole workspace for all (their history outlives the trash).
  const perDay = await all<{ day: string; n: number; ms: number; fresh: number; correct: number }>(
    `SELECT day,COUNT(*) n,SUM(COALESCE(duration_ms,0)) ms,SUM(CASE WHEN state_before=0 THEN 1 ELSE 0 END) fresh,SUM(CASE WHEN rating>1 THEN 1 ELSE 0 END) correct
       FROM review_log WHERE user_id=? AND workspace_id=? AND undone_at IS NULL AND day>=?${scope} GROUP BY day ORDER BY day`,
    user.id,
    workspaceId,
    from,
    ...scoped,
  );
  const heatmap = perDay.map((d) => ({ day: d.day, reviews: Number(d.n), minutes: Math.round(Number(d.ms || 0) / 60_000) }));
  const todayRow = perDay.find((d) => d.day === today.day);
  const retention = async (days: number) => {
    const r = await one<{ n: number; ok: number }>(
      `SELECT COUNT(*) n,SUM(CASE WHEN rating>1 THEN 1 ELSE 0 END) ok FROM review_log WHERE user_id=? AND workspace_id=? AND undone_at IS NULL AND state_before=2 AND day>=?${scope}`,
      user.id,
      workspaceId,
      addDays(today.day, -(days - 1)),
      ...scoped,
    );
    const n = Number(r?.n || 0);
    return { days, reviews: n, rate: n ? Number(r?.ok || 0) / n : null };
  };
  // Cards by state and the forecast: decks the person may study now.
  const ids = decks.map((d) => d.page.id);
  const states = { new: 0, learning: 0, young: 0, mature: 0, suspended: 0 };
  const forecast = new Map<string, number>();
  let overdue = 0;
  const last = addDays(today.day, FORECAST_DAYS - 1);
  for (const part of chunks(ids, 400)) {
    if (!part.length) continue;
    const list = placeholders(part.length);
    const fresh = await one<{ n: number }>(
      `SELECT COUNT(*) n FROM study_cards c WHERE c.page_id IN (${list}) AND NOT EXISTS(SELECT 1 FROM card_states s WHERE s.user_id=? AND s.row_id=c.row_id AND s.sub=c.sub)`,
      ...part,
      user.id,
    );
    states.new += Number(fresh?.n || 0);
    for (const r of await all<{ state: number; suspended: number; mature: number; n: number }>(
      `SELECT s.state,s.suspended,CASE WHEN s.stability>=${MATURE_DAYS} THEN 1 ELSE 0 END mature,COUNT(*) n FROM card_states s JOIN study_cards c ON c.page_id=s.page_id AND c.row_id=s.row_id AND c.sub=s.sub
        WHERE s.user_id=? AND s.page_id IN (${list}) AND s.orphaned_at IS NULL GROUP BY s.state,s.suspended,CASE WHEN s.stability>=${MATURE_DAYS} THEN 1 ELSE 0 END`,
      user.id,
      ...part,
    )) {
      const n = Number(r.n);
      if (Number(r.suspended)) states.suspended += n;
      else if (Number(r.state) !== 2) states.learning += n;
      else states[Number(r.mature) ? "mature" : "young"] += n;
    }
    for (const r of await all<{ due_day: string | null; state: number; n: number; early: number }>(
      `SELECT s.due_day,s.state,COUNT(*) n,SUM(CASE WHEN s.due<? THEN 1 ELSE 0 END) early FROM card_states s JOIN study_cards c ON c.page_id=s.page_id AND c.row_id=s.row_id AND c.sub=s.sub
        WHERE s.user_id=? AND s.page_id IN (${list}) AND s.suspended=0 AND s.orphaned_at IS NULL AND (s.state<>2 OR s.due_day<=?) GROUP BY s.due_day,s.state`,
      today.end,
      user.id,
      ...part,
      last,
    )) {
      const n = Number(r.n);
      // Learning cards: due today (or tomorrow when a step passes the day).
      if (Number(r.state) !== 2) {
        forecast.set(today.day, (forecast.get(today.day) || 0) + Number(r.early || 0));
        continue;
      }
      const day = r.due_day || today.day;
      if (day < today.day) overdue += n;
      forecast.set(day < today.day ? today.day : day, (forecast.get(day < today.day ? today.day : day) || 0) + n);
    }
  }
  const streak = await streakOf(user, workspaceId!, today.day, input.pageId);
  const studiedDays = await one<{ n: number }>(
    `SELECT COUNT(DISTINCT day) n FROM review_log WHERE user_id=? AND workspace_id=? AND undone_at IS NULL${scope}`,
    user.id,
    workspaceId,
    ...scoped,
  );
  const target = input.pageId && decks[0] ? await targetRetention(user, decks[0]) : null;
  return {
    day: today.day,
    zone: clock.zone,
    scope: input.pageId ? ("deck" as const) : ("all" as const),
    decks: decks.length,
    today: {
      reviews: Number(todayRow?.n || 0),
      new: Number(todayRow?.fresh || 0),
      minutes: Math.round(Number(todayRow?.ms || 0) / 60_000),
      correct: todayRow && Number(todayRow.n) ? Number(todayRow.correct || 0) / Number(todayRow.n) : null,
    },
    streak,
    studiedDays: Number(studiedDays?.n || 0),
    heatmap,
    forecast: Array.from({ length: FORECAST_DAYS }, (_, i) => {
      const day = addDays(today.day, i);
      return { day, due: forecast.get(day) || 0 };
    }),
    overdue,
    retention: await Promise.all([7, 30, 365].map(retention)),
    target,
    // The FSRS weights the deck uses for the person (§23): FSRS-6's defaults, or
    // optimised ones (of this deck or of all decks) with their date.
    model: input.pageId ? await modelOf(user.id, input.pageId) : null,
    states,
  };
}
async function modelOf(userId: string, pageId: string) {
  const { source, at, reviews, fit } = await personalWeights(userId, pageId);
  return { source, at, reviews, fit };
}
async function targetRetention(user: Identity, deck: Deck) {
  const own = await one<{ retention: number | null }>("SELECT retention FROM study_prefs WHERE user_id=? AND page_id=?", user.id, deck.page.id);
  return own?.retention ?? deck.settings.retention ?? STUDY_DEFAULTS.retention;
}

// "An diesem Tag erledigt" (lib/journal-completed.ts): one line per deck
// with the person's own ratings in the calendar day's bounds – never
// another person's, whatever the filter. Only decks the person may read
// now, outside journals behind a PIN.
export async function studiedOn(user: Identity, workspaceId: string, start: number, end: number, locked: Set<string>) {
  const groups = await all<{ page_id: string; n: number; at: number }>(
    `SELECT page_id,COUNT(*) n,MAX(reviewed_at) at FROM review_log WHERE user_id=? AND workspace_id=? AND undone_at IS NULL AND reviewed_at>=? AND reviewed_at<? GROUP BY page_id`,
    user.id,
    workspaceId,
    start,
    end,
  );
  const out: { pageId: string; count: number; at: number; title: string; icon: string }[] = [];
  for (const g of groups) {
    if (locked.has(g.page_id)) continue;
    const page = await one<Page>("SELECT * FROM pages WHERE id=? AND deleted_at IS NULL", g.page_id);
    if (!page || !(await pageRole(user, page))) continue;
    out.push({ pageId: page.id, count: Number(g.n), at: Number(g.at), title: page.title, icon: page.icon });
  }
  return out;
}
