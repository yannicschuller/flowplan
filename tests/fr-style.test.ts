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
// Bare singular imperatives ("Choisis", "Indique", "Saisis") are checked only
// where the English source asks the reader to do something ("Choose …",
// "Please enter …"), at the start of a French clause – elsewhere most of these
// words are 3rd-person descriptions ("Vérifie l’adresse …" for "Checks …").
const EN_IMPERATIVE =
  /(?:^|[.:;!?–]\s+|\bplease\s+)(?:add|allow|cancel|change|check|choose|click|close|confirm|connect|copy|create|delete|download|drag|drop|enable|enter|export|fill|give|import|insert|install|keep|leave|make|move|open|paste|pick|press|put|reload|remove|rename|restart|save|scan|select|send|set|share|sign|start|summari[sz]e|tap|test|tick|try|type|update|upload|use|wait|write|do not|don't)\b/i;
const TU_IMPERATIVE = new Set(
  (
    "ajoute autorise annule change vérifie choisis clique ferme confirme connecte copie crée supprime télécharge glisse dépose active saisis " +
    "entre exporte remplis indique donne importe insère installe garde laisse mets déplace ouvre colle appuie recharge retire renomme " +
    "redémarre enregistre scanne sélectionne envoie définis partage commence démarre résume touche tape teste coche essaie réessaie écris " +
    "attends reviens fais prends utilise modifie téléverse lance"
  ).split(" "),
);
const CLAUSE_START = /(?:^|[.:;!?–]\s+|\b(?:puis|et)\s+)(\p{L}+)/gu;
// Known 3rd-person descriptions next to an English imperative: "key → word".
const IMPERATIVE_ALLOWED = new Set([
  "Check mark → Coche",
  "The AI only sees names of databases, properties, spaces and pages you may see – no contents. The result is a draft: check it, complete it, then activate it yourself. Uses AI requests of your personal allowance. → Utilise",
]);
function informalImperatives(entries: [string, string][]) {
  const found: string[] = [];
  for (const [key, value] of entries) {
    if (!value || !EN_IMPERATIVE.test(key)) continue;
    for (const [, word] of value.replace(/^par ex\.\s+/, "").matchAll(CLAUSE_START))
      if (TU_IMPERATIVE.has(word.toLowerCase()) && !IMPERATIVE_ALLOWED.has(`${key} → ${word}`)) found.push(`${key} → ${word}`);
  }
  return found;
}
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

test("French: instructions use the “vous” imperative (“Choisissez”, not “Choisis”)", () => {
  assert.deepEqual(informalImperatives(Object.entries(catalog)), []);
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
  assert.deepEqual(
    informalImperatives([
      ["Choose a journal.", "Choisis un journal."],
      ["Please enter some text first.", "Saisis d’abord du texte."],
      ["Litestream is running: please restart the container now.", "Litestream est actif : redémarre maintenant le conteneur."],
      ["e.g. Summarize {Description} in one sentence", "par ex. Résume {Description} en une phrase"],
      ["Choose a journal.", "Choisissez un journal."],
      ["Checks the end of the text.", "Vérifie la fin du texte."],
      ["Opens the sign-in in your browser", "Ouvre la connexion dans votre navigateur"],
    ]),
    [
      "Choose a journal. → Choisis",
      "Please enter some text first. → Saisis",
      "Litestream is running: please restart the container now. → redémarre",
      "e.g. Summarize {Description} in one sentence → Résume",
    ],
  );
  assert.deepEqual(sample(STRAIGHT_APOSTROPHE, "l'adresse, l’adresse"), ["l'a"]);
  assert.deepEqual(sample(P_EX, "p. ex. PAC, par ex. PAC"), ["p. ex."]);
});
