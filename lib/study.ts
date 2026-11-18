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
import { createHash, randomUUID } from "node:crypto";
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
import { DEFAULT_DAY_START, REMIND_AT, daysBetween, reminderMoment, studyClock, studyDay, studyZone } from "./study-day";
import { buildQueue, seededRank, sessionOrder, type QueueCard } from "./study-queue";
import { MAX_CHOICES, deriveCards, foldChoice, needsDocument, sideIsEmpty, sidePlain, studyFieldIds, typedAnswer, type CardSide, type DerivedCard, type OcclusionCard } from "./study-content";
import { clozeHtml } from "./study-cloze";
import { STUDY_DEFAULTS, STUDY_FIELD_TYPES, studyPrefsInput, studySettingsSchema, type StudySettings } from "./study-schema";
import { decksWithWeights, personalWeights, storedWeights, type ParamsScope } from "./study-params";
import { DEFAULT_WEIGHTS, MIN_REVIEWS, DEFAULT_COSTS, clampWeights, memoryOf as foldMemory, type ReviewCosts, type TrainingCard } from "./fsrs/optimize";
import { clipParameters } from "ts-fsrs";
import { htmlToMarkdown, type MarkdownContext } from "./markdown";
import { inlineToHtml, toPlain } from "./inline-markdown";
import { readUpload } from "./storage";
import { CSV_FORMULA } from "./cell-text";
import { ct } from "./content-locale";
import { exportName } from "./export-name";
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
const hashOf = (card: DerivedCard) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        card.occlusion
          ? [card.front, card.back, card.occlusion.src, card.occlusion.mode, card.occlusion.masks]
          : card.choices
            ? [card.front, card.back, card.choices]
            : [card.front, card.back],
      ),
    )
    .digest("hex")
    .slice(0, 32);
