// "So heißt das hier" and "Woher kommst du?" (lib/migration-glossary.ts,
// lib/migration-sources.ts): the data the introduction and the
// documentation share.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MIGRATION_GLOSSARY, SHARED_HABITS } from "../lib/migration-glossary";
import { MIGRATION_SOURCES } from "../lib/migration-sources";
import { ONBOARDING_SOURCES } from "../lib/getting-started-items";
import { templateCatalog } from "../lib/template-catalog";
import { STARTERS, GOAL_STARTERS } from "../lib/onboarding-goals";

const catalog = (code: string) => JSON.parse(readFileSync(`locales/${code}.json`, "utf8")) as Record<string, string>;

test("every tool of the introduction has its export guide and its glossary", () => {
  const tools = ONBOARDING_SOURCES.filter((s) => s !== "fresh");
  assert.deepEqual(MIGRATION_SOURCES.map((s) => s.id).sort(), [...tools].sort());
  assert.deepEqual(Object.keys(MIGRATION_GLOSSARY).sort(), [...tools].sort());
  for (const source of MIGRATION_SOURCES) {
    assert.ok(source.steps.length >= 1, source.id);
    // A file route has the picker's types; BookStack's API takes none.
    if (source.route.kind === "bookstack") assert.equal(source.accept, undefined, source.id);
    else assert.ok(source.accept?.split(",").every((a) => /^(\.[a-z]+|[a-z]+\/[a-z.+-]+)$/.test(a)), `${source.id}: ${source.accept}`);
    // The routes the server has: the ZIP import or a known importer.
    if (source.route.kind === "source")
      assert.ok(["auto", "affine", "confluence", "evernote", "gdocs", "obsidian", "word"].includes(source.route.source), source.id);
  }
});

test("glossary entries are well-formed and honest about what is missing", () => {
  for (const [tool, entries] of Object.entries(MIGRATION_GLOSSARY)) {
    assert.ok(entries.length >= 8, `${tool}: at least eight terms`);
    const theirs = entries.map((e) => e.theirs);
    assert.equal(new Set(theirs).size, theirs.length, `${tool}: a term twice`);
    for (const e of entries) {
      if (e.match === "none") {
        assert.equal(e.ours, null, `${tool}/${e.theirs}: no counterpart, no name`);
        assert.ok(e.note, `${tool}/${e.theirs}: says what to do instead`);
      } else assert.ok(e.ours?.de && e.ours.en, `${tool}/${e.theirs}`);
      // A difference is named.
      if (e.match === "similar") assert.ok(e.note, `${tool}/${e.theirs}: similar needs a note`);
      for (const text of [e.ours, e.note].filter(Boolean)) {
        assert.ok(text!.de.trim() && text!.en.trim());
        assert.notEqual(text!.de, "", `${tool}/${e.theirs}`);
      }
    }
  }
  // The term table states the three habits that stay the same.
  assert.equal(SHARED_HABITS.length, 3);
});

test("Flowplan's names are the interface's: each one is a translated text of the app", () => {
  const en = catalog("en"),
    fr = catalog("fr"),
    zh = catalog("zh");
  const texts = [
    ...Object.values(MIGRATION_GLOSSARY).flatMap((entries) => entries.flatMap((e) => [e.ours, e.note].filter((x) => x !== null && x !== undefined))),
    ...SHARED_HABITS,
    ...MIGRATION_SOURCES.flatMap((s) => [...s.steps, s.file]),
  ];
  for (const text of texts) {
    assert.ok(text!.en in en, `not in locales/en.json: ${text!.en} (npm run i18n)`);
    assert.ok(fr[text!.en], `French missing: ${text!.en}`);
    assert.ok(zh[text!.en], `Chinese missing: ${text!.en}`);
  }
});

test("the starters by goal name templates that exist, of the right kind", () => {
  for (const [id, spec] of Object.entries(STARTERS)) {
    if (!spec.template) continue;
    const template = templateCatalog[spec.template];
    assert.ok(template, `${id}: ${spec.template}`);
    assert.equal(template.kind, spec.kind, id);
  }
  for (const [goal, list] of Object.entries(GOAL_STARTERS)) {
    assert.ok(list.length >= 3 && list.length <= 4, goal);
    assert.equal(new Set(list).size, list.length, goal);
  }
});
