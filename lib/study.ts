// Flashcards (docs/specs/flashcards.md): a database with a card mapping
// (databases.settings.study) is a deck, its records are cards, and every
// person has their own learning state (card_states) and log (review_log).
//
// - Reading is enough to study (§7.1): the session's actions check read
//   access to the page, the journal PIN, private records and hidden
//   properties – a rating changes only the person's own state, never the
//   database, so it is no edit (lib/api.ts editActions) and not audited.
// - study_cards is a derived index, drained per deck before it is read (the
//   triggers of lib/db.ts migrateFlashcards fill study_dirty); every instance
//   may drain (claimed by DELETE … RETURNING, upserts) – cluster-safe.
// - The state of a card is the fold of its log (lib/fsrs replay): undo
//   marks a rating undone and replays the rest.
// - Study data is private: only `user_id = the person` is ever read.
import { createHash } from "node:crypto";
import { z } from "zod";
import { all, one, run, sql } from "./db";
import { HttpError } from "./auth";
import { requirePage } from "./permissions";
import { requireUnlocked } from "./journal-extras";
import { databaseSettings, storeSettings } from "./database-settings";
import { hiddenFieldsFor } from "./field-access";
import { rowRoleResolver } from "./row-access";
import { cleanHtml, escaped } from "./document-server";
import { effectiveFilterGroup, filterCount, matchesFilterGroup } from "./database-filters";
import { allow } from "./action-limits";
import { schedule, replay, type FsrsParams, type Memory, type StudyRating } from "./fsrs";
import { DEFAULT_DAY_START, studyClock, studyDay, studyZone } from "./study-day";
import { buildQueue, sessionOrder, type QueueCard } from "./study-queue";
import { deriveCards, studyFieldIds, usesDocument, type CardSide, type DerivedCard } from "./study-content";
import { STUDY_DEFAULTS, STUDY_FIELD_TYPES, studyPrefsInput, studySettingsSchema, type StudySettings } from "./study-schema";
import type { Field, Identity, Page, View } from "./types";

const uuid = z.string().uuid();
const zoneInput = z.string().max(100).optional();
const MAX_BATCH = 50;
// Undo reaches back this far (§6.4).
const UNDO_WINDOW = 24 * 3_600_000;

type Deck = { page: Page; fields: Field[]; views: View[]; settings: StudySettings | undefined };
async function deckOf(user: Identity, pageId: string): Promise<Deck> {
  const page = await requirePage(user, pageId);
  if (page.kind !== "database") throw new HttpError(400, "Keine Datenbank.");
  await requireUnlocked(user, page);
  const raw = await one<{ fields: string; views: string }>("SELECT fields,views FROM databases WHERE page_id=?", pageId);
  if (!raw) throw new HttpError(404, "Datenbank nicht gefunden.");
  return { page, fields: JSON.parse(raw.fields), views: JSON.parse(raw.views), settings: (await databaseSettings(pageId)).study };
}
const requireDeck = (deck: Deck) => {
  if (!deck.settings) throw new HttpError(409, "Für diese Datenbank sind noch keine Lernkarten eingerichtet.");
  return deck.settings;
};

// ---- The card index ----

