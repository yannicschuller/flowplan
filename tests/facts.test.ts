import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { facts, factsJson } from "../lib/facts";
import { LOCALES } from "../lib/i18n";

const root = new URL("..", import.meta.url);

test("facts.json matches the counts in the code (run `npm run facts` after a change)", () => {
  const stored = readFileSync(new URL("facts.json", root), "utf8");
  assert.equal(stored, factsJson(), "facts.json is out of date – run `npm run facts` and commit the result.");
});

test("the counted lists are complete and free of duplicates", () => {
  const f = facts();
  for (const [name, list] of Object.entries(f.names)) {
    const items = Array.isArray(list) ? list : Object.keys(list);
    assert.ok(items.length > 0, name);
    assert.equal(new Set(items).size, items.length, `${name} has duplicates`);
  }
  assert.equal(f.views, f.names.views.length);
  assert.equal(f.fieldTypes, f.names.fieldTypes.length);
  assert.equal(f.questionTypes, f.names.questionTypes.length);
  assert.equal(f.languages, Object.keys(f.names.languages).length);
  assert.equal(f.calloutTypes, f.names.calloutTypes.length);
  assert.equal(f.exportFormats, f.names.exportFormats.length);
  assert.equal(f.templateCategories, f.names.templateCategories.length);
  assert.ok(f.templates >= f.templateCategories);
});

test("every language has a catalogue and every catalogue a language", () => {
  const f = facts();
  assert.deepEqual(Object.keys(f.names.languages), LOCALES);
  // German is written in the code; the others are catalogues in locales/.
  const catalogues = readdirSync(new URL("locales", root))
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.replace(/\.json$/, ""))
    .sort();
  assert.deepEqual(catalogues, LOCALES.filter((code) => code !== "de").sort());
});
