// What a record shows on a flashcard (docs/specs/flashcards.md §3.1, §5.1):
// the sides come from properties or the record's document, the document
// split at its first top-level horizontal rule (`---` in the editor, as a
// slide break in lib/slides.ts). Pure functions for the card index
// (lib/study.ts) and the setup dialog's preview; HTML is never built here
// from cells – a property side stays text (inline Markdown, shown as React
// text), a document side is the record's sanitized HTML.
import { Parser } from "htmlparser2";
import { cellText } from "./cell-text";
import { isFormattedText, toPlain } from "./inline-markdown";
import { clozeFilled, clozeNumbers } from "./study-cloze";
import { typeOfOption, type CardType, type StudySettings } from "./study-schema";
import { occludedImages, occlusionTargets, withoutOccludedImages, type OcclusionMask, type OcclusionMode } from "./study-occlusion";
import type { Field } from "./types";

export type CardSide = { text: string; formatted?: boolean } | { html: string };
export type DerivedKind = CardType;
// An image occlusion card (lib/study-occlusion.ts): the picture with all its
// masks, the ones asked (a mask or a group) and the card's place among the
// record's ("Bereich 3 von 7").
export type OcclusionCard = { src: string; alt: string; mode: OcclusionMode; masks: OcclusionMask[]; target: string[]; index: number; total: number };
export type DerivedCard = {
  sub: string;
  kind: DerivedKind;
  front: CardSide;
  back: CardSide;
  hint?: CardSide;
  extra?: CardSide;
  // A cloze card: its number and the side that holds the clozes (the
  // other side is shown with it – the front above, the back after).
  cloze?: { n: number; on: "front" | "back" };
  // Multiple choice: the wrong options of the record's own property.
  choices?: string[];
  occlusion?: OcclusionCard;
  tags?: string[];
};
export type DocumentPart = "above" | "below" | "all";

// The part of a document above or below its first top-level <hr>; without
// one, "above" is empty and "below" is the whole document (a document
// without a rule is all answer).
export function splitCardHtml(html: string, part: DocumentPart): string {
  if (part === "all" || !html) return html || "";
  let depth = 0;
  let cut: { start: number; end: number } | null = null;
  const parser = new Parser(
    {
      onopentag(name) {
        if (cut) return;
        if (name === "hr" && depth === 0) cut = { start: parser.startIndex, end: parser.endIndex + 1 };
        else if (!VOID.has(name)) depth++;
      },
      onclosetag(name, implied) {
        if (cut || VOID.has(name)) return;
        void implied;
        depth = Math.max(0, depth - 1);
      },
    },
    { decodeEntities: true, recognizeSelfClosing: true },
  );
  parser.write(html);
  parser.end();
  const found = cut as { start: number; end: number } | null;
  if (!found) return part === "above" ? "" : html;
  return (part === "above" ? html.slice(0, found.start) : html.slice(found.end)).trim();
}
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
// Media and formulas count as content even without text.
const CONTENT_TAGS = new Set(["img", "video", "audio", "iframe", "svg", "canvas", "math"]);
export function htmlHasContent(html: string) {
  if (!html) return false;
  let found = false;
  const parser = new Parser(
    {
      onopentag(name, attributes) {
        if (CONTENT_TAGS.has(name) || "data-math" in attributes || "data-mermaid" in attributes || "data-drawio" in attributes) found = true;
      },
      ontext(text) {
        if (text.trim()) found = true;
      },
    },
    { decodeEntities: true },
  );
  parser.write(html);
  parser.end();
  return found;
}
export const sideIsEmpty = (side: CardSide) => ("html" in side ? !htmlHasContent(side.html) : !toPlain(side.text).trim());
// A side as text, for hashes and the preview.
export const sideText = (side: CardSide) => ("html" in side ? side.html : side.text);

function fieldSide(fields: Field[], cells: Record<string, unknown>, id: string): CardSide {
  const field = fields.find((f) => f.id === id);
  const text = cellText(cells[id]);
  return isFormattedText(field, fields) ? { text, formatted: true } : { text };
}

// The plain text of HTML: blocks on lines of their own (`firstBlock`: only
// the first block with text).
const BLOCKS = new Set(["p", "div", "li", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "tr", "summary", "details", "figcaption", "aside"]);
export function htmlPlain(html: string, firstBlock = false): string {
  if (!html) return "";
  let out = "";
  let done = false;
  let depth = 0;
  const parser = new Parser(
    {
      onopentag(name) {
        if (done) return;
        if (name === "br") out += "\n";
        if (BLOCKS.has(name)) {
          if (out && !out.endsWith("\n")) out += "\n";
          depth++;
        }
      },
      onclosetag(name) {
        if (done || !BLOCKS.has(name)) return;
        depth = Math.max(0, depth - 1);
        if (firstBlock && depth === 0 && out.trim()) done = true;
        else if (!out.endsWith("\n")) out += "\n";
      },
      ontext(text) {
        if (!done) out += text;
      },
    },
    { decodeEntities: true },
  );
  parser.write(html);
  parser.end();
  return out
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}
// A side as plain text: inline Markdown read, clozes filled.
export const sidePlain = (side: CardSide) => clozeFilled("html" in side ? htmlPlain(side.html) : side.formatted ? toPlain(side.text) : side.text).trim();
// The answer a typed card expects: the back as text – of a document only
// its first paragraph (§5.3).
export const typedAnswer = (side: CardSide) => ("html" in side ? clozeFilled(htmlPlain(side.html, true)) : sidePlain(side)).replace(/\s+/g, " ").trim();