type StoredRow = { id: string; page_id: string; cells: string; content: string | null; position: number };
const hashOf = (card: DerivedCard) => createHash("sha256").update(JSON.stringify([card.front, card.back])).digest("hex").slice(0, 32);
// The HTML of a record's document as lib/row-documents.ts ensureRowDocument
// would create it, without creating it.
function documentHtml(row: Pick<StoredRow, "content">, stored: string | undefined) {
  if (stored !== undefined) return stored;
  const source = row.content || "";
  return source.startsWith("<") ? cleanHtml(source) : source ? `<p>${escaped(source).replaceAll("\n", "</p><p>")}</p>` : "";
}
async function documentsOf(rows: Pick<StoredRow, "id">[]) {
  const out = new Map<string, string>();
  for (let i = 0; i < rows.length; i += 500) {
    const ids = rows.slice(i, i + 500).map((r) => r.id);
    if (!ids.length) continue;
    for (const d of await all<{ row_id: string; html: string }>(`SELECT row_id,html FROM row_documents WHERE row_id IN (${ids.map(() => "?").join(",")})`, ...ids))
      out.set(d.row_id, d.html);
  }
  return out;
}
async function rowsOf(pageId: string, ids?: string[]) {
  if (!ids) return await all<StoredRow>("SELECT id,page_id,cells,content,position FROM rows WHERE page_id=?", pageId);
  const out: StoredRow[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    out.push(...(await all<StoredRow>(`SELECT id,page_id,cells,content,position FROM rows WHERE page_id=? AND id IN (${part.map(() => "?").join(",")})`, pageId, ...part)));
  }
  return out;
}
async function cardsOfRows(settings: StudySettings, fields: Field[], rows: StoredRow[]) {
  const docs = usesDocument(settings) ? await documentsOf(rows) : new Map<string, string>();
  return new Map(rows.map((r) => [r.id, deriveCards(settings, fields, JSON.parse(r.cells || "{}"), usesDocument(settings) ? documentHtml(r, docs.get(r.id)) : null)]));
}
// Brings the card index of a deck up to date with the records changed since
// (or all of them after a change of the mapping).
export async function drainStudyCards(pageId: string) {
  const claimed = await all<{ row_id: string }>("DELETE FROM study_dirty WHERE page_id=? RETURNING row_id", pageId);
  if (!claimed.length) return 0;
  const now = Date.now();
  const page = await one<{ workspace_id: string }>("SELECT workspace_id FROM pages WHERE id=?", pageId);
  const settings = page ? (await databaseSettings(pageId)).study : undefined;
  const raw = await one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", pageId);
  if (!page || !settings || !raw) {
    await run("DELETE FROM study_cards WHERE page_id=?", pageId);
    await run("UPDATE card_states SET orphaned_at=? WHERE page_id=? AND orphaned_at IS NULL", now, pageId);
    return claimed.length;
  }
  const whole = claimed.some((c) => c.row_id === "");
  const ids = whole ? undefined : [...new Set(claimed.map((c) => c.row_id))];
  const rows = await rowsOf(pageId, ids);
  const derived = await cardsOfRows(settings, JSON.parse(raw.fields), rows);
  const existing = whole
    ? await all<{ row_id: string; sub: string; content_hash: string }>("SELECT row_id,sub,content_hash FROM study_cards WHERE page_id=?", pageId)
    : (
        await Promise.all(
          chunks(ids!, 500).map((part) =>
            all<{ row_id: string; sub: string; content_hash: string }>(`SELECT row_id,sub,content_hash FROM study_cards WHERE page_id=? AND row_id IN (${part.map(() => "?").join(",")})`, pageId, ...part),
          ),
        )
      ).flat();
  const before = new Map(existing.map((e) => [`${e.row_id}\u0000${e.sub}`, e.content_hash]));
  const position = new Map(rows.map((r) => [r.id, r.position]));
  const kept = new Set<string>();
  for (const [rowId, cards] of derived)
    for (const card of cards) {
      const key = `${rowId}\u0000${card.sub}`;
      kept.add(key);
      const hash = hashOf(card);
      if (before.get(key) !== hash || !before.has(key))
        await run(
          "INSERT INTO study_cards(page_id,row_id,sub,kind,position,content_hash,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(page_id,row_id,sub) DO UPDATE SET kind=excluded.kind,position=excluded.position,content_hash=excluded.content_hash",
          pageId,
          rowId,
          card.sub,
          card.kind,
          position.get(rowId) ?? 0,
          hash,
          now,
        );
      else await run("UPDATE study_cards SET position=? WHERE page_id=? AND row_id=? AND sub=? AND position<>?", position.get(rowId) ?? 0, pageId, rowId, card.sub, position.get(rowId) ?? 0);
      // A card that is back (restored from the trash, moved here, its
      // sides filled again) finds its learning state again.
      await run(
        "UPDATE card_states SET orphaned_at=NULL,page_id=? WHERE row_id=? AND sub=? AND workspace_id=? AND (orphaned_at IS NOT NULL OR page_id<>?)",
        pageId,
        rowId,
        card.sub,
        page.workspace_id,
        pageId,
      );
    }
  for (const e of existing) {
    const key = `${e.row_id}\u0000${e.sub}`;
    if (kept.has(key)) continue;
    await run("DELETE FROM study_cards WHERE page_id=? AND row_id=? AND sub=?", pageId, e.row_id, e.sub);
    // The state rests (§3.4): back within the deck, it lives on.
    await run("UPDATE card_states SET orphaned_at=? WHERE page_id=? AND row_id=? AND sub=? AND orphaned_at IS NULL", now, pageId, e.row_id, e.sub);
  }
  return claimed.length;
}
const chunks = <T>(list: T[], size: number) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, i * size + size));

