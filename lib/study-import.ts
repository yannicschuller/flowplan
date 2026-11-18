// "Karten importieren" (docs/specs/flashcards.md §8.3): cards from text –
// a CSV or TSV file, Quizlet's export or anything pasted – into a deck's
// properties. Quizlet has no file format: its "Export" gives text with a
// chosen separator between term and definition (tab, comma or own) and
// between cards (new line, semicolon or own); the same form fits Anki's
// text export, Brainscape and Memrise. Pure and client-safe: the wizard
// (components/study/import.tsx) shows the preview and the errors per line,
// then creates the records through rows.import like the database's own
// CSV import, which checks every value again on the server.
//
// - Separators are detected (detectDelimiters) and can be changed.
// - A first line naming the columns ("Vorderseite", "Back", "Term", the
//   deck's own property names …) is a header; the columns are mapped to
//   the deck's sides by those names, else the first to the front and the
//   second to the back.
// - Lines without a front or back (a cloze text needs no back), values
//   longer than MAX_IMPORT_VALUE, and lines beyond MAX_IMPORT_CARDS are
//   errors with their line number; the same line twice is imported once.
// - Text properties other than the title hold inline Markdown: imported
//   text is escaped so it shows as written (as the CSV import does); the
//   cloze syntax {{c1::…}} stays as it is.
import Papa from "papaparse";
import { csvImportText } from "./cell-text";
import { escapeInline, isFormattedText } from "./inline-markdown";
import { foldName } from "./page-properties";
import { clozeNumbers } from "./study-cloze";
import type { StudySettings } from "./study-schema";
import type { Field } from "./types";

export const MAX_IMPORT_CARDS = 5000;
export const MAX_IMPORT_BYTES = 5_000_000;
export const MAX_IMPORT_VALUE = 10_000;
export const IMPORT_BATCH = 1000;

export type Delimiters = { column: string; row: string };
export type ImportRole = "front" | "back" | "hint" | "extra" | "tags" | "type" | "choices";

// Tab, semicolon or comma between the columns; a new line between cards –
// or, for text on a single line with semicolons (Quizlet's "between
// cards: semicolon"), a semicolon between cards and a tab or comma inside.
export function detectDelimiters(text: string): Delimiters {
  const sample = text.slice(0, 50_000).replace(/\r\n?/g, "\n");
  const lines = sample.split("\n").filter((l) => l.trim());
  if (lines.length <= 1 && sample.includes(";") && (sample.includes("\t") || sample.includes(","))) return { column: sample.includes("\t") ? "\t" : ",", row: ";" };
  const share = (c: string) => (lines.length ? lines.filter((l) => l.includes(c)).length / lines.length : 0);
  if (share("\t") >= 0.6) return { column: "\t", row: "\n" };
  if (share(";") >= 0.6 && share(";") >= share(",")) return { column: ";", row: "\n" };
  if (share(",") >= 0.6) return { column: ",", row: "\n" };
  return { column: "\t", row: "\n" };
}

// The text as rows of cells.
export function splitRows(text: string, d: Delimiters): string[][] {
  const source = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  if (!d.column) return [];
  if (d.row === "\n") {
    // Quoted fields (a value with the separator or a line break in it) as
    // in CSV; a TSV without quotes is split plainly, so a lone '"' (5" disk)
    // stays text.
    const quoted = d.column !== "\t" || /(^|\t|\n)"/.test(source);
    if (quoted) {
      const parsed = Papa.parse<string[]>(source, { delimiter: d.column, skipEmptyLines: "greedy", transform: csvImportText });
      return parsed.data.map((row) => row.map((c) => c ?? ""));
    }
    return source
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => l.split("\t"));
  }
  // Cards separated by their own character: two parts each, split at the
  // first separator (a definition may hold it again).
  return source
    .split(d.row)
    .map((card) => card.replace(/^\n+|\n+$/g, ""))
    .filter((card) => card.trim())
    .map((card) => {
      const at = card.indexOf(d.column);
      return at < 0 ? [card] : [card.slice(0, at), card.slice(at + d.column.length)];
    });
}

// Names a header may give a column (folded: lower case, no accents).
const NAMES: Record<ImportRole, string[]> = {
  front: ["vorderseite", "front", "frage", "question", "term", "begriff", "wort", "word", "text", "vorne"],
  back: ["ruckseite", "back", "antwort", "answer", "definition", "ubersetzung", "translation", "bedeutung", "meaning", "hinten"],
  hint: ["hinweis", "hint", "tipp"],
  extra: ["zusatz", "extra", "beispiel", "example", "notiz", "notizen", "notes", "back extra"],
  tags: ["tags", "tag", "schlagworter", "labels"],
  type: ["kartentyp", "card type", "typ", "type"],
  choices: ["antwortoptionen", "optionen", "options", "choices", "distraktoren", "distractors"],
};
const fold = (text: string) => foldName(text).normalize("NFD").replace(/\p{M}/gu, "").replace(/\s+/g, " ").trim();

