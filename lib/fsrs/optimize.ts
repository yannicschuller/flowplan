// FSRS parameter optimisation (docs/specs/flashcards.md §23): the 21
// weights of FSRS-6 fitted to a person's own review log, the recommended
// retention from the fitted model, and the memory state of a card under
// given weights. Pure TypeScript without dependencies of its own – it runs
// in a Web Worker in the person's browser (components/study/optimize-
// worker.ts), on the server for the API and MCP (lib/study.ts
// study.optimize, optimizeAsync: pausing between mini-batches, with a
// deadline) and in the tests.
//
// - Model: FSRS-6 exactly as the pinned ts-fsrs computes it (next_state,
//   forgetting_curve; tests/fsrs-optimize.test.ts compares both), without
//   ts-fsrs's rounding to 8 decimals.
// - Objective: like fsrs-rs, the binary cross-entropy (log loss) between
//   the predicted retrievability R and the outcome (rating > 1) of every
//   review a day or more after the one before; same-day reviews only move
//   the memory state (short-term stability). Plus a small L2 pull towards
//   the start (FSRS-6's defaults): REGULARIZATION pseudo-reviews per unit of
//   (change / range of the weight)², so a short log cannot run off.
// - Gradients: forward-mode automatic differentiation (dual numbers with
//   21 partial derivatives) through the recurrence of each card – exact,
//   no finite differences.
// - Optimiser: Adam (lr 0.04, β 0.9/0.999) on mini-batches of cards, 5
//   epochs, cosine-annealed learning rate, a seeded shuffle (deterministic:
//   the same log gives the same weights). The initial stabilities w0–w3 are
//   optimised in log space (a step changes them by a few per cent, so they
//   travel from 0.2 to 20 in reach). After every step the weights are
//   clamped to ts-fsrs's bounds (CLAMP_PARAMETERS, the same as fsrs-rs).
// - Evaluation: log loss and RMSE (bins): predictions in 20 bins of R, the
//   root of the count-weighted mean squared difference between mean
//   prediction and mean outcome per bin.
// - From fsrs-rs (#344): the outlier filter on the first long-term reviews
//   and the separate initialisation of w0–w3 from them (prepareTraining,
//   ported from parameter_initialization.rs and dataset.rs, checked against
//   its reference numbers), and the smoothing of w0–w3 after training.
// Not taken from fsrs-rs: its recency weighting of reviews, its exact
// regularisation constants and its training schedule (epochs, lr).
// - The workload (#344): a year of the deck's own cards at each desired
//   retention within its daily limits and a time budget (simulateDeck,
//   workload) – cards and minutes per day, and the recommended retention.
import { CLAMP_PARAMETERS, S_MIN, W17_W18_Ceiling, default_w } from "ts-fsrs";

export const WEIGHT_COUNT = 21;
// Phase 8 asks for this many ratings before optimising (§16).
export const MIN_REVIEWS = 1000;
// Fewer reviews a day or more apart than this: only w0–w3 are initialised
// (fsrs-rs MIN_ITEMS_TO_TRAIN).
export const MIN_ITEMS = 64;
export const DEFAULT_WEIGHTS: readonly number[] = default_w;
export const WEIGHT_BOUNDS = CLAMP_PARAMETERS(W17_W18_Ceiling, true) as unknown as readonly (readonly [number, number])[];
const S_MAX = 36500;
const LN09 = Math.log(0.9);

// One card's log in order: the rating of each review and the study days
// since the one before (t[0], the first review, is ignored).
export type TrainingCard = { t: number[]; r: number[] };
export type Fit = { logLoss: number; rmse: number; items: number };

export const clampWeights = (w: readonly number[]) =>
  WEIGHT_BOUNDS.map(([lo, hi], i) => {
    const x = Number(w[i]);
    return Math.min(hi, Math.max(lo, Number.isFinite(x) ? x : DEFAULT_WEIGHTS[i]));
  });
export const validWeights = (w: unknown): w is number[] => Array.isArray(w) && w.length === WEIGHT_COUNT && w.every((x) => typeof x === "number" && Number.isFinite(x));

// ---- Dual numbers: a value and its partial derivatives by the weights ----

// The derivatives of each formula are written out (one array per result
// instead of one per arithmetic step: about ten times faster).
type G = Float64Array | null;
class Dual {
  constructor(
    readonly v: number,
    readonly g: G,
  ) {}
}
const c = (v: number) => new Dual(v, null);
// Σ coefficient·gradient into a new gradient (null when all are constant).
function comb(...terms: [number, G][]): G {
  let out: Float64Array | null = null;
  for (const [k, g] of terms) {
    if (!g || k === 0) continue;
    out ??= new Float64Array(WEIGHT_COUNT);
    for (let i = 0; i < WEIGHT_COUNT; i++) out[i] += k * g[i];
  }
  return out;
}
const clamp = (x: Dual, lo: number, hi: number) => (x.v < lo ? c(lo) : x.v > hi ? c(hi) : x);

// ---- FSRS-6 (ts-fsrs 5.4.2 FSRSAlgorithm, without rounding) ----

