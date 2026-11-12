// Personal visit history for the quick search (#243): which pages and
// records a person opened and when, so that the search ranks what they use
// often and recently ("frecency") and the empty palette lists what they
// visited last.
//
// Privacy: one row per person and page/record with at most VISITS_KEPT
// visit times (minute precision) and nothing else – no text, no device,
// no IP address. Only that person's own search reads it (never someone
// else's ranking, read receipts or exports); it goes with the account
// (lib/account-deletion.ts, ON DELETE CASCADE) and with the page; entries
// older than RETENTION_DAYS are deleted, and at most ENTRIES_KEPT entries
// per person are kept. Not page_visits: that table is shared on purpose
// (read receipts, "changed since your visit") and keeps one time only.
import { all, one, run } from "./db";
import type { Identity } from "./types";

export const VISITS_KEPT = 10;
export const ENTRIES_KEPT = 500;
export const RETENTION_DAYS = 180;
const MINUTE = 60_000;
const DAY = 86_400_000;
// Half-life of a visit's weight: a visit two weeks ago counts half.
const HALF_LIFE = 14 * DAY;

const parse = (visits: string) =>
  visits
    .split(",")
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0);

// Records one opening (page: rowId ""). Within the same minute a second
// opening adds nothing. API tokens and integrations do not count.
export async function recordSearchVisit(user: Identity, pageId: string, rowId = "", at = Date.now()) {
  if (user.apiScope) return;
  const minute = Math.floor(at / MINUTE);
  const row = await one<{ visits: string }>(
    "SELECT visits FROM search_visits WHERE user_id=? AND page_id=? AND row_id=?",
    user.id,
    pageId,
    rowId,
  );
  const previous = row ? parse(row.visits) : [];
  if (previous[0] === minute) return;
  const visits = [minute, ...previous.filter((m) => m < minute)].slice(0, VISITS_KEPT).join(",");
  await run(
    `INSERT INTO search_visits(user_id,page_id,row_id,visits,last_at) VALUES(?,?,?,?,?)
     ON CONFLICT(user_id,page_id,row_id) DO UPDATE SET visits=excluded.visits,last_at=excluded.last_at`,
    user.id,
    pageId,
    rowId,
    visits,
    at,
  );
  // Bounded per person: what is older than the retention period, and
  // beyond the newest ENTRIES_KEPT (checked now and then, it is cheap).
  if (!row) await pruneSearchVisits(user.id, at);
}

// Retention: for one person (after a new entry) or for everyone (the
// retention worker, lib/version-history.ts).
export async function pruneSearchVisits(userId?: string, now = Date.now()) {
  const cutoff = now - RETENTION_DAYS * DAY;
  if (userId) {
    await run("DELETE FROM search_visits WHERE user_id=? AND last_at<?", userId, cutoff);
    const edge = await one<{ last_at: number }>(
      "SELECT last_at FROM search_visits WHERE user_id=? ORDER BY last_at DESC LIMIT 1 OFFSET ?",
      userId,
      ENTRIES_KEPT,
    );
    if (edge) await run("DELETE FROM search_visits WHERE user_id=? AND last_at<=?", userId, Number(edge.last_at));
    return;
  }
  await run("DELETE FROM search_visits WHERE last_at<?", cutoff);
  // Records that are gone (deleted, or in the trash: rows has them no more).
  await run("DELETE FROM search_visits WHERE row_id<>'' AND NOT EXISTS(SELECT 1 FROM rows r WHERE r.id=search_visits.row_id)");
}

// The frecency of a list of visit minutes: each visit weighs 1 today and
// halves every HALF_LIFE; squashed into 0..1 (3 recent visits ≈ 0.5,
// 10 ≈ 0.77, one a month ago ≈ 0.08).
export function frecency(visits: number[], now = Date.now()) {
  let raw = 0;
  for (const minute of visits) raw += Math.pow(0.5, Math.max(0, now - minute * MINUTE) / HALF_LIFE);
  return raw / (raw + 3);
}

// The person's own signals for ranking: frecency per "pageId:rowId", the
// pages they edited lately and their favourites. One indexed read each,
// bounded (ENTRIES_KEPT entries; edits and favourites of the given pages).
export type PersonalSignals = { frecency: Map<string, number>; edited: Map<string, number>; favourite: Set<string> };
export async function personalSignals(user: Identity, pageIds: string[], now = Date.now()): Promise<PersonalSignals> {
  const result: PersonalSignals = { frecency: new Map(), edited: new Map(), favourite: new Set() };
  for (const v of await all<{ page_id: string; row_id: string; visits: string }>(
    "SELECT page_id,row_id,visits FROM search_visits WHERE user_id=? ORDER BY last_at DESC LIMIT ?",
    user.id,
    ENTRIES_KEPT,
  ))
    result.frecency.set(`${v.page_id}:${v.row_id}`, frecency(parse(v.visits), now));
  const ids = [...new Set(pageIds)];
  for (let i = 0; i < ids.length; i += 500) {
    const batch = ids.slice(i, i + 500);
    const list = batch.map(() => "?").join(",");
    for (const e of await all<{ page_id: string; at: number }>(
      `SELECT page_id,at FROM page_edits WHERE user_id=? AND page_id IN (${list}) AND at>?`,
      user.id,
      ...batch,
      now - 30 * DAY,
    ))
      result.edited.set(e.page_id, Math.pow(0.5, (now - Number(e.at)) / (7 * DAY)));
    for (const f of await all<{ page_id: string }>(`SELECT page_id FROM favorites WHERE user_id=? AND page_id IN (${list})`, user.id, ...batch))
      result.favourite.add(`${f.page_id}:`);
    for (const f of await all<{ page_id: string; row_id: string }>(
      `SELECT page_id,row_id FROM row_favorites WHERE user_id=? AND page_id IN (${list})`,
      user.id,
      ...batch,
    ))
      result.favourite.add(`${f.page_id}:${f.row_id}`);
  }
  return result;
}

// The person's own boost of an entry, 0 … PERSONAL_MAX.
export const PERSONAL_MAX = 1.2;
export function personalBoost(signals: PersonalSignals, pageId: string, rowId: string) {
  const key = `${pageId}:${rowId}`;
  const f = signals.frecency.get(key) ?? 0;
  const edited = rowId ? 0 : (signals.edited.get(pageId) ?? 0);
  const favourite = signals.favourite.has(key) ? 1 : 0;
  return Math.min(PERSONAL_MAX, PERSONAL_MAX * f + 0.15 * edited + 0.15 * favourite);
}

// The text part of the score: where the query stands in the title. An
// exact title (or alias) first, then titles that start with it (or a word
// in them does), then titles that contain it, then hits in the text only.
export const TITLE_EXACT = 3,
  TITLE_PREFIX = 2,
  TITLE_CONTAINS = 1.5;
export function titleScore(foldedTitles: string[], foldedQuery: string) {
  let best = 0;
  const q = foldedQuery.trim();
  if (!q) return 0;
  for (const title of foldedTitles) {
    const t = title.trim();
    if (!t) continue;
    if (t === q) return TITLE_EXACT;
    if (t.startsWith(q) || t.split(/[\s\-_/.,:;()[\]"'„“«»]+/u).some((w) => w && w.startsWith(q))) best = Math.max(best, TITLE_PREFIX);
    else if (t.includes(q)) best = Math.max(best, TITLE_CONTAINS);
  }
  return best;
}
