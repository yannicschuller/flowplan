// FSRS parameter optimisation (docs/specs/flashcards.md §23): the 21
// weights of FSRS-6 fitted to a person's own review log, the recommended
// retention from the fitted model, and the memory state of a card under
// given weights. Pure TypeScript without dependencies of its own – it runs
// in a Web Worker in the person's browser (components/study/optimize-
// worker.ts), the tests and, for the memory states, on the server.
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
// Not implemented from fsrs-rs: the separate pre-training of w0–w3, outlier
// filters and its exact regularisation constants.
import { CLAMP_PARAMETERS, S_MIN, W17_W18_Ceiling, default_w } from "ts-fsrs";

export const WEIGHT_COUNT = 21;
// Phase 8 asks for this many ratings before optimising (§16).
export const MIN_REVIEWS = 1000;
// Fewer reviews a day or more apart than this: nothing to learn from.
export const MIN_ITEMS = 50;
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

// ---- Fitting ----

export const REGULARIZATION = 32;
const LR = 0.04,
  BETA1 = 0.9,
  BETA2 = 0.999,
  EPS = 1e-8,
  EPOCHS = 5,
  MAX_BATCH = 512,
  MIN_BATCH = 64;
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
export type OptimizeOptions = { start?: readonly number[]; epochs?: number; seed?: number; onProgress?: (done: number) => void };
export type OptimizeResult = { weights: number[]; before: Fit; after: Fit };
// Fits the weights to the cards' log, starting from `start` (FSRS-6's
// defaults). `before` is the fit of the start, `after` that of the result.
export function optimize(cards: TrainingCard[], options: OptimizeOptions = {}): OptimizeResult {
  const start = clampWeights(options.start ?? DEFAULT_WEIGHTS);
  const usable = cards.filter((card) => card.r.length > 1 && card.t.slice(1).some((t) => t > 0));
  const total = trainingItems(usable);
  const before = evaluate(usable, start);
  if (total < MIN_ITEMS) return { weights: start, before, after: before };
  const batchItems = Math.min(MAX_BATCH, Math.max(MIN_BATCH, Math.ceil(total / 32)));
  // Batches of whole cards with about `batchItems` predictions each.
  const order = usable.map((_, i) => i);
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
      current.push(usable[i]);
      n += usable[i].t.slice(1).filter((t) => t > 0).length;
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
    }
    options.onProgress?.((epoch + 1) / epochs);
  }
  const weights = toWeights(theta).map((x) => Math.round(x * 10_000) / 10_000);
  const fitted = clampWeights(weights);
  return { weights: fitted, before, after: evaluate(usable, fitted) };
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