type Memory = { s: Dual; d: Dual };
type Model = {
  w: Dual[];
  // −w20 and 0.9^(1/decay) − 1.
  decay: Dual;
  factor: Dual;
  // D0(Easy), the target of the mean reversion.
  initEasy: Dual;
};
function initDifficulty(w: Dual[], g: number) {
  const e = Math.exp((g - 1) * w[5].v);
  return new Dual(w[4].v - e + 1, comb([1, w[4].g], [-(g - 1) * e, w[5].g]));
}
function model(w: Dual[]): Model {
  const decay = new Dual(-w[20].v, comb([-1, w[20].g]));
  const f = Math.exp(LN09 / decay.v);
  const factor = new Dual(f - 1, comb([(-f * LN09) / (decay.v * decay.v), decay.g]));
  return { w, decay, factor, initEasy: initDifficulty(w, 4) };
}
// R(t, S) = (1 + factor·t/S)^decay
function forgetting(m: Model, t: number, s: Dual) {
  const f = m.factor.v,
    dec = m.decay.v;
  const base = 1 + (f * t) / s.v;
  const r = Math.pow(base, dec);
  const k = (r * dec) / base;
  return new Dual(r, comb([r * Math.log(base), m.decay.g], [(k * t) / s.v, m.factor.g], [(-k * f * t) / (s.v * s.v), s.g]));
}
function nextDifficulty(m: Model, d: Dual, g: number) {
  const w = m.w;
  const delta = -w[6].v * (g - 3);
  const damped = d.v + (delta * (10 - d.v)) / 9;
  const dDamped = comb([1 - delta / 9, d.g], [(-(g - 3) * (10 - d.v)) / 9, w[6].g]);
  const w7 = w[7].v;
  const v = w7 * m.initEasy.v + (1 - w7) * damped;
  return clamp(new Dual(v, comb([m.initEasy.v - damped, w[7].g], [w7, m.initEasy.g], [1 - w7, dDamped])), 1, 10);
}
// S' = S·(1 + e^w8·(11−D)·S^−w9·(e^((1−R)·w10) − 1)·h·b)
function recallStability(m: Model, d: Dual, s: Dual, r: Dual, g: number) {
  const w = m.w;
  const A = Math.exp(w[8].v),
    B = 11 - d.v,
    C = Math.pow(s.v, -w[9].v),
    X = Math.exp((1 - r.v) * w[10].v),
    E = X - 1;
  const hb = g === 2 ? w[15] : g === 4 ? w[16] : null;
  const H = hb ? hb.v : 1;
  const inc = A * B * C * E * H;
  const v = s.v * (1 + inc);
  if (v < S_MIN || v > S_MAX) return c(Math.min(S_MAX, Math.max(S_MIN, v)));
  const k = s.v * A * B * C * H;
  return new Dual(
    v,
    comb(
      [1 + inc - s.v * inc * (w[9].v / s.v), s.g],
      [s.v * inc, w[8].g],
      [(-s.v * inc) / B, d.g],
      [-s.v * inc * Math.log(s.v), w[9].g],
      [k * X * (1 - r.v), w[10].g],
      [-k * X * w[10].v, r.g],
      [hb ? s.v * A * B * C * E : 0, hb ? hb.g : null],
    ),
  );
}
// min(S / e^(w17·w18), w11·D^−w12·((S+1)^w13 − 1)·e^((1−R)·w14))
function forgetStability(m: Model, d: Dual, s: Dual, r: Dual) {
  const w = m.w;
  const P = Math.pow(d.v, -w[12].v),
    S1 = Math.pow(s.v + 1, w[13].v),
    Q = S1 - 1,
    X = Math.exp((1 - r.v) * w[14].v);
  const v = w[11].v * P * Q * X;
  const after =
    v < S_MIN || v > S_MAX
      ? c(Math.min(S_MAX, Math.max(S_MIN, v)))
      : new Dual(
          v,
          comb(
            [P * Q * X, w[11].g],
            [-v * Math.log(d.v), w[12].g],
            [(-v * w[12].v) / d.v, d.g],
            [w[11].v * P * X * S1 * Math.log(s.v + 1), w[13].g],
            [(w[11].v * P * X * S1 * w[13].v) / (s.v + 1), s.g],
            [v * (1 - r.v), w[14].g],
            [-v * w[14].v, r.g],
          ),
        );
  const fl = s.v / Math.exp(w[17].v * w[18].v);
  const floor = fl < S_MIN ? c(S_MIN) : new Dual(fl, comb([fl / s.v, s.g], [-fl * w[18].v, w[17].g], [-fl * w[17].v, w[18].g]));
  return floor.v < after.v ? floor : after;
}
// Same day: S' = S·S^−w19·e^(w17·(G−3+w18)), never smaller from Hard on.
function shortTermStability(m: Model, s: Dual, g: number) {
  const w = m.w;
  const sinc = Math.pow(s.v, -w[19].v) * Math.exp(w[17].v * (g - 3 + w[18].v));
  if (g >= 2 && sinc <= 1) return clamp(s, S_MIN, S_MAX);
  const v = s.v * sinc;
  if (v < S_MIN || v > S_MAX) return c(Math.min(S_MAX, Math.max(S_MIN, v)));
  return new Dual(v, comb([sinc * (1 - w[19].v), s.g], [-v * Math.log(s.v), w[19].g], [v * (g - 3 + w[18].v), w[17].g], [v * w[17].v, w[18].g]));
}
function first(m: Model, g: number): Memory {
  const s0 = m.w[g - 1];
  return { s: s0.v < 0.1 ? c(0.1) : s0, d: clamp(initDifficulty(m.w, g), 1, 10) };
}
function next(m: Model, mem: Memory, t: number, g: number, r?: Dual): Memory {
  let s: Dual;
  if (t === 0) s = shortTermStability(m, mem.s, g);
  else {
    const rr = r ?? forgetting(m, t, mem.s);
    s = g === 1 ? forgetStability(m, mem.d, mem.s, rr) : recallStability(m, mem.d, mem.s, rr, g);
  }
  return { s, d: nextDifficulty(m, mem.d, g) };
}

// ---- Loss ----

