// FSRS behind lib/fsrs (docs/specs/flashcards.md §4, §14.1): the pinned
// ts-fsrs (6, FSRS-6 model) checked against the FSRS-6 formulas written out
// here (§4.2), its default weights, the intervals of ts-fsrs 5 without fuzz
// (golden values), the clipping of weights, deterministic fuzz within its
// range, study days and the replay of a log.
import { test } from "node:test";
import assert from "node:assert/strict";
import { clipWeights, defaultParams, defaultWeights, fsrsCardId, intervalOf, preview, replay, retrievability, schedule, type FsrsParams, type Memory } from "../lib/fsrs";
import { studyDayStart, addDays } from "../lib/study-day";
import { getFuzzRange } from "ts-fsrs";

const w = defaultWeights;
const UTC = { zone: "UTC" };
const close = (a: number, b: number, eps = 1e-4) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const at = (iso: string) => Date.parse(iso);
const CARD = fsrsCardId("00000000-0000-4000-8000-000000000001", "");
const noFuzz: FsrsParams = { ...defaultParams, fuzz: false };

test("the default weights are FSRS-6's 21 of the pinned version", () => {
  // ts-fsrs 6 (models/fsrs-6), as 5.4.2 (and fsrs-rs / Anki 25.x): FSRS-6 defaults.
  assert.deepEqual(
    [...w],
    [0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542],
  );
});

// §4.2 written out independently of the library.
const D0 = (g: number) => w[4] - Math.exp(w[5] * (g - 1)) + 1;
const F = Math.pow(0.9, -1 / w[20]) - 1;
const R = (t: number, s: number) => Math.pow(1 + (F * t) / s, -w[20]);
const clampD = (d: number) => Math.min(10, Math.max(1, d));

test("first rating: S0 = w[G-1], D0 = w4 − e^(w5·(G−1)) + 1 (clamped)", () => {
  const p = preview(null, at("2026-11-18T10:00:00Z"), defaultParams, UTC, CARD);
  for (const g of [1, 2, 3, 4] as const) {
    close(p[g].memory.stability, w[g - 1]);
    close(p[g].memory.difficulty, clampD(D0(g)));
  }
  // Learning steps [1, 10] min: Again 1 min, Hard between the steps (5.5, rounded to 6 min as before), Good 10 min; Easy graduates.
  assert.deepEqual(
    [1, 2, 3, 4].map((g) => p[g as 1].memory.state),
    [1, 1, 1, 2],
  );
  const now = at("2026-11-18T10:00:00Z");
  assert.deepEqual([1, 2, 3].map((g) => (p[g as 1].memory.due - now) / 60_000), [1, 6, 10]);
  // Easy: I(0.9, S0(4)) = S0(4) days ≈ 8, fuzzed within its range.
  const easy = p[4].memory;
  const { minInterval, maxInterval } = getFuzzRange(Math.round(w[3]), 0, 36500);
  const days = (studyDayStart(easy.dueDay!, "UTC") - studyDayStart("2026-11-18", "UTC")) / 86_400_000;
  assert.ok(days >= minInterval && days <= maxInterval, `${days} in ${minInterval}..${maxInterval}`);
});

test("a successful review grows S by the FSRS-6 formula, a lapse shrinks it", () => {
  const S = 10,
    D = 5,
    t = 10;
  const last = at("2026-11-08T12:00:00Z"),
    now = at("2026-11-18T12:00:00Z");
  const memory: Memory = { state: 2, step: 0, due: now - 3_600_000, dueDay: "2026-11-18", stability: S, difficulty: D, reps: 3, lapses: 0, lastReview: last };
  const r = R(t, S);
  close(r, 0.9);
  close(retrievability(memory, now, UTC), r);
  const grow = (g: number) => S * (1 + Math.exp(w[8]) * (11 - D) * Math.pow(S, -w[9]) * (Math.exp(w[10] * (1 - r)) - 1) * (g === 2 ? w[15] : 1) * (g === 4 ? w[16] : 1));
  const nextD = (g: number) => {
    const delta = -w[6] * (g - 3);
    const damped = D + (delta * (10 - D)) / 9;
    return clampD(w[7] * D0(4) + (1 - w[7]) * damped);
  };
  const p = preview(memory, now, defaultParams, UTC, CARD);
  for (const g of [2, 3, 4] as const) {
    close(p[g].memory.stability, grow(g), 1e-3);
    close(p[g].memory.difficulty, nextD(g), 1e-3);
    assert.equal(p[g].memory.state, 2);
    assert.equal(p[g].elapsedDays, t);
  }
  const forget = Math.min(S, w[11] * Math.pow(D, -w[12]) * (Math.pow(S + 1, w[13]) - 1) * Math.exp(w[14] * (1 - r)));
  close(p[1].memory.stability, forget, 1e-3);
  assert.equal(p[1].memory.state, 3);
  assert.equal(p[1].memory.lapses, 1);
  // Hard < Good < Easy, whatever the fuzz.
  for (let i = 0; i < 50; i++) {
    const q = preview(memory, now, defaultParams, UTC, fsrsCardId(`row-${i}`, ""));
    assert.ok(q[2].memory.dueDay! <= q[3].memory.dueDay! && q[3].memory.dueDay! < q[4].memory.dueDay!, `card ${i}`);
  }
});

