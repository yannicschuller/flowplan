// FSRS for flashcards (docs/specs/flashcards.md §4): the scheduler of the
// pinned ts-fsrs (MIT, open-spaced-repetition; explicitly the FSRS-6 model
// with 21 weights, short-term stability, learning steps and fuzz) behind a
// small interface of our own, so a port could replace it without touching
// the callers.
//
// - ts-fsrs 6 composes a scheduler from a model, a chrono and middleware
//   (defineScheduler). Here: the FSRS-6 model (ts-fsrs/models/fsrs-6), the
//   date chrono in whole UTC days, ts-fsrs's middleware for the desired
//   retention, the seeded fuzz and the counters, and two of our own that
//   keep the intervals of ts-fsrs 5 (which the cards' stored due dates come
//   from): the maximum interval caps before the fuzz (so a fuzzed interval
//   stays within the range of the capped one), and the learning steps and
//   the order of the review intervals as before (ts-fsrs 6's own policy
//   middleware keeps Hard's step unrounded and also orders a new card's
//   intervals).
// - Days between reviews are study days (lib/study-day.ts): ts-fsrs counts
//   UTC dates, so it gets instants on a virtual clock where each study day is
//   a UTC day (virtualTime). The elapsed days of a review come from the
//   timestamps (the card's last review and now) on that clock.
// - Fuzz is deterministic: ts-fsrs seeds it (FNV-1a + Mulberry32) with the
//   card's id and its number of reviews after this one, so the preview on
//   the buttons, the server, a device studying offline (the same code in the
//   web bundle, also in the app) and a replay of the log (undo, later
//   offline merges) give the same date. The card's id is fsrsCardId(rowId,
//   sub).
// - A card in review is due at the start of its study day (04:00 local);
//   learning steps are due minutes later, a step past the end of the study
//   day at the start of the day it falls on.
// Client-safe (used for the intervals on the rating buttons).
import {
  Rating,
  State,
  calculateLearningSteps,
  dateChrono,
  defineMiddleware,
  defineScheduler,
  fuzzingConfigSchema,
  learningStepFieldsSchema,
  learningStepsConfigSchema,
  schedulerDesiredRetentionMiddleware,
  schedulerFuzzingMiddleware,
  schedulerStatsMiddleware,
  type Grade,
  type StepUnit,
} from "ts-fsrs";
import { FSRS6Model, FSRS6_DEFAULT_WEIGHTS, clipFSRS6Parameters } from "ts-fsrs/models/fsrs-6";
import { DEFAULT_DAY_START, addDays, daysBetween, studyClock, studyDay, studyDayStart, virtualDay, virtualTime } from "../study-day";

export const ratings = [1, 2, 3, 4] as const;
export type StudyRating = (typeof ratings)[number];
// 0 new (no stored state), 1 learning, 2 review, 3 relearning.
export type MemoryState = 1 | 2 | 3;
export type Memory = {
  state: MemoryState;
  step: number;
  due: number;
  // The study day a card in review is due on; null while learning.
  dueDay: string | null;
  stability: number;
  difficulty: number;
  reps: number;
  lapses: number;
  lastReview: number;
};
export type FsrsParams = {
  retention: number;
  // Minutes.
  learningSteps: number[];
  relearningSteps: number[];
  maxInterval: number;
  // 21 weights; the library's defaults when missing (personal ones: phase 8).
  weights?: number[] | null;
  // Fuzz of intervals from 2.5 days on; only tests turn it off.
  fuzz?: boolean;
};
export type StudyClockInput = { zone: string; dayStart?: number };
export type Scheduled = { memory: Memory; elapsedDays: number; scheduledDays: number };

// The FSRS-6 default weights of the pinned version (tests/fsrs.test.ts compares them).
export const defaultWeights: readonly number[] = FSRS6_DEFAULT_WEIGHTS;
export const defaultParams: FsrsParams = { retention: 0.9, learningSteps: [1, 10], relearningSteps: [10], maxInterval: 36500 };

