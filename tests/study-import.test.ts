// "Karten importieren" (docs/specs/flashcards.md §8.3): separators of CSV,
// TSV and Quizlet's export, the header and the mapping to the deck's
// properties, errors per line, duplicates and limits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_IMPORT_CARDS, MAX_IMPORT_VALUE, detectDelimiters, looksLikeHeader, planImport, splitRows, splitTags, suggestMapping } from "../lib/study-import";
import { studySettingsSchema } from "../lib/study-schema";
import type { Field } from "../lib/types";

const fields: Field[] = [
  { id: "title", name: "Wort", type: "text" },
  { id: "back", name: "Übersetzung", type: "text" },
  { id: "note", name: "Beispiel", type: "text" },
  { id: "tags", name: "Tags", type: "multiselect", options: [] },
];
const settings = studySettingsSchema.parse({ version: 1, front: { field: "title" }, back: { field: "back" }, extra: { field: "note" } });

test("Quizlet's export: tab or comma between term and definition, new line or semicolon between cards", () => {
  const tabLines = "hola\thallo\nperro\tHund\ngato\tKatze";
  assert.deepEqual(detectDelimiters(tabLines), { column: "\t", row: "\n" });
  assert.deepEqual(splitRows(tabLines, detectDelimiters(tabLines)), [["hola", "hallo"], ["perro", "Hund"], ["gato", "Katze"]]);
  const semicolons = "hola\thallo;perro\tHund;gato\tKatze;";
  assert.deepEqual(detectDelimiters(semicolons), { column: "\t", row: ";" });
  assert.deepEqual(splitRows(semicolons, detectDelimiters(semicolons)), [["hola", "hallo"], ["perro", "Hund"], ["gato", "Katze"]]);
  const commas = "hola,hallo;perro,Hund, Köter;gato,Katze";
  assert.deepEqual(detectDelimiters(commas), { column: ",", row: ";" });
  // A definition with the separator again: split at the first one.
  assert.deepEqual(splitRows(commas, detectDelimiters(commas))[1], ["perro", "Hund, Köter"]);
  // A lone quote in TSV is text (5" disk), Windows line ends and a BOM go.
  assert.deepEqual(splitRows('﻿disk\t5" Diskette\r\nzwei\tdrei\r\n', { column: "\t", row: "\n" }), [["disk", '5" Diskette'], ["zwei", "drei"]]);
  // Own separators.
  assert.deepEqual(splitRows("a - b|c - d", { column: " - ", row: "|" }), [["a", "b"], ["c", "d"]]);
});

test("CSV with quotes, semicolons (German Excel) and a header", () => {
  const csv = 'Wort,Übersetzung,Tags\n"hola, amigo","hallo, Freund",Grüße\nperro,"Hund\nmit Zeilenumbruch",Tiere Haus\n';
  assert.deepEqual(detectDelimiters(csv), { column: ",", row: "\n" });
  const rows = splitRows(csv, detectDelimiters(csv));
  assert.deepEqual(rows[1], ["hola, amigo", "hallo, Freund", "Grüße"]);
  assert.equal(rows[2][1], "Hund\nmit Zeilenumbruch");
  assert.equal(looksLikeHeader(rows[0], settings, fields), true);
  assert.deepEqual(suggestMapping(3, rows[0], settings, fields), ["title", "back", "tags"]);
  assert.deepEqual(detectDelimiters("Vorderseite;Rückseite\nhola;hallo\n"), { column: ";", row: "\n" });
  // The usual names, English and German, and the deck's own names.
  assert.deepEqual(suggestMapping(3, ["Term", "Definition", "Beispiel"], settings, fields), ["title", "back", "note"]);
  assert.deepEqual(suggestMapping(2, ["Front", "Back"], settings, fields), ["title", "back"]);
  // No header: the first column is the front, the second the back.
  assert.equal(looksLikeHeader(["hola", "hallo"], settings, fields), false);
  assert.deepEqual(suggestMapping(3, null, settings, fields), ["title", "back", ""]);
  // Formula protection of Flowplan's own CSV export is undone.
  assert.deepEqual(splitRows("'=1+1,x\n", { column: ",", row: "\n" }), [["=1+1", "x"]]);
});

test("planImport: records, errors per line, duplicates, cloze without a back", () => {
  const rows = [
    ["Wort", "Übersetzung", "Tags"],
    ["hola", "hallo", "Grüße, Kapitel 1"],
    ["", "ohne Vorderseite", ""],
    ["perro", "", ""],
    ["{{c1::Madrid}} ist die Hauptstadt", "", "Geografie"],
    ["hola", "hallo", "Grüße, Kapitel 1"],
    ["  ", "", ""],
    ["*stern*", "[x]", "a b"],
    ["lang", "x".repeat(MAX_IMPORT_VALUE + 1), ""],
  ];
  const plan = planImport(rows, ["title", "back", "tags"], true, settings, fields);
  assert.deepEqual(plan.records, [
    { title: "hola", back: "hallo", tags: ["Grüße", "Kapitel 1"] },
    { title: "{{c1::Madrid}} ist die Hauptstadt", tags: ["Geografie"] },
    // The title is plain text; other text properties are escaped Markdown.
    { title: "*stern*", back: "\\[x\\]", tags: ["a", "b"] },
  ]);
  assert.deepEqual(
    plan.errors.map((e) => [e.line, e.message]),
    [
      [3, "Vorderseite fehlt."],
      [4, "Rückseite fehlt."],
      [9, `Ein Wert ist länger als ${MAX_IMPORT_VALUE} Zeichen.`],
    ],
  );
  assert.equal(plan.duplicates, 1);
  // English messages through the translator.
  assert.equal(planImport([["", "x"]], ["title", "back"], false, settings, fields, (_de, en) => en).errors[0].message, "The front is missing.");
  assert.deepEqual(splitTags("a, b;c"), ["a", "b", "c"]);
  assert.deepEqual(splitTags("Kapitel1 Tiere"), ["Kapitel1", "Tiere"]);
});

test("planImport: at most MAX_IMPORT_CARDS records, one error for the rest", () => {
  const rows = Array.from({ length: MAX_IMPORT_CARDS + 3 }, (_, i) => [`w${i}`, `b${i}`]);
  const plan = planImport(rows, ["title", "back"], false, settings, fields);
  assert.equal(plan.records.length, MAX_IMPORT_CARDS);
  assert.equal(plan.errors.length, 1);
  assert.equal(plan.errors[0].line, MAX_IMPORT_CARDS + 1);
});
