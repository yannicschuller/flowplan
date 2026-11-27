// Property types of an Obsidian import (#598): Obsidian's registry
// .obsidian/types.json first, else what the values of the whole vault show –
// lists as multi-selects, a small closed set of short values as a select,
// everything else as text; the options hold every value of the vault.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-obsidian-types-"));
const { all, run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { bootstrap } = await import("../lib/api");
const { writeZip } = await import("../lib/archive");
const { importFromSource } = await import("../lib/importers");
const { inferPropertyTypes, obsidianTypes, SELECT_MAX_OPTIONS, MAX_CHOICE_LENGTH } = await import("../lib/frontmatter-types");

const hintsOf = (...args: Parameters<typeof inferPropertyTypes>) => Object.fromEntries(inferPropertyTypes(...args));

test("types.json: Obsidian's types become ours, values that do not fit fall back to inference", () => {
  const registry = obsidianTypes(
    JSON.stringify({ types: { Tags: "multitext", score: "number", done: "checkbox", day: "date", at: "datetime", kind: "text", aliases: "aliases", other: "tags", odd: "weird" } }),
  );
  assert.deepEqual(Object.fromEntries(registry), { tags: "multiselect", score: "number", done: "checkbox", day: "date", at: "date", kind: "text" });
  assert.equal(obsidianTypes("not json").size, 0);
  assert.equal(obsidianTypes(undefined).size, 0);
  const notes = [
    { tags: "a", score: "7", done: "true", day: "2026-01-02", at: "2026-01-02T10:30:00", kind: "x" },
    { tags: ["b", "a"], score: 3, done: false, day: "2026-03-04", at: "2026-03-04T08:00", kind: "x" },
  ];
  assert.deepEqual(hintsOf(notes, registry), {
    // multitext with a single value on the first note: still a multi-select.
    tags: { type: "multiselect", options: ["a", "b"] },
    score: { type: "number" },
    done: { type: "checkbox" },
    day: { type: "date" },
    at: { type: "date" },
    // "text" stays text even where the values would make a select.
    kind: { type: "text" },
  });
  // A word in a number property: the values decide (here: mixed, so text).
  assert.deepEqual(hintsOf([{ score: 1 }, { score: "viel" }], obsidianTypes('{"types":{"score":"number"}}')), { score: { type: "text" } });
  // A multitext property with links is never a multi-select.
  assert.deepEqual(hintsOf([{ up: ["[[Start]]"] }], obsidianTypes('{"types":{"up":"multitext"}}')), { up: { type: "text" } });
});

test("a list on any note makes a multi-select with every item as an option, in first-seen order", () => {
  const hints = hintsOf([{ topics: "Garten" }, { topics: ["Küche", "Garten"] }, { topics: ["Bad"] }, {}]);
  assert.deepEqual(hints, { topics: { type: "multiselect", options: ["Garten", "Küche", "Bad"] } });
});

test("a small closed set of short values becomes a select", () => {
  const notes = ["arquivado", "ativo", "arquivado", "ativo", "pausado", "pausado", "ativo"].map((estado) => ({ estado }));
  assert.deepEqual(hintsOf(notes), { estado: { type: "select", options: ["arquivado", "ativo", "pausado"] } });
  // Too many distinct values, or one used by a single note: text.
  const many = Array.from({ length: SELECT_MAX_OPTIONS + 1 }, (_, i) => [{ v: `w${i}` }, { v: `w${i}` }]).flat();
  assert.deepEqual(hintsOf(many), { v: { type: "text" } });
  assert.deepEqual(hintsOf([{ v: "a" }, { v: "a" }, { v: "b" }]), { v: { type: "text" } });
  // Differing only in case: the values would not stay as they are.
  assert.deepEqual(hintsOf([{ v: "Done" }, { v: "Done" }, { v: "done" }, { v: "done" }]), { v: { type: "text" } });
});

test("free text, links and long values stay text; uniform numbers and dates are left to the guess", () => {
  const sentences = ["Das ist gut. Wirklich.", "Das ist gut. Wirklich."].map((summary) => ({ summary }));
  assert.deepEqual(hintsOf(sentences), { summary: { type: "text" } });
  assert.deepEqual(hintsOf([{ up: "[[Start]]" }, { up: "[[Start]]" }]), { up: { type: "text" } });
  assert.deepEqual(hintsOf([{ up: ["[[Start]]", "b"] }]), { up: { type: "text" } });
  const long = "x".repeat(MAX_CHOICE_LENGTH + 1);
  assert.deepEqual(hintsOf([{ v: long }, { v: long }]), { v: { type: "text" } });
  assert.deepEqual(hintsOf([{ v: [long] }]), { v: { type: "text" } });
  assert.deepEqual(hintsOf([{ v: "a\nb" }, { v: "a\nb" }]), { v: { type: "text" } });
  // Mixed types keep every value as text; uniform ones get no hint.
  assert.deepEqual(hintsOf([{ v: 1 }, { v: "eins" }]), { v: { type: "text" } });
  assert.deepEqual(hintsOf([{ n: 1 }, { n: 2 }, { d: "2026-01-02" }, { d: "2026-01-02" }, { u: "https://a.example" }, { u: "https://a.example" }]), {});
});

test("an imported vault creates selects and multi-selects whose options hold every value", async () => {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, "types", "types@example.test");
  const owner = { id: uid, name: "types", email: "types@example.test", groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
  const wid = await createWorkspace(owner.id, "Typen");
  const space = (await bootstrap(owner, wid)).spaces[0].id;
  const note = (front: string) => Buffer.from(`---\n${front}\n---\nText\n`);
  const bytes = await writeZip(
    new Map([
      [".obsidian/types.json", Buffer.from(JSON.stringify({ types: { bereich: "multitext", punkte: "number", wann: "datetime" } }))],
      // The first note has scalars where later notes have lists.
      ["A.md", note("estado: arquivado\nthemen: Garten\nbereich: Haus\npunkte: 3\nwann: 2026-01-02T10:30:00\nnotiz: Ein langer Satz. Noch einer.\nlink: \"[[B]]\"")],
      ["B.md", note("estado: ativo\nthemen: [Küche, Garten]\nbereich: [Haus, Büro]\npunkte: 5\nnotiz: kurz\nlink: \"[[A]]\"")],
      ["C.md", note("estado: arquivado\nthemen:\n  - Bad\nnotiz: anders\nlink: \"[[A]]\"")],
      ["D.md", note("estado: ativo\nbereich: Büro")],
    ]),
  );
  await importFromSource(owner, wid, space, { name: "vault.zip", bytes }, { source: "obsidian" });
  const defs = Object.fromEntries(
    (await all<{ name: string; type: string; options: string }>("SELECT name,type,options FROM page_property_defs WHERE workspace_id=?", wid)).map((d) => [
      d.name,
      { type: d.type, options: JSON.parse(d.options) },
    ]),
  );
  assert.deepEqual(defs, {
    estado: { type: "select", options: ["arquivado", "ativo"] },
    themen: { type: "multiselect", options: ["Garten", "Küche", "Bad"] },
    bereich: { type: "multiselect", options: ["Haus", "Büro"] },
    punkte: { type: "number", options: [] },
    wann: { type: "date", options: [] },
    notiz: { type: "text", options: [] },
    link: { type: "text", options: [] },
  });
  const values = await all<{ title: string; name: string; value: string }>(
    "SELECT p.title,d.name,v.value FROM page_property_values v JOIN page_property_defs d ON d.id=v.property_id JOIN pages p ON p.id=v.page_id WHERE p.workspace_id=? ORDER BY p.title,d.name",
    wid,
  );
  const of = (title: string) => Object.fromEntries(values.filter((v) => v.title === title).map((v) => [v.name, JSON.parse(v.value)]));
  assert.deepEqual(of("A"), { bereich: ["Haus"], estado: "arquivado", link: "[[B]]", notiz: "Ein langer Satz. Noch einer.", punkte: 3, themen: ["Garten"], wann: "2026-01-02T10:30:00" });
  assert.deepEqual(of("B"), { bereich: ["Haus", "Büro"], estado: "ativo", link: "[[A]]", notiz: "kurz", punkte: 5, themen: ["Küche", "Garten"] });
  assert.deepEqual(of("D"), { bereich: ["Büro"], estado: "ativo" });
});