const P_MIN = 1e-4;
type Prediction = { p: number; y: number };
// Walks one card: every review a day or more after the one before is a
// prediction; `grad` (if given) collects d(loss)/d(weights).
function walk(m: Model, card: TrainingCard, grad: Float64Array | null, out: Prediction[] | null) {
  let loss = 0,
    items = 0;
  let mem: Memory | null = null;
  for (let i = 0; i < card.r.length; i++) {
    const g = card.r[i];
    if (!mem) {
      mem = first(m, g);
      continue;
    }
    const t = Math.max(0, card.t[i]);
    let r: Dual | undefined;
    if (t > 0) {
      r = forgetting(m, t, mem.s);
      const p = Math.min(1 - P_MIN, Math.max(P_MIN, r.v));
      const y = g > 1 ? 1 : 0;
      loss -= y ? Math.log(p) : Math.log(1 - p);
      items++;
      out?.push({ p, y });
      if (grad && r.g && p === r.v) {
        const dp = y ? -1 / p : 1 / (1 - p);
        for (let k = 0; k < WEIGHT_COUNT; k++) grad[k] += dp * r.g[k];
      }
    }
    mem = next(m, mem, t, g, r);
  }
  return { loss, items };
}
const constants = (w: readonly number[]) => model(w.map((x) => c(x)));
const variables = (w: readonly number[]) =>
  model(
    w.map((x, i) => {
      const g = new Float64Array(WEIGHT_COUNT);
      g[i] = 1;
      return new Dual(x, g);
    }),
  );

// Log loss and RMSE (bins) of weights on a log.
// The summed log loss and its gradient by the weights (for the tests'
// comparison with finite differences).
export function lossGradient(cards: TrainingCard[], weights: readonly number[]) {
  const m = variables(weights);
  const grad = new Float64Array(WEIGHT_COUNT);
  let loss = 0;
  for (const card of cards) loss += walk(m, card, grad, null).loss;
  return { loss, grad: [...grad] };
}
export function evaluate(cards: TrainingCard[], weights: readonly number[]): Fit {
  const m = constants(weights);
  const preds: Prediction[] = [];
  let loss = 0;
  for (const card of cards) loss += walk(m, card, null, preds).loss;
  return { logLoss: preds.length ? loss / preds.length : 0, rmse: rmseBins(preds), items: preds.length };
}
const BINS = 20;
function rmseBins(preds: Prediction[]) {
  if (!preds.length) return 0;
  const n = new Float64Array(BINS),
    p = new Float64Array(BINS),
    y = new Float64Array(BINS);
  for (const x of preds) {
    const b = Math.min(BINS - 1, Math.floor(x.p * BINS));
    n[b]++;
    p[b] += x.p;
    y[b] += x.y;
  }
  let sum = 0;
  for (let b = 0; b < BINS; b++) if (n[b]) sum += n[b] * Math.pow(p[b] / n[b] - y[b] / n[b], 2);
  return Math.sqrt(sum / preds.length);
}
// Reviews of the log that are predictions (a day or more after the one before).
export const trainingItems = (cards: TrainingCard[]) => cards.reduce((n, card) => n + card.t.slice(1).filter((t) => t > 0).length, 0);

// ---- fsrs-rs's initialisation of w0–w3 and its outlier filter ----

