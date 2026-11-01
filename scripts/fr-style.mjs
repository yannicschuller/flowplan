#!/usr/bin/env node
// Lists candidates for informal "tu" imperatives in locales/fr.json for a
// manual look (#74). The unambiguous style rules ("tu"/"ton"/"t’", "Vérifie-le",
// straight apostrophes, "p. ex.") are enforced by tests/fr-style.test.ts; the
// forms here also occur legitimately, so this only reports:
//
//   node scripts/fr-style.mjs            candidates, grouped by word
//   node scripts/fr-style.mjs --all      every occurrence with its key
//
// A candidate is a word at the start of a clause (or after "puis", "et", "ou")
// whose "vous" form ending in -ez also appears in the catalogue ("Bloque" →
// "bloquez"), or a 2nd-person singular form ending in -s ("Choisis", "Fais").
// Expected hits: 3rd-person descriptions ("Vérifie l’adresse …" for
// "Checks the address …"), nouns ("Sauvegarde", "Copie"), participles
// ("événements choisis") and 1st person ("j’attends").
import { readFileSync } from "node:fs";

const catalog = JSON.parse(readFileSync(new URL("../locales/fr.json", import.meta.url), "utf8"));
const vocabulary = new Set(Object.values(catalog).join(" ").toLowerCase().match(/\p{L}+/gu));
const SINGULAR = new Set(
  "fais mets prends dis va sois aie lis écris sers reviens viens vois sache attends rends réponds pars sors crois perds entends rejoins éteins choisis saisis remplis définis finis".split(" "),
);
const CLAUSE_START = /(?:^|[.:;!?–—(«»]\s*|\b(?:puis|et|ou)\s+|,\s*)$/u;

const found = new Map();
for (const [key, value] of Object.entries(catalog)) {
  for (const match of value.matchAll(/\p{L}+/gu)) {
    const word = match[0].toLowerCase();
    const before = value.slice(0, match.index);
    if (!CLAUSE_START.test(before)) continue;
    const candidate =
      SINGULAR.has(word) ||
      (word.length > 3 && word.endsWith("e") && vocabulary.has(`${word}z`)) ||
      (word.endsWith("is") && vocabulary.has(`${word.slice(0, -1)}ssez`));
    if (!candidate) continue;
    if (!found.has(word)) found.set(word, []);
    found.get(word).push([key, value]);
  }
}

const all = process.argv.includes("--all");
for (const [word, list] of [...found].sort((a, b) => b[1].length - a[1].length)) {
  if (!all) {
    console.log(`${word} (${list.length}): ${list[0][1].slice(0, 120)}`);
    continue;
  }
  console.log(`\n${word}`);
  for (const [key, value] of list) console.log(`  ${key.slice(0, 80)}\n    → ${value.slice(0, 200)}`);
}
console.log(`\n${found.size} words to look at.`);
