// Which cards a study session shows, in which order (docs/specs/flashcards.md
// §4.6, §4.7). Pure: the server builds the queue (lib/study.ts), the client
// orders its batch with the same functions.
// 1. Learning and relearning cards due within the learn-ahead limit (20 min),
//    by due time – they never count against a limit and are never buried.
// 2. Reviews due today up to the day's review limit, by due day, then in a
//    random order seeded by the day (stable within the day).
// 3. New cards up to the new limit, in the order added (or seeded random),
//    mixed between the reviews (one after every n-th review) or before/after.
// Siblings (the other card of the same record) wait for the next day once
// one of them was studied today (bury), and a batch never holds two cards of
// one record.
import type { Memory } from "./fsrs";
import type { StudyViewConfig } from "./study-schema";

export const LEARN_AHEAD_MS = 20 * 60_000;
export type QueueCard = { rowId: string; sub: string; position: number; memory: Memory | null };
export type QueueInput = {
  cards: QueueCard[];
  now: number;
  // The end of the current study day (ms) and its name.
  dayEnd: number;
  day: string;
  // Ratings of today in this deck: of new cards and of reviews.
  done: { new: number; review: number };
  limits: { new: number; review: number };
  // Records with a card studied today (for burying siblings).
  studiedRows: ReadonlySet<string>;
  bury: { new: boolean; review: boolean };
  view?: Partial<StudyViewConfig>;
};
export type Queue = {
  learning: QueueCard[];
  review: QueueCard[];
  new: QueueCard[];
  // What is left today (the header of the session and the overview).
  counts: { new: number; learning: number; review: number };
  // The next learning card later today, when nothing is due now.
  nextDue: number | null;
};

// FNV-1a, for orders that are random but the same all day.
export function seededRank(seed: string, key: string) {
  let h = 0x811c9dc5;
  const s = `${seed}\u0000${key}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}
const byKey = (seed: string) => (a: QueueCard, b: QueueCard) => seededRank(seed, `${a.rowId}:${a.sub}`) - seededRank(seed, `${b.rowId}:${b.sub}`);

export function buildQueue(input: QueueInput): Queue {
  const { now, dayEnd, day } = input;
  const learning: QueueCard[] = [],
    reviews: QueueCard[] = [],
    fresh: QueueCard[] = [];
  for (const card of input.cards) {
    const m = card.memory;
    if (!m) fresh.push(card);
    else if (m.state === 2) {
      if (m.due < dayEnd) reviews.push(card);
    } else if (m.due < dayEnd) learning.push(card);
  }
  learning.sort((a, b) => a.memory!.due - b.memory!.due);
  const order = input.view?.order ?? "due";
  reviews.sort((a, b) => (order === "due" ? (a.memory!.dueDay || "").localeCompare(b.memory!.dueDay || "") : 0) || byKey(day)(a, b));
  if ((input.view?.newOrder ?? "added") === "random") fresh.sort(byKey(day));
  else fresh.sort((a, b) => a.position - b.position || (a.rowId < b.rowId ? -1 : a.rowId > b.rowId ? 1 : 0) || (a.sub < b.sub ? -1 : 1));
  // Siblings: one card per record and day (learning steps excepted).
  const taken = new Set<string>();
  const pick = (list: QueueCard[], bury: boolean, max: number) => {
    const out: QueueCard[] = [];
    for (const card of list) {
      if (out.length >= max) break;
      if (bury && (input.studiedRows.has(card.rowId) || taken.has(card.rowId))) continue;
      taken.add(card.rowId);
      out.push(card);
    }
    return out;
  };
  for (const card of learning) taken.add(card.rowId);
  const review = pick(reviews, input.bury.review, Math.max(0, input.limits.review - input.done.review));
  const added = pick(fresh, input.bury.new, Math.max(0, input.limits.new - input.done.new));
  const dueNow = learning.filter((c) => c.memory!.due <= now + LEARN_AHEAD_MS);
  const later = learning.find((c) => c.memory!.due > now + LEARN_AHEAD_MS);
  return {
    learning: dueNow,
    review,
    new: added,
    counts: { new: added.length, learning: learning.length, review: review.length },
    nextDue: dueNow.length ? null : (later?.memory!.due ?? null),
  };
}
// The order of one batch: learning cards first, then reviews with the new
// cards mixed in.
export function sessionOrder(queue: Pick<Queue, "learning" | "review" | "new">, mixNew: StudyViewConfig["mixNew"] = "mixed"): QueueCard[] {
  const out = [...queue.learning];
  if (mixNew === "before") return [...out, ...queue.new, ...queue.review];
  if (mixNew === "after" || !queue.new.length) return [...out, ...queue.review, ...queue.new];
  const every = Math.max(1, Math.round(queue.review.length / queue.new.length));
  let n = 0;
  for (let i = 0; i < queue.review.length; i++) {
    out.push(queue.review[i]);
    if ((i + 1) % every === 0 && n < queue.new.length) out.push(queue.new[n++]);
  }
  return [...out, ...queue.new.slice(n)];
}