// The role a column's name stands for, by the deck's own property names
// first, then the usual names.
export function roleOfName(name: string, settings: StudySettings, fields: Field[]): ImportRole | null {
  const key = fold(name);
  if (!key) return null;
  for (const [role, id] of roleFields(settings, fields)) if (id && fold(fields.find((f) => f.id === id)?.name || "") === key) return role;
  for (const role of Object.keys(NAMES) as ImportRole[]) if (NAMES[role].some((n) => fold(n) === key)) return role;
  return null;
}
// The property each role writes to: the deck's mapping, the tags property
// (its own or one named "Tags") and the card type property.
export function roleFields(settings: StudySettings, fields: Field[]): [ImportRole, string | undefined][] {
  const side = (s: StudySettings["front"] | StudySettings["back"]) => ("field" in s ? s.field : undefined);
  const tags = settings.tags?.field ?? fields.find((f) => f.type === "multiselect" && fold(f.name) === "tags")?.id;
  return [
    ["front", side(settings.front)],
    ["back", side(settings.back)],
    ["hint", settings.hint?.field],
    ["extra", settings.extra?.field],
    ["tags", tags],
    ["type", "field" in settings.type ? settings.type.field : undefined],
    ["choices", settings.choices?.field],
  ];
}
export function looksLikeHeader(row: string[], settings: StudySettings, fields: Field[]) {
  const roles = row.map((c) => roleOfName(c, settings, fields));
  return row.length >= 2 && roles.filter(Boolean).length >= Math.min(2, row.length);
}
// The property each column goes to ("" = not imported).
export function suggestMapping(columns: number, header: string[] | null, settings: StudySettings, fields: Field[]): string[] {
  const byRole = new Map(roleFields(settings, fields));
  const used = new Set<string>();
  return Array.from({ length: columns }, (_, i) => {
    const named = header ? roleOfName(header[i] || "", settings, fields) : null;
    const role = named ?? (!header ? (i === 0 ? "front" : i === 1 ? "back" : null) : null);
    const id = role ? byRole.get(role) : undefined;
    if (!id || used.has(id)) {
      // A header naming a property of the database directly.
      const direct = header ? fields.find((f) => fold(f.name) === fold(header[i] || "") && !used.has(f.id)) : undefined;
      if (direct && IMPORTABLE.has(direct.type)) {
        used.add(direct.id);
        return direct.id;
      }
      return "";
    }
    used.add(id);
    return id;
  });
}
export const IMPORTABLE: ReadonlySet<string> = new Set(["text", "url", "email", "phone", "select", "multiselect", "number"]);

export type ImportError = { line: number; message: string };
export type ImportPlan = { records: Record<string, unknown>[]; errors: ImportError[]; duplicates: number; lines: number };
// Tags of one cell: separated by commas or semicolons, else (Anki) by spaces.
export const splitTags = (text: string) =>
  [...new Set((/[,;]/.test(text) ? text.split(/[,;]/) : text.split(/\s+/)).map((t) => t.trim()).filter(Boolean))].slice(0, 50);

// The records of the rows: `mapping` names the property of each column.
// `header`: the first row names the columns and is no card.
export function planImport(rows: string[][], mapping: string[], header: boolean, settings: StudySettings, fields: Field[], tr: (de: string, en: string) => string = (de) => de): ImportPlan {
  const byRole = new Map(roleFields(settings, fields));
  const front = byRole.get("front"),
    back = byRole.get("back");
  const records: Record<string, unknown>[] = [];
  const errors: ImportError[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  let over = false;
  const body = header ? rows.slice(1) : rows;
  body.forEach((row, i) => {
    const line = i + 1 + (header ? 1 : 0);
    if (!row.some((c) => c.trim())) return;
    const cells: Record<string, unknown> = {};
    let tooLong = false;
    mapping.forEach((id, column) => {
      if (!id) return;
      const field = fields.find((f) => f.id === id);
      if (!field) return;
      const raw = (row[column] ?? "").trim();
      if (raw.length > MAX_IMPORT_VALUE) tooLong = true;
      if (!raw) return;
      if (field.type === "multiselect") cells[id] = [...new Set([...((cells[id] as string[]) || []), ...splitTags(raw)])];
      else if (field.type === "number") cells[id] = Number.isFinite(Number(raw.replace(",", "."))) ? Number(raw.replace(",", ".")) : raw;
      else cells[id] = isFormattedText(field, fields) ? escapeInline(raw) : raw;
    });
    if (tooLong) {
      errors.push({ line, message: tr(`Ein Wert ist länger als ${MAX_IMPORT_VALUE} Zeichen.`, `A value is longer than ${MAX_IMPORT_VALUE} characters.`) });
      return;
    }
    const text = (id: string | undefined) => (id ? String(cells[id] ?? "").trim() : "x");
    const cloze = front ? clozeNumbers(String(cells[front] ?? "")).length > 0 : false;
    if (front && !text(front)) {
      errors.push({ line, message: tr("Vorderseite fehlt.", "The front is missing.") });
      return;
    }
    if (back && !text(back) && !cloze) {
      errors.push({ line, message: tr("Rückseite fehlt.", "The back is missing.") });
      return;
    }
    if (!Object.keys(cells).length) return;
    const key = JSON.stringify(mapping.map((id) => (id ? cells[id] ?? "" : "")));
    if (seen.has(key)) {
      duplicates++;
      return;
    }
    seen.add(key);
    if (records.length >= MAX_IMPORT_CARDS) {
      // One error for all lines beyond the limit.
      if (over) return;
      over = true;
      errors.push({ line, message: tr(`Mehr als ${MAX_IMPORT_CARDS} Zeilen auf einmal – diese und die folgenden fehlen.`, `More than ${MAX_IMPORT_CARDS} lines at once – this one and the following are left out.`) });
      return;
    }
    records.push(cells);
  });
  return { records, errors, duplicates, lines: body.filter((r) => r.some((c) => c.trim())).length };
}