// The id ts-fsrs seeds a card's fuzz with (followed by its reps): stable for
// the card of a record (row) and its sub-card, the same on every device.
// The "#" ends it, so "c1" with 12 reviews and "c11" with 2 differ.
export const fsrsCardId = (rowId: string, sub: string) => `${rowId}/${sub}#`;

// The model's interval capped at the maximum interval, before the fuzz
// wraps it (registered before ts-fsrs's fuzzing middleware): ts-fsrs 5
// fuzzed the capped interval, ts-fsrs 6 caps after the fuzz.
const capped = Symbol("flowplan.capped");
const capBeforeFuzz = defineMiddleware({
  name: Symbol("flowplan.cap-before-fuzz"),
  schema: { config: fuzzingConfigSchema },
  handlers: {
    review(ctx, next) {
      // Wrapped in place, as ts-fsrs's own middleware does (its type is read-only).
      const candidate = ctx.candidate as unknown as { nextInterval: (memoryState: unknown, retention: number) => number; [capped]?: true };
      if (!candidate[capped]) {
        candidate[capped] = true;
        const inner = candidate.nextInterval;
        candidate.nextInterval = (memoryState, retention) => Math.min(inner(memoryState, retention), ctx.config.maximumInterval);
      }
      next();
    },
  },
});
// Learning steps and review intervals as ts-fsrs 5 scheduled them
// (registered after the fuzz, so the intervals asked are fuzzed):
// - new, learning, relearning: the grade's step (Hard halfway between the
//   first two, rounded to whole minutes); a step of a day or more, or none,
//   graduates – a day step as it is, otherwise with the model's interval;
// - review: Again the relearning step (or the model's interval without
//   one), Hard ≤ Good < Easy by at least a day each.
const MINUTES_PER_DAY = 1440;
const stepsAsBefore = defineMiddleware({
  name: Symbol("flowplan.steps-as-before"),
  schema: { config: learningStepsConfigSchema, card: learningStepFieldsSchema, revlog: learningStepFieldsSchema },
  defaultValue: {
    card() {
      return { learningStep: 0 };
    },
  },
  handlers: {
    review(ctx, next) {
      const { card, grade } = ctx.input;
      const interval = (g: Grade) => ctx.candidate.nextInterval(ctx.candidate.step(g), ctx.candidate.desiredRetention[g]);
      let state: number, step: number, days: number;
      if (card.state === State.Review && grade !== Rating.Again) {
        const good0 = interval(Rating.Good);
        const hard = Math.min(interval(Rating.Hard), good0);
        const good = Math.max(good0, hard + 1);
        const easy = Math.max(interval(Rating.Easy), good + 1);
        state = State.Review;
        step = 0;
        days = grade === Rating.Hard ? hard : grade === Rating.Good ? good : easy;
      } else {
        const planned = calculateLearningSteps(ctx.config, card.state, card.learningStep || 0)[grade];
        const raw = Math.max(0, planned?.scheduledMinutes ?? 0);
        const minutes = grade === Rating.Hard ? Math.round(raw) : raw;
        const nextStep = Math.max(0, planned?.nextStep ?? 0);
        if (minutes > 0 && minutes < MINUTES_PER_DAY) {
          state = card.state === State.New ? State.Learning : card.state === State.Review ? State.Relearning : card.state;
          step = nextStep;
          days = Math.round(minutes) / MINUTES_PER_DAY;
        } else if (minutes >= MINUTES_PER_DAY) {
          state = State.Review;
          step = nextStep;
          days = Math.round(minutes) / MINUTES_PER_DAY;
        } else {
          state = State.Review;
          step = 0;
          days = interval(grade);
        }
      }
      ctx.scheduledDays = days;
      next();
      ctx.result.card.state = state as typeof ctx.result.card.state;
      ctx.result.card.scheduleStatus = state === State.Review ? "review" : "learning";
      ctx.result.card.learningStep = step;
      ctx.result.revlog.learningStep = card.learningStep;
    },
  },
});
const definition = defineScheduler({ model: FSRS6Model, chrono: dateChrono }).use(
  schedulerDesiredRetentionMiddleware,
  capBeforeFuzz,
  schedulerFuzzingMiddleware,
  schedulerStatsMiddleware,
  stepsAsBefore,
);
type Scheduler = ReturnType<typeof definition.create>;
type Card = ReturnType<Scheduler["newCard"]>;