// Ported from fsrs-rs (src/parameter_initialization.rs, src/dataset.rs
// outlier_bucket_decisions; tests/fsrs-optimize.test.ts checks its
// reference numbers). A card's first rating and its first review a day or
// more later ("the first long-term review") say how stable a card is after
// that first rating: per rating, the stability whose forgetting curve
// (FSRS-6's default decay) fits those outcomes best is the start of w0–w3.
export type InitialReview = { rating: number; delta: number; recalled: boolean };
const INIT_S_MAX = 100;
const DEFAULT_DECAY = DEFAULT_WEIGHTS[20];
// The first long-term review of a card (null: none yet).
export function firstLongTerm(card: TrainingCard): InitialReview | null {
  for (let i = 1; i < card.r.length; i++) if (card.t[i] > 0) return { rating: card.r[0], delta: card.t[i], recalled: card.r[i] > 1 };
  return null;
}
// Per first rating, the (rating, interval) buckets of the first long-term
// reviews: the least populated ones go (5 %, at least 20 reviews), and so
// do buckets of fewer than 6 or with an interval over 100 days (365 for
// Easy). The cards of a removed bucket leave the training as well.
export function outlierBuckets(reviews: Pick<InitialReview, "rating" | "delta">[]) {
  const buckets = new Map<string, { rating: number; delta: number; count: number; members: number[] }>();
  const totals = [0, 0, 0, 0, 0];
  reviews.forEach((r, index) => {
    const key = `${r.rating}:${r.delta}`;
    const bucket = buckets.get(key) ?? { rating: r.rating, delta: r.delta, count: 0, members: [] };
    bucket.count++;
    bucket.members.push(index);
    buckets.set(key, bucket);
    totals[r.rating]++;
  });
  const removed = new Set<string>(),
    kept: number[] = [],
    dropped = [0, 0, 0, 0, 0];
  const sorted = [...buckets.values()].sort((a, b) => a.rating - b.rating || a.count - b.count || a.delta - b.delta);
  for (const b of sorted) {
    let discard: boolean;
    if (dropped[b.rating] + b.count < Math.max(20, Math.floor(totals[b.rating] / 20))) {
      dropped[b.rating] += b.count;
      discard = true;
    } else discard = b.count < 6 || b.delta > (b.rating !== 4 ? 100 : 365);
    if (discard) removed.add(`${b.rating}:${b.delta}`);
    else kept.push(...b.members);
  }
  return { removed, kept: kept.sort((a, b) => a - b) };
}
// The initialisation's objective for one rating: the summed binary cross-
// entropy of the default forgetting curve at stability `s` against the
// mean outcome per interval, plus |s − default| / 16.
export function initLoss(data: { delta: number; recall: number; count: number }[], s: number, defaultS: number) {
  const factor = Math.pow(0.9, -1 / DEFAULT_DECAY) - 1;
  let loss = 0;
  for (const d of data) {
    const p = Math.pow(1 + (d.delta / s) * factor, -DEFAULT_DECAY);
    loss -= (d.recall * Math.log(p) + (1 - d.recall) * Math.log(1 - p)) * d.count;
  }
  return loss + Math.abs(s - defaultS) / 16;
}
function initSlope(data: { delta: number; recall: number; count: number }[], s: number): [number, number] {
  const decay = DEFAULT_DECAY;
  const factor = Math.pow(0.9, -1 / decay) - 1;
  let slope = 0,
    curvature = 0;
  for (const { delta, recall: y, count: n } of data) {
    const c = delta * factor;
    const p = Math.pow(1 + c / s, -decay);
    const b = (decay * c) / (s * (s + c));
    const a = (p - y) / (1 - p);
    slope += n * a * b;
    curvature += n * ((1 - y) * p * Math.pow(b / (1 - p), 2) - a * b * (1 / s + 1 / (s + c)));
  }
  return [slope, curvature];
}
// fsrs-rs initial_stability: the prior's kink at the default decides the
// side; Newton steps safeguarded by bisection find the slope's root.
function initialStability(data: { delta: number; recall: number; count: number }[], defaultS: number) {
  const [slope] = initSlope(data, defaultS);
  if (Math.abs(slope) <= 1 / 16) return defaultS;
  let [low, high, prior] = slope > 0 ? [S_MIN, defaultS, -1 / 16] : [defaultS, INIT_S_MAX, 1 / 16];
  const boundary = slope > 0 ? low : high;
  const atBoundary = initSlope(data, boundary)[0] + prior;
  if ((slope > 0 && atBoundary >= 0) || (slope < 0 && atBoundary <= 0)) return boundary;
  let s = defaultS;
  for (let k = 0; k < 80; k++) {
    const [g0, curvature] = initSlope(data, s);
    const g = g0 + prior;
    if (g > 0) high = s;
    else low = s;
    if (Math.fround(low) === Math.fround(high)) break;
    const newton = s - g / curvature;
    const next = curvature > 0 && newton > low && newton < high ? newton : (low + high) / 2;
    if (Math.fround(next) === Math.fround(s)) return next;
    s = next;
  }
  return (low + high) / 2;
}
// Per first rating the fitted stability (Laplace-smoothed recall per
// interval with the average recall of the log).
export function searchStability(byRating: Map<number, { delta: number; recall: number; count: number }[]>, averageRecall: number) {
  const out = new Map<number, number>();
  for (const [rating, data] of byRating) {
    const smoothed = data.map((d) => ({ ...d, recall: (d.recall * d.count + averageRecall) / (d.count + 1) }));
    out.set(rating, initialStability(smoothed, DEFAULT_WEIGHTS[rating - 1]));
  }
  return out;
}
// fsrs-rs smooth_and_fill: the stabilities in order of the ratings (the
// one with fewer reviews gives way), missing ones filled in from the
// others (in log space, with fsrs-rs's weights 0.41/0.54), clamped.
export function smoothAndFill(stability: Map<number, number>, counts: Map<number, number>): number[] | null {
  const s = new Map([...stability].filter(([rating]) => counts.has(rating)));
  for (let pass = 0; pass < 20; pass++) {
    let changed = false;
    for (const [small, big] of [
      [1, 2],
      [2, 3],
      [3, 4],
      [1, 3],
      [2, 4],
      [1, 4],
    ]) {
      const a = s.get(small),
        b = s.get(big);
      if (a === undefined || b === undefined || a <= b) continue;
      if (counts.get(small)! > counts.get(big)!) s.set(big, a);
      else s.set(small, b);
      changed = true;
    }
    if (!changed) break;
  }
  const w1 = 0.41,
    w2 = 0.54;
  const pow = Math.pow;
  const r = [undefined, s.get(1), s.get(2), s.get(3), s.get(4)] as (number | undefined)[];
  const has = (i: number) => r[i] !== undefined;
  let out: number[];
  if (s.size === 0) return null;
  if (s.size === 1) {
    const [rating, value] = [...s][0];
    const factor = value / DEFAULT_WEIGHTS[rating - 1];
    out = DEFAULT_WEIGHTS.slice(0, 4)
      .map((x) => x * factor)
      .sort((a, b) => a - b);
  } else {
    if (s.size === 2) {
      const k = w1 + w2 - w1 * w2;
      if (!has(1) && !has(2)) {
        r[2] = pow(r[3]!, 1 / (1 - w2)) * pow(r[4]!, 1 - 1 / (1 - w2));
        r[1] = pow(r[2]!, 1 / w1) * pow(r[3]!, 1 - 1 / w1);
      } else if (!has(1) && !has(3)) {
        r[3] = pow(r[2]!, 1 - w2) * pow(r[4]!, w2);
        r[1] = pow(r[2]!, 1 / w1) * pow(r[3]!, 1 - 1 / w1);
      } else if (!has(1) && !has(4)) {
        r[4] = pow(r[2]!, 1 - 1 / w2) * pow(r[3]!, 1 / w2);
        r[1] = pow(r[2]!, 1 / w1) * pow(r[3]!, 1 - 1 / w1);
      } else if (!has(2) && !has(3)) {
        r[2] = pow(r[1]!, w1 / k) * pow(r[4]!, 1 - w1 / k);
        r[3] = pow(r[1]!, 1 - w2 / k) * pow(r[4]!, w2 / k);
      } else if (!has(2) && !has(4)) {
        r[2] = pow(r[1]!, w1) * pow(r[3]!, 1 - w1);
        r[4] = pow(r[2]!, 1 - 1 / w2) * pow(r[3]!, 1 / w2);
      } else if (!has(3) && !has(4)) {
        r[3] = pow(r[1]!, 1 - 1 / (1 - w1)) * pow(r[2]!, 1 / (1 - w1));
        r[4] = pow(r[2]!, 1 - 1 / w2) * pow(r[3]!, 1 / w2);
      }
    } else if (s.size === 3) {
      if (!has(1)) r[1] = pow(r[2]!, 1 / w1) * pow(r[3]!, 1 - 1 / w1);
      else if (!has(2)) r[2] = pow(r[1]!, w1) * pow(r[3]!, 1 - w1);
      else if (!has(3)) r[3] = pow(r[2]!, 1 - w2) * pow(r[4]!, w2);
      else if (!has(4)) r[4] = pow(r[2]!, 1 - 1 / w2) * pow(r[3]!, 1 / w2);
    }
    out = r.slice(1) as number[];
  }
  return out.map((v) => Math.min(INIT_S_MAX, Math.max(S_MIN, v)));
}
// The training set after the outlier filter, the initial stabilities w0–w3
// fitted to the first long-term reviews (null: none) and the reviews per
// first rating (for the final smoothing).
export function prepareTraining(cards: TrainingCard[]) {
  const firsts = cards.map(firstLongTerm);
  const initial = firsts.filter((f): f is InitialReview => !!f);
  const { removed, kept } = outlierBuckets(initial);
  const train = cards.filter((_, i) => {
    const f = firsts[i];
    return !f || !removed.has(`${f.rating}:${f.delta}`);
  });
  const init = kept.map((i) => initial[i]);
  const counts = new Map<number, number>();
  for (const r of init) counts.set(r.rating, (counts.get(r.rating) || 0) + 1);
  // The share recalled of every prediction left for training.
  let recalled = 0,
    predictions = 0;
  for (const card of train)
    for (let i = 1; i < card.r.length; i++)
      if (card.t[i] > 0) {
        predictions++;
        if (card.r[i] > 1) recalled++;
      }
  const byRating = new Map<number, { delta: number; recall: number; count: number }[]>();
  const groups = new Map<string, { rating: number; delta: number; recalled: number; count: number }>();
  for (const r of init) {
    const key = `${r.rating}:${r.delta}`;
    const g = groups.get(key) ?? { rating: r.rating, delta: r.delta, recalled: 0, count: 0 };
    g.count++;
    if (r.recalled) g.recalled++;
    groups.set(key, g);
  }
  for (const g of [...groups.values()].sort((a, b) => a.delta - b.delta)) byRating.set(g.rating, [...(byRating.get(g.rating) || []), { delta: g.delta, recall: g.recalled / g.count, count: g.count }]);
  const stability = predictions ? smoothAndFill(searchStability(byRating, recalled / predictions), counts) : null;
  return { train, initial: stability, counts, removed: cards.length - train.length };
}

