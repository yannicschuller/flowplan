// Studying flashcards without a connection (docs/specs/flashcards.md §10.4).
//
// - The deck comes from the offline copy: GET /api/pages/{id}/study
//   ?offline=1 (lib/study.ts studyOffline), stored for the decks studied in
//   the last 14 days (lib/offline-plan.ts planStudy). It holds every card
//   with its content and the person's state, today's ratings and the
//   limits.
// - The queue is built here with the same pure functions as on the server
//   (lib/study-queue.ts buildQueue/sessionOrder, lib/fsrs schedule), from
//   that state with the ratings still waiting applied on top.
// - Ratings wait in a queue of their own in IndexedDB (database
//   "flowplan-study", per person: every entry names its user) – not in the
//   record queue (lib/offline-queue.ts): a rating is no change of a record
//   and has no conflicts. They are sent as study.reviews (up to 500 at a
//   time, in the order made) once the connection is back; the server keeps
//   them idempotent by their id and replays a card's log when one arrives
//   late (lib/study.ts studyReviews).
// Client-safe: the IndexedDB part runs in the browser only; the rest is
// pure and tested (tests/study-offline.test.ts).
import { fsrsCardId, schedule, type FsrsParams, type Memory, type StudyRating } from "./fsrs";
import { buildQueue, sessionOrder, type QueueCard } from "./study-queue";
import { studyClock, studyDay } from "./study-day";
import type { StudyViewConfig } from "./study-schema";
import { STUDY_PENDING, setStudyPendingFlag } from "./study-pending-flag";

export type PendingReview = {
  id: string;
  userId: string;
  pageId: string;
  rowId: string;
  sub: string;
  rating: StudyRating;
  reviewedAt: number;
  zone: string;
  durationMs?: number;
  // The card's number of reviews the device knew (sent along).
  baseReps: number;
};
type Counts = { new: number; review: number };
// The stored deck (the answer of studyOffline, as far as used here).
export type OfflineDeck<Card extends { rowId: string; sub: string; memory: Memory | null } = { rowId: string; sub: string; memory: Memory | null }> = {
  pageId: string;
  title: string;
  userId: string;
  zone: string;
  dayStart: number;
  day: string;
  now: number;
  offline: true;
  configured: true;
  blocked: "hidden" | null;
  settings: { buryNew?: boolean; buryReviews?: boolean; typedCompare?: unknown };
  params: FsrsParams;
  limits: Counts;
  baseLimits: Counts;
  prefs?: unknown;
  deckDefaults?: unknown;
  done: Counts & { all: number };
  studiedRows: string[];
  views: Record<string, { rows?: string[]; study?: Partial<StudyViewConfig> }>;
  total: number;
  cards: Card[];
};
export const isOfflineDeck = (value: unknown): value is OfflineDeck =>
  !!value && typeof value === "object" && (value as { offline?: unknown }).offline === true && (value as { configured?: unknown }).configured === true && Array.isArray((value as { cards?: unknown }).cards);