// The HTML of a record's document as lib/row-documents.ts ensureRowDocument
// would create it, without creating it.
export function documentHtml(row: Pick<StoredRow, "content">, stored: string | undefined) {
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
// Documents are read only for the records whose cards need them (document
// sides, image occlusion records).
async function cardsOfRows(settings: StudySettings, fields: Field[], rows: StoredRow[]) {
  const parsed = rows.map((r) => ({ row: r, cells: JSON.parse(r.cells || "{}") as Record<string, unknown> }));
  const needing = parsed.filter((p) => needsDocument(settings, p.cells));
  const docs = needing.length ? await documentsOf(needing.map((p) => p.row)) : new Map<string, string>();
  return new Map(parsed.map(({ row, cells }) => [row.id, deriveCards(settings, fields, cells, needsDocument(settings, cells) ? documentHtml(row, docs.get(row.id)) : null)]));
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
  // The person's optimised weights (§23): the deck's own, else those for
  // all decks, else FSRS-6's defaults.
  const { weights, ...model } = await personalWeights(user.id, pageId);
  const params: FsrsParams = {
    retention,
    learningSteps: settings.learningSteps,
    relearningSteps: settings.relearningSteps,
    maxInterval: settings.maxInterval,
    ...(weights ? { weights } : {}),
  };
  return {
    params,
    model,
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
async function studyable(user: Identity, deck: Deck, settings: StudySettings, viewId?: string, withSuspended = false) {
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
    .filter((r) => !invisible.has(r.row_id) && (!matching || matching.has(r.row_id)) && (withSuspended || !Number(r.suspended)))
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
// - cloze: the side with the clozes twice – with card N's gaps hidden (the
//   front) and with their answers marked (the back); text sides carry the
//   number for the client (components/study/cloze.tsx), document sides are
//   rewritten here and cleaned again. The other side comes along: the
//   front as context above, a back as a note after revealing.
// - typed: the expected answer as text.
// - choice: the right option first (the client shuffles them with the
//   review's id as seed, stable while the card is shown) and wrong ones –
//   the record's own, filled up from the backs of other cards of `pool`:
//   only cards this person may study (readable records, the view's
//   filters, no hidden properties – §17.9), never others'.
export type ShownSide = { text: string; formatted?: boolean; cloze?: { n: number; reveal: boolean } } | { html: string };
export type ShownCard = {
  rowId: string;
  sub: string;
  kind: DerivedCard["kind"];
  memory: Memory | null;
  front: ShownSide;
  back: ShownSide;
  hint?: ShownSide;
  extra?: ShownSide;
  context?: ShownSide;
  note?: ShownSide;
  typed?: { answer: string };
  choice?: { options: string[]; correct: number };
  occlusion?: OcclusionCard;
};
const clean = (side: CardSide | undefined): CardSide | undefined => (side && "html" in side ? { html: cleanHtml(side.html) } : side);
const POOL_ROWS = 80;
const WRONG_OPTIONS = 3;
export type Candidate = { rowId: string; text: string; key: string; tags: string[] };
// The records whose backs may fill a choice card's options: at most 80 of
// the pool, picked at random but the same all day.
export const poolRows = (rowIds: Iterable<string>, day: string) =>
  [...new Set(rowIds)].sort((a, b) => seededRank(day, a) - seededRank(day, b)).slice(0, POOL_ROWS);
async function distractorPool(deck: Deck, settings: StudySettings, pool: QueueCard[], day: string): Promise<Candidate[]> {
  const ids = poolRows(pool.map((c) => c.rowId), day);
  if (!ids.length) return [];
  return choiceCandidates(await cardsOfRows(settings, deck.fields, await rowsOf(deck.page.id, ids)));
}
// The backs of the records' first cards as options (pure).
export function choiceCandidates(derived: Map<string, DerivedCard[]>): Candidate[] {
  const out: Candidate[] = [];
  for (const [rowId, cards] of derived) {
    const card = cards.find((c) => c.sub === "" && c.kind !== "cloze");
    const text = card ? sidePlain(card.back).replace(/\s+/g, " ").slice(0, 300) : "";
    if (text) out.push({ rowId, text, key: foldChoice(text), tags: card?.tags || [] });
  }
  return out;
}
function choiceOptions(card: DerivedCard, rowId: string, candidates: Candidate[]) {
  const correct = sidePlain(card.back).replace(/\s+/g, " ").slice(0, 300);
  const wrong = [...(card.choices || [])];
  const seen = new Set([foldChoice(correct), ...wrong.map(foldChoice)]);
  if (wrong.length < WRONG_OPTIONS) {
    const length = correct.length;
    const tags = new Set(card.tags || []);
    const ranked = candidates
      .filter((c) => c.rowId !== rowId && !seen.has(c.key))
      .map((c) => ({ c, score: (c.tags.some((t) => tags.has(t)) ? 2 : 0) + 1 - Math.abs(c.text.length - length) / Math.max(c.text.length, length, 1) }))
      .sort((a, b) => b.score - a.score || seededRank(rowId, a.c.rowId) - seededRank(rowId, b.c.rowId));
    for (const { c } of ranked) {
      if (wrong.length >= WRONG_OPTIONS) break;
      if (seen.has(c.key)) continue;
      seen.add(c.key);
      wrong.push(c.text);
    }
  }
  return { options: [correct, ...wrong.slice(0, MAX_CHOICES - 1)], correct: 0 };
}
// Also for the cards of a public link (lib/shared-study.ts).
export function present(card: DerivedCard, c: Pick<QueueCard, "rowId" | "sub" | "memory">, candidates: Candidate[]): ShownCard {
  const base = { rowId: c.rowId, sub: c.sub, kind: card.kind, memory: c.memory, ...(card.hint ? { hint: clean(card.hint) } : {}), ...(card.extra ? { extra: clean(card.extra) } : {}) };
  if (card.cloze) {
    const { n, on } = card.cloze;
    const side = on === "front" ? card.front : card.back,
      other = on === "front" ? card.back : card.front;
    const view = (reveal: boolean): ShownSide => ("html" in side ? { html: cleanHtml(clozeHtml(side.html, n, reveal)) } : { ...side, cloze: { n, reveal } });
    const rest = sideIsEmpty(other) ? undefined : clean(other);
    return { ...base, front: view(false), back: view(true), ...(rest ? (on === "back" ? { context: rest } : { note: rest }) : {}) };
  }
  if (card.occlusion) {
    // The picture is the card; the record's sides come with it – the front
    // above, the back after revealing – and the back itself is the labels
    // of the masks asked.
    const { masks, target } = card.occlusion;
    const labels = [...new Set(masks.filter((m) => target.includes(m.id) && m.label).map((m) => m.label!))];
    return {
      ...base,
      front: { text: "" },
      back: { text: labels.join(" · ") },
      ...(sideIsEmpty(card.front) ? {} : { context: clean(card.front) }),
      ...(sideIsEmpty(card.back) ? {} : { note: clean(card.back) }),
      occlusion: card.occlusion,
    };
  }
  const shown: ShownCard = { ...base, front: clean(card.front)!, back: clean(card.back)! };
  if (card.kind === "typed") return { ...shown, typed: { answer: typedAnswer(card.back) } };
  if (card.kind === "choice") {
    const choice = choiceOptions(card, c.rowId, candidates);
    // Fewer than two options: the card is asked like a basic one.
    return choice.options.length > 1 ? { ...shown, choice } : shown;
  }
  return shown;
}
async function contentOf(deck: Deck, settings: StudySettings, cards: QueueCard[], pool: QueueCard[], day: string): Promise<ShownCard[]> {
  const rows = await rowsOf(deck.page.id, [...new Set(cards.map((c) => c.rowId))]);
  const derived = await cardsOfRows(settings, deck.fields, rows);
  const needsPool = cards.some((c) => {
    const card = derived.get(c.rowId)?.find((d) => d.sub === c.sub);
    return card?.kind === "choice" && (card.choices?.length || 0) < WRONG_OPTIONS;
  });
  const candidates = needsPool ? await distractorPool(deck, settings, pool, day) : [];
  return cards.flatMap((c) => {
    const card = derived.get(c.rowId)?.find((d) => d.sub === c.sub);
    return card ? [present(card, c, candidates)] : [];
  });
}
const queueInput = z.object({
  pageId: uuid,
  viewId: z.string().max(100).optional(),
  zone: zoneInput,
  limit: z.number().int().min(0).max(MAX_BATCH).optional(),
  // "Früher zeigen": learning cards due later today come now.
  ahead: z.boolean().optional(),
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
  const base = { pageId: deck.page.id, title: deck.page.title, userId: user.id, zone: clock.zone, dayStart: clock.dayStart, day: today.day, dayEnd: today.end, now };
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
    ...(input.ahead ? { learnAhead: Math.max(0, today.end - now) } : {}),
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
    model: mine.model,
    // The overview only: the note "Parameter optimieren" (§23).
    ...(input.limit === 0 ? { optimizer: await optimizerNote(user, deck.page.id, mine.model, now) } : {}),
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
    cards: batch.length ? await contentOf(deck, settings, batch, cards, today.day) : [],
  };
}

// ---- Offline (§10.4) ----

// At most this many cards go into a deck's offline copy: the ones due
// soonest first, then the new ones in the order added.
export const OFFLINE_CARDS = 5000;
const offlineInput = z.object({ pageId: uuid, zone: zoneInput });
// A deck for studying without a connection (GET /api/pages/{id}/study
// ?offline=1, stored by the offline copy for decks studied in the last 14
// days – lib/offline-plan.ts): every card the person may study with its
// content and own state, today's ratings, the limits (today's and those
// of any other day), the parameters, and per study view with filters the
// records it selects. The device builds its queue from it with the same
// functions (lib/study-queue.ts, lib/fsrs – lib/study-offline.ts).
export async function studyOffline(user: Identity, raw: unknown) {
  const input = offlineInput.parse(raw);
  if (!allow(`study-queue:${user.id}`, 120, 60_000)) throw new HttpError(429, "Zu viele Anfragen in kurzer Zeit. Bitte später erneut versuchen.");
  const deck = await deckOf(user, input.pageId);
  const now = Date.now();
  const clock = await zoneFor(user, input.zone);
  const today = studyClock(now, clock.zone, clock.dayStart);
  const base = { pageId: deck.page.id, title: deck.page.title, userId: user.id, zone: clock.zone, dayStart: clock.dayStart, day: today.day, dayEnd: today.end, now, offline: true as const };
  await drainStudyCards(deck.page.id);
  if (!deck.settings) return { ...base, configured: false as const };
  const settings = deck.settings;
  const mine = await effective(user, deck.page.id, settings, today.day);
  const { cards, blocked } = await studyable(user, deck, settings);
  const { done, studiedRows } = await todayOf(user.id, deck.page.id, today.day);
  const views: Record<string, { rows?: string[]; study?: View["study"] }> = {};
  for (const view of deck.views.filter((v) => v.type === "study")) {
    const group = effectiveFilterGroup(view);
    views[view.id] = {
      ...(view.study ? { study: view.study } : {}),
      ...(group && filterCount(group) > 0 ? { rows: [...new Set((await studyable(user, deck, settings, view.id)).cards.map((c) => c.rowId))] } : {}),
    };
  }
  const kept = [...cards]
    .sort((a, b) => (a.memory ? a.memory.due : Infinity) - (b.memory ? b.memory.due : Infinity) || a.position - b.position || (a.rowId < b.rowId ? -1 : a.rowId > b.rowId ? 1 : 0))
    .slice(0, OFFLINE_CARDS);
  return {
    ...base,
    configured: true as const,
    blocked,
    settings,
    params: mine.params,
    model: mine.model,
    limits: mine.limits,
    // The limits of a later study day (without today's "Heute mehr lernen").
    baseLimits: { new: mine.limits.new - mine.prefs.moreToday.new, review: mine.limits.review - mine.prefs.moreToday.review },
    prefs: mine.prefs,
    deckDefaults: mine.deck,
    done,
    studiedRows: [...studiedRows],
    views,
    total: cards.length,
    truncated: kept.length < cards.length,
    cards: kept.length ? await contentOf(deck, settings, kept, cards, today.day) : [],
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
// A learning state brought from elsewhere (the Anki import, §8.1): each
// card's reviews replayed through FSRS with the deck's parameters and
// logged as the person's (source "import"), for the person importing only.
// Cards that are not (or no longer) cards of the deck are skipped; Anki's
// own FSRS memory, when it has one, replaces stability and difficulty of
// the result. A suspended card stays suspended. Returns the reviews logged.
export type ImportedHistory = {
  rowId: string;
  sub: string;
  reviews: { at: number; rating: StudyRating }[];
  suspended?: boolean;
  memory?: { stability: number; difficulty: number };
};
export async function importStudyHistory(user: Identity, pageId: string, cards: ImportedHistory[], zoneName: string) {
  const page = await requirePage(user, pageId);
  const settings = (await databaseSettings(pageId)).study;
  if (!settings) return 0;
  await drainStudyCards(pageId);
  const existing = new Set((await all<{ row_id: string; sub: string }>("SELECT row_id,sub FROM study_cards WHERE page_id=?", pageId)).map((c) => `${c.row_id}\u0000${c.sub}`));
  const clock = await zoneFor(user, zoneName);
  const mine = await effective(user, pageId, settings, studyDay(Date.now(), clock.zone, clock.dayStart));
  const now = Date.now();
  let logged = 0;
  for (const card of cards) {
    if (!existing.has(`${card.rowId}\u0000${card.sub}`)) continue;
    let memory: Memory | null = null;
    const reviews = card.reviews.filter((r) => r.at <= now + 5 * 60_000).sort((a, b) => a.at - b.at);
    for (const review of reviews) {
      const reviewId = randomUUID();
      const reviewedAt = Math.max(review.at, memory?.lastReview ?? 0);
      const next = schedule(memory, review.rating, reviewedAt, mine.params, clock, reviewId);
      await run(
        `INSERT INTO review_log(id,user_id,workspace_id,page_id,row_id,sub,rating,state_before,reviewed_at,day,zone,elapsed_days,scheduled_days,duration_ms,stability,difficulty,due,source,received_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        reviewId,
        user.id,
        page.workspace_id,
        pageId,
        card.rowId,
        card.sub,
        review.rating,
        memory ? memory.state : 0,
        reviewedAt,
        studyDay(reviewedAt, clock.zone, clock.dayStart),
        clock.zone,
        next.elapsedDays,
        next.scheduledDays,
        null,
        next.memory.stability,
        next.memory.difficulty,
        next.memory.due,
        "import",
        now,
      );
      memory = next.memory;
      logged++;
    }
    if (!memory) continue;
    if (card.memory && memory.state === 2) memory = { ...memory, stability: card.memory.stability, difficulty: card.memory.difficulty };
    await storeState(user, page, card.rowId, card.sub, memory);
    if (card.suspended) await run("UPDATE card_states SET suspended=1 WHERE user_id=? AND row_id=? AND sub=?", user.id, card.rowId, card.sub);
  }
  return logged;
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
// Ratings made without a connection (§10.4), sent by the device's own
// queue (lib/study-offline.ts) once it is back – up to 500 at a time, in
// any order:
// - Idempotent by the review's id (the primary key of review_log), with no
//   time limit: a rating that is there already is skipped ("duplicate").
// - "The log wins": a card's state is the fold of its log. A rating newer
//   than the card's last one is scheduled from its state as online; an
//   older one (two devices, one of them offline) is put in its place and
//   the card's log replayed (lib/fsrs replay) – deterministic, as the fuzz
//   is seeded with each review's id. Two ratings of the same card on the
//   same day both count, as in Anki after a sync.
// - The device's clock: never later than five minutes from now (no lower
//   bound – an older rating is ordered, not moved); a rating older than 30
//   days is accepted but marked source "offline".
// - A card that is gone or that the person may no longer study: the rating
//   is kept in the log (statistics), the state is left alone ("orphaned").
//   A deck that does not exist any more keeps nothing.
const OFFLINE_AGE = 30 * 86_400_000;
export const MAX_OFFLINE_REVIEWS = 500;
const reviewsInput = z.object({
  reviews: z
    .array(
      z.object({
        id: uuid,
        pageId: uuid,
        rowId: uuid,
        sub: z.string().max(40),
        rating: z.number().int().min(1).max(4),
        reviewedAt: z.number().int().positive(),
        zone: zoneInput,
        durationMs: z.number().int().min(0).max(3_600_000).optional(),
        // The card's number of reviews the device knew (informational).
        baseReps: z.number().int().min(0).optional(),
      }),
    )
    .min(1)
    .max(MAX_OFFLINE_REVIEWS),
  // Where the ratings were made (the app or the browser).
  source: z.enum(["web", "app"]).optional(),
});
export type OfflineReviewResult = { id: string; status: "ok" | "replayed" | "duplicate" | "orphaned" | "conflict" };
export async function studyReviews(user: Identity, raw: unknown) {
  const input = reviewsInput.parse(raw);
  if (!allow(`study-reviews:${user.id}`, 30, 60_000)) throw new HttpError(429, "Zu viele Wertungen in kurzer Zeit. Bitte später erneut versuchen.");
  const now = Date.now();
  const global = await prefsOf(user.id, "");
  const dayStart = global?.day_start ?? DEFAULT_DAY_START;
  const decks = new Map<string, Deck | null>();
  const deckFor = async (pageId: string) => {
    if (!decks.has(pageId))
      decks.set(
        pageId,
        await deckOf(user, pageId).catch((error) => {
          if (error instanceof HttpError) return null;
          throw error;
        }),
      );
    return decks.get(pageId)!;
  };
  const sorted = [...input.reviews].sort((a, b) => a.reviewedAt - b.reviewedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const results: OfflineReviewResult[] = [];
  const touched = new Set<string>();
  for (const r of sorted) {
    const known = await one<{ user_id: string }>("SELECT user_id FROM review_log WHERE id=?", r.id);
    if (known) {
      results.push({ id: r.id, status: known.user_id === user.id ? "duplicate" : "conflict" });
      continue;
    }
    const deck = await deckFor(r.pageId);
    const page = deck?.page ?? (await one<Page>("SELECT * FROM pages WHERE id=?", r.pageId));
    if (!page || !(await one("SELECT 1 FROM members WHERE workspace_id=? AND user_id=?", page.workspace_id, user.id))) {
      results.push({ id: r.id, status: "orphaned" });
      continue;
    }
    const zone = studyZone(r.zone, global?.time_zone);
    const clock = { zone, dayStart };
    const reviewedAt = Math.min(r.reviewedAt, now + 5 * 60_000);
    const day = studyDay(reviewedAt, zone, dayStart);
    const settings = deck?.settings;
    const params = settings ? (await effective(user, page.id, settings, day)).params : { retention: STUDY_DEFAULTS.retention, learningSteps: [1, 10], relearningSteps: [10], maxInterval: 36500 };
    let usable = !!(deck && settings);
    if (usable)
      await requireCard(user, deck!, settings!, r.rowId, r.sub).catch((error) => {
        if (!(error instanceof HttpError)) throw error;
        usable = false;
      });
    const state = await one<StateRow>(`SELECT * FROM card_states WHERE user_id=? AND row_id=? AND sub=?${sql.forUpdate()}`, user.id, r.rowId, r.sub);
    const history = (await all<LogRow>("SELECT * FROM review_log WHERE user_id=? AND row_id=? AND sub=? AND undone_at IS NULL", user.id, r.rowId, r.sub)).map((l) => ({
      id: l.id,
      rating: Number(l.rating) as StudyRating,
      reviewedAt: Number(l.reviewed_at),
      zone: l.zone,
    }));
    const later = (h: { id: string; reviewedAt: number }) => h.reviewedAt > reviewedAt || (h.reviewedAt === reviewedAt && h.id > r.id);
    const replayed = usable && history.some(later);
    // The state before this rating: the card's now, or the fold of the
    // ratings before it.
    const before = replayed ? replay(history.filter((h) => !later(h)), params, dayStart) : state ? memoryOf(state) : null;
    const next = schedule(before, r.rating as StudyRating, reviewedAt, params, clock, r.id);
    await run(
      `INSERT INTO review_log(id,user_id,workspace_id,page_id,row_id,sub,rating,state_before,reviewed_at,day,zone,elapsed_days,scheduled_days,duration_ms,stability,difficulty,due,source,received_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      r.id,
      user.id,
      page.workspace_id,
      page.id,
      r.rowId,
      r.sub,
      r.rating,
      before ? before.state : 0,
      reviewedAt,
      day,
      zone,
      next.elapsedDays,
      next.scheduledDays,
      r.durationMs === undefined ? null : Math.min(r.durationMs, 60_000),
      next.memory.stability,
      next.memory.difficulty,
      next.memory.due,
      reviewedAt < now - OFFLINE_AGE ? "offline" : user.apiScope ? "api" : (input.source ?? "web"),
      now,
    );
    if (!usable) {
      results.push({ id: r.id, status: "orphaned" });
      continue;
    }
    await storeState(user, page, r.rowId, r.sub, replayed ? replay([...history, { id: r.id, rating: r.rating as StudyRating, reviewedAt, zone }], params, dayStart) : next.memory);
    touched.add(page.id);
    results.push({ id: r.id, status: replayed ? "replayed" : "ok" });
  }
  return { results, decks: [...touched] };
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
    ? await contentOf(deck, settings, [{ rowId: log.row_id, sub: log.sub, position: 0, memory }], (await studyable(user, deck, settings, input.viewId)).cards, overview.day)
    : [];
  return { ...overview, undone: log.id, card: card ?? null };
}

// ---- Parameter optimisation (§23) ----

// The fit itself runs in the person's browser (components/study/optimize-
// worker.ts, lib/fsrs/optimize.ts): the server hands out the log in a
// compact form (study.history) and stores the 21 numbers it gets back
// (study.params).
const historyInput = z.object({ pageId: uuid, scope: z.enum(["deck", "all"]).default("deck"), zone: zoneInput });
// At most this many reviews go to the browser (the cards studied last).
export const MAX_HISTORY_REVIEWS = 200_000;
// The gentle note in "Meine Einstellungen": optimise again after this many
// new reviews, or after a month with some.
const REOPTIMIZE_REVIEWS = 1000,
  REOPTIMIZE_DAYS = 30,
  REOPTIMIZE_SOME = 200;
type HistoryRow = { row_id: string; sub: string; rating: number; state_before: number; day: string; duration_ms: number | null };
const scopeFilter = (scope: ParamsScope, pageId: string) => (scope === "deck" ? { sql: " AND page_id=?", args: [pageId] } : { sql: "", args: [] as string[] });
async function reviewCount(userId: string, scope: ParamsScope, pageId: string, after?: number) {
  const f = scopeFilter(scope, pageId);
  const r = await one<{ n: number }>(
    `SELECT COUNT(*) n FROM review_log WHERE user_id=? AND undone_at IS NULL${f.sql}${after === undefined ? "" : " AND reviewed_at>?"}`,
    userId,
    ...f.args,
    ...(after === undefined ? [] : [after]),
  );
  return Number(r?.n || 0);
}
type Model = Awaited<ReturnType<typeof effective>>["model"];
async function optimizerNote(user: Identity, pageId: string, model: Model, now: number) {
  const reviews = await reviewCount(user.id, "deck", pageId);
  if (model.source === "default" || model.at === null) return { reviews, since: null, suggest: reviews >= MIN_REVIEWS ? ("first" as const) : null };
  const since = await reviewCount(user.id, model.source, pageId, model.at);
  const due = since >= REOPTIMIZE_REVIEWS || (now - model.at >= REOPTIMIZE_DAYS * 86_400_000 && since >= REOPTIMIZE_SOME);
  return { reviews, since, suggest: due ? ("again" as const) : null };
}
// The logs of cards as the optimiser reads them: per card the ratings in
// order and the study days since the review before. A card whose log does
// not start with its first rating (state before: new) is left out.
export function trainingCards(rows: HistoryRow[]): TrainingCard[] {
  const cards: TrainingCard[] = [];
  let key = "",
    current: TrainingCard | null = null,
    lastDay = "",
    skip = false;
  for (const row of rows) {
    const k = `${row.row_id}\u0000${row.sub}`;
    if (k !== key) {
      if (current && !skip) cards.push(current);
      key = k;
      skip = Number(row.state_before) !== 0;
      current = { t: [0], r: [Number(row.rating)] };
      lastDay = row.day;
      continue;
    }
    if (skip || !current) continue;
    current.t.push(Math.max(0, daysBetween(lastDay, row.day)));
    current.r.push(Number(row.rating));
    lastDay = row.day;
  }
  if (current && !skip) cards.push(current);
  return cards;
}
// Seconds per kind of review and the shares of ratings, for the
// recommended retention (lib/fsrs/optimize.ts recommendRetention); too few
// timed reviews keep the defaults.
export function reviewCosts(rows: Pick<HistoryRow, "rating" | "state_before" | "duration_ms">[]): ReviewCosts {
  const MIN = 20;
  const sum = { learn: 0, learnN: 0, cards: 0, recall: 0, recallN: 0, lapse: 0, lapseN: 0, relearn: 0 };
  const first = [0, 0, 0, 0],
    recalled = [0, 0, 0];
  for (const r of rows) {
    const state = Number(r.state_before),
      rating = Number(r.rating),
      ms = r.duration_ms === null ? null : Number(r.duration_ms);
    if (state === 0) {
      first[rating - 1]++;
      sum.cards++;
    }
    if (state === 2 && rating > 1) recalled[rating - 2]++;
    if (ms === null) continue;
    if (state === 0 || state === 1) {
      sum.learn += ms;
      sum.learnN++;
    } else if (state === 2 && rating > 1) {
      sum.recall += ms;
      sum.recallN++;
    } else if (state === 2) {
      sum.lapse += ms;
      sum.lapseN++;
    } else sum.relearn += ms;
  }
  const seconds = (ms: number) => Math.round(ms / 100) / 10;
  const shares = <T extends number[]>(counts: T, fallback: T) => {
    const n = counts.reduce((a, b) => a + b, 0);
    return (n >= MIN ? counts.map((x) => Math.round((x / n) * 1000) / 1000) : fallback) as T;
  };
  return {
    learn: sum.learnN >= MIN && sum.cards ? seconds(sum.learn / Math.max(1, Math.min(sum.cards, sum.learnN))) : DEFAULT_COSTS.learn,
    recall: sum.recallN >= MIN ? seconds(sum.recall / sum.recallN) : DEFAULT_COSTS.recall,
    forget: sum.lapseN >= MIN ? seconds((sum.lapse + sum.relearn) / sum.lapseN) : DEFAULT_COSTS.forget,
    first: shares(first as [number, number, number, number], DEFAULT_COSTS.first),
    recalled: shares(recalled as [number, number, number], DEFAULT_COSTS.recalled),
  };
}
async function historyRows(userId: string, scope: ParamsScope, pageId: string) {
  const f = scopeFilter(scope, pageId);
  return await all<HistoryRow>(
    `SELECT row_id,sub,rating,state_before,day,duration_ms FROM review_log WHERE user_id=? AND undone_at IS NULL${f.sql} ORDER BY row_id,sub,reviewed_at,id`,
    userId,
    ...f.args,
  );
}
// The person's own log of a deck or of all their decks, for the optimiser:
// below MIN_REVIEWS ratings only the count.
export async function studyHistory(user: Identity, raw: unknown) {
  const input = historyInput.parse(raw);
  if (!allow(`study-history:${user.id}`, 20, 60_000)) throw new HttpError(429, "Zu viele Anfragen in kurzer Zeit. Bitte später erneut versuchen.");
  const deck = await deckOf(user, input.pageId);
  const settings = requireDeck(deck);
  const clock = await zoneFor(user, input.zone);
  const mine = await effective(user, deck.page.id, settings, studyDay(Date.now(), clock.zone, clock.dayStart));
  const stored = await storedWeights(user.id, deck.page.id, input.scope);
  // "Before": what this scope uses now.
  const current = input.scope === "deck" ? mine.params.weights ?? null : stored?.weights ?? null;
  const base = {
    scope: input.scope,
    minimum: MIN_REVIEWS,
    retention: mine.params.retention,
    maxInterval: settings.maxInterval,
    model: mine.model,
    stored: stored ? { at: stored.at, reviews: stored.reviews } : null,
    current,
    defaults: [...DEFAULT_WEIGHTS],
  };
  const reviews = await reviewCount(user.id, input.scope, deck.page.id);
  if (reviews < MIN_REVIEWS) return { ...base, reviews, cards: [] as TrainingCard[], costs: DEFAULT_COSTS, truncated: false };
  const rows = await historyRows(user.id, input.scope, deck.page.id);
  let cards = trainingCards(rows);
  const total = cards.reduce((n, c) => n + c.r.length, 0);
  const truncated = total > MAX_HISTORY_REVIEWS;
  if (truncated) {
    // Keep the longest-studied cards up to the cap (the order is stable).
    let n = 0;
    cards = [...cards]
      .sort((a, b) => b.r.length - a.r.length)
      .filter((c) => {
        n += c.r.length;
        return n <= MAX_HISTORY_REVIEWS;
      });
  }
  return { ...base, reviews, cards, costs: reviewCosts(rows), truncated };
}
const fitInput = z.object({ logLoss: z.number().min(0).max(100), rmse: z.number().min(0).max(1), items: z.number().int().min(0) }).strict();
const paramsInput = z.object({
  pageId: uuid,
  scope: z.enum(["deck", "all"]).default("deck"),
  // The 21 weights, clamped to FSRS-6's bounds; null: FSRS-6's defaults again.
  weights: z.array(z.number().finite()).length(21).nullable(),
  reviews: z.number().int().min(0).optional(),
  fit: z.object({ before: fitInput, after: fitInput }).strict().optional(),
  zone: zoneInput,
});
// Stores (or resets) the person's weights for a deck or for all decks and
// computes the stability and difficulty of their cards there again from
// the log (Anki does the same); due dates stay.
export async function studyParams(user: Identity, raw: unknown) {
  const input = paramsInput.parse(raw);
  const deck = await deckOf(user, input.pageId);
  requireDeck(deck);
  const now = Date.now();
  const target = input.scope === "all" ? "" : deck.page.id;
  const value = input.weights
    ? JSON.stringify({ version: 1, w: clampWeights(input.weights), reviews: input.reviews ?? (await reviewCount(user.id, input.scope, deck.page.id)), ...(input.fit ? { fit: input.fit } : {}) })
    : null;
  await run(
    `INSERT INTO study_prefs(user_id,page_id,params,params_at,updated_at) VALUES(?,?,?,?,?)
     ON CONFLICT(user_id,page_id) DO UPDATE SET params=excluded.params,params_at=excluded.params_at,updated_at=excluded.updated_at`,
    user.id,
    target,
    value,
    value ? now : null,
    now,
  );
  const recomputed = await recomputeMemory(user, input.scope, deck.page.id);
  const overview = await studyQueue(user, { pageId: input.pageId, zone: input.zone, limit: 0 });
  return { ...overview, recomputed };
}
// The cards of the scope get the stability and difficulty their log gives
// under the weights their deck now uses.
async function recomputeMemory(user: Identity, scope: ParamsScope, pageId: string) {
  const own = scope === "all" ? await decksWithWeights(user.id) : new Set<string>();
  const states = await all<{ row_id: string; sub: string; page_id: string; stability: number; difficulty: number }>(
    `SELECT row_id,sub,page_id,stability,difficulty FROM card_states WHERE user_id=?${scope === "deck" ? " AND page_id=?" : ""}`,
    user.id,
    ...(scope === "deck" ? [pageId] : []),
  );
  const affected = states.filter((s) => scope === "deck" || !own.has(s.page_id));
  if (!affected.length) return 0;
  const byCard = new Map(affected.map((s) => [`${s.row_id}\u0000${s.sub}`, s]));
  const rows = (
    await all<HistoryRow>(
      `SELECT l.row_id,l.sub,l.rating,l.state_before,l.day,l.duration_ms FROM review_log l JOIN card_states s ON s.user_id=l.user_id AND s.row_id=l.row_id AND s.sub=l.sub
        WHERE l.user_id=? AND l.undone_at IS NULL${scope === "deck" ? " AND s.page_id=?" : ""} ORDER BY l.row_id,l.sub,l.reviewed_at,l.id`,
      user.id,
      ...(scope === "deck" ? [pageId] : []),
    )
  ).filter((r) => byCard.has(`${r.row_id}\u0000${r.sub}`));
  // Weights per deck, clipped like the scheduler clips them (ts-fsrs, by
  // the deck's relearning steps).
  const weightsOf = new Map<string, number[]>();
  const weightsFor = async (deckId: string) => {
    if (!weightsOf.has(deckId)) {
      const settings = (await databaseSettings(deckId)).study;
      const w = (await personalWeights(user.id, deckId)).weights ?? [...DEFAULT_WEIGHTS];
      weightsOf.set(deckId, clipParameters(w, settings?.relearningSteps.length ?? 1, true));
    }
    return weightsOf.get(deckId)!;
  };
  let changed = 0;
  const groups = new Map<string, HistoryRow[]>();
  for (const r of rows) {
    const k = `${r.row_id}\u0000${r.sub}`;
    const list = groups.get(k);
    if (list) list.push(r);
    else groups.set(k, [r]);
  }
  for (const [k, list] of groups) {
    const [card] = trainingCards(list);
    const state = byCard.get(k)!;
    if (!card) continue;
    const memory = foldMemory(card, await weightsFor(state.page_id));
    if (!memory) continue;
    const stability = Math.round(memory.stability * 1e8) / 1e8,
      difficulty = Math.round(memory.difficulty * 1e8) / 1e8;
    if (Math.abs(stability - Number(state.stability)) < 1e-6 && Math.abs(difficulty - Number(state.difficulty)) < 1e-6) continue;
    await run("UPDATE card_states SET stability=?,difficulty=?,updated_at=? WHERE user_id=? AND row_id=? AND sub=?", stability, difficulty, Date.now(), user.id, state.row_id, state.sub);
    changed++;
  }
  return changed;
}

// ---- Settings ----

// The daily study reminder (§10.3, lib/study-reminders.ts): a local time
// 'HH:MM' or null (off), with the zone it means. Set after today's moment
// has passed, it starts tomorrow; setting it counts as activity for the
// pause after 30 days without studying.
const reminderInput = z.object({ remindAt: z.string().regex(REMIND_AT).nullable(), zone: zoneInput });
export async function studyReminder(user: Identity, raw: unknown) {
  const input = reminderInput.parse(raw);
  const clock = await zoneFor(user, input.zone);
  const now = Date.now();
  const day = studyDay(now, clock.zone, clock.dayStart);
  const passed = !!input.remindAt && now >= reminderMoment(day, input.remindAt, clock.zone, clock.dayStart);
  await run(
    `INSERT INTO study_prefs(user_id,page_id,time_zone,remind_at,reminded_day,reminder_paused_at,updated_at) VALUES(?,'',?,?,?,NULL,?)
     ON CONFLICT(user_id,page_id) DO UPDATE SET time_zone=excluded.time_zone,remind_at=excluded.remind_at,reminded_day=excluded.reminded_day,reminder_paused_at=NULL,updated_at=excluded.updated_at`,
    user.id,
    clock.zone,
    input.remindAt,
    passed ? day : null,
    now,
  );
  return { remindAt: input.remindAt, zone: clock.zone };
}

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

// ---- CSV export (§8.3) ----

const exportInput = z.object({ pageId: uuid, state: z.boolean().optional(), zone: zoneInput, viewId: z.string().max(100).optional() });
const csvLinks: MarkdownContext = {
  url: (raw) => (/^(https?:|mailto:)/i.test(raw) ? raw : null),
  linked: () => null,
};
// One line per card the person may study (suspended ones too): the sides
// as written – text as plain text with its {{c1::…}} clozes, documents as
// Markdown (the editor's clozes as {{cN::…}}) – hint, extra, tags, type and
// the card ("" the card, "r" its reverse, "c1" … the clozes). With `state`
// the person's own learning state; nobody else's is ever read. The import
// wizard (lib/study-import.ts) reads the file back, one record per line
// with the same front and back.
export async function studyExport(user: Identity, raw: unknown) {
  const input = exportInput.parse(raw);
  const deck = await deckOf(user, input.pageId);
  const settings = requireDeck(deck);
  await drainStudyCards(deck.page.id);
  const clock = await zoneFor(user, input.zone);
  const { cards } = await studyable(user, deck, settings, input.viewId, true);
  const suspended = new Set(
    (await all<{ row_id: string; sub: string }>("SELECT row_id,sub FROM card_states WHERE user_id=? AND page_id=? AND suspended=1", user.id, deck.page.id)).map((r) => `${r.row_id}\u0000${r.sub}`),
  );
  const text = (side: CardSide | undefined) =>
    !side ? "" : "html" in side ? htmlToMarkdown(side.html, csvLinks).trim() : side.formatted ? toPlain(side.text) : side.text;
  const types: Record<string, string> = { basic: ct("Vorder-/Rückseite", "Front/back"), cloze: ct("Lückentext", "Cloze"), typed: ct("Eintippen", "Typed"), choice: ct("Multiple Choice", "Multiple choice"), occlusion: ct("Bildverdeckung", "Image occlusion") };
  const states: Record<number, string> = { 0: ct("Neu", "New"), 1: ct("Lernen", "Learning"), 2: ct("Wiederholung", "Review"), 3: ct("Wiederlernen", "Relearning") };
  const header = [ct("Vorderseite", "Front"), ct("Rückseite", "Back"), ct("Hinweis", "Hint"), ct("Zusatz", "Extra"), "Tags", ct("Kartentyp", "Card type"), ct("Karte", "Card")];
  if (input.state) header.push(ct("Zustand", "State"), ct("Fällig", "Due"), ct("Stabilität (Tage)", "Stability (days)"), ct("Schwierigkeit", "Difficulty"), ct("Wiederholungen", "Reviews"), ct("Vergessen", "Lapses"), ct("Ausgesetzt", "Suspended"));
  const lines: string[][] = [];
  const sorted = [...cards].sort((a, b) => a.position - b.position || (a.rowId < b.rowId ? -1 : a.rowId > b.rowId ? 1 : 0) || (a.sub < b.sub ? -1 : 1));
  for (let i = 0; i < sorted.length; i += 500) {
    const part = sorted.slice(i, i + 500);
    const derived = await cardsOfRows(settings, deck.fields, await rowsOf(deck.page.id, [...new Set(part.map((c) => c.rowId))]));
    for (const c of part) {
      const card = derived.get(c.rowId)?.find((d) => d.sub === c.sub);
      if (!card) continue;
      // The record's sides as written (a reverse card names them as the
      // record does, so the file reads back as one record per line).
      const record = card.sub === "r" ? { front: card.back, back: card.front } : card;
      const line = [text(record.front), text(record.back), text(card.hint), text(card.extra), (card.tags || []).join(", "), types[card.kind] || card.kind, card.sub];
      if (input.state) {
        const m = c.memory;
        line.push(
          states[m?.state ?? 0],
          m ? (m.state === 2 && m.dueDay ? m.dueDay : new Date(m.due).toISOString()) : "",
          m ? String(Math.round(m.stability * 100) / 100) : "",
          m ? String(Math.round(m.difficulty * 100) / 100) : "",
          m ? String(m.reps) : "0",
          m ? String(m.lapses) : "0",
          suspended.has(`${c.rowId}\u0000${c.sub}`) ? ct("ja", "yes") : "",
        );
      }
      lines.push(line);
    }
  }
  const cell = (value: string) => {
    const safe = CSV_FORMULA.test(value) ? `'${value}` : value;
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  void clock;
  return {
    name: `${exportName(deck.page.title || ct("Lernkarten", "Flashcards")).slice(0, 80)}.csv`,
    csv: "﻿" + [header, ...lines].map((l) => l.map(cell).join(",")).join("\r\n") + "\r\n",
    cards: lines.length,
  };
}

// ---- Anki export (§8.2) ----

// Media of an .apkg at most (the ZIP stays below 100 MB).
export const ANKI_EXPORT_MEDIA_BYTES = 80 * 1024 * 1024;
// The cards the person may study (with the view's filters, suspended ones
// too) as Anki notes, one per record: the sides as written – text as HTML,
// documents with their images and sounds as media, clozes as {{cN::…}},
// formulas as \(…\) – tags, and the select "Deck" (as the Anki import
// creates it) as the sub-deck. Only files of this database go along. No
// learning state (it stays in Flowplan).
export async function studyAnkiExport(user: Identity, raw: unknown) {
  const input = exportInput.parse(raw);
  const deck = await deckOf(user, input.pageId);
  const settings = requireDeck(deck);
  await drainStudyCards(deck.page.id);
  const { cards } = await studyable(user, deck, settings, input.viewId, true);
  const { ankiFieldHtml, buildAnkiPackage } = await import("./study-anki-export");
  const allowed = new Set(cards.map((c) => `${c.rowId}\u0000${c.sub}`));
  const position = new Map<string, number>();
  for (const c of cards) position.set(c.rowId, Math.min(position.get(c.rowId) ?? Infinity, c.position));
  const rowIds = [...position.keys()].sort((a, b) => position.get(a)! - position.get(b)! || (a < b ? -1 : 1));
  const deckField = deck.fields.find((f) => f.type === "select" && /^deck$/i.test(f.name.trim()));
  const files = new Map<string, string>();
  const fileName = (fileId: string) => {
    const key = fileId.toLowerCase();
    if (!files.has(key)) files.set(key, "");
    return key;
  };
  const html = (side: CardSide | undefined) =>
    !side ? "" : "html" in side ? ankiFieldHtml(side.html, fileName) : side.formatted ? inlineToHtml(side.text) : escaped(side.text).replace(/\n/g, "<br>");
  type Note = import("./study-anki-export").AnkiExportNote;
  const notes: Note[] = [];
  for (let i = 0; i < rowIds.length; i += 500) {
    const part = rowIds.slice(i, i + 500);
    const stored = await rowsOf(deck.page.id, part);
    const derived = await cardsOfRows(settings, deck.fields, stored);
    const cellsOf = new Map(stored.map((r) => [r.id, JSON.parse(r.cells || "{}") as Record<string, unknown>]));
    for (const rowId of part) {
      const list = (derived.get(rowId) || []).filter((c) => allowed.has(`${rowId}\u0000${c.sub}`));
      if (!list.length) continue;
      const first = list.find((c) => c.sub === "") || list[0];
      const subdeckValue = deckField ? cellsOf.get(rowId)?.[deckField.id] : undefined;
      const subdeck = typeof subdeckValue === "string" && subdeckValue.trim() ? subdeckValue.trim().slice(0, 200) : undefined;
      const tags = first.tags || [];
      const hint = html(first.hint),
        extra = html(first.extra);
      if (first.kind === "occlusion") {
        // One Image Occlusion note per picture: its masks as Anki's
        // "Occlusion" field, a card per mask or group (cloze N → N-1).
        const { toAnkiOcclusion, occlusionTargets } = await import("./study-occlusion");
        for (const src of [...new Set(list.map((c) => c.occlusion!.src))]) {
          const cardsOfImage = list.filter((c) => c.occlusion!.src === src);
          const { mode, masks, alt } = cardsOfImage[0].occlusion!;
          const occlusion = { v: 1 as const, mode, masks };
          const keys = occlusionTargets(occlusion).map((t) => t.key);
          notes.push({
            kind: "occlusion",
            fields: [toAnkiOcclusion(occlusion), ankiFieldHtml(`<img src="${escaped(src)}" alt="${escaped(alt)}">`, fileName), html(first.front), html(first.back), extra],
            ords: cardsOfImage.map((c) => keys.indexOf(c.sub)).filter((i) => i >= 0),
            tags,
            subdeck,
          });
        }
        continue;
      }
      if (first.kind === "cloze") {
        const text = first.cloze?.on === "back" ? first.back : first.front;
        const other = first.cloze?.on === "back" ? first.front : first.back;
        notes.push({ kind: "cloze", fields: [html(text), html(other), hint, extra], ords: list.map((c) => (c.cloze?.n ?? 1) - 1), tags, subdeck });
        continue;
      }
      let front = html(first.front);
      if (first.kind === "choice") {
        const options = [sidePlain(first.back), ...(first.choices || [])].sort((a, b) => a.localeCompare(b));
        front += `<ul>${options.map((o) => `<li>${escaped(o)}</li>`).join("")}</ul>`;
      }
      const kind = first.kind === "typed" ? "typed" : first.kind === "basic" && list.some((c) => c.sub === "r") ? "reversed" : "basic";
      notes.push({ kind, fields: [front, html(first.back), hint, extra], ords: kind === "reversed" ? list.map((c) => (c.sub === "r" ? 1 : 0)) : [0], tags, subdeck });
    }
  }
  // The media: files of this database the sides show.
  const media: { name: string; data: Buffer }[] = [];
  const names = new Map<string, string>();
  const taken = new Set<string>();
  let bytes = 0,
    skipped = 0;
  const ids = [...files.keys()];
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    for (const f of await all<{ id: string; name: string; size: number }>(`SELECT id,name,size FROM files WHERE page_id=? AND id IN (${part.map(() => "?").join(",")})`, deck.page.id, ...part)) {
      if (bytes + Number(f.size) > ANKI_EXPORT_MEDIA_BYTES) {
        skipped++;
        continue;
      }
      const data = await readUpload(f.id);
      if (!data) continue;
      let name = (f.name || "datei").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 120) || "datei";
      if (taken.has(name.toLowerCase())) name = `${f.id.slice(0, 8)}-${name}`;
      taken.add(name.toLowerCase());
      names.set(f.id.toLowerCase(), name);
      bytes += data.length;
      media.push({ name, data });
    }
  }
  // File references become the media names; others are dropped.
  const withMedia = (field: string) =>
    field
      .replace(/\[sound:([0-9a-f-]{36})\]/gi, (_, fid: string) => (names.has(fid.toLowerCase()) ? `[sound:${names.get(fid.toLowerCase())}]` : ""))
      .replace(/<img src="([0-9a-f-]{36})"[^>]*>/gi, (_, fid: string) => (names.has(fid.toLowerCase()) ? `<img src="${escaped(names.get(fid.toLowerCase())!)}">` : ""));
  for (const note of notes) note.fields = note.fields.map(withMedia) as Note["fields"];
  return {
    name: `${exportName(deck.page.title || ct("Lernkarten", "Flashcards")).slice(0, 80)}.apkg`,
    bytes: await buildAnkiPackage(deck.page.title || ct("Lernkarten", "Flashcards"), notes, media),
    notes: notes.length,
    skippedMedia: skipped,
  };
}

// The commands (lib/api.ts): reading the deck is enough for everything but
// the mapping (study.settings, checked there with write access).
export async function studyCommand(user: Identity, action: string, b: Record<string, unknown>) {
  switch (action) {
    case "study.queue":
      return await studyQueue(user, b);
    case "study.review":
      return await studyReview(user, b);
    case "study.reviews":
      return await studyReviews(user, b);
    case "study.reminder":
      return await studyReminder(user, b);
    case "study.undo":
      return await studyUndo(user, b);
    case "study.prefs":
      return await studyPrefs(user, b);
    case "study.history":
      return await studyHistory(user, b);
    case "study.params":
      return await studyParams(user, b);
    case "study.due":
      return await (await import("./study-stats")).studyDue(user, b);
    case "study.stats":
      return await (await import("./study-stats")).studyStats(user, b);
    default:
      throw new HttpError(400, "Unbekannte Aktion.");
  }
}