// ---- Fitting ----

export const REGULARIZATION = 32;
const LR = 0.04,
  BETA1 = 0.9,
  BETA2 = 0.999,
  EPS = 1e-8,
  EPOCHS = 5,
  MAX_BATCH = 512,
  MIN_BATCH = 64;
// Fewer predictions than this: the defaults stay (fsrs-rs: 8).
export const MIN_START = 8;
// A small seeded generator (mulberry32): the shuffle, the simulation.
export function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const LOG_SPACE = 4;
export type OptimizeOptions = {
  // The weights to start from (else FSRS-6's defaults with w0–w3 from the
  // initialisation); `before` is the fit of these.
  start?: readonly number[];
  epochs?: number;
  seed?: number;
  // false: no initialisation of w0–w3 and no outlier filter (as before #344).
  prepare?: boolean;
  onProgress?: (done: number) => void;
};
export type OptimizeResult = { weights: number[]; before: Fit; after: Fit; removed: number };
// The fit as steps: yields its progress (0–1) after every mini-batch, so
// optimizeAsync can pause between them; optimize runs it at once.
function* fitting(cards: TrainingCard[], options: OptimizeOptions): Generator<number, OptimizeResult> {
  const reference = clampWeights(options.start ?? DEFAULT_WEIGHTS);
  const usable = cards.filter((card) => card.r.length > 1 && card.t.slice(1).some((t) => t > 0));
  const before = evaluate(usable, reference);
  if (trainingItems(usable) < MIN_START) return { weights: reference, before, after: before, removed: 0 };
  const prepared = options.prepare === false ? { train: usable, initial: null, counts: new Map<number, number>(), removed: 0 } : prepareTraining(usable);
  // fsrs-rs starts from the initial stabilities fitted to the first reviews.
  const start = !options.start && prepared.initial ? clampWeights([...prepared.initial, ...DEFAULT_WEIGHTS.slice(4)]) : reference;
  const train = prepared.train;
  const total = trainingItems(train);
  const finish = (w: number[]): OptimizeResult => {
    // fsrs-rs smooths w0–w3 once more after training.
    const smoothed = prepared.counts.size ? smoothAndFill(new Map(w.slice(0, 4).map((x, i) => [i + 1, x])), prepared.counts) : null;
    const weights = clampWeights((smoothed ? [...smoothed, ...w.slice(4)] : w).map((x) => Math.round(x * 10_000) / 10_000));
    return { weights, before, after: evaluate(usable, weights), removed: prepared.removed };
  };
  if (total < MIN_ITEMS) return finish(start);
  const batchItems = Math.min(MAX_BATCH, Math.max(MIN_BATCH, Math.ceil(total / 32)));
  // Batches of whole cards with about `batchItems` predictions each.
  const order = train.map((_, i) => i);
  const random = seeded(options.seed ?? 20_231_105);
  const epochs = options.epochs ?? EPOCHS;
  const batchesOf = () => {
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const batches: TrainingCard[][] = [];
    let current: TrainingCard[] = [],
      n = 0;
    for (const i of order) {
      current.push(train[i]);
      n += train[i].t.slice(1).filter((t) => t > 0).length;
      if (n >= batchItems) {
        batches.push(current);
        current = [];
        n = 0;
      }
    }
    if (current.length) batches.push(current);
    return batches;
  };
  const steps = epochs * Math.ceil(total / batchItems);
  // The parameters Adam moves: w0–w3 as logarithms, the rest as they are.
  const theta = start.map((w, i) => (i < LOG_SPACE ? Math.log(w) : w));
  const toWeights = (th: number[]) => clampWeights(th.map((x, i) => (i < LOG_SPACE ? Math.exp(x) : x)));
  const range = WEIGHT_BOUNDS.map(([lo, hi]) => hi - lo);
  const m1 = new Float64Array(WEIGHT_COUNT),
    m2 = new Float64Array(WEIGHT_COUNT);
  let step = 0;
  for (let epoch = 0; epoch < epochs; epoch++) {
    for (const batch of batchesOf()) {
      const w = toWeights(theta);
      const grad = new Float64Array(WEIGHT_COUNT);
      const m = variables(w);
      let items = 0;
      for (const card of batch) items += walk(m, card, grad, null).items;
      if (!items) continue;
      step++;
      const lr = LR * 0.5 * (1 + Math.cos((Math.PI * (step - 1)) / Math.max(1, steps)));
      for (let i = 0; i < WEIGHT_COUNT; i++) {
        // The mean loss of the batch, plus its share of the pull to the start.
        let g = grad[i] / items + ((2 * REGULARIZATION) / total) * ((w[i] - start[i]) / (range[i] * range[i]));
        if (i < LOG_SPACE) g *= w[i];
        if (!Number.isFinite(g)) g = 0;
        m1[i] = BETA1 * m1[i] + (1 - BETA1) * g;
        m2[i] = BETA2 * m2[i] + (1 - BETA2) * g * g;
        const mh = m1[i] / (1 - Math.pow(BETA1, step)),
          vh = m2[i] / (1 - Math.pow(BETA2, step));
        theta[i] -= (lr * mh) / (Math.sqrt(vh) + EPS);
      }
      // Clamped after every step (fsrs-rs's parameter clipper).
      const clipped = toWeights(theta);
      for (let i = 0; i < WEIGHT_COUNT; i++) theta[i] = i < LOG_SPACE ? Math.log(clipped[i]) : clipped[i];
      yield step / Math.max(1, steps);
    }
    options.onProgress?.((epoch + 1) / epochs);
  }
  return finish(toWeights(theta));
}
// Fits the weights to the cards' log: fsrs-rs's outlier filter and
// initialisation of w0–w3, then Adam from there. `before` is the fit of
// the start (FSRS-6's defaults), `after` that of the result – both on the
// whole log.
export function optimize(cards: TrainingCard[], options: OptimizeOptions = {}): OptimizeResult {
  const run = fitting(cards, options);
  for (;;) {
    const next = run.next();
    if (next.done) return next.value;
  }
}
// The same, pausing every `sliceMs` so the server's event loop stays free
// (lib/study.ts study.optimize); past `deadline` (ms since the epoch) it
// stops with a TimeoutError.
export class OptimizeTimeout extends Error {}
export const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
export async function optimizeAsync(cards: TrainingCard[], options: OptimizeOptions & { deadline?: number; sliceMs?: number } = {}): Promise<OptimizeResult> {
  const run = fitting(cards, options);
  let slice = Date.now();
  for (;;) {
    const next = run.next();
    if (next.done) return next.value;
    if (Date.now() - slice >= (options.sliceMs ?? 20)) {
      if (options.deadline && Date.now() > options.deadline) throw new OptimizeTimeout("timeout");
      await pause();
      slice = Date.now();
    }
  }
}