export type LocalOptions = { now: number; zone: string; viewId?: string; limit: number; ahead?: boolean };
// The deck as the server would answer study.queue, built on the device:
// the stored state with the waiting ratings of this deck applied in the
// order made, counts and limits of the study day now (a new day starts
// from zero with the limits of any day), the view's records (a sub-deck)
// and up to `limit` cards in session order.
export function localQueue<Card extends { rowId: string; sub: string; memory: Memory | null }>(deck: OfflineDeck<Card>, pending: PendingReview[], options: LocalOptions) {
  const { now } = options;
  const dayStart = deck.dayStart;
  const today = studyClock(now, options.zone, dayStart);
  const sameDay = today.day === deck.day;
  const done = sameDay ? { ...deck.done } : { new: 0, review: 0, all: 0 };
  const studied = new Set(sameDay ? deck.studiedRows : []);
  const key = (rowId: string, sub: string) => `${rowId}\u0000${sub}`;
  const memories = new Map(deck.cards.map((c) => [key(c.rowId, c.sub), c.memory]));
  // A card of a part of the deck with weights of its own carries them (#344).
  const weightsOf = new Map(deck.cards.map((c) => [key(c.rowId, c.sub), (c as { weights?: number[] }).weights]));
  const mine = pending.filter((p) => p.pageId === deck.pageId && p.userId === deck.userId).sort((a, b) => a.reviewedAt - b.reviewedAt || (a.id < b.id ? -1 : 1));
  for (const p of mine) {
    const k = key(p.rowId, p.sub);
    if (!memories.has(k)) continue;
    const before = memories.get(k) ?? null;
    const weights = weightsOf.get(k);
    memories.set(k, schedule(before, p.rating, p.reviewedAt, weights ? { ...deck.params, weights } : deck.params, { zone: p.zone, dayStart }, fsrsCardId(p.rowId, p.sub)).memory);
    if (studyDay(p.reviewedAt, options.zone, dayStart) !== today.day) continue;
    done.all++;
    if (!before) done.new++;
    else if (before.state === 2) done.review++;
    studied.add(p.rowId);
  }
  const view = options.viewId ? deck.views[options.viewId] : undefined;
  const inView = view?.rows ? new Set(view.rows) : null;
  const cards: QueueCard[] = deck.cards
    .filter((c) => !inView || inView.has(c.rowId))
    .map((c, position) => ({ rowId: c.rowId, sub: c.sub, position, memory: memories.get(key(c.rowId, c.sub)) ?? null }));
  const limits = sameDay ? deck.limits : deck.baseLimits;
  const queue = buildQueue({
    cards,
    now,
    day: today.day,
    dayEnd: today.end,
    done,
    limits,
    studiedRows: studied,
    bury: { new: deck.settings.buryNew ?? true, review: deck.settings.buryReviews ?? true },
    view: view?.study,
    ...(options.ahead ? { learnAhead: Math.max(0, today.end - now) } : {}),
  });
  const content = new Map(deck.cards.map((c) => [key(c.rowId, c.sub), c]));
  const batch = sessionOrder(queue, view?.study?.mixNew).slice(0, options.limit);
  const states = { new: 0, learning: 0, review: 0 };
  for (const c of cards) states[!c.memory ? "new" : c.memory.state === 2 ? "review" : "learning"]++;
  const { studiedRows: _rows, views: _views, baseLimits: _base, cards: _cards, ...rest } = deck;
  return {
    ...rest,
    zone: options.zone,
    day: today.day,
    dayEnd: today.end,
    now,
    limits,
    done,
    counts: queue.counts,
    nextDue: queue.nextDue,
    total: cards.length,
    states,
    tomorrow: cards.filter((c) => c.memory && c.memory.due >= today.end && c.memory.due < today.end + 86_400_000).length,
    pending: mine.length,
    cards: batch.map((c) => ({ ...content.get(key(c.rowId, c.sub))!, memory: c.memory })),
  };
}

// Batches for study.reviews, in the order made.
export const REVIEWS_PER_CALL = 500;
export function reviewBatches(pending: PendingReview[], userId: string) {
  const mine = pending.filter((p) => p.userId === userId).sort((a, b) => a.reviewedAt - b.reviewedAt || (a.id < b.id ? -1 : 1));
  const out: PendingReview[][] = [];
  for (let i = 0; i < mine.length; i += REVIEWS_PER_CALL) out.push(mine.slice(i, i + REVIEWS_PER_CALL));
  return out;
}

// ---- IndexedDB ----

const DB_NAME = "flowplan-study";
const STORE = "reviews";
// Fired on window when the waiting ratings changed (detail: none).
export { STUDY_PENDING };
let opening: Promise<IDBDatabase> | null = null;
function database(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("IndexedDB is not available."));
  opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE, { keyPath: "id" });
      store.createIndex("user", "userId");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      opening = null;
      reject(request.error);
    };
  });
  return opening;
}
function done<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
const changed = () => {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(STUDY_PENDING));
};
// The person's waiting ratings (all decks, or one).
export async function pendingReviews(userId: string, pageId?: string): Promise<PendingReview[]> {
  try {
    const db = await database();
    const list = (await done(db.transaction(STORE).objectStore(STORE).index("user").getAll(userId))) as PendingReview[];
    return pageId ? list.filter((r) => r.pageId === pageId) : list;
  } catch {
    return [];
  }
}
export async function queueReview(review: PendingReview) {
  const db = await database();
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).put(review);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  setStudyPendingFlag(true);
  changed();
}
export async function dropReviews(ids: string[]) {
  if (!ids.length) return;
  const db = await database();
  const tx = db.transaction(STORE, "readwrite");
  for (const id of ids) tx.objectStore(STORE).delete(id);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  changed();
}
// Everything of this device (offline use switched off, signed out).
export async function clearPendingReviews() {
  try {
    const db = await database();
    await done(db.transaction(STORE, "readwrite").objectStore(STORE).clear());
    changed();
  } catch {}
}
