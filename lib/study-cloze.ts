// Cloze deletions (docs/specs/flashcards.md §5.2): `{{c1::answer}}` and
// `{{c1::answer::hint}}` in text (Anki's syntax, kept as written on import
// and export), and the editor's mark "Lücke" in documents, stored as
// `<span data-cloze="1" data-cloze-hint="…">` (lib/document-schema.ts
// Cloze). The same number twice is one card with two gaps; a record gives
// one card per number (sub "c1" … "c99").
//
// - Nested clozes (Anki ≥ 2.1.56) are flattened: the inner one's text stays
//   in the outer gap, its number gives no card of its own.
// - Broken syntax (no closing "}}", no number, c0, c100) stays text.
// - The card "cN" hides the gaps numbered N ("[…]" or "[hint]") and shows
//   the others as plain text; revealed, the answer is marked
//   (class cloze-answer – never an inline style, the CSP forbids them).
// Pure and client-safe (htmlparser2 only).
import { Parser } from "htmlparser2";

export const MAX_CLOZE = 99;
export type ClozeSegment = { type: "text"; text: string } | { type: "cloze"; n: number; answer: string; hint?: string };

const OPEN = /\{\{c(\d{1,2})::/y;
// The text split into plain runs and clozes.
export function parseClozeText(text: string): ClozeSegment[] {
  const out: ClozeSegment[] = [];
  let plain = "";
  let i = 0;
  while (i < text.length) {
    const at = text.indexOf("{{c", i);
    if (at < 0) break;
    OPEN.lastIndex = at;
    const open = OPEN.exec(text);
    const n = open ? Number(open[1]) : 0;
    if (!open || n < 1 || n > MAX_CLOZE) {
      plain += text.slice(i, at + 3);
      i = at + 3;
      continue;
    }
    // The content up to the matching "}}": inner clozes are flattened.
    let j = OPEN.lastIndex,
      depth = 0,
      answer = "",
      hint: string | undefined,
      closed = false;
    while (j < text.length) {
      OPEN.lastIndex = j;
      const inner = text.startsWith("{{c", j) ? OPEN.exec(text) : null;
      if (inner) {
        depth++;
        j = OPEN.lastIndex;
        continue;
      }
      if (text.startsWith("}}", j)) {
        if (depth === 0) {
          closed = true;
          j += 2;
          break;
        }
        depth--;
        j += 2;
        continue;
      }
      if (depth === 0 && hint === undefined && text.startsWith("::", j)) {
        hint = "";
        j += 2;
        continue;
      }
      if (depth > 0 && text.startsWith("::", j)) {
        // An inner cloze's hint is dropped with its marker.
        const end = text.indexOf("}}", j);
        j = end < 0 ? text.length : end;
        continue;
      }
      if (hint === undefined) answer += text[j];
      else hint += text[j];
      j++;
    }
    if (!closed) {
      plain += text.slice(i, at + 3);
      i = at + 3;
      continue;
    }
    plain += text.slice(i, at);
    if (plain) out.push({ type: "text", text: plain });
    plain = "";
    out.push({ type: "cloze", n, answer, ...(hint?.trim() ? { hint: hint.trim() } : {}) });
    i = j;
  }
  plain += text.slice(i);
  if (plain) out.push({ type: "text", text: plain });
  return out;
}

type Span = { n: number; hint: string; open: [number, number]; close: [number, number] };
// The cloze marks of a document's HTML, outermost first.
function clozeSpans(html: string): Span[] {
  const spans: Span[] = [];
  const stack: ({ n: number; hint: string; open: [number, number] } | null)[] = [];
  const parser = new Parser(
    {
      onopentag(name, attributes) {
        if (name !== "span") return;
        const n = Number(attributes["data-cloze"]);
        stack.push("data-cloze" in attributes && Number.isInteger(n) && n >= 1 && n <= MAX_CLOZE ? { n, hint: attributes["data-cloze-hint"] || "", open: [parser.startIndex, parser.endIndex + 1] } : null);
      },
      onclosetag(name, implied) {
        if (name !== "span") return;
        const top = stack.pop();
        if (!top) return;
        const close: [number, number] = implied ? [parser.startIndex, parser.startIndex] : [parser.startIndex, parser.endIndex + 1];
        spans.push({ ...top, close });
      },
    },
    { decodeEntities: true, recognizeSelfClosing: true },
  );
  parser.write(html);
  parser.end();
  return spans.sort((a, b) => a.open[0] - b.open[0]);
}

// The numbers of all clozes in a text or a document's HTML, ascending.
export function clozeNumbers(source: string, html = false): number[] {
  const found = new Set<number>();
  if (html && source.includes("data-cloze")) for (const s of clozeSpans(source)) found.add(s.n);
  if (source.includes("{{c")) for (const s of parseClozeText(source)) if (s.type === "cloze") found.add(s.n);
  return [...found].sort((a, b) => a - b);
}

const escapeHtml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const gapHtml = (hint: string) => `<span class="cloze-gap">[${hint ? escapeHtml(hint) : "…"}]</span>`;

// The HTML of card N: its gaps hidden, or (revealed) their answers marked;
// the other clozes as plain content. The result is to be sanitized again
// by the caller (lib/study.ts cleans every side it sends).
export function clozeHtml(html: string, n: number, revealed: boolean): string {
  type Edit = { start: number; end: number; text: string; whole?: boolean };
  const edits: Edit[] = [];
  if (html.includes("data-cloze"))
    for (const span of clozeSpans(html)) {
      if (span.n === n && !revealed) edits.push({ start: span.open[0], end: span.close[1], text: gapHtml(span.hint), whole: true });
      else {
        edits.push({ start: span.open[0], end: span.open[1], text: span.n === n ? '<span class="cloze-answer">' : "" });
        edits.push({ start: span.close[0], end: span.close[1], text: span.n === n ? "</span>" : "" });
      }
    }
  // Edits inside a hidden gap go with it.
  const wholes = edits.filter((e) => e.whole);
  const kept = edits.filter((e) => e.whole || !wholes.some((w) => e.start >= w.start && e.end <= w.end)).sort((a, b) => a.start - b.start || a.end - b.end);
  let out = "",
    at = 0;
  for (const e of kept) {
    if (e.start < at) continue;
    out += html.slice(at, e.start) + e.text;
    at = e.end;
  }
  out += html.slice(at);
  if (!out.includes("{{c")) return out;
  return parseClozeText(out)
    .map((s) => (s.type === "text" ? s.text : s.n !== n ? s.answer : revealed ? `<span class="cloze-answer">${s.answer}</span>` : gapHtml(s.hint || "")))
    .join("");
}

// The plain text of a cloze text with every gap filled (search, the CSV
// export's readable column, distractors).
export const clozeFilled = (text: string) => (text.includes("{{c") ? parseClozeText(text).map((s) => (s.type === "text" ? s.text : s.answer)).join("") : text);
