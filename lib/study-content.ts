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
import type { StudySettings } from "./study-schema";
import type { Field } from "./types";

export type CardSide = { text: string; formatted?: boolean } | { html: string };
export type DerivedCard = { sub: string; kind: "basic"; front: CardSide; back: CardSide; hint?: CardSide; extra?: CardSide };
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
// The cards of one record (phase 1: basic and its reverse). `documentHtml`:
// the record's document (needed only for document sides).
export function deriveCards(settings: StudySettings, fields: Field[], cells: Record<string, unknown>, documentHtml: string | null): DerivedCard[] {
  if (settings.type.fixed !== "basic") return [];
  const side = (source: StudySettings["front"] | StudySettings["back"]): CardSide =>
    "field" in source ? fieldSide(fields, cells, source.field) : { html: splitCardHtml(documentHtml || "", source.document) };
  const front = side(settings.front),
    back = side(settings.back);
  // A card needs both sides: rather no card than half a card.
  if (sideIsEmpty(front) || sideIsEmpty(back)) return [];
  const extras = {
    ...(settings.hint ? { hint: fieldSide(fields, cells, settings.hint.field) } : {}),
    ...(settings.extra ? { extra: fieldSide(fields, cells, settings.extra.field) } : {}),
  };
  for (const key of ["hint", "extra"] as const) if (extras[key] && sideIsEmpty(extras[key])) delete extras[key];
  const cards: DerivedCard[] = [{ sub: "", kind: "basic", front, back, ...extras }];
  if (settings.reverse) cards.push({ sub: "r", kind: "basic", front: back, back: front, ...extras });
  return cards;
}
// The properties a mapping reads (all must be readable for a person to get
// cards, §3.5).
export function studyFieldIds(settings: StudySettings) {
  return [settings.front, settings.back, settings.hint, settings.extra].flatMap((s) => (s && "field" in s ? [s.field] : []));
}
export const usesDocument = (settings: StudySettings) => "document" in settings.front || "document" in settings.back;