// ---- Personal settings ----

type PrefsRow = { new_per_day: number | null; reviews_per_day: number | null; retention: number | null; extra: string; time_zone: string | null; day_start: number };
async function prefsOf(userId: string, pageId: string) {
  return await one<PrefsRow>("SELECT new_per_day,reviews_per_day,retention,extra,time_zone,day_start FROM study_prefs WHERE user_id=? AND page_id=?", userId, pageId);
}
// The zone of the request, remembered for work without a browser (later:
// reminders); invalid or missing: the remembered one, else UTC.
async function zoneFor(user: Identity, zone: unknown) {
  const global = await prefsOf(user.id, "");
  const chosen = studyZone(zone, global?.time_zone);
  if (chosen !== global?.time_zone && typeof zone === "string" && chosen === zone)
    await run(
      "INSERT INTO study_prefs(user_id,page_id,time_zone,updated_at) VALUES(?,'',?,?) ON CONFLICT(user_id,page_id) DO UPDATE SET time_zone=excluded.time_zone,updated_at=excluded.updated_at",
      user.id,
      chosen,
      Date.now(),
    );
  return { zone: chosen, dayStart: global?.day_start ?? DEFAULT_DAY_START };
}
type Extra = Record<string, { new?: number; review?: number }>;
const extraOf = (raw: string | undefined): Extra => {
  try {
    const value = JSON.parse(raw || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Extra) : {};
  } catch {
    return {};
  }
};
// The limits and retention that apply to a person, and where they come from.
async function effective(user: Identity, pageId: string, settings: StudySettings, day: string) {
  const own = await prefsOf(user.id, pageId);
  const more = extraOf(own?.extra)[day] || {};
  const newPerDay = own?.new_per_day ?? settings.newPerDay ?? STUDY_DEFAULTS.newPerDay;
  const reviewsPerDay = own?.reviews_per_day ?? settings.reviewsPerDay ?? STUDY_DEFAULTS.reviewsPerDay;
  const retention = own?.retention ?? settings.retention ?? STUDY_DEFAULTS.retention;
  const params: FsrsParams = { retention, learningSteps: settings.learningSteps, relearningSteps: settings.relearningSteps, maxInterval: settings.maxInterval };
  return {
    params,
    limits: { new: newPerDay + (more.new || 0), review: reviewsPerDay + (more.review || 0) },
    prefs: {
      newPerDay: own?.new_per_day ?? null,
      reviewsPerDay: own?.reviews_per_day ?? null,
      retention: own?.retention ?? null,
      moreToday: { new: more.new || 0, review: more.review || 0 },
    },
    deck: { newPerDay: settings.newPerDay, reviewsPerDay: settings.reviewsPerDay, retention: settings.retention },
  };
}

// ---- The queue ----