test("fuzz is deterministic by the card and its count of reviews, the same for the buttons and the rating", () => {
  const now = at("2026-11-18T09:00:00Z");
  const memory: Memory = { state: 2, step: 0, due: now, dueDay: "2026-11-18", stability: 40, difficulty: 4, reps: 6, lapses: 0, lastReview: at("2026-10-09T09:00:00Z") };
  const a = schedule(memory, 3, now, defaultParams, UTC, CARD);
  // Repeated calls, and the rating a minute after the buttons were shown.
  assert.deepEqual(schedule(memory, 3, now, defaultParams, UTC, CARD), a);
  assert.deepEqual(preview(memory, now, defaultParams, UTC, CARD)[3], a);
  assert.equal(schedule(memory, 3, now + 60_000, defaultParams, UTC, CARD).memory.dueDay, a.memory.dueDay);
  // Another card or another count of reviews: another draw.
  const byCard = new Set(Array.from({ length: 40 }, (_, i) => schedule(memory, 3, now, defaultParams, UTC, fsrsCardId(`row-${i}`, "")).memory.dueDay));
  assert.ok(byCard.size > 1, "different cards give different fuzz");
  const byReps = new Set(Array.from({ length: 40 }, (_, i) => schedule({ ...memory, reps: i }, 3, now, defaultParams, UTC, CARD).memory.dueDay));
  assert.ok(byReps.size > 1, "different counts of reviews give different fuzz");
  // The sub-card is part of the card's id, which ends before the count.
  assert.notEqual(`${fsrsCardId("r", "c1")}12`, `${fsrsCardId("r", "c11")}2`);
});

test("a fuzzed interval stays within ts-fsrs's fuzz range of the unfuzzed one (also at the maximum interval)", () => {
  const now = at("2026-11-18T09:00:00Z");
  const elapsed = 40;
  // Easy, and Hard where the maximum interval caps (as in ts-fsrs 5, Good and
  // Easy are then still a day and two later than Hard).
  for (const [stability, maxInterval, rating] of [
    [4, 36500, 4],
    [12, 36500, 4],
    [40, 36500, 4],
    [300, 36500, 4],
    [300, 30, 2],
    [3000, 100, 2],
  ] as const) {
    const memory: Memory = { state: 2, step: 0, due: now, dueDay: "2026-11-18", stability, difficulty: 5, reps: 6, lapses: 0, lastReview: now - elapsed * 86_400_000 };
    const params = { ...defaultParams, maxInterval };
    const plain = schedule(memory, rating, now, { ...params, fuzz: false }, UTC, CARD).scheduledDays;
    const { minInterval, maxInterval: highest } = getFuzzRange(plain, elapsed, maxInterval);
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const days = schedule(memory, rating, now, params, UTC, fsrsCardId(`row-${i}`, "")).scheduledDays;
      assert.ok(days >= minInterval && days <= highest, `S ${stability}, max ${maxInterval}: ${days} in ${minInterval}..${highest} (unfuzzed ${plain})`);
      seen.add(days);
    }
    assert.ok(highest === minInterval || seen.size > 1, `S ${stability}: spread`);
  }
});

