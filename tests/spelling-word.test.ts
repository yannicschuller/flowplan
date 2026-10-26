import { test } from "node:test";
import assert from "node:assert/strict";
import { wordAt } from "../lib/spelling-word";

test("the word under the pointer, with apostrophes and hyphens inside", () => {
  assert.deepEqual(wordAt("Ein Tesst hier", 6), { word: "Tesst", start: 4, end: 9 });
  assert.deepEqual(wordAt("Ein Tesst hier", 4), { word: "Tesst", start: 4, end: 9 }, "at its start");
  assert.deepEqual(wordAt("Ein Tesst hier", 9), { word: "Tesst", start: 4, end: 9 }, "right after it");
  assert.deepEqual(wordAt("c'est l'été", 8), { word: "l'été", start: 6, end: 11 });
  assert.deepEqual(wordAt("Müller-Lüdenscheidt.", 3), { word: "Müller-Lüdenscheidt", start: 0, end: 19 });
  assert.deepEqual(wordAt("'quoted'", 3), { word: "quoted", start: 1, end: 7 }, "quotes around a word are no part of it");
});

test("nothing where there is no word", () => {
  assert.equal(wordAt("a  b", 2), null);
  assert.equal(wordAt("123 456", 1), null);
  assert.equal(wordAt("", 0), null);
  assert.equal(wordAt("abc", 9), null);
  assert.equal(wordAt("x".repeat(80), 3), null, "no endless words");
  assert.equal(wordAt("a\ufffcb", 1)?.word, "a", "a mention or other inline node ends a word");
});