type StateRow = {
  row_id: string;
  sub: string;
  position: number;
  state: number | null;
  step: number | null;
  due: number | null;
  due_day: string | null;
  stability: number | null;
  difficulty: number | null;
  reps: number | null;
  lapses: number | null;
  last_review: number | null;
  suspended: number | null;
};
const memoryOf = (s: Omit<StateRow, "row_id" | "sub" | "position">): Memory | null =>
  s.state
    ? {
        state: s.state as Memory["state"],
        step: Number(s.step),
        due: Number(s.due),
        dueDay: s.due_day,
        stability: Number(s.stability),
        difficulty: Number(s.difficulty),
        reps: Number(s.reps),
        lapses: Number(s.lapses),
        lastReview: Number(s.last_review),
      }
    : null;
// Cards the person may study in this deck (and view): readable records,
// the view's filters (sub-decks), not suspended.
async function studyable(user: Identity, deck: Deck, settings: StudySettings, viewId?: string) {
  const hidden = await hiddenFieldsFor(user, deck.page, deck.fields);
  // A side the person may not read: no cards at all (rather none than half).
  if (studyFieldIds(settings).some((id) => hidden.has(id) || !deck.fields.some((f) => f.id === id))) return { cards: [] as QueueCard[], blocked: "hidden" as const };
  const resolve = await rowRoleResolver(user, deck.page);
  const restricted = await all<{ id: string; access: string; created_by: string | null }>("SELECT id,access,created_by FROM rows WHERE page_id=? AND access='private'", deck.page.id);
  const invisible = new Set(restricted.filter((r) => !resolve(r)).map((r) => r.id));
  const view = viewId ? deck.views.find((v) => v.id === viewId) : undefined;
  const group = view ? effectiveFilterGroup(view) : null;
  let matching: Set<string> | null = null;
  if (group && filterCount(group) > 0) {
    matching = new Set();
    const now = new Date();
    for (const r of await all<{ id: string; cells: string }>("SELECT id,cells FROM rows WHERE page_id=?", deck.page.id))
      if (matchesFilterGroup(JSON.parse(r.cells || "{}"), group, deck.fields, now)) matching.add(r.id);
  }
  const rows = await all<StateRow>(
    `SELECT c.row_id,c.sub,c.position,s.state,s.step,s.due,s.due_day,s.stability,s.difficulty,s.reps,s.lapses,s.last_review,s.suspended
       FROM study_cards c LEFT JOIN card_states s ON s.user_id=? AND s.row_id=c.row_id AND s.sub=c.sub
      WHERE c.page_id=?`,
    user.id,
    deck.page.id,
  );
  const cards = rows
    .filter((r) => !invisible.has(r.row_id) && (!matching || matching.has(r.row_id)) && !Number(r.suspended))
    .map((r) => ({ rowId: r.row_id, sub: r.sub, position: Number(r.position), memory: memoryOf(r) }));
  return { cards, blocked: null };
}
async function todayOf(userId: string, pageId: string, day: string) {
  const logs = await all<{ row_id: string; state_before: number }>(
    "SELECT row_id,state_before FROM review_log WHERE user_id=? AND page_id=? AND day=? AND undone_at IS NULL",
    userId,
    pageId,
    day,
  );
  return {
    done: { new: logs.filter((l) => Number(l.state_before) === 0).length, review: logs.filter((l) => Number(l.state_before) === 2).length, all: logs.length },
    studiedRows: new Set(logs.map((l) => l.row_id)),
  };
}
// The content of cards to show: derived again from the records now.
async function contentOf(deck: Deck, settings: StudySettings, cards: QueueCard[]) {
  const rows = await rowsOf(deck.page.id, [...new Set(cards.map((c) => c.rowId))]);
  const derived = await cardsOfRows(settings, deck.fields, rows);
  const clean = (side: CardSide | undefined): CardSide | undefined => (side && "html" in side ? { html: cleanHtml(side.html) } : side);
  return cards.flatMap((c) => {
    const card = derived.get(c.rowId)?.find((d) => d.sub === c.sub);
    if (!card) return [];
    return [{ rowId: c.rowId, sub: c.sub, kind: card.kind, memory: c.memory, front: clean(card.front)!, back: clean(card.back)!, hint: clean(card.hint), extra: clean(card.extra) }];
  });
}
const queueInput = z.object({
  pageId: uuid,
  viewId: z.string().max(100).optional(),
  zone: zoneInput,
  limit: z.number().int().min(0).max(MAX_BATCH).optional(),
});
// The deck's state for the person: counts, limits, settings and the next
// cards with their content (up to 50; 0 for the overview only).
export async function studyQueue(user: Identity, raw: unknown) {
  const input = queueInput.parse(raw);
  if (!allow(`study-queue:${user.id}`, 120, 60_000)) throw new HttpError(429, "Zu viele Anfragen in kurzer Zeit. Bitte später erneut versuchen.");
  const deck = await deckOf(user, input.pageId);
  const now = Date.now();
  const clock = await zoneFor(user, input.zone);
  const today = studyClock(now, clock.zone, clock.dayStart);
  const base = { pageId: deck.page.id, title: deck.page.title, zone: clock.zone, dayStart: clock.dayStart, day: today.day, dayEnd: today.end, now };
  await drainStudyCards(deck.page.id);
  if (!deck.settings) return { ...base, configured: false as const };
  const settings = deck.settings;
  const mine = await effective(user, deck.page.id, settings, today.day);
  const { cards, blocked } = await studyable(user, deck, settings, input.viewId);
  const { done, studiedRows } = await todayOf(user.id, deck.page.id, today.day);
  const view = input.viewId ? deck.views.find((v) => v.id === input.viewId)?.study : undefined;
  const queue = buildQueue({
    cards,
    now,
    day: today.day,
    dayEnd: today.end,
    done,
    limits: mine.limits,
    studiedRows,
    bury: { new: settings.buryNew, review: settings.buryReviews },
    view,
  });
  const batch = sessionOrder(queue, view?.mixNew).slice(0, input.limit ?? MAX_BATCH);
  const states = { new: 0, learning: 0, review: 0, suspended: 0 };
  for (const c of cards) states[!c.memory ? "new" : c.memory.state === 2 ? "review" : "learning"]++;
  return {
    ...base,
    configured: true as const,
    blocked,
    settings,
    params: mine.params,
    limits: mine.limits,
    prefs: mine.prefs,
    deckDefaults: mine.deck,
    done,
    counts: queue.counts,
    nextDue: queue.nextDue,
    total: cards.length,
    states,
    // Tomorrow's reviews (the summary's "Morgen fällig").
    tomorrow: cards.filter((c) => c.memory && c.memory.due >= today.end && c.memory.due < today.end + 86_400_000).length,
    cards: batch.length ? await contentOf(deck, settings, batch) : [],
  };
}

