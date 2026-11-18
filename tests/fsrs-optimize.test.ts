// The FSRS optimiser (docs/specs/flashcards.md §23, lib/fsrs/optimize.ts):
// its model against the pinned ts-fsrs (memory states of whole logs, with
// learning steps and study days), its gradient against finite differences,
// recovering known weights from synthetic logs, the bounds, determinism,
// and the recommended retention.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FSRSAlgorithm, generatorParameters, type Grade } from "ts-fsrs";
import {
  DEFAULT_WEIGHTS,
  MIN_ITEMS,
  RETENTION_RANGE,
  WEIGHT_BOUNDS,
  clampWeights,
  evaluate,
  lossGradient,
  memoryOf,
  optimize,
  MIN_START,
  OptimizeTimeout,
  initLoss,
  optimizeAsync,
  outlierBuckets,
  prepareTraining,
  recommendRetention,
  retentionCurve,
  searchStability,
  seeded,
  simulateDeck,
  smoothAndFill,
  workload,
  type SimDeck,
  trainingItems,
  type TrainingCard,
} from "../lib/fsrs/optimize";
import { defaultParams, replay, type LoggedReview, type StudyRating } from "../lib/fsrs";
import { daysBetween, studyDay } from "../lib/study-day";
import { TRUE_WEIGHTS, syntheticLog } from "./helpers/fsrs-synthetic";

