// Typed answers (docs/specs/flashcards.md §5.3): the tolerance per deck,
// the verdict and its suggested rating, the character diff.
import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptedAnswers, answerDiff, compareTyped, levenshtein, normalizeAnswer } from "../lib/study-compare";
import { typedAnswer } from "../lib/study-content";

test("normalising: case, accents, punctuation, whitespace, Unicode forms", () => {
  assert.equal(normalizeAnswer("  Der   Hund. "), "der hund");
  assert.equal(normalizeAnswer("Der Hund.", { ignoreCase: false }), "Der Hund");
  assert.equal(normalizeAnswer("Der Hund.", { ignorePunctuation: false }), "der hund.");
  assert.equal(normalizeAnswer("café"), "café");
  assert.equal(normalizeAnswer("café", { ignoreAccents: true }), "cafe");
  // NFD (decomposed) and NFC (composed) are the same answer.
  assert.equal(normalizeAnswer("café"), normalizeAnswer("café"));
});

test("verdicts and suggestions", () => {
  assert.deepEqual([compareTyped("perro", "Perro").verdict, compareTyped("perro", "Perro").suggested], ["right", 3]);
  // One edit away from a word of six or more letters: almost (Hard).
  const almost = compareTyped("Bahnhfo", "Bahnhof");
  assert.equal(almost.verdict, "wrong");
  const one = compareTyped("Bahnho", "Bahnhof");
  assert.deepEqual([one.verdict, one.suggested, one.distance], ["almost", 2, 1]);
  // Short words have no "almost".
  assert.equal(compareTyped("gat", "gato").verdict, "wrong");
  assert.equal(compareTyped("", "gato").suggested, 1);
  // Accents count by default (languages), not when the deck says so.
  assert.equal(compareTyped("cafe", "café").verdict, "wrong");
  assert.equal(compareTyped("cafe", "café", { ignoreAccents: true }).verdict, "right");
  assert.equal(compareTyped("Cafe!", "café", { ignoreAccents: true }).verdict, "right");
  assert.equal(compareTyped("Cafe", "café", { ignoreAccents: true, ignoreCase: false }).verdict, "wrong");
  // Several accepted answers.
  assert.deepEqual(acceptedAnswers("colour | color"), ["colour", "color"]);
  const either = compareTyped("color", "colour | color");
  assert.deepEqual([either.verdict, either.expected], ["right", "color"]);
  // CJK and right-to-left text compare by character.
  assert.equal(compareTyped("东京", "东京").verdict, "right");
  assert.equal(compareTyped("东", "东京").verdict, "wrong");
  assert.equal(compareTyped("שלום", "שלום").verdict, "right");
  assert.equal(levenshtein("👍🏽a", "👍🏽b"), 1);
});

test("the diff is by character, the tolerance applied", () => {
  assert.deepEqual(answerDiff("Hnud", "Hund"), [
    { type: "same", text: "H" },
    { type: "removed", text: "n" },
    { type: "same", text: "u" },
    { type: "added", text: "n" },
    { type: "same", text: "d" },
  ]);
  // Case is no difference while ignored.
  assert.deepEqual(answerDiff("hund", "Hund"), [{ type: "same", text: "hund" }]);
  assert.deepEqual(answerDiff("hund", "Hund", { ignoreCase: false })[0], { type: "removed", text: "h" });
  // Ignored punctuation is no difference either.
  assert.ok(answerDiff("Hund", "Hund!").every((p) => p.type === "same"));
});

test("the expected answer of a document back is its first paragraph", () => {
  assert.equal(typedAnswer({ html: "<p>der <strong>Hund</strong></p><p>Beispiel: El perro ladra.</p>" }), "der Hund");
  assert.equal(typedAnswer({ text: "rot", formatted: true }), "rot");
  assert.equal(typedAnswer({ text: "\\*Stern\\*", formatted: true }), "*Stern*");
});
