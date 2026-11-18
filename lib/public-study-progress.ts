// The learning state of a public link's practice (docs/specs/flashcards.md
// §7.3), kept only in the visitor's browser: localStorage under
// `flowplan-study:<shareToken>`, never a cookie, nothing sent anywhere.
// Without localStorage (blocked, a private window that refuses it) the
// practice keeps it in memory: a one-off session.
//
// Per deck of the link: the state of each card at the start of today
// (`base`) and today's ratings (`reviews`); a rating of an earlier study day
// is folded into the base on the next start, so the list stays short. The
// queue is built with the app's own functions (lib/study-offline.ts
// localQueue: lib/study-queue.ts and lib/fsrs), as offline in the app.
// Client-safe and pure apart from the storage; tested in
// tests/public-study.test.ts.
import { schedule, type FsrsParams, type Memory } from "./fsrs";
import { localQueue, type OfflineDeck, type PendingReview } from "./study-offline";
import { DEFAULT_DAY_START, studyClock, studyDay } from "./study-day";
import type { StudySettings } from "./study-schema";
import { progressKey } from "./public-study-key";

export { hasProgress, progressKey } from "./public-study-key";
// The ratings of one day kept per deck at most (more is not studied in a day).
export const MAX_DAY_REVIEWS = 5000;

export type DeckProgress = {
  // Card ("rowId\u0000sub") → its state at the start of `day`.
  base: Record<string, Memory>;
  day: string;
  reviews: PendingReview[];
  // "Heute mehr lernen": extra new cards per study day.
  more: Record<string, number>;
};
export type Progress = { v: 1; noted?: boolean; decks: Record<string, DeckProgress> };
export const emptyProgress = (): Progress => ({ v: 1, decks: {} });

const isMemory = (m: unknown): m is Memory =>
  !!m && typeof m === "object" && [1, 2, 3].includes((m as Memory).state) && Number.isFinite((m as Memory).due) && Number.isFinite((m as Memory).stability);
// What localStorage held; anything else is no progress.
export function parseProgress(raw: string | null | undefined): Progress {
  if (!raw) return emptyProgress();
  try {
    const value = JSON.parse(raw) as Partial<Progress>;
    if (value?.v !== 1 || !value.decks || typeof value.decks !== "object") return emptyProgress();
    const decks: Record<string, DeckProgress> = {};
    for (const [pageId, d] of Object.entries(value.decks)) {
      if (!d || typeof d !== "object") continue;
      const base = Object.fromEntries(Object.entries(d.base || {}).filter(([, m]) => isMemory(m)));
      const reviews = Array.isArray(d.reviews) ? d.reviews.filter((r) => r && typeof r.rowId === "string" && typeof r.sub === "string" && [1, 2, 3, 4].includes(r.rating) && Number.isFinite(r.reviewedAt)) : [];
      const more = Object.fromEntries(Object.entries(d.more || {}).filter(([, n]) => Number.isInteger(n) && (n as number) > 0)) as Record<string, number>;
      decks[pageId] = { base, day: typeof d.day === "string" ? d.day : "", reviews: reviews.slice(-MAX_DAY_REVIEWS), more };
    }
    return { v: 1, ...(value.noted ? { noted: true } : {}), decks };
  } catch {
    return emptyProgress();
  }
}

export const cardKey = (rowId: string, sub: string) => `${rowId}\u0000${sub}`;
export type PracticeSettings = Pick<StudySettings, "newPerDay" | "reviewsPerDay" | "retention" | "learningSteps" | "relearningSteps" | "maxInterval" | "buryNew" | "buryReviews" | "typedCompare">;
export const practiceParams = (s: PracticeSettings): FsrsParams => ({ retention: s.retention, learningSteps: s.learningSteps, relearningSteps: s.relearningSteps, maxInterval: s.maxInterval });

// The deck's progress on the study day of `now`: ratings of earlier days
// folded into the base, in the order made.
export function currentDeck(progress: DeckProgress | undefined, params: FsrsParams, now: number, zone: string): DeckProgress {
  const today = studyDay(now, zone, DEFAULT_DAY_START);
  const deck: DeckProgress = progress ? { base: { ...progress.base }, day: progress.day, reviews: [...progress.reviews], more: { ...progress.more } } : { base: {}, day: today, reviews: [], more: {} };
  const sorted = deck.reviews.sort((a, b) => a.reviewedAt - b.reviewedAt || (a.id < b.id ? -1 : 1));
  const kept: PendingReview[] = [];
  for (const r of sorted) {
    if (studyDay(r.reviewedAt, zone, DEFAULT_DAY_START) === today) {
      kept.push(r);
      continue;
    }
    const key = cardKey(r.rowId, r.sub);
    deck.base[key] = schedule(deck.base[key] ?? null, r.rating, r.reviewedAt, params, { zone: r.zone, dayStart: DEFAULT_DAY_START }, r.id).memory;
  }
  deck.reviews = kept;
  deck.day = today;
  for (const day of Object.keys(deck.more)) if (day !== today) delete deck.more[day];
  return deck;
}

// The session's batch (or only the counts, limit 0) like the server's
// study.queue answer, for components/study/focus-core.tsx.
export function practiceQueue<Card extends { rowId: string; sub: string }>(
  input: { pageId: string; title: string; settings: PracticeSettings; cards: Card[]; progress: DeckProgress },
  options: { now: number; zone: string; limit: number; ahead?: boolean },
) {
  const { settings, progress } = input;
  const today = studyClock(options.now, options.zone, DEFAULT_DAY_START);
  const limits = { new: settings.newPerDay + (progress.more[today.day] || 0), review: settings.reviewsPerDay };
  const deck: OfflineDeck<Card & { memory: Memory | null }> = {
    pageId: input.pageId,
    title: input.title,
    userId: "",
    zone: options.zone,
    dayStart: DEFAULT_DAY_START,
    day: progress.day,
    now: options.now,
    offline: true,
    configured: true,
    blocked: null,
    settings: { buryNew: settings.buryNew, buryReviews: settings.buryReviews, typedCompare: settings.typedCompare },
    params: practiceParams(settings),
    limits,
    baseLimits: { new: settings.newPerDay, review: settings.reviewsPerDay },
    done: { new: 0, review: 0, all: 0 },
    studiedRows: [],
    views: {},
    total: input.cards.length,
    cards: input.cards.map((c) => ({ ...c, memory: progress.base[cardKey(c.rowId, c.sub)] ?? null })),
  };
  return localQueue(deck, progress.reviews.map((r) => ({ ...r, userId: "", pageId: input.pageId })), options);
}

// localStorage, or memory when the browser refuses it.
export type ProgressStore = { persistent: boolean; read: () => Progress; write: (progress: Progress) => void; clear: () => void };
export function progressStore(token: string, storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null): ProgressStore {
  const key = progressKey(token);
  let memory = emptyProgress();
  let persistent = false;
  if (storage)
    try {
      const probe = `${key}:probe`;
      storage.setItem(probe, "1");
      storage.removeItem(probe);
      persistent = true;
    } catch {}
  return {
    persistent,
    read: () => {
      if (!persistent) return memory;
      try {
        return parseProgress(storage!.getItem(key));
      } catch {
        return memory;
      }
    },
    write: (progress) => {
      memory = progress;
      if (!persistent) return;
      try {
        storage!.setItem(key, JSON.stringify(progress));
      } catch {
        // Full: this session goes on in memory.
      }
    },
    clear: () => {
      memory = emptyProgress();
      try {
        storage?.removeItem(key);
      } catch {}
    },
  };
}
