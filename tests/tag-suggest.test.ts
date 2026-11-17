import { test } from "node:test";
import assert from "node:assert/strict";
import { insertTagToken, rankTags, tagFragmentAt } from "../lib/tag-suggest";
import { parseSearchTokens } from "../lib/page-properties";

const tags = ["Reproduktion", "Projekt", "Prototyp", "Big Project", "Übersicht", "pro", "Archiv"].map((name, i) => ({ id: `t${i}`, name }));
const names = (list: { name: string }[]) => list.map((t) => t.name);

test("rankTags: exact, then prefix, then word start, then anywhere", () => {
  assert.deepEqual(names(rankTags(tags, "pro")), ["pro", "Projekt", "Prototyp", "Big Project", "Reproduktion"]);
  // Case and diacritics do not count; a leading # is ignored.
  assert.deepEqual(names(rankTags(tags, "#UBER")), ["Übersicht"]);
  assert.deepEqual(names(rankTags(tags, "übersicht")), ["Übersicht"]);
  // Spaces in the query match spaces in the name.
  assert.deepEqual(names(rankTags(tags, "big  pro")), ["Big Project"]);
  assert.deepEqual(rankTags(tags, "xyz"), []);
  // An empty query keeps every tag in order.
  assert.deepEqual(names(rankTags(tags, "")), names(tags));
  assert.deepEqual(names(rankTags(tags, "  ")), names(tags));
  // Regex characters are taken literally.
  assert.deepEqual(rankTags([{ name: "c++" }, { name: "c" }], "c+").map((t) => t.name), ["c++"]);
});

test("tagFragmentAt: the #… at the caret", () => {
  assert.deepEqual(tagFragmentAt("#pro", 4), { start: 0, end: 4, query: "pro", exclude: false });
  assert.deepEqual(tagFragmentAt("notes #pro", 10), { start: 6, end: 10, query: "pro", exclude: false });
  // The caret inside the word: the whole word is replaced, the query is up to the caret.
  assert.deepEqual(tagFragmentAt("a #projekt b", 6), { start: 2, end: 10, query: "pro", exclude: false });
  assert.deepEqual(tagFragmentAt("-#ar", 4), { start: 0, end: 4, query: "ar", exclude: true });
  assert.deepEqual(tagFragmentAt('#"big pr', 8), { start: 0, end: 8, query: "big pr", exclude: false });
  assert.deepEqual(tagFragmentAt('#"big pr" x', 5), { start: 0, end: 9, query: "big", exclude: false });
  assert.deepEqual(tagFragmentAt("#", 1), { start: 0, end: 1, query: "", exclude: false });
  // Not a tag: # inside a word, after the word, after a finished quoted name, no caret in it.
  assert.equal(tagFragmentAt("C#", 2), null);
  assert.equal(tagFragmentAt("#pro x", 6), null);
  assert.equal(tagFragmentAt('#"big project" ', 15), null);
  assert.equal(tagFragmentAt('#"big project"', 14), null);
  assert.equal(tagFragmentAt("abc", 3), null);
  assert.equal(tagFragmentAt("#pro", 9), null);
});

test("insertTagToken: replaces the fragment with the token and a space", () => {
  const at = (value: string, caret: number, name: string) => insertTagToken(value, tagFragmentAt(value, caret)!, name);
  assert.deepEqual(at("#pro", 4, "Projekt"), { value: "#Projekt ", caret: 9 });
  assert.deepEqual(at("notes #pro more", 10, "Projekt"), { value: "notes #Projekt more", caret: 15 });
  assert.deepEqual(at("a #prx y", 5, "Projekt"), { value: "a #Projekt y", caret: 11 });
  // Names with spaces are quoted; the minus stays.
  assert.deepEqual(at("-#big", 5, "Big Project"), { value: '-#"Big Project" ', caret: 16 });
  assert.deepEqual(at('x #"big p', 9, "Big Project"), { value: 'x #"Big Project" ', caret: 17 });
  // The search reads the inserted token as the tag.
  const { value } = at("report #pro", 11, "Big Project");
  const parsed = parseSearchTokens(value, { tags, properties: [] });
  assert.deepEqual(parsed.tags.map((t) => t.tagId), ["t3"]);
  assert.equal(parsed.text, "report");
});