// ---- Rating, undo ----

const reviewInput = z.object({
  pageId: uuid,
  rowId: uuid,
  sub: z.string().max(40),
  rating: z.number().int().min(1).max(4),
  // Made by the client when the card is shown: idempotent, and the seed of
  // the interval's fuzz (the same the buttons showed).
  id: uuid,
  zone: zoneInput,
  viewId: z.string().max(100).optional(),
  durationMs: z.number().int().min(0).max(3_600_000).optional(),
  reviewedAt: z.number().int().positive().optional(),
});
type LogRow = { id: string; user_id: string; page_id: string; row_id: string; sub: string; rating: number; reviewed_at: number; zone: string; undone_at: number | null; received_at: number; state_before: number };
async function storeState(user: Identity, page: Page, rowId: string, sub: string, memory: Memory | null) {
  if (!memory) {
    await run("DELETE FROM card_states WHERE user_id=? AND row_id=? AND sub=?", user.id, rowId, sub);
    return;
  }
  await run(
    `INSERT INTO card_states(user_id,workspace_id,page_id,row_id,sub,state,step,due,due_day,stability,difficulty,reps,lapses,last_review,suspended,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)
     ON CONFLICT(user_id,row_id,sub) DO UPDATE SET workspace_id=excluded.workspace_id,page_id=excluded.page_id,state=excluded.state,step=excluded.step,due=excluded.due,due_day=excluded.due_day,stability=excluded.stability,difficulty=excluded.difficulty,reps=excluded.reps,lapses=excluded.lapses,last_review=excluded.last_review,orphaned_at=NULL,version=card_states.version+1,updated_at=excluded.updated_at`,
    user.id,
    page.workspace_id,
    page.id,
    rowId,
    sub,
    memory.state,
    memory.step,
    memory.due,
    memory.dueDay,
    memory.stability,
    memory.difficulty,
    memory.reps,
    memory.lapses,
    memory.lastReview,
    Date.now(),
  );
}
// The card must be one the person may study now.
async function requireCard(user: Identity, deck: Deck, settings: StudySettings, rowId: string, sub: string) {
  await drainStudyCards(deck.page.id);
  if (!(await one("SELECT 1 FROM study_cards WHERE page_id=? AND row_id=? AND sub=?", deck.page.id, rowId, sub))) throw new HttpError(404, "Karte nicht gefunden.");
  const hidden = await hiddenFieldsFor(user, deck.page, deck.fields);
  if (studyFieldIds(settings).some((id) => hidden.has(id))) throw new HttpError(404, "Karte nicht gefunden.");
  const row = await one<{ id: string; access: string; created_by: string | null }>("SELECT id,access,created_by FROM rows WHERE id=? AND page_id=?", rowId, deck.page.id);
  if (!row || !(await rowRoleResolver(user, deck.page))(row)) throw new HttpError(404, "Karte nicht gefunden.");
}
export async function studyReview(user: Identity, raw: unknown) {
  const input = reviewInput.parse(raw);
  if (!allow(`study-review:${user.id}`, 600, 60_000)) throw new HttpError(429, "Zu viele Wertungen in kurzer Zeit. Bitte später erneut versuchen.");
  const deck = await deckOf(user, input.pageId);
  const settings = requireDeck(deck);
  const known = await one<LogRow>("SELECT * FROM review_log WHERE id=?", input.id);
  // The same rating sent twice (a retry): answered, not counted again.
  if (known) {
    if (known.user_id !== user.id) throw new HttpError(409, "Diese Wertung gibt es schon.");
    return { duplicate: true, ...(await studyQueue(user, { pageId: input.pageId, viewId: input.viewId, zone: input.zone, limit: 0 })) };
  }
  await requireCard(user, deck, settings, input.rowId, input.sub);
  const clock = await zoneFor(user, input.zone);
  const state = await one<StateRow>(`SELECT * FROM card_states WHERE user_id=? AND row_id=? AND sub=?${sql.forUpdate()}`, user.id, input.rowId, input.sub);
  const before = state ? memoryOf(state) : null;
  const now = Date.now();
  // The device's time, but never before the card's last rating nor in the
  // future (§10.4).
  const reviewedAt = Math.min(Math.max(input.reviewedAt ?? now, before?.lastReview ?? 0), now + 5 * 60_000);
  const day = studyDay(reviewedAt, clock.zone, clock.dayStart);
  const mine = await effective(user, deck.page.id, settings, day);
  const next = schedule(before, input.rating as StudyRating, reviewedAt, mine.params, clock, input.id);
  await run(
    `INSERT INTO review_log(id,user_id,workspace_id,page_id,row_id,sub,rating,state_before,reviewed_at,day,zone,elapsed_days,scheduled_days,duration_ms,stability,difficulty,due,source,received_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    input.id,
    user.id,
    deck.page.workspace_id,
    deck.page.id,
    input.rowId,
    input.sub,
    input.rating,
    before ? before.state : 0,
    reviewedAt,
    day,
    clock.zone,
    next.elapsedDays,
    next.scheduledDays,
    input.durationMs === undefined ? null : Math.min(input.durationMs, 60_000),
    next.memory.stability,
    next.memory.difficulty,
    next.memory.due,
    user.apiScope ? "api" : "web",
    now,
  );
  await storeState(user, deck.page, input.rowId, input.sub, next.memory);
  const overview = await studyQueue(user, { pageId: input.pageId, viewId: input.viewId, zone: input.zone, limit: 0 });
  return { ...overview, review: { id: input.id, rowId: input.rowId, sub: input.sub, memory: next.memory } };
}
const undoInput = z.object({ pageId: uuid, reviewId: uuid, zone: zoneInput, viewId: z.string().max(100).optional() });
// Undoes the person's last rating of a card (§6.4): marked undone, the
// card's state replayed from the rest of its log. Answers with the card,
// to be shown again.
export async function studyUndo(user: Identity, raw: unknown) {
  const input = undoInput.parse(raw);
  const log = await one<LogRow>("SELECT * FROM review_log WHERE id=? AND user_id=?", input.reviewId, user.id);
  if (!log || log.page_id !== input.pageId) throw new HttpError(404, "Wertung nicht gefunden.");
  if (log.undone_at) throw new HttpError(409, "Diese Wertung ist schon rückgängig gemacht.");
  if (Number(log.received_at) < Date.now() - UNDO_WINDOW) throw new HttpError(409, "Nur Wertungen der letzten 24 Stunden lassen sich rückgängig machen.");
  const deck = await deckOf(user, input.pageId);
  const settings = requireDeck(deck);
  await one(`SELECT 1 FROM card_states WHERE user_id=? AND row_id=? AND sub=?${sql.forUpdate()}`, user.id, log.row_id, log.sub);
  const history = (await all<LogRow>("SELECT * FROM review_log WHERE user_id=? AND row_id=? AND sub=? AND undone_at IS NULL", user.id, log.row_id, log.sub)).map((l) => ({
    id: l.id,
    rating: Number(l.rating) as StudyRating,
    reviewedAt: Number(l.reviewed_at),
    zone: l.zone,
  }));
  const last = [...history].sort((a, b) => b.reviewedAt - a.reviewedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))[0];
  if (last?.id !== log.id) throw new HttpError(409, "Nur die letzte Wertung einer Karte lässt sich rückgängig machen.");
  await run("UPDATE review_log SET undone_at=? WHERE id=?", Date.now(), log.id);
  const clock = await zoneFor(user, input.zone);
  const mine = await effective(user, deck.page.id, settings, studyDay(Date.now(), clock.zone, clock.dayStart));
  const memory = replay(
    history.filter((h) => h.id !== log.id),
    mine.params,
    clock.dayStart,
  );
  await storeState(user, deck.page, log.row_id, log.sub, memory);
  const overview = await studyQueue(user, { pageId: input.pageId, viewId: input.viewId, zone: input.zone, limit: 0 });
  const [card] = (await one("SELECT 1 FROM study_cards WHERE page_id=? AND row_id=? AND sub=?", deck.page.id, log.row_id, log.sub))
    ? await contentOf(deck, settings, [{ rowId: log.row_id, sub: log.sub, position: 0, memory }])
    : [];
  return { ...overview, undone: log.id, card: card ?? null };
}

// ---- Settings ----

const prefsCommand = studyPrefsInput.extend({
  pageId: uuid,
  zone: zoneInput,
  // "Heute mehr lernen": more new cards or reviews for today only.
  more: z.object({ new: z.number().int().min(0).max(9999).optional(), review: z.number().int().min(0).max(99999).optional() }).optional(),
});
export async function studyPrefs(user: Identity, raw: unknown) {
  const input = prefsCommand.parse(raw);
  const deck = await deckOf(user, input.pageId);
  requireDeck(deck);
  const clock = await zoneFor(user, input.zone);
  const day = studyDay(Date.now(), clock.zone, clock.dayStart);
  const own = await prefsOf(user.id, input.pageId);
  const value = <K extends "newPerDay" | "reviewsPerDay" | "retention">(key: K, column: keyof PrefsRow) =>
    input[key] === undefined ? ((own?.[column] as number | null | undefined) ?? null) : input[key];
  const extra = extraOf(own?.extra);
  const today = { ...(extra[day] || {}) };
  if (input.more?.new) today.new = Math.min(9999, (today.new || 0) + input.more.new);
  if (input.more?.review) today.review = Math.min(99999, (today.review || 0) + input.more.review);
  await run(
    `INSERT INTO study_prefs(user_id,page_id,new_per_day,reviews_per_day,retention,extra,updated_at) VALUES(?,?,?,?,?,?,?)
     ON CONFLICT(user_id,page_id) DO UPDATE SET new_per_day=excluded.new_per_day,reviews_per_day=excluded.reviews_per_day,retention=excluded.retention,extra=excluded.extra,updated_at=excluded.updated_at`,
    user.id,
    input.pageId,
    value("newPerDay", "new_per_day"),
    value("reviewsPerDay", "reviews_per_day"),
    value("retention", "retention"),
    // Only today's extra: it lapses with the study day.
    JSON.stringify(today.new || today.review ? { [day]: today } : {}),
    Date.now(),
  );
  return await studyQueue(user, { pageId: input.pageId, zone: input.zone, limit: 0 });
}
// The card mapping and the deck's defaults (write access; `settings: null`
// removes the mapping – everyone's learning state rests and returns with it).
export async function saveStudySettings(page: Page, raw: unknown) {
  const input = z.object({ settings: z.unknown() }).parse(raw);
  const current = await databaseSettings(page.id);
  if (input.settings === null) {
    const { study: _removed, ...rest } = current;
    await storeSettings(page.id, rest);
    return { settings: null };
  }
  const next = studySettingsSchema.parse(input.settings);
  const db = await one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", page.id);
  const fields: Field[] = JSON.parse(db?.fields || "[]");
  for (const id of studyFieldIds(next)) {
    const field = fields.find((f) => f.id === id);
    if (!field) throw new HttpError(400, "Einstellung verweist auf eine unbekannte Eigenschaft.");
    if (!STUDY_FIELD_TYPES.has(field.type)) throw new HttpError(400, `„${field.name}“ lässt sich nicht als Kartenseite verwenden.`);
  }
  if (JSON.stringify(next.front) === JSON.stringify(next.back)) throw new HttpError(400, "Vorder- und Rückseite brauchen verschiedene Inhalte.");
  await storeSettings(page.id, { ...current, study: next });
  return { settings: next };
}

// ---- All decks of a workspace (MCP, later the widget and #study) ----

export async function studyDecks(user: Identity, workspaceId: string, zone?: string) {
  const pages = await all<{ id: string }>(
    "SELECT p.id FROM pages p JOIN databases d ON d.page_id=p.id WHERE p.workspace_id=? AND p.deleted_at IS NULL AND d.settings LIKE ?",
    workspaceId,
    '%"study"%',
  );
  const out: { pageId: string; title: string; new: number; learning: number; review: number; total: number }[] = [];
  for (const p of pages) {
    try {
      const deck = await studyQueue(user, { pageId: p.id, zone, limit: 0 });
      if (deck.configured) out.push({ pageId: p.id, title: deck.title, ...deck.counts, total: deck.total });
    } catch (error) {
      // Pages the person may not read (or behind a PIN) are left out.
      if (!(error instanceof HttpError)) throw error;
    }
  }
  return out.sort((a, b) => b.review + b.learning + b.new - (a.review + a.learning + a.new) || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
}

// The commands (lib/api.ts): reading the deck is enough for everything but
// the mapping (study.settings, checked there with write access).
export async function studyCommand(user: Identity, action: string, b: Record<string, unknown>) {
  switch (action) {
    case "study.queue":
      return await studyQueue(user, b);
    case "study.review":
      return await studyReview(user, b);
    case "study.undo":
      return await studyUndo(user, b);
    case "study.prefs":
      return await studyPrefs(user, b);
    default:
      throw new HttpError(400, "Unbekannte Aktion.");
  }
}