const near = (a: number, b: number, eps: number, what = "") => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${what} ${a} ≈ ${b}`);

test("the bounds are ts-fsrs's (and fsrs-rs's) for FSRS-6, and clamping keeps every weight inside", () => {
  assert.equal(WEIGHT_BOUNDS.length, 21);
  assert.deepEqual(WEIGHT_BOUNDS[4], [1, 10]);
  assert.deepEqual(WEIGHT_BOUNDS[20], [0.1, 0.8]);
  assert.deepEqual(WEIGHT_BOUNDS[19], [0.01, 0.8]);
  const wild = clampWeights([-5, 1000, NaN, 3, 0, 9, 9, 9, -1, 9, 9, 9, 9, 9, 9, 9, 0, 9, 9, 9, 9]);
  wild.forEach((w, i) => assert.ok(w >= WEIGHT_BOUNDS[i][0] && w <= WEIGHT_BOUNDS[i][1], `w${i} = ${w}`));
  assert.equal(wild[2], DEFAULT_WEIGHTS[2], "not a number: the default");
  // The defaults are inside the bounds.
  assert.deepEqual(clampWeights(DEFAULT_WEIGHTS), [...DEFAULT_WEIGHTS]);
});

// Logs of cards rated at real moments (learning steps minutes apart, reviews
// days apart, a few lapses), replayed with lib/fsrs (ts-fsrs's scheduler with
// its learning steps and the study day's clock) and folded with the
// optimiser's model on study days.
function randomLogs(seed: number, cards: number) {
  const random = seeded(seed);
  const zone = "Europe/Berlin";
  const out: { reviews: LoggedReview[]; card: TrainingCard }[] = [];
  for (let c = 0; c < cards; c++) {
    let at = Date.parse("2026-01-05T09:00:00Z") + Math.floor(random() * 40) * 86_400_000;
    const reviews: LoggedReview[] = [];
    const n = 2 + Math.floor(random() * 10);
    for (let i = 0; i < n; i++) {
      const rating = (1 + Math.floor(random() * 4)) as StudyRating;
      reviews.push({ id: `c${c}-r${i}`, rating, reviewedAt: at, zone });
      // Same day (a step) or days later.
      at += random() < 0.35 ? (1 + Math.floor(random() * 15)) * 60_000 : (1 + Math.floor(random() * 30)) * 86_400_000 + Math.floor(random() * 5) * 3_600_000;
    }
    const days = reviews.map((r) => studyDay(r.reviewedAt, zone));
    out.push({ reviews, card: { t: days.map((d, i) => (i ? daysBetween(days[i - 1], d) : 0)), r: reviews.map((r) => r.rating) } });
  }
  return out;
}

test("the model folds a log to the same stability and difficulty as ts-fsrs's scheduler (lib/fsrs replay)", () => {
  for (const weights of [DEFAULT_WEIGHTS, TRUE_WEIGHTS]) {
    const params = { ...defaultParams, weights: [...weights] };
    for (const { reviews, card } of randomLogs(weights === DEFAULT_WEIGHTS ? 1 : 2, 150)) {
      const expected = replay(reviews, params)!;
      const got = memoryOf(card, weights)!;
      near(got.stability, expected.stability, 1e-5, "stability");
      near(got.difficulty, expected.difficulty, 1e-5, "difficulty");
    }
  }
});

test("the predicted retrievability is ts-fsrs's forgetting curve before each review a day or more later", () => {
  const alg = new FSRSAlgorithm(generatorParameters({ w: [...TRUE_WEIGHTS], enable_short_term: true }));
  const card: TrainingCard = { t: [0, 0, 3, 0, 9, 20], r: [1, 3, 3, 1, 3, 4] };
  // Log loss by hand from ts-fsrs's next_state and forgetting_curve.
  let state = alg.next_state(null, 0, card.r[0] as Grade),
    loss = 0,
    items = 0;
  for (let i = 1; i < card.r.length; i++) {
    if (card.t[i] > 0) {
      const r = alg.forgetting_curve(card.t[i], state.stability);
      loss -= card.r[i] > 1 ? Math.log(r) : Math.log(1 - r);
      items++;
    }
    state = alg.next_state(state, card.t[i], card.r[i] as Grade);
  }
  const fit = evaluate([card], TRUE_WEIGHTS);
  assert.equal(fit.items, items);
  assert.equal(trainingItems([card]), 3);
  near(fit.logLoss, loss / items, 1e-7, "log loss");
});

test("the gradient is the loss's (finite differences)", () => {
  const cards = syntheticLog(TRUE_WEIGHTS, 120, 5);
  const at = [...DEFAULT_WEIGHTS].map((w, i) => (i === 7 ? 0.05 : w));
  const { loss, grad } = lossGradient(cards, at);
  const total = (w: number[]) => {
    const fit = evaluate(cards, w);
    return fit.logLoss * fit.items;
  };
  near(loss, total(at), 1e-9, "loss");
  for (let i = 0; i < 21; i++) {
    const h = 1e-6 * Math.max(1, Math.abs(at[i]));
    const up = [...at],
      down = [...at];
    up[i] += h;
    down[i] -= h;
    const numeric = (total(up) - total(down)) / (2 * h);
    assert.ok(Math.abs(grad[i] - numeric) <= 1e-3 * Math.max(1, Math.abs(numeric)), `∂/∂w${i}: ${grad[i]} vs ${numeric}`);
  }
});

test("optimising a synthetic log recovers the weights that made it: the loss falls to the truth's, the weights move towards it", () => {
  const cards = syntheticLog(TRUE_WEIGHTS, 2000, 1);
  const result = optimize(cards);
  const truth = evaluate(cards, TRUE_WEIGHTS);
  assert.ok(result.after.logLoss < result.before.logLoss - 0.005, `${result.after.logLoss} < ${result.before.logLoss}`);
  assert.ok(result.after.logLoss <= truth.logLoss + 0.001, `${result.after.logLoss} ≈ truth ${truth.logLoss}`);
  assert.ok(result.after.rmse < result.before.rmse / 3, `RMSE ${result.after.rmse} ≪ ${result.before.rmse}`);
  // Distance to the truth, each weight relative to its range.
  const distance = (w: readonly number[]) => w.reduce((sum, x, i) => sum + Math.abs(x - TRUE_WEIGHTS[i]) / (WEIGHT_BOUNDS[i][1] - WEIGHT_BOUNDS[i][0]), 0);
  assert.ok(distance(result.weights) < distance(DEFAULT_WEIGHTS) * 0.75, `${distance(result.weights)} < 0.75 × ${distance(DEFAULT_WEIGHTS)}`);
  // The initial stabilities and the decay, which the log shows most plainly.
  for (const i of [1, 2, 3, 20]) assert.ok(Math.abs(result.weights[i] - TRUE_WEIGHTS[i]) < Math.abs(DEFAULT_WEIGHTS[i] - TRUE_WEIGHTS[i]), `w${i} ${result.weights[i]} towards ${TRUE_WEIGHTS[i]}`);
  // Applied to a fresh log of the same person, the fit still beats the defaults.
  const fresh = syntheticLog(TRUE_WEIGHTS, 800, 99);
  assert.ok(evaluate(fresh, result.weights).logLoss < evaluate(fresh, DEFAULT_WEIGHTS).logLoss);
});

test("the defaults' own log leaves them nearly where they are", () => {
  const cards = syntheticLog(DEFAULT_WEIGHTS, 1500, 3);
  const result = optimize(cards);
  assert.ok(result.after.logLoss <= result.before.logLoss + 1e-4);
  result.weights.forEach((w, i) => assert.ok(Math.abs(w - DEFAULT_WEIGHTS[i]) <= 0.35 * (WEIGHT_BOUNDS[i][1] - WEIGHT_BOUNDS[i][0]), `w${i} ${w}`));
});

test("the fit stays inside the bounds, also for a log that pushes out of them", () => {
  // Everything forgotten, always: stabilities and decay want to leave the range.
  const forgotten: TrainingCard[] = Array.from({ length: 400 }, () => ({ t: [0, 1, 1, 2, 5], r: [1, 1, 1, 1, 1] }));
  // Everything remembered after very long gaps.
  const remembered: TrainingCard[] = Array.from({ length: 400 }, () => ({ t: [0, 300, 900, 3000], r: [4, 4, 4, 4] }));
  for (const cards of [forgotten, remembered]) {
    const { weights } = optimize(cards);
    weights.forEach((w, i) => assert.ok(w >= WEIGHT_BOUNDS[i][0] && w <= WEIGHT_BOUNDS[i][1], `w${i} = ${w} in ${WEIGHT_BOUNDS[i]}`));
  }
  // A start outside the bounds is clamped first.
  const { weights } = optimize(syntheticLog(TRUE_WEIGHTS, 100, 4), { start: DEFAULT_WEIGHTS.map((w, i) => (i === 4 ? 50 : w)) });
  assert.ok(weights[4] <= 10);
});

test("the fit is deterministic: the same log gives the same weights", () => {
  const cards = syntheticLog(TRUE_WEIGHTS, 400, 8);
  const a = optimize(cards),
    b = optimize(cards.map((c) => ({ t: [...c.t], r: [...c.r] })));
  assert.deepEqual(a.weights, b.weights);
  assert.deepEqual(a.after, b.after);
  // The shuffle's seed is what could change it.
  assert.notDeepEqual(optimize(cards, { seed: 1 }).weights, a.weights);
});

test("too little to learn from: only w0–w3 are initialised (fewer than 8: the start comes back unchanged)", () => {
  const cards: TrainingCard[] = Array.from({ length: MIN_ITEMS - 1 }, () => ({ t: [0, 2], r: [3, 3] }));
  const result = optimize(cards);
  assert.deepEqual(result.weights.slice(4), DEFAULT_WEIGHTS.slice(4));
  assert.ok(result.weights[2] > DEFAULT_WEIGHTS[2], "always remembered after two days: more stable than the default");
  assert.deepEqual([...result.weights.slice(0, 4)].sort((a, b) => a - b), result.weights.slice(0, 4), "in order of the ratings");
  assert.equal(result.after.items, MIN_ITEMS - 1);
  const few = optimize(cards.slice(0, MIN_START - 1));
  assert.deepEqual(few.weights, [...DEFAULT_WEIGHTS]);
  assert.deepEqual(optimize(cards, { prepare: false }).weights, [...DEFAULT_WEIGHTS], "without the initialisation: as before");
});

// fsrs-rs's own reference numbers (src/parameter_initialization.rs tests,
// FSRS-6 defaults): the initialisation's objective, the search of one
// rating's stability and the smoothing and filling of w0–w3. fsrs-rs
// computes in f32, hence the tolerances.
test("the initialisation of w0–w3 matches fsrs-rs's reference values", () => {
  const data = [
    { delta: 1, recall: 0.86666667, count: 435 },
    { delta: 2, recall: 0.90721649, count: 97 },
    { delta: 3, recall: 0.73015873, count: 63 },
    { delta: 4, recall: 0.76315789, count: 38 },
    { delta: 5, recall: 0.67857143, count: 28 },
  ];
  near(initLoss(data, 0.7840586, DEFAULT_WEIGHTS[0]), 279.9206961069712, 1e-6, "loss");
  near(initLoss(data, 0.7840590622451964, DEFAULT_WEIGHTS[0]), 279.9206977311556, 1e-6, "loss");
  near(searchStability(new Map([[1, data]]), 0.94302857).get(1)!, 0.7355089, 2e-6, "search");
  const fill = (s: [number, number][], n: [number, number][]) => smoothAndFill(new Map(s), new Map(n))!;
  fill([[1, 0.4], [3, 2.3], [4, 10.9]], [[1, 1], [2, 1], [3, 1], [4, 1]]).forEach((v, i) => near(v, [0.4, 1.1227008, 2.3, 10.9][i], 1e-6, `w${i}`));
  fill([[2, 0.35]], [[2, 1]]).forEach((v, i) => near(v, [0.05738148, 0.35, 0.6242943, 2.2453482][i], 1e-6, `w${i}`));
  fill([[2, 2], [3, 5], [4, 0.5]], [[2, 200], [3, 100], [4, 100]]).forEach((v) => near(v, 2, 1e-9, "a pair broken later in the pass is fixed too"));
  assert.equal(smoothAndFill(new Map(), new Map()), null);
});

test("the outlier filter drops the rarest buckets (5 %, at least 20) and small or long ones, like fsrs-rs", () => {
  const reviews = [
    ...Array.from({ length: 300 }, () => ({ rating: 3, delta: 1 })),
    ...Array.from({ length: 100 }, () => ({ rating: 3, delta: 3 })),
    ...Array.from({ length: 12 }, () => ({ rating: 3, delta: 7 })),
    ...Array.from({ length: 10 }, () => ({ rating: 3, delta: 20 })),
    ...Array.from({ length: 30 }, () => ({ rating: 3, delta: 150 })),
    ...Array.from({ length: 30 }, () => ({ rating: 4, delta: 150 })),
    ...Array.from({ length: 5 }, () => ({ rating: 1, delta: 2 })),
  ];
  const { removed, kept } = outlierBuckets(reviews);
  // Rating 3 (452 reviews, 5 % = 22): the smallest bucket goes (10), the
  // next one would pass 22 and stays; 150 days is too long; Easy may wait
  // a year; 5 reviews of Again are too few.
  assert.deepEqual([...removed].sort(), ["1:2", "3:150", "3:20"]);
  assert.equal(kept.length, 300 + 100 + 12 + 30);
  // A log's cards in a removed bucket leave the training; w0–w3 come from the rest.
  const cards: TrainingCard[] = [
    ...syntheticLog(TRUE_WEIGHTS, 3000, 11),
    ...Array.from({ length: 6 }, () => ({ t: [0, 400, 5], r: [3, 1, 3] })),
  ];
  const prepared = prepareTraining(cards);
  assert.ok(!prepared.train.some((c) => c.t[1] === 400), "the six cards first seen again after 400 days are outliers");
  assert.equal(prepared.removed, cards.length - prepared.train.length);
  assert.ok(prepared.train.length > 2400, "most of the log stays");
  assert.ok(prepared.initial && prepared.initial.length === 4);
  // Towards the truth's initial stabilities (Hard is rare: w1 has little to go by).
  for (const i of [0, 2, 3]) assert.ok(Math.abs(Math.log(prepared.initial![i] / TRUE_WEIGHTS[i])) < Math.abs(Math.log(DEFAULT_WEIGHTS[i] / TRUE_WEIGHTS[i])), `w${i} ${prepared.initial![i]}`);
});

test("on the server the fit pauses between mini-batches and gives the same weights; past its deadline it stops", async () => {
  const cards = syntheticLog(TRUE_WEIGHTS, 400, 8);
  const sync = optimize(cards);
  const async = await optimizeAsync(cards, { sliceMs: 1 });
  assert.deepEqual(async.weights, sync.weights);
  await assert.rejects(optimizeAsync(syntheticLog(TRUE_WEIGHTS, 2000, 1), { sliceMs: 1, deadline: Date.now() - 1 }), OptimizeTimeout);
});

test("the workload: cards and minutes per day rise with the retention, limits and a time budget hold", async () => {
  const random = seeded(4);
  const deck: SimDeck = {
    cards: Array.from({ length: 800 }, () => ({ s: 1 + random() * 60, d: 3 + random() * 5, elapsed: Math.floor(random() * 30), due: Math.floor(random() * 20) - 3 })),
    newCards: 600,
    newPerDay: 10,
    reviewsPerDay: 9999,
  };
  const { curve, recommended } = await workload(TRUE_WEIGHTS, deck);
  assert.equal(curve.length, 26);
  assert.ok(curve[25].cardsPerDay > curve[0].cardsPerDay * 1.5, `${curve[0].cardsPerDay} → ${curve[25].cardsPerDay}`);
  assert.ok(curve[25].minutesPerDay > curve[0].minutesPerDay);
  assert.ok(curve[25].knowledge > curve[0].knowledge, "remembering more");
  assert.ok(recommended >= 0.7 && recommended <= 0.95);
  assert.deepEqual((await workload(TRUE_WEIGHTS, deck)).curve, curve, "deterministic");
  // At most 30 reviews a day and 10 minutes: the cards per day stay within them.
  const limited = await workload(TRUE_WEIGHTS, { ...deck, reviewsPerDay: 30, budget: 600 });
  for (const p of limited.curve) {
    assert.ok(p.cardsPerDay <= 40 + 1e-9, `${p.cardsPerDay}`);
    assert.ok(p.minutesPerDay <= 10 + 0.5, `${p.minutesPerDay} min`);
  }
  // With a budget that binds, more retention does not mean more work.
  assert.ok(limited.curve[25].cardsPerDay < curve[25].cardsPerDay);
  // A deck too small to say anything: 2000 new cards at its limits.
  assert.ok((await workload(TRUE_WEIGHTS, { cards: [], newCards: 3, newPerDay: 20, reviewsPerDay: 200 })).curve[10].cardsPerDay > 20);
  // The simulation samples very large decks and scales the result.
  const huge = simulateDeck(TRUE_WEIGHTS, 0.9, { cards: [], newCards: 45_000, newPerDay: 30, reviewsPerDay: 9999 });
  assert.ok(huge.cardsPerDay > 30, `${huge.cardsPerDay}`);
});

test("the recommended retention is a whole per cent in 70–95 %, deterministic, and follows the costs", () => {
  const r = recommendRetention(TRUE_WEIGHTS);
  assert.ok(r >= RETENTION_RANGE[0] && r <= RETENTION_RANGE[1]);
  assert.equal(Math.round(r * 100), r * 100);
  assert.equal(recommendRetention(TRUE_WEIGHTS), r);
  assert.equal(retentionCurve(TRUE_WEIGHTS).length, 26);
  // Forgetting much more expensive: remember more.
  const costly = recommendRetention(TRUE_WEIGHTS, { learn: 20, recall: 5, forget: 200, first: [0.25, 0.08, 0.5, 0.17], recalled: [0.22, 0.63, 0.15] });
  const cheap = recommendRetention(TRUE_WEIGHTS, { learn: 20, recall: 30, forget: 10, first: [0.25, 0.08, 0.5, 0.17], recalled: [0.22, 0.63, 0.15] });
  assert.ok(costly > r && r >= cheap, `${cheap} ≤ ${r} < ${costly}`);
});
