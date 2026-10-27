// Planning poker maths and visibility (lib/whiteboard-estimation.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DECKS, deckOf, estimateStats, estimationView, parseCustomDeck, type Estimation } from "../lib/whiteboard-estimation";

const fib = [...DECKS.fibonacci];
test("numbers: distribution in deck order, average, median, nearest card", () => {
  const s = estimateStats(["8", "3", "5", "5", "?", "☕"], fib);
  assert.deepEqual(s.distribution, [
    { value: "3", count: 1 },
    { value: "5", count: 2 },
    { value: "8", count: 1 },
    { value: "?", count: 1 },
    { value: "☕", count: 1 },
  ]);
  assert.equal(s.votes, 6);
  assert.equal(s.counted, 4);
  assert.equal(s.average, 5.3);
  assert.equal(s.median, "5");
  assert.equal(s.consensus, false);
  assert.equal(s.suggestion, "5");
  // An even count: the middle of the two; the suggestion is the nearest card (ties: larger).
  const even = estimateStats(["3", "8"], fib);
  assert.equal(even.median, "5.5");
  assert.equal(even.suggestion, "5");
  assert.equal(estimateStats(["2", "3"], fib).suggestion, "3");
});
test("consensus needs two or more equal estimates; abstentions do not count", () => {
  assert.equal(estimateStats(["5", "5", "?"], fib).consensus, true);
  assert.equal(estimateStats(["5", "5", "?"], fib).suggestion, "5");
  assert.equal(estimateStats(["5"], fib).consensus, false);
  const none = estimateStats(["?", "☕"], fib);
  assert.equal(none.counted, 0);
  assert.equal(none.average, null);
  assert.equal(none.median, null);
  assert.equal(none.suggestion, null);
  assert.equal(estimateStats([], fib).votes, 0);
});
test("sizes: the middle by the deck's order, no average", () => {
  const sizes = [...DECKS.tshirt];
  const s = estimateStats(["XL", "S", "M", "M"], sizes);
  assert.equal(s.average, null);
  assert.equal(s.median, "M");
  assert.equal(s.suggestion, "M");
  assert.deepEqual(s.distribution.map((d) => d.value), ["S", "M", "XL"]);
});
test("custom decks: separators, duplicates and lengths", () => {
  assert.deepEqual(parseCustomDeck("1, 2;4\n8  16, 2"), ["1", "2", "4", "8", "16"]);
  assert.deepEqual(parseCustomDeck("sehr-langer-wert-der-zu-lang-ist"), ["sehr-langer-"]);
  assert.equal(parseCustomDeck(Array.from({ length: 30 }, (_, i) => i).join(",")).length, 20);
  assert.deepEqual(deckOf("tshirt"), { kind: "tshirt", values: ["XS", "S", "M", "L", "XL"] });
  assert.deepEqual(deckOf("custom", "½, 1, 2").values, ["½", "1", "2"]);
  assert.equal(estimateStats(["½", "1"], ["½", "1", "2"]).average, 0.8);
});
test("before the reveal each person sees only who voted and their own card", () => {
  const session: Estimation = {
    id: crypto.randomUUID(),
    deck: deckOf("fibonacci"),
    items: ["a"],
    index: 0,
    round: crypto.randomUUID(),
    revealed: false,
    by: "u1",
    name: "Mara",
    startedAt: 0,
    results: {},
  };
  const votes = [
    { userId: "u1", name: "Mara", value: "5" },
    { userId: "u2", name: "Ben", value: "13" },
  ];
  const hidden = estimationView(session, votes, "u2");
  assert.equal(hidden.mine, "13");
  assert.deepEqual(hidden.votes, [{ userId: "u1", name: "Mara" }, { userId: "u2", name: "Ben" }]);
  assert.equal(hidden.stats, null);
  assert.doesNotMatch(JSON.stringify(hidden.votes), /"5"|"13"/);
  const open = estimationView({ ...session, revealed: true }, votes, "u3");
  assert.equal(open.mine, null);
  assert.deepEqual(open.votes.map((v) => v.value), ["5", "13"]);
  assert.equal(open.stats?.average, 9);
});