// The card type of a record (lib/study-schema.ts type).
export function recordType(settings: StudySettings, cells: Record<string, unknown>): CardType {
  if ("fixed" in settings.type) return settings.type.fixed;
  const value = cellText(cells[settings.type.field]).trim();
  return value ? typeOfOption(value, settings.type.map) : "basic";
}
const sideClozes = (side: CardSide) => ("html" in side ? clozeNumbers(side.html, true) : clozeNumbers(side.text));
export const MAX_CHOICES = 5;
export const foldChoice = (text: string) => text.normalize("NFC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
// The wrong options of a multiple choice record's own property: a
// multi-select's values, or text with one option per line (on a single
// line: separated by ";" or "|").
export function ownChoices(value: unknown, correct: string): string[] {
  let raw: string[];
  if (Array.isArray(value)) raw = value.map((v) => cellText(v));
  else {
    const text = toPlain(cellText(value));
    raw = text.includes("\n") ? text.split("\n") : text.split(/[;|]/);
  }
  const seen = new Set([foldChoice(correct)]);
  const out: string[] = [];
  for (const option of raw.map((o) => o.replace(/\s+/g, " ").trim()).filter(Boolean)) {
    const key = foldChoice(option);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(option.slice(0, 500));
  }
  return out.slice(0, MAX_CHOICES - 1);
}

// The cards of one record. `documentHtml`: the record's document (needed
// only for document sides).
// - basic: the card and (with "reverse") its reverse "r". A basic record
//   whose sides hold clozes gives cloze cards instead – so cards imported
//   or typed with {{c1::…}} need no type of their own.
// - cloze: one card per cloze number of the first side holding clozes;
//   the other side may be empty.
// - typed: like basic; the expected answer is the back's text.
// - choice: one card; the back is the right option.
// - occlusion: one card per mask or group of the pictures with masks in the
//   record's document (wherever they are in it); the sides without those
//   pictures are the text above the picture and after revealing, and may
//   be empty.
export function deriveCards(settings: StudySettings, fields: Field[], cells: Record<string, unknown>, documentHtml: string | null): DerivedCard[] {
  const type = recordType(settings, cells);
  const side = (source: StudySettings["front"] | StudySettings["back"]): CardSide => {
    if ("field" in source) return fieldSide(fields, cells, source.field);
    const html = splitCardHtml(documentHtml || "", source.document);
    return { html: type === "occlusion" ? withoutOccludedImages(html) : html };
  };
  const front = side(settings.front),
    back = side(settings.back);
  const extras = {
    ...(settings.hint ? { hint: fieldSide(fields, cells, settings.hint.field) } : {}),
    ...(settings.extra ? { extra: fieldSide(fields, cells, settings.extra.field) } : {}),
  };
  for (const key of ["hint", "extra"] as const) if (extras[key] && sideIsEmpty(extras[key])) delete extras[key];
  const tagValue = settings.tags ? cells[settings.tags.field] : undefined;
  const tags = Array.isArray(tagValue) ? tagValue.map((t) => cellText(t)).filter(Boolean) : cellText(tagValue) ? [cellText(tagValue)] : [];
  const tagged = tags.length ? { tags } : {};
  if (type === "occlusion") {
    // A key twice (a picture copied with its masks) is one card.
    const seen = new Set<string>();
    const targets = occludedImages(documentHtml || "")
      .flatMap((image) => occlusionTargets(image.occlusion).map((target) => ({ image, target })))
      .filter(({ target }) => !seen.has(target.key) && !!seen.add(target.key));
    return targets.map(({ image, target }, i) => ({
      sub: target.key,
      kind: "occlusion" as const,
      front,
      back,
      ...extras,
      ...tagged,
      occlusion: { src: image.src, alt: image.alt, mode: image.occlusion.mode, masks: image.occlusion.masks, target: target.masks, index: i + 1, total: targets.length },
    }));
  }
  if (type === "cloze" || type === "basic") {
    const onFront = sideClozes(front);
    const numbers = onFront.length ? onFront : sideClozes(back);
    if (numbers.length) {
      const on = onFront.length ? ("front" as const) : ("back" as const);
      return numbers.map((n) => ({ sub: `c${n}`, kind: "cloze" as const, front, back, ...extras, ...tagged, cloze: { n, on } }));
    }
    // A cloze record without clozes is no card.
    if (type === "cloze") return [];
  }
  // A card needs both sides: rather no card than half a card.
  if (sideIsEmpty(front) || sideIsEmpty(back)) return [];
  if (type === "choice") {
    const correct = sidePlain(back);
    if (!correct) return [];
    const own = settings.choices ? ownChoices(cells[settings.choices.field], correct) : [];
    return [{ sub: "", kind: "choice", front, back, ...extras, ...tagged, ...(own.length ? { choices: own } : {}) }];
  }
  const kind = type === "typed" ? ("typed" as const) : ("basic" as const);
  if (kind === "typed" && !typedAnswer(back)) return [];
  const cards: DerivedCard[] = [{ sub: "", kind, front, back, ...extras, ...tagged }];
  if (settings.reverse && (kind === "basic" || typedAnswer(front))) cards.push({ sub: "r", kind, front: back, back: front, ...extras, ...tagged });
  return cards;
}
// The properties a mapping reads (all must be readable for a person to get
// cards, §3.5).
export function studyFieldIds(settings: StudySettings) {
  return [settings.front, settings.back, settings.hint, settings.extra, settings.choices, "field" in settings.type ? settings.type : undefined].flatMap((s) => (s && "field" in s ? [s.field] : []));
}
export const usesDocument = (settings: StudySettings) => "document" in settings.front || "document" in settings.back;
// Whether a record's cards need its document: document sides, or an image
// occlusion record (its pictures are in the document).
export const needsDocument = (settings: StudySettings, cells: Record<string, unknown>) => usesDocument(settings) || recordType(settings, cells) === "occlusion";
