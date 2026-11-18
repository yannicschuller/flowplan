// FSRS for flashcards (docs/specs/flashcards.md §4): the scheduler of the
// pinned ts-fsrs (MIT, open-spaced-repetition; FSRS-6 with 21 weights,
// short-term stability, learning steps and fuzz) behind a small interface of
// our own, so a port could replace it without touching the callers.
//
// - Days between reviews are study days (lib/study-day.ts): ts-fsrs counts
//   UTC dates, so it gets instants on a virtual clock where each study day is
//   a UTC day (virtualTime).
// - Fuzz is deterministic: its random number is seeded with the review's id
//   (StrategyMode.SEED), so the preview on the buttons, the server and a
//   replay of the log (undo, later offline merges) give the same date.
// - A card in review is due at the start of its study day (04:00 local);
//   learning steps are due minutes later, a step past the end of the study
//   day at the start of the day it falls on.
// Client-safe (used for the intervals on the rating buttons).
import { createEmptyCard, default_w, fsrs, generatorParameters, State, StrategyMode, type Card, type Grade, type StepUnit } from "ts-fsrs";
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
};
export type StudyClockInput = { zone: string; dayStart?: number };
export type Scheduled = { memory: Memory; elapsedDays: number; scheduledDays: number };

// The default weights of the pinned version (tests/fsrs.test.ts compares them).
export const defaultWeights: readonly number[] = default_w;
export const defaultParams: FsrsParams = { retention: 0.9, learningSteps: [1, 10], relearningSteps: [10], maxInterval: 36500 };

const steps = (minutes: number[]): StepUnit[] => minutes.map((m) => `${m}m` as StepUnit);
function scheduler(params: FsrsParams, seed: string) {
  const f = fsrs(
    generatorParameters({
      request_retention: params.retention,
      maximum_interval: params.maxInterval,
      enable_fuzz: true,
      enable_short_term: true,
      learning_steps: steps(params.learningSteps),
      relearning_steps: steps(params.relearningSteps),
      ...(params.weights?.length === 21 ? { w: params.weights } : {}),
    }),
  );
  return f.useStrategy(StrategyMode.SEED, () => seed);
}
function toCard(memory: Memory | null, now: number, clock: StudyClockInput): Card {
  const dayStart = clock.dayStart ?? DEFAULT_DAY_START;
  if (!memory) return createEmptyCard(new Date(virtualTime(now, clock.zone, dayStart)));
  return {
    due: new Date(virtualTime(memory.due, clock.zone, dayStart)),
    stability: memory.stability,
    difficulty: memory.difficulty,
    elapsed_days: 0,
    scheduled_days: 0,
    learning_steps: memory.step,
    reps: memory.reps,
    lapses: memory.lapses,
    state: memory.state as State,
    last_review: new Date(virtualTime(memory.lastReview, clock.zone, dayStart)),
  };
}
function fromCard(card: Card, now: number, clock: StudyClockInput): Memory {
  const dayStart = clock.dayStart ?? DEFAULT_DAY_START;
  const vnow = virtualTime(now, clock.zone, dayStart);
  const state = card.state === State.New ? 1 : (card.state as MemoryState);
  let due: number, dueDay: string | null;
  if (state === 2) {
    dueDay = virtualDay(card.due.getTime());
    due = studyDayStart(dueDay, clock.zone, dayStart);
  } else {
    dueDay = null;
    due = now + Math.max(0, card.due.getTime() - vnow);
    // A step past the end of today's study day waits for the start of its day.
    const today = studyClock(now, clock.zone, dayStart);
    if (due >= today.end) due = studyDayStart(studyDay(due, clock.zone, dayStart), clock.zone, dayStart);
  }
  return {
    state,
    step: card.learning_steps,
    due,
    dueDay,
    stability: card.stability,
    difficulty: card.difficulty,
    reps: card.reps,
    lapses: card.lapses,
    lastReview: now,
  };
}
// The next state of a card rated `rating` at `now` (ms); `seed` is the id
// of the review.
export function schedule(memory: Memory | null, rating: StudyRating, now: number, params: FsrsParams, clock: StudyClockInput, seed: string): Scheduled {
  const dayStart = clock.dayStart ?? DEFAULT_DAY_START;
  const { card, log } = scheduler(params, seed).next(toCard(memory, now, clock), new Date(virtualTime(now, clock.zone, dayStart)), rating as Grade);
  const next = fromCard(card, now, clock);
  return {
    memory: next,
    elapsedDays: memory ? log.elapsed_days : 0,
    scheduledDays: next.dueDay ? daysBetween(studyDay(now, clock.zone, dayStart), next.dueDay) : (next.due - now) / 86_400_000,
  };
}
// All four outcomes (the buttons' intervals), with the same seed.
export function preview(memory: Memory | null, now: number, params: FsrsParams, clock: StudyClockInput, seed: string) {
  return Object.fromEntries(ratings.map((r) => [r, schedule(memory, r, now, params, clock, seed)])) as Record<StudyRating, Scheduled>;
}
export type LoggedReview = { id: string; rating: StudyRating; reviewedAt: number; zone: string };
// The state of a card as the fold of its log (§6.4 undo, §10.4 offline):
// the reviews in order of time, each scheduled with its own id as seed and
// its own zone.
export function replay(reviews: LoggedReview[], params: FsrsParams, dayStart = DEFAULT_DAY_START): Memory | null {
  let memory: Memory | null = null;
  const sorted = [...reviews].sort((a, b) => a.reviewedAt - b.reviewedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const r of sorted) memory = schedule(memory, r.rating, r.reviewedAt, params, { zone: r.zone, dayStart }, r.id).memory;
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
