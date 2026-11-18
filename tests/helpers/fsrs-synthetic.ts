// Synthetic review logs for the FSRS optimiser (tests/fsrs-optimize.test.ts):
// cards studied by a "person" whose memory follows FSRS-6 with given weights
// (ts-fsrs's own next_state and forgetting curve). Each card: a first
// rating, a same-day learning step unless Easy, then up to `reviews`
// reviews at intervals of 0.3–3 times the stability (so retrievability
// varies), recalled with probability R; a lapse is followed by a same-day
// relearning step. Seeded: the same seed gives the same log.
import { FSRSAlgorithm, generatorParameters, type Grade } from "ts-fsrs";
import { seeded, type TrainingCard } from "../../lib/fsrs/optimize";

export const TRUE_WEIGHTS = [0.5, 2.0, 4.5, 20, 5.8, 1.2, 2.2, 0.02, 1.4, 0.25, 1.1, 1.8, 0.1, 0.35, 1.9, 0.4, 2.4, 0.6, 0.2, 0.1, 0.3];

export function syntheticLog(weights: readonly number[], cards: number, seed: number, reviews = 8): TrainingCard[] {
  const alg = new FSRSAlgorithm(generatorParameters({ w: [...weights], enable_short_term: true }));
  const random = seeded(seed);
  const pick = (shares: number[]) => {
    const x = random();
    let sum = 0;
    for (let i = 0; i < shares.length; i++) {
      sum += shares[i];
      if (x < sum) return i;
    }
    return shares.length - 1;
  };
  const out: TrainingCard[] = [];
  for (let c = 0; c < cards; c++) {
    const t: number[] = [0],
      r: number[] = [];
    const g = (pick([0.25, 0.08, 0.5, 0.17]) + 1) as Grade;
    r.push(g);
    let state = alg.next_state(null, 0, g);
    if (g < 4) {
      t.push(0);
      r.push(3);
      state = alg.next_state(state, 0, 3);
    }
    for (let k = 0; k < reviews; k++) {
      const interval = Math.max(1, Math.round(state.stability * (0.3 + 2.7 * random())));
      const recalled = random() < alg.forgetting_curve(interval, state.stability);
      const rating = (recalled ? pick([0.22, 0.63, 0.15]) + 2 : 1) as Grade;
      t.push(interval);
      r.push(rating);
      state = alg.next_state(state, interval, rating);
      if (!recalled) {
        t.push(0);
        r.push(3);
        state = alg.next_state(state, 0, 3);
      }
    }
    out.push({ t, r });
  }
  return out;
}

// The same as ratings for study.reviews (browser specs, the UI gallery): one
// synthetic card per record, starting `days` ago at 10:00 UTC, same-day
// steps ten minutes apart; only what lies in the past, in order of time.
export function syntheticReviews(pageId: string, rowIds: string[], now = Date.now(), seed = 1, days = 600) {
  const DAY = 86_400_000;
  const start = Math.floor((now - days * DAY) / DAY) * DAY + 10 * 3_600_000;
  const reviews: { id: string; pageId: string; rowId: string; sub: string; rating: number; reviewedAt: number; zone: string; durationMs: number }[] = [];
  syntheticLog(TRUE_WEIGHTS, rowIds.length, seed, 10).forEach((card, i) => {
    let at = start + i * 60_000;
    card.r.forEach((rating, k) => {
      at += card.t[k] === 0 ? (k ? 10 * 60_000 : 0) : card.t[k] * DAY;
      if (at < now - 3_600_000)
        reviews.push({ id: crypto.randomUUID(), pageId, rowId: rowIds[i], sub: "", rating, reviewedAt: at, zone: "UTC", durationMs: rating === 1 ? 14_000 : 5_000 + ((i * 7 + k * 3) % 5) * 1000 });
    });
  });
  return reviews.sort((a, b) => a.reviewedAt - b.reviewedAt);
}
