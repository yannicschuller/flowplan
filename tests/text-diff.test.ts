import { test } from "node:test";
import assert from "node:assert/strict";
import { diff, compareParagraphs } from "../lib/text-diff";

function apply<T>(ops: { type: string; value: T }[]) {
  return {
    before: ops.filter((o) => o.type !== "added").map((o) => o.value),
    after: ops.filter((o) => o.type !== "removed").map((o) => o.value),
  };
}
test("myers diff reconstructs both sides with minimal edits", () => {
  assert.deepEqual(diff([], []), []);
  assert.deepEqual(diff(["a"], []), [{ type: "removed", value: "a" }]);
  assert.deepEqual(diff([], ["a"]), [{ type: "added", value: "a" }]);
  const ops = diff("ABCABBA".split(""), "CBABAC".split(""))!;
  assert.equal(ops.filter((o) => o.type !== "same").length, 5);
  let seed = 7;
  const random = () =>
    (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let round = 0; round < 300; round++) {
    const a = Array.from(
      { length: Math.floor(random() * 30) },
      () => "abcd"[Math.floor(random() * 4)],
    );
    const b = a
      .filter(() => random() > 0.2)
      .flatMap((x) => (random() > 0.8 ? [x, "e"] : [x]));
    const result = diff(a, b)!;
    assert.deepEqual(apply(result), { before: a, after: b });
  }
});
test("paragraph comparison marks inline word changes and gives up on huge edits", () => {
  assert.deepEqual(
    compareParagraphs(
      ["Titel", "Der Hund bellt laut", "Ende"],
      ["Titel", "Der Hund schläft laut", "Neu", "Ende"],
    ),
    [
      { type: "same", text: "Titel" },
      {
        type: "changed",
        parts: [
          { type: "same", text: "Der Hund " },
          { type: "removed", text: "bellt" },
          { type: "added", text: "schläft" },
          { type: "same", text: " laut" },
        ],
      },
      { type: "added", text: "Neu" },
      { type: "same", text: "Ende" },
    ],
  );
  const many = (p: string) => Array.from({ length: 5000 }, (_, i) => p + i);
  assert.equal(compareParagraphs(many("a"), many("b")), null);
});