// ---- Memory state of a card under given weights ----

// Stability and difficulty after a card's log (the reviews in order with
// their study days since the one before) – the same as replaying it with
// ts-fsrs (lib/fsrs replay), for the cards' states once new weights apply.
export function memoryOf(card: TrainingCard, weights: readonly number[]): { stability: number; difficulty: number } | null {
  const m = constants(clampWeights(weights));
  let mem: Memory | null = null;
  for (let i = 0; i < card.r.length; i++) mem = mem ? next(m, mem, Math.max(0, card.t[i]), card.r[i]) : first(m, card.r[i]);
  return mem ? { stability: mem.s.v, difficulty: mem.d.v } : null;
}

// ---- Recommended retention ----

// Seconds per kind of review and the shares of the ratings, from the
// person's log (lib/study.ts studyHistory) or these defaults.
export type ReviewCosts = {
  learn: number;
  recall: number;
  forget: number;
  // Shares of Again, Hard, Good, Easy at a card's first rating.
  first: [number, number, number, number];
  // Shares of Hard, Good, Easy among recalled reviews.
  recalled: [number, number, number];
};
export const DEFAULT_COSTS: ReviewCosts = { learn: 20, recall: 8, forget: 23, first: [0.25, 0.08, 0.5, 0.17], recalled: [0.22, 0.63, 0.15] };
export const RETENTION_RANGE = [0.7, 0.95] as const;
const SIM_DAYS = 365,
  SIM_CARDS = 2000;