// 21 weights clipped to FSRS-6's bounds for a deck with `relearningSteps`
// steps (short-term stability on) – what the scheduler uses, and what
// stored personal weights are brought into after an optimisation.
export const clipWeights = (weights: readonly number[], relearningSteps: number) => clipFSRS6Parameters([...weights], relearningSteps, true);

const steps = (minutes: number[]): StepUnit[] => minutes.map((m) => `${m}m` as StepUnit);
// Schedulers by their parameters: the buttons' preview asks four times in a
// row, a replay once per review.
const schedulers = new Map<string, Scheduler>();
function scheduler(params: FsrsParams): Scheduler {
  const weights = params.weights?.length === 21 ? params.weights : null;
  const key = JSON.stringify([params.retention, params.maxInterval, params.learningSteps, params.relearningSteps, weights, params.fuzz !== false]);
  let s = schedulers.get(key);
  if (!s) {
    s = definition.create({
      config: {
        fractionalDays: false,
        // The scheduler takes the weights as they are: clipped here to the
        // FSRS-6 bounds, with the ceiling of w17/w18 for the relearning
        // steps (as ts-fsrs 5 did, the defaults too).
        weights: clipWeights(weights ?? FSRS6_DEFAULT_WEIGHTS, params.relearningSteps.length),
        enableShortTerm: true,
        numRelearningSteps: params.relearningSteps.length,
        desiredRetention: params.retention,
        learningSteps: steps(params.learningSteps),
        relearningSteps: steps(params.relearningSteps),
        enableFuzz: params.fuzz !== false,
        maximumInterval: params.maxInterval || 36500,
      },
    });
    if (schedulers.size >= 32) schedulers.delete(schedulers.keys().next().value!);
    schedulers.set(key, s);
  }
  return s;
}
function toCard(s: Scheduler, memory: Memory | null, now: number, clock: StudyClockInput, cardId: string): Card {
  const dayStart = clock.dayStart ?? DEFAULT_DAY_START;
  if (!memory) return s.newCard({ now: new Date(virtualTime(now, clock.zone, dayStart)), cardId });
  return {
    cardId,
    dueAt: new Date(virtualTime(memory.due, clock.zone, dayStart)),
    lastReviewAt: new Date(virtualTime(memory.lastReview, clock.zone, dayStart)),
    stability: memory.stability,
    difficulty: memory.difficulty,
    learningStep: memory.step,
    reps: memory.reps,
    lapses: memory.lapses,
    state: memory.state,
    scheduleStatus: memory.state === 2 ? "review" : "learning",
  };
}
function fromCard(card: Card, now: number, clock: StudyClockInput): Memory {
  const dayStart = clock.dayStart ?? DEFAULT_DAY_START;
  const vnow = virtualTime(now, clock.zone, dayStart);
  const state = card.state === 0 ? 1 : (card.state as MemoryState);
  let due: number, dueDay: string | null;
  if (state === 2) {
    dueDay = virtualDay(card.dueAt.getTime());
    due = studyDayStart(dueDay, clock.zone, dayStart);
  } else {
    dueDay = null;
    // Whole seconds: ts-fsrs adds a step as a fraction of a day.
    due = now + Math.max(0, Math.round((card.dueAt.getTime() - vnow) / 1000) * 1000);
    // A step past the end of today's study day waits for the start of its day.
    const today = studyClock(now, clock.zone, dayStart);
    if (due >= today.end) due = studyDayStart(studyDay(due, clock.zone, dayStart), clock.zone, dayStart);
  }
  return {
    state,
    step: card.learningStep,
    due,
    dueDay,
    stability: card.stability,
    difficulty: card.difficulty,
    reps: card.reps,
    lapses: card.lapses,
    lastReview: now,
  };
}
// The next state of a card rated `rating` at `now` (ms); `cardId` is the
// card's fsrsCardId.
export function schedule(memory: Memory | null, rating: StudyRating, now: number, params: FsrsParams, clock: StudyClockInput, cardId: string): Scheduled {
  const dayStart = clock.dayStart ?? DEFAULT_DAY_START;
  const s = scheduler(params);
  const card = toCard(s, memory, now, clock, cardId);
  const vnow = new Date(virtualTime(now, clock.zone, dayStart));
  const next = fromCard(s.review({ card, grade: rating, now: vnow }).card, now, clock);
  return {
    memory: next,
    // Days since the last review on the study-day clock (ts-fsrs 6 keeps no
    // elapsed days on cards or logs; the review log still stores them).
    elapsedDays: memory && card.lastReviewAt ? s.chrono.difference(card.lastReviewAt, vnow) : 0,
    scheduledDays: next.dueDay ? daysBetween(studyDay(now, clock.zone, dayStart), next.dueDay) : (next.due - now) / 86_400_000,
  };
}
// All four outcomes (the buttons' intervals), as schedule gives them.
export function preview(memory: Memory | null, now: number, params: FsrsParams, clock: StudyClockInput, cardId: string) {
  return Object.fromEntries(ratings.map((r) => [r, schedule(memory, r, now, params, clock, cardId)])) as Record<StudyRating, Scheduled>;
}
export type LoggedReview = { id: string; rating: StudyRating; reviewedAt: number; zone: string };
// The state of a card as the fold of its log (§6.4 undo, §10.4 offline):
// the reviews in order of time, each scheduled in its own zone.
export function replay(cardId: string, reviews: LoggedReview[], params: FsrsParams, dayStart = DEFAULT_DAY_START): Memory | null {
  let memory: Memory | null = null;
  const sorted = [...reviews].sort((a, b) => a.reviewedAt - b.reviewedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const r of sorted) memory = schedule(memory, r.rating, r.reviewedAt, params, { zone: r.zone, dayStart }, cardId).memory;
  return memory;
}
// The probability of recalling a card in review now (FSRS-6 forgetting
// curve with the weights' decay, w20).
export function retrievability(memory: Memory, now: number, clock: StudyClockInput, weights: readonly number[] = defaultWeights) {
  const dayStart = clock.dayStart ?? DEFAULT_DAY_START;
  const elapsed = Math.max(0, daysBetween(studyDay(memory.lastReview, clock.zone, dayStart), studyDay(now, clock.zone, dayStart)));
  const decay = -weights[20];
  const factor = Math.pow(0.9, 1 / decay) - 1;
  return Math.pow(1 + (factor * elapsed) / Math.max(memory.stability, 0.001), decay);
}
// "in 10 min", "in 4 days" – the time until a scheduled card is due, in
// the largest unit that fits (rounded), for the buttons.
export type IntervalUnit = "now" | "minutes" | "hours" | "days" | "months" | "years";
export function intervalOf(memory: Memory, now: number, clock: StudyClockInput): { unit: IntervalUnit; value: number } {
  const dayStart = clock.dayStart ?? DEFAULT_DAY_START;
  if (memory.dueDay) {
    const days = Math.max(1, daysBetween(studyDay(now, clock.zone, dayStart), memory.dueDay));
    if (days >= 365) return { unit: "years", value: Math.round((days / 365) * 10) / 10 };
    if (days >= 30) return { unit: "months", value: Math.round((days / 30) * 10) / 10 };
    return { unit: "days", value: days };
  }
  const minutes = (memory.due - now) / 60_000;
  if (minutes < 1) return { unit: "now", value: 0 };
  if (minutes < 60) return { unit: "minutes", value: Math.round(minutes) };
  if (minutes < 1440) return { unit: "hours", value: Math.round(minutes / 6) / 10 };
  return { unit: "days", value: Math.max(1, daysBetween(studyDay(now, clock.zone, dayStart), addDays(studyDay(memory.due, clock.zone, dayStart), 0))) };
}
