// The order of a study session (docs/specs/flashcards.md §4.6, §4.7):
// limits, learn-ahead, mixing, burying siblings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildQueue, sessionOrder, LEARN_AHEAD_MS, type QueueCard, type QueueInput } from "../lib/study-queue";
import type { Memory } from "../lib/fsrs";

const now = Date.parse("2026-11-18T10:00:00Z");
const dayEnd = Date.parse("2026-11-19T03:00:00Z");
const memory = (state: 1 | 2 | 3, due: number, dueDay: string | null = null): Memory => ({ state, step: 0, due, dueDay, stability: 1, difficulty: 5, reps: 1, lapses: 0, lastReview: now - 86_400_000 });
const card = (rowId: string, m: Memory | null = null, sub = "", position = 0): QueueCard => ({ rowId, sub, position, memory: m });
const input = (cards: QueueCard[], more: Partial<QueueInput> = {}): QueueInput => ({
  cards,
  now,
  dayEnd,
  day: "2026-11-18",
  done: { new: 0, review: 0 },
  limits: { new: 20, review: 200 },
  studiedRows: new Set(),
  bury: { new: true, review: true },
  ...more,
});

test("limits: new and reviews per day, minus what was done today", () => {
  const cards = [
    ...Array.from({ length: 30 }, (_, i) => card(`n${i}`, null, "", i)),
    ...Array.from({ length: 10 }, (_, i) => card(`r${i}`, memory(2, now - 1000, "2026-11-18"))),
    // Due tomorrow: not today.
    card("later", memory(2, dayEnd + 1, "2026-11-19")),
  ];
  const q = buildQueue(input(cards, { limits: { new: 20, review: 4 }, done: { new: 5, review: 1 } }));
  assert.deepEqual(q.counts, { new: 15, learning: 0, review: 3 });
  // New cards in the order they were added.
  assert.deepEqual(q.new.slice(0, 3).map((c) => c.rowId), ["n0", "n1", "n2"]);
  // "Heute mehr lernen" is a higher limit for today.
  assert.equal(buildQueue(input(cards, { limits: { new: 40, review: 200 } })).counts.new, 30);
  assert.equal(buildQueue(input(cards, { limits: { new: 0, review: 0 } })).counts.new, 0);
});

test("learning cards: due within 20 minutes now, later ones counted and announced", () => {
  const soon = card("soon", memory(1, now + LEARN_AHEAD_MS - 1000));
  const late = card("late", memory(3, now + 2 * 3_600_000));
  const tomorrow = card("tomorrow", memory(1, dayEnd + 60_000));
  const q = buildQueue(input([late, soon, tomorrow]));
  assert.deepEqual(q.learning.map((c) => c.rowId), ["soon"]);
  assert.equal(q.counts.learning, 2);
  assert.equal(q.nextDue, null);
  const waiting = buildQueue(input([late]));
  assert.equal(waiting.learning.length, 0);
  assert.equal(waiting.nextDue, late.memory!.due);
});

test("siblings wait for the next day; never two cards of a record in one batch", () => {
  const cards = [card("a", null, "", 1), card("a", null, "r", 1), card("b", memory(2, now, "2026-11-18")), card("b", null, "r", 2), card("c", null, "", 3)];
  const q = buildQueue(input(cards, { studiedRows: new Set(["c"]) }));
  assert.deepEqual(q.review.map((c) => `${c.rowId}${c.sub}`), ["b"]);
  assert.deepEqual(q.new.map((c) => `${c.rowId}${c.sub}`), ["a"]);
  // Without burying both come.
  const all = buildQueue(input(cards, { bury: { new: false, review: false } }));
  assert.equal(all.new.length, 4);
  // A learning card's sibling waits too, the learning card itself never.
  const learning = buildQueue(input([card("d", memory(1, now)), card("d", null, "r")], { studiedRows: new Set(["d"]) }));
  assert.deepEqual([learning.learning.length, learning.new.length], [1, 0]);
});

test("reviews by due day, random within a day but the same all day", () => {
  const cards = Array.from({ length: 12 }, (_, i) => card(`r${i}`, memory(2, now - i, i < 6 ? "2026-11-17" : "2026-11-18")));
  const q = buildQueue(input(cards));
  assert.ok(q.review.slice(0, 6).every((c) => c.memory!.dueDay === "2026-11-17"));
  assert.deepEqual(buildQueue(input([...cards].reverse())).review, q.review);
  const other = buildQueue(input(cards, { day: "2026-11-19" }));
  assert.notDeepEqual(other.review.map((c) => c.rowId), q.review.map((c) => c.rowId));
});

test("session order: learning first, new cards mixed between reviews", () => {
  const learning = [card("L", memory(1, now))];
  const review = Array.from({ length: 6 }, (_, i) => card(`R${i}`, memory(2, now, "2026-11-18")));
  const fresh = [card("N0"), card("N1"), card("N2")];
  const order = (mix: "mixed" | "before" | "after") => sessionOrder({ learning, review, new: fresh }, mix).map((c) => c.rowId).join(" ");
  assert.equal(order("mixed"), "L R0 R1 N0 R2 R3 N1 R4 R5 N2");
  assert.equal(order("before"), "L N0 N1 N2 R0 R1 R2 R3 R4 R5");
  assert.equal(order("after"), "L R0 R1 R2 R3 R4 R5 N0 N1 N2");
  assert.equal(sessionOrder({ learning: [], review: [], new: fresh }).length, 3);
});