// A forgotten card counts this many times its time (loss aversion: without
// it, the lowest retention always looks cheapest per remembered card).
export const LOSS_AVERSION = 2.5;
const pick = (shares: readonly number[], x: number) => {
  const total = shares.reduce((a, b) => a + b, 0) || 1;
  let sum = 0;
  for (let i = 0; i < shares.length; i++) {
    sum += shares[i] / total;
    if (x < sum) return i;
  }
  return shares.length - 1;
};
// Time spent and knowledge (sum of retrievability of every card at the end)
// for SIM_CARDS cards, one introduced every few days over a year, studied
// at `retention`: interval I(r, S), recalled with probability R, a lapse
// followed by one relearning step on the same day.
export function simulate(weights: readonly number[], retention: number, costs: ReviewCosts = DEFAULT_COSTS, maxInterval = S_MAX) {
  const m = constants(clampWeights(weights));
  const decay = m.decay.v,
    factor = m.factor.v;
  let time = 0,
    knowledge = 0,
    reviews = 0;
  for (let card = 0; card < SIM_CARDS; card++) {
    // The same random numbers for every retention (common random numbers):
    // the curve over the retention stays smooth.
    const random = seeded(7919 * (card + 1));
    let day = Math.floor((card * SIM_DAYS) / SIM_CARDS);
    let mem = first(m, pick(costs.first, random()) + 1);
    time += costs.learn;
    for (;;) {
      const interval = Math.min(maxInterval, Math.max(1, Math.round((mem.s.v / factor) * (Math.pow(retention, 1 / decay) - 1))));
      if (day + interval >= SIM_DAYS) {
        knowledge += forgetting(m, SIM_DAYS - day, mem.s).v;
        break;
      }
      day += interval;
      reviews++;
      const r = forgetting(m, interval, mem.s);
      if (random() < r.v) {
        mem = next(m, mem, interval, pick(costs.recalled, random()) + 2, r);
        time += costs.recall;
      } else {
        mem = next(m, next(m, mem, interval, 1, r), 0, 3);
        time += costs.forget;
      }
    }
  }
  return { time, knowledge, reviews };
}
// The desired retention with the least time per remembered card – a
// simplified "optimal retention" (CMRR) of Anki: a deterministic simulation
// of one year instead of one over the deck's own limits, forgetting
// weighted by LOSS_AVERSION, the curve smoothed over ±2 points against
// the simulation's noise; in whole per cent between 70 % and 95 %.
export function retentionCurve(weights: readonly number[], costs: ReviewCosts = DEFAULT_COSTS, maxInterval = S_MAX) {
  const weighted = { ...costs, forget: costs.forget * LOSS_AVERSION };
  const out: { retention: number; cost: number }[] = [];
  for (let p = Math.round(RETENTION_RANGE[0] * 100); p <= Math.round(RETENTION_RANGE[1] * 100); p++) {
    const { time, knowledge } = simulate(weights, p / 100, weighted, maxInterval);
    out.push({ retention: p / 100, cost: time / Math.max(knowledge, 1e-9) });
  }
  return out;
}
export function recommendRetention(weights: readonly number[], costs: ReviewCosts = DEFAULT_COSTS, maxInterval = S_MAX) {
  const curve = retentionCurve(weights, costs, maxInterval);
  let best = { retention: 0.9, cost: Infinity };
  curve.forEach((point, i) => {
    const near = curve.slice(Math.max(0, i - 2), i + 3);
    const cost = near.reduce((sum, x) => sum + x.cost, 0) / near.length;
    if (cost < best.cost) best = { retention: point.retention, cost };
  });
  return best.retention;
}

// ---- The workload of a deck at each desired retention (#344) ----

