// FSRS behind lib/fsrs (docs/specs/flashcards.md §4, §14.1): the pinned
// ts-fsrs checked against the FSRS-6 formulas written out here (§4.2), its
// default weights, deterministic fuzz, study days and the replay of a log.
import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultParams, defaultWeights, intervalOf, preview, replay, retrievability, schedule, type Memory } from "../lib/fsrs";
import { studyDayStart, addDays } from "../lib/study-day";
import { get_fuzz_range } from "ts-fsrs";

const w = defaultWeights;
const UTC = { zone: "UTC" };
const close = (a: number, b: number, eps = 1e-4) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const at = (iso: string) => Date.parse(iso);

test("the default weights are FSRS-6's 21 of the pinned version", () => {
  // ts-fsrs 5.4.2 (and fsrs-rs / Anki 25.x): FSRS-6 defaults.
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
  const p = preview(null, at("2026-11-18T10:00:00Z"), defaultParams, UTC, "seed");
  for (const g of [1, 2, 3, 4] as const) {
    close(p[g].memory.stability, w[g - 1]);
    close(p[g].memory.difficulty, clampD(D0(g)));
  }
  // Learning steps [1, 10] min: Again 1 min, Hard between the steps (6 min), Good 10 min; Easy graduates.
  assert.deepEqual(
    [1, 2, 3, 4].map((g) => p[g as 1].memory.state),
    [1, 1, 1, 2],
  );
  const now = at("2026-11-18T10:00:00Z");
  assert.deepEqual([1, 2, 3].map((g) => (p[g as 1].memory.due - now) / 60_000), [1, 6, 10]);
  // Easy: I(0.9, S0(4)) = S0(4) days ≈ 8, fuzzed within its range.
  const easy = p[4].memory;
  const { min_ivl, max_ivl } = get_fuzz_range(Math.round(w[3]), 0, 36500);
  const days = (studyDayStart(easy.dueDay!, "UTC") - studyDayStart("2026-11-18", "UTC")) / 86_400_000;
  assert.ok(days >= min_ivl && days <= max_ivl, `${days} in ${min_ivl}..${max_ivl}`);
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
  const p = preview(memory, now, defaultParams, UTC, "seed");
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
    const q = preview(memory, now, defaultParams, UTC, `seed-${i}`);
    assert.ok(q[2].memory.dueDay! <= q[3].memory.dueDay! && q[3].memory.dueDay! <= q[4].memory.dueDay!, `seed ${i}`);
  }
});

test("fuzz is deterministic by the review id and stays below the maximum interval", () => {
  const now = at("2026-11-18T09:00:00Z");
  const memory: Memory = { state: 2, step: 0, due: now, dueDay: "2026-11-18", stability: 40, difficulty: 4, reps: 6, lapses: 0, lastReview: at("2026-10-09T09:00:00Z") };
  const a = schedule(memory, 3, now, defaultParams, UTC, "review-1");
  assert.deepEqual(schedule(memory, 3, now, defaultParams, UTC, "review-1"), a);
  const days = new Set(Array.from({ length: 40 }, (_, i) => schedule(memory, 3, now, defaultParams, UTC, `review-${i}`).memory.dueDay));
  assert.ok(days.size > 1, "different ids give different fuzz");
  const capped = schedule(memory, 4, now, { ...defaultParams, maxInterval: 30 }, UTC, "review-1");
  assert.ok(capped.scheduledDays <= 30, String(capped.scheduledDays));
});

test("golden sequences of the pinned version: [3,3,3,3] and [1,3,3,4,1,3]", () => {
  const run = (ratings: number[]) => {
    let memory: Memory | null = null;
    let now = at("2026-01-05T10:00:00Z");
    const out: string[] = [];
    ratings.forEach((g, i) => {
      memory = schedule(memory, g as 1, now, defaultParams, UTC, `golden-${i}`).memory;
      out.push(`${memory.state}:${memory.dueDay ?? "-"}:${memory.stability.toFixed(4)}:${memory.difficulty.toFixed(4)}`);
      // The next rating when the card is due (learning: at its due time).
      now = memory.dueDay ? studyDayStart(memory.dueDay, "UTC") + 6 * 3_600_000 : memory.due;
    });
    return out;
  };
  assert.deepEqual(run([3, 3, 3, 3]), [
    "1:-:2.3065:2.1181",
    "2:2026-01-07:2.3065:2.1112",
    "2:2026-01-18:10.9710:2.1043",
    "2:2026-03-03:46.3169:2.0975",
  ]);
  assert.deepEqual(run([1, 3, 3, 4, 1, 3]), [
    "1:-:0.2120:6.4133",
    "1:-:0.2467:6.4021",
    "2:2026-01-06:0.2842:6.3909",
    "2:2026-01-09:3.7825:5.1702",
    "3:-:0.7851:8.3977",
    "2:2026-01-10:0.8382:8.3845",
  ]);
});

test("days between reviews are study days in the person's zone", () => {
  const zone = { zone: "Europe/Berlin" };
  // 23:00 on Monday and 05:00 on Tuesday are one study day apart (04:00 cut),
  // 03:00 on Tuesday still belongs to Monday.
  const monday = at("2026-11-16T22:00:00Z");
  const memory = schedule(null, 4, monday, defaultParams, zone, "x").memory;
  const early = schedule(memory, 3, at("2026-11-17T02:00:00Z"), defaultParams, zone, "y");
  const later = schedule(memory, 3, at("2026-11-17T04:00:00Z"), defaultParams, zone, "y");
  assert.equal(early.elapsedDays, 0);
  assert.equal(later.elapsedDays, 1);
  // A review is due at 04:00 local of its day.
  assert.equal(new Date(memory.due).toISOString().slice(11, 16), "03:00");
});

test("a learning step past the end of the study day waits for the start of its day", () => {
  const now = at("2026-11-18T02:30:00Z"); // 03:30 in Berlin: 30 min left of the day
  const next = schedule(null, 1, now, { ...defaultParams, learningSteps: [60] }, { zone: "Europe/Berlin" }, "z").memory;
  assert.equal(next.state, 1);
  assert.equal(next.due, studyDayStart(addDays("2026-11-17", 1), "Europe/Berlin"));
});

test("replaying a log gives the stored state (undo, later offline merges)", () => {
  let memory: Memory | null = null;
  let now = at("2026-02-01T08:00:00Z");
  const log: { id: string; rating: 1 | 2 | 3 | 4; reviewedAt: number; zone: string }[] = [];
  for (const [i, g] of ([3, 3, 1, 3, 4, 2, 3] as const).entries()) {
    const id = `r${i}`;
    memory = schedule(memory, g, now, defaultParams, { zone: "America/New_York" }, id).memory;
    log.push({ id, rating: g, reviewedAt: now, zone: "America/New_York" });
    now = memory.due + 60_000;
  }
  assert.deepEqual(replay(log, defaultParams), memory);
  // Order of arrival does not matter.
  assert.deepEqual(replay([...log].reverse(), defaultParams), memory);
  assert.equal(replay([], defaultParams), null);
});

test("intervals for the buttons", () => {
  const now = at("2026-11-18T10:00:00Z");
  const p = preview(null, now, defaultParams, UTC, "s");
  assert.deepEqual(intervalOf(p[1].memory, now, UTC), { unit: "minutes", value: 1 });
  assert.deepEqual(intervalOf(p[3].memory, now, UTC), { unit: "minutes", value: 10 });
  assert.equal(intervalOf(p[4].memory, now, UTC).unit, "days");
});