test("short intervals are not fuzzed: under 2.5 days the dates are the same with and without fuzz", () => {
  const now = at("2026-11-18T09:00:00Z");
  const memory: Memory = { state: 2, step: 0, due: now, dueDay: "2026-11-18", stability: 0.4, difficulty: 6, reps: 3, lapses: 0, lastReview: now - 86_400_000 };
  let checked = 0;
  for (const rating of [1, 2, 3, 4] as const) {
    const plain = schedule(memory, rating, now, noFuzz, UTC, CARD);
    if (plain.scheduledDays >= 2.5) continue;
    checked++;
    assert.deepEqual(schedule(memory, rating, now, defaultParams, UTC, CARD), plain, `rating ${rating}`);
  }
  assert.ok(checked >= 2);
  // Learning steps neither.
  for (const rating of [1, 2, 3] as const) assert.deepEqual(schedule(null, rating, now, defaultParams, UTC, CARD), schedule(null, rating, now, noFuzz, UTC, CARD));
});

test("weights are clipped to FSRS-6's bounds, w17/w18 by the relearning steps (stored personal weights too)", () => {
  // ts-fsrs 5.4.2's clipParameters gave the same: w17 ≤ 0.49027301 with three relearning steps.
  assert.deepEqual(clipWeights(w, 1), [...w]);
  assert.equal(clipWeights(w, 3)[17], 0.49027301);
  const wild = [0.0001, 200, 3, 9, 0.5, 9, 9, 2, 9, 9, 9, 9, 9, 9, 9, 9, 0.5, 5, 5, 2, 0.01];
  assert.deepEqual(clipWeights(wild, 1), [0.001, 100, 3, 9, 1, 4, 4, 0.75, 4.5, 0.8, 3.5, 5, 0.25, 0.9, 4, 1, 1, 2, 2, 0.8, 0.1]);
  // The scheduler schedules with the clipped weights.
  const now = at("2026-11-18T09:00:00Z");
  const memory: Memory = { state: 2, step: 0, due: now, dueDay: "2026-11-18", stability: 8, difficulty: 5, reps: 4, lapses: 0, lastReview: now - 8 * 86_400_000 };
  const params = { ...defaultParams, relearningSteps: [10, 20, 30] };
  for (const rating of [1, 2, 3, 4] as const)
    assert.deepEqual(schedule(memory, rating, now, { ...params, weights: wild }, UTC, CARD), schedule(memory, rating, now, { ...params, weights: clipWeights(wild, 3) }, UTC, CARD));
});

// Without fuzz the dates are those of ts-fsrs 5.4.2 (golden values computed
// with it), so cards scheduled before the update go on as they would have.
test("golden sequences without fuzz, as ts-fsrs 5.4.2 scheduled them: [3,3,3,3,3,3,3] and [1,3,3,4,1,3]", () => {
  const run = (ratings: number[], params: FsrsParams) => {
    let memory: Memory | null = null;
    let now = at("2026-01-05T10:00:00Z");
    const out: string[] = [];
    ratings.forEach((g) => {
      memory = schedule(memory, g as 1, now, params, UTC, CARD).memory;
      out.push(`${memory.state}:${memory.dueDay ?? "-"}:${memory.stability.toFixed(4)}:${memory.difficulty.toFixed(4)}`);
      // The next rating when the card is due (learning: at its due time).
      now = memory.dueDay ? studyDayStart(memory.dueDay, "UTC") + 6 * 3_600_000 : memory.due;
    });
    return out;
  };
  assert.deepEqual(run([3, 3, 3, 3, 3, 3, 3], noFuzz), [
    "1:-:2.3065:2.1181",
    "2:2026-01-07:2.3065:2.1112",
    "2:2026-01-18:10.9710:2.1043",
    "2:2026-03-05:46.3169:2.0975",
    "2:2026-08-15:162.9998:2.0906",
    "2:2027-12-26:497.8766:2.0837",
    "2:2031-09-04:1347.9186:2.0769",
  ]);
  assert.deepEqual(run([1, 3, 3, 4, 1, 3], noFuzz), [
    "1:-:0.2120:6.4133",
    "1:-:0.2467:6.4021",
    "2:2026-01-06:0.2842:6.3909",
    "2:2026-01-10:3.7825:5.1702",
    "3:-:0.8101:8.3977",
    "2:2026-01-11:0.8631:8.3845",
  ]);
  // With fuzz (ts-fsrs 6's, seeded with this card): pinned, so a change of the fuzz shows.
  assert.deepEqual(run([3, 3, 3, 3, 3, 3, 3], defaultParams), FUZZED);
});
const FUZZED = [
  "1:-:2.3065:2.1181",
  "2:2026-01-07:2.3065:2.1112",
  "2:2026-01-19:10.9710:2.1043",
  "2:2026-03-09:48.5596:2.0975",
  "2:2026-08-29:171.3189:2.0906",
  "2:2028-02-09:522.8216:2.0837",
  "2:2031-10-31:1415.5097:2.0769",
];