// Like Anki's simulator: the deck's own cards (their stability, difficulty
// and due day) and its new cards, studied day by day for a year at a
// desired retention within the person's daily limits and, if given, a
// time budget – reviews due first (overdue ones stay due), then new cards.
// Per retention: cards and minutes per day, and the knowledge at the end
// (sum of the retrievability of every card studied).
export type SimCard = { s: number; d: number; elapsed: number; due: number };
export type SimDeck = {
  cards: SimCard[];
  newCards: number;
  newPerDay: number;
  reviewsPerDay: number;
  // Seconds a day at most (null: no budget).
  budget?: number | null;
};
export type WorkloadPoint = { retention: number; cardsPerDay: number; minutesPerDay: number; knowledge: number; cost: number };
export const SIM_DECK_DAYS = 365;
// More cards than this are sampled (every k-th card, limits divided by k,
// counts multiplied by k).
export const SIM_MAX_CARDS = 20_000;
export function simulateDeck(weights: readonly number[], retention: number, deck: SimDeck, costs: ReviewCosts = DEFAULT_COSTS, maxInterval = S_MAX) {
  const m = constants(clampWeights(weights));
  const decay = m.decay.v,
    factor = m.factor.v;
  const total = deck.cards.length + deck.newCards;
  const k = Math.max(1, Math.ceil(total / SIM_MAX_CARDS));
  const existing = k > 1 ? deck.cards.filter((_, i) => i % k === 0) : deck.cards;
  const fresh = Math.floor(deck.newCards / k);
  const n = existing.length + fresh;
  const days = SIM_DECK_DAYS;
  const s = new Float64Array(n),
    d = new Float64Array(n),
    last = new Float64Array(n),
    seen = new Uint8Array(n);
  const random: (() => number)[] = [];
  const calendar: number[][] = Array.from({ length: days }, () => []);
  const interval = (stability: number) => Math.min(maxInterval, Math.max(1, Math.round((stability / factor) * (Math.pow(retention, 1 / decay) - 1))));
  existing.forEach((card, i) => {
    s[i] = Math.max(S_MIN, card.s);
    d[i] = Math.min(10, Math.max(1, card.d));
    last[i] = -Math.max(0, card.elapsed);
    seen[i] = 1;
    const due = Math.max(0, Math.round(card.due));
    if (due < days) calendar[due].push(i);
  });
  for (let i = 0; i < n; i++) random.push(seeded(7919 * (i + 1)));
  const newPerDay = deck.newPerDay / k,
    reviewsPerDay = deck.reviewsPerDay / k,
    budget = deck.budget ? deck.budget / k : null;
  let nextNew = existing.length,
    carry: number[] = [],
    cards = 0,
    time = 0,
    weighted = 0;
  const schedule = (i: number, day: number) => {
    last[i] = day;
    const at = day + interval(s[i]);
    if (at < days) calendar[at].push(i);
  };
  for (let day = 0; day < days; day++) {
    const due = carry.length ? carry.concat(calendar[day]) : calendar[day];
    carry = [];
    let spent = 0,
      reviews = 0;
    for (const i of due) {
      if (reviews >= reviewsPerDay || (budget !== null && spent >= budget)) {
        carry.push(i);
        continue;
      }
      const t = day - last[i];
      const mem = { s: c(s[i]), d: c(d[i]) };
      const r = forgetting(m, t, mem.s);
      let next: Memory;
      if (random[i]() < r.v) {
        next = nextOf(m, mem, t, pick(costs.recalled, random[i]()) + 2, r);
        spent += costs.recall;
      } else {
        next = nextOf(m, nextOf(m, mem, t, 1, r), 0, 3);
        spent += costs.forget;
        weighted += costs.forget * (LOSS_AVERSION - 1);
      }
      s[i] = next.s.v;
      d[i] = next.d.v;
      reviews++;
      schedule(i, day);
    }
    let learned = 0;
    while (nextNew < n && learned + 1 <= newPerDay + 1e-9 && (budget === null || spent < budget)) {
      const i = nextNew++;
      const mem = first(m, pick(costs.first, random[i]()) + 1);
      s[i] = mem.s.v;
      d[i] = mem.d.v;
      seen[i] = 1;
      spent += costs.learn;
      learned++;
      schedule(i, day);
    }
    cards += reviews + learned;
    time += spent;
  }
  let knowledge = 0,
    studied = 0;
  for (let i = 0; i < n; i++)
    if (seen[i]) {
      studied++;
      knowledge += forgetting(m, days - last[i], c(s[i])).v;
    }
  // The weighted cost: the time spent, forgetting weighted by LOSS_AVERSION,
  // and what learning again every card not remembered at the end would
  // take – so a low retention does not win just because the deck's old
  // cards count as knowledge either way.
  const relearn = LOSS_AVERSION * costs.learn * Math.max(0, studied - knowledge);
  return { cardsPerDay: (cards * k) / days, minutesPerDay: (time * k) / 60 / days, knowledge: knowledge * k, time: time * k, weighted: (time + weighted + relearn) * k };
}
const nextOf = (m: Model, mem: Memory, t: number, g: number, r?: Dual) => next(m, mem, t, g, r);
// The workload curve 70–95 % and the recommended retention: the one with
// the least weighted time per card remembered (reviews, forgetting weighted by LOSS_AVERSION,
// and learning again what is forgotten at the end), smoothed over ±2
// points – within the deck's limits and budget, so a binding budget
// recommends the retention that keeps the most in memory. `between` lets
// the server pause between retentions.
export async function workload(
  weights: readonly number[],
  deck: SimDeck,
  costs: ReviewCosts = DEFAULT_COSTS,
  maxInterval = S_MAX,
  between?: () => Promise<void>,
): Promise<{ curve: WorkloadPoint[]; recommended: number }> {
  // Too small a deck says little: a deck of 2000 new cards at its limits.
  if (deck.cards.length + deck.newCards < 50) deck = { ...deck, cards: [], newCards: 2000, newPerDay: Math.max(1, deck.newPerDay) };
  const curve: WorkloadPoint[] = [];
  for (let p = Math.round(RETENTION_RANGE[0] * 100); p <= Math.round(RETENTION_RANGE[1] * 100); p++) {
    const run = simulateDeck(weights, p / 100, deck, costs, maxInterval);
    curve.push({
      retention: p / 100,
      cardsPerDay: Math.round(run.cardsPerDay * 10) / 10,
      minutesPerDay: Math.round(run.minutesPerDay * 10) / 10,
      knowledge: Math.round(run.knowledge),
      cost: run.weighted / Math.max(run.knowledge, 1e-9),
    });
    await between?.();
  }
  return { curve, recommended: recommendFrom(curve) };
}
export function recommendFrom(curve: Pick<WorkloadPoint, "retention" | "cost">[]) {
  let best = { retention: 0.9, cost: Infinity };
  curve.forEach((point, i) => {
    const near = curve.slice(Math.max(0, i - 2), i + 3);
    const cost = near.reduce((sum, x) => sum + x.cost, 0) / near.length;
    if (cost < best.cost) best = { retention: point.retention, cost };
  });
  return best.retention;
}
