import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// House style of locales/fr.json (#74): formal "vous", "par ex.", typographic
// apostrophes. These checks only flag forms that cannot be read any other way,
// so they stay free of false positives. Bare imperatives ("Vérifie", "Choisis")
// are also 3rd-person descriptions or participles ("Vérifie l’adresse …" for
// "Checks the address …", "événements choisis"); `node scripts/fr-style.mjs`
// lists those candidates for a manual look.
const catalog = JSON.parse(readFileSync("locales/fr.json", "utf8")) as Record<string, string>;

// Informal pronouns and possessives. "ton" is also "tone" – allowed where the English says so.
const TU = /(?<![\p{L}\p{N}_-])(?:[Tt]u|[Tt]oi|[Tt]e|[Tt]a|[Tt]es|[Tt]on|[Tt]iens?|[Tt]ienne)(?![\p{L}\p{N}_])|(?<![\p{L}\p{N}_-])[Tt]’(?=\p{L})/gu;
// Singular imperative with an attached pronoun ("Vérifie-le", "Ouvre-la", "Assieds-toi");
// the "vous" forms end in -z or are "dites"/"faites".
const IMPERATIVE_PRONOUN = /\p{L}*(?<!ites?)(?<!z)(?<=\p{L})-(?:le|la|les|moi|toi|lui|leur)(?![\p{L}-])/gu;
const STRAIGHT_APOSTROPHE = /\p{L}'\p{L}/gu;
const P_EX = /(?<!\p{L})[Pp]\. ?ex\./gu;

function hits(re: RegExp, allow?: (key: string, word: string) => boolean) {
  const found: string[] = [];
  for (const [key, value] of Object.entries(catalog))
    for (const [word] of value.matchAll(re)) if (!allow?.(key, word)) found.push(`${key} → ${word}`);
  return found;
}

test("French: formal “vous”, no “tu”, “ton”, “tes”, “te” …", () => {
  assert.deepEqual(hits(TU, (key, word) => /^ton$/i.test(word) && /\btone\b/i.test(key)), []);
  assert.deepEqual(hits(IMPERATIVE_PRONOUN), []);
});

test("French: typographic apostrophes and “par ex.”", () => {
  assert.deepEqual(hits(STRAIGHT_APOSTROPHE), []);
  assert.deepEqual(hits(P_EX), []);
});

test("the French style checks catch the forms they are meant for", () => {
  const sample = (re: RegExp, text: string) => [...text.matchAll(re)].map((m) => m[0]);
  assert.deepEqual(sample(TU, "Change ton mot de passe, tu le sais. Si t’as un doute, Toi."), ["ton", "tu", "t’", "Toi"]);
  assert.deepEqual(sample(TU, "Votre texte, une entrée, la tâche, statut, Tente, cette"), []);
  assert.deepEqual(
    sample(IMPERATIVE_PRONOUN, "Vérifie-le et ouvre-la, assieds-toi ; vérifiez-le, dites-le, faites-la. Peut-être là-bas, celle-ci."),
    ["Vérifie-le", "ouvre-la", "assieds-toi"],
  );
  assert.deepEqual(sample(STRAIGHT_APOSTROPHE, "l'adresse, l’adresse"), ["l'a"]);
  assert.deepEqual(sample(P_EX, "p. ex. PAC, par ex. PAC"), ["p. ex."]);
});