test("learning steps as ts-fsrs 5 had them: Hard rounded, a day step graduates, no steps graduate at once", () => {
  const now = at("2026-11-18T10:00:00Z");
  const minutes = (params: FsrsParams, rating: 1 | 2 | 3 | 4) => (schedule(null, rating, now, params, UTC, CARD).memory.due - now) / 60_000;
  // One step of 5 min: Hard 7.5, rounded to 8.
  assert.equal(minutes({ ...noFuzz, learningSteps: [5] }, 2), 8);
  // No learning steps: every rating graduates with FSRS's interval (not raised to follow Again's).
  const none = preview(null, now, { ...noFuzz, learningSteps: [] }, UTC, CARD);
  assert.deepEqual(
    [1, 2, 3, 4].map((g) => [none[g as 1].memory.state, none[g as 1].scheduledDays]),
    NONE,
  );
  // A step of a day or more: in review, due after the step.
  const day = schedule(null, 3, now, { ...noFuzz, learningSteps: [5, 1500] }, UTC, CARD).memory;
  assert.equal(day.state, 2);
  assert.equal(day.dueDay, "2026-11-19");
});
const NONE = [
  [2, 1],
  [2, 1],
  [2, 2],
  [2, 8],
];

test("days between reviews are study days in the person's zone", () => {
  const zone = { zone: "Europe/Berlin" };
  // 23:00 on Monday and 05:00 on Tuesday are one study day apart (04:00 cut),
  // 03:00 on Tuesday still belongs to Monday.
  const monday = at("2026-11-16T22:00:00Z");
  const memory = schedule(null, 4, monday, defaultParams, zone, CARD).memory;
  const early = schedule(memory, 3, at("2026-11-17T02:00:00Z"), defaultParams, zone, CARD);
  const later = schedule(memory, 3, at("2026-11-17T04:00:00Z"), defaultParams, zone, CARD);
  assert.equal(early.elapsedDays, 0);
  assert.equal(later.elapsedDays, 1);
  // A review is due at 04:00 local of its day.
  assert.equal(new Date(memory.due).toISOString().slice(11, 16), "03:00");
});

test("a learning step past the end of the study day waits for the start of its day", () => {
  const now = at("2026-11-18T02:30:00Z"); // 03:30 in Berlin: 30 min left of the day
  const next = schedule(null, 1, now, { ...defaultParams, learningSteps: [60] }, { zone: "Europe/Berlin" }, CARD).memory;
  assert.equal(next.state, 1);
  assert.equal(next.due, studyDayStart(addDays("2026-11-17", 1), "Europe/Berlin"));
});

test("replaying a log gives the stored state (undo, later offline merges)", () => {
  let memory: Memory | null = null;
  let now = at("2026-02-01T08:00:00Z");
  const log: { id: string; rating: 1 | 2 | 3 | 4; reviewedAt: number; zone: string }[] = [];
  for (const [i, g] of ([3, 3, 1, 3, 4, 2, 3] as const).entries()) {
    const id = `r${i}`;
    memory = schedule(memory, g, now, defaultParams, { zone: "America/New_York" }, CARD).memory;
    log.push({ id, rating: g, reviewedAt: now, zone: "America/New_York" });
    now = memory.due + 60_000;
  }
  assert.deepEqual(replay(CARD, log, defaultParams), memory);
  // Order of arrival does not matter.
  assert.deepEqual(replay(CARD, [...log].reverse(), defaultParams), memory);
  assert.equal(replay(CARD, [], defaultParams), null);
});

test("intervals for the buttons", () => {
  const now = at("2026-11-18T10:00:00Z");
  const p = preview(null, now, defaultParams, UTC, CARD);
  assert.deepEqual(intervalOf(p[1].memory, now, UTC), { unit: "minutes", value: 1 });
  assert.deepEqual(intervalOf(p[3].memory, now, UTC), { unit: "minutes", value: 10 });
  assert.equal(intervalOf(p[4].memory, now, UTC).unit, "days");
});
