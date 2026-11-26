// Rich text on stickies, shapes and text: the text stays a plain string
// (it merges and searches like before) with a small Markdown-like markup.
//   - item / * item      bullet list        1. item     numbered list
//   **bold**  *italic* or _italic_  __underline__  [label](https://…)
// Bare http(s) addresses become links. The parser gives spans, never HTML:
// the board renders them as React elements, the SVG export escapes them
// (richTextHtml), so nothing from the board ever runs as markup. Links pass
// lib/whiteboard-links.ts safeHref (http, https, mailto, element links,
// mentions of pages, records and people, #567).
import { mentionHref, parseMention, safeHref, type Mention } from "./whiteboard-links";

export type Span = { text: string; bold?: boolean; italic?: boolean; underline?: boolean; href?: string };
export type Block =
  | { kind: "p"; spans: Span[] }
  | { kind: "ul"; items: Span[][] }
  | { kind: "ol"; start: number; items: Span[][] };

type Marks = Omit<Span, "text">;
const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBER = /^\s*(\d{1,4})[.)]\s+(.*)$/;
// Inline patterns, tried at the earliest position (ties: in this order).
const PATTERNS: { re: RegExp; mark: (m: RegExpExecArray) => { marks: Marks; inner: string } | null }[] = [
  {
    re: /\[([^\]\n]{1,500})\]\(([^()\s]{1,2000})\)/,
    mark: (m) => {
      const href = safeHref(m[2]);
      return href ? { marks: { href }, inner: m[1] } : { marks: {}, inner: m[1] };
    },
  },
  { re: /\*\*(?=\S)([^\n]*?\S)\*\*/, mark: (m) => ({ marks: { bold: true }, inner: m[1] }) },
  { re: /__(?=\S)([^\n]*?\S)__/, mark: (m) => ({ marks: { underline: true }, inner: m[1] }) },
  { re: /\*(?=[^\s*])([^*\n]*?[^\s*])\*|\*([^\s*])\*/, mark: (m) => ({ marks: { italic: true }, inner: m[1] ?? m[2] }) },
  { re: /(?<![\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?![\w])|(?<![\w])_([^\s_])_(?![\w])/, mark: (m) => ({ marks: { italic: true }, inner: m[1] ?? m[2] }) },
  {
    re: /\bhttps?:\/\/[^\s<>()[\]"']*[^\s<>()[\]"'.,;:!?]/,
    mark: (m) => {
      const href = safeHref(m[0]);
      return href ? { marks: { href }, inner: m[0] } : null;
    },
  },
];

function inline(text: string, marks: Marks, out: Span[], depth = 0) {
  let rest = text;
  while (rest) {
    let best: { index: number; length: number; marks: Marks; inner: string; literal?: boolean } | null = null;
    if (depth < 6)
      for (const pattern of PATTERNS) {
        const m = pattern.re.exec(rest);
        if (!m || (best && m.index >= best.index)) continue;
        // Links inside links stay text.
        if (marks.href && (pattern.re === PATTERNS[0].re || pattern.re === PATTERNS[5].re)) continue;
        const found = pattern.mark(m);
        if (!found) continue;
        best = { index: m.index, length: m[0].length, ...found, literal: pattern.re === PATTERNS[5].re };
      }
    if (!best) {
      push(out, { ...marks, text: rest });
      return;
    }
    if (best.index) push(out, { ...marks, text: rest.slice(0, best.index) });
    if (best.literal) push(out, { ...marks, ...best.marks, text: best.inner });
    else inline(best.inner, { ...marks, ...best.marks }, out, depth + 1);
    rest = rest.slice(best.index + best.length);
  }
}
// Neighbouring spans with the same marks become one.
function push(out: Span[], span: Span) {
  if (!span.text) return;
  const last = out[out.length - 1];
  if (last && last.bold === span.bold && last.italic === span.italic && last.underline === span.underline && last.href === span.href)
    last.text += span.text;
  else out.push(clean(span));
}
function clean(span: Span): Span {
  const result: Span = { text: span.text };
  if (span.bold) result.bold = true;
  if (span.italic) result.italic = true;
  if (span.underline) result.underline = true;
  if (span.href) result.href = span.href;
  return result;
}
export function inlineSpans(text: string): Span[] {
  const out: Span[] = [];
  inline(text, {}, out);
  return out;
}

export function parseRichText(raw: string): Block[] {
  const text = String(raw ?? "").slice(0, 20000);
  const blocks: Block[] = [];
  for (const line of text.split("\n")) {
    const bullet = BULLET.exec(line),
      number = bullet ? null : NUMBER.exec(line);
    const last = blocks[blocks.length - 1];
    if (bullet) {
      if (last?.kind === "ul") last.items.push(inlineSpans(bullet[1]));
      else blocks.push({ kind: "ul", items: [inlineSpans(bullet[1])] });
    } else if (number) {
      if (last?.kind === "ol") last.items.push(inlineSpans(number[2]));
      else blocks.push({ kind: "ol", start: Number(number[1]) || 1, items: [inlineSpans(number[2])] });
    } else blocks.push({ kind: "p", spans: inlineSpans(line) });
  }
  return blocks;
}
// Whether the text uses any of the markup (plain texts render as before).
export function hasRichText(text: string | undefined) {
  if (!text) return false;
  return /(^|\n)\s*([-*•]|\d{1,4}[.)])\s|\*|__|_\S|\]\(|https?:\/\//.test(text);
}

// The text without markup: for search, previews and the summary.
export function plainText(raw: string) {
  if (!hasRichText(raw)) return raw;
  return parseRichText(raw)
    .map((block) =>
      block.kind === "p" ? block.spans.map((s) => s.text).join("") : block.items.map((spans) => spans.map((s) => s.text).join("")).join("\n"),
    )
    .join("\n");
}

const escape = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
function spansHtml(spans: Span[]) {
  return spans
    .map((s) => {
      let html = escape(s.text);
      if (s.bold) html = `<b>${html}</b>`;
      if (s.italic) html = `<i>${html}</i>`;
      if (s.underline) html = `<u>${html}</u>`;
      // A mention is its title as text: its address only works inside Flowplan.
      if (s.href && parseMention(s.href)) html = `<span style="text-decoration:underline">${html}</span>`;
      else if (s.href) html = `<a href="${escape(s.href)}" style="color:inherit;text-decoration:underline">${html}</a>`;
      return html;
    })
    .join("");
}
// XHTML for the SVG export: every text escaped, links only from safeHref.
export function richTextHtml(raw: string) {
  const list = "margin:0;padding-left:1.3em;text-align:left";
  return parseRichText(raw)
    .map((block) =>
      block.kind === "p"
        ? `<div>${spansHtml(block.spans) || "<br/>"}</div>`
        : block.kind === "ul"
          ? `<ul style="${list}">${block.items.map((i) => `<li>${spansHtml(i)}</li>`).join("")}</ul>`
          : `<ol start="${block.start}" style="${list}">${block.items.map((i) => `<li>${spansHtml(i)}</li>`).join("")}</ol>`,
    )
    .join("");
}

// The board's text as HTML for documents.html (lib/whiteboard.ts
// whiteboardSummary): plain text, with mentions as the page links and
// person mentions documents use – what backlinks (lib/text-links.ts), the
// graph, renames and notifications read there. Every text escaped.
export function summaryHtml(raw: string, max = 2000) {
  const html: string[] = [];
  let left = max;
  const add = (spans: Span[]) => {
    for (const s of spans) {
      if (left <= 0) return;
      const text = escape(s.text.slice(0, left));
      left -= s.text.length;
      const mention = s.href ? parseMention(s.href) : null;
      if (mention?.kind === "page") html.push(`<a href="${escape(mentionHref(mention))}">${text}</a>`);
      else if (mention?.kind === "person") html.push(`<span data-mention="${escape(mention.userId)}">${text}</span>`);
      else html.push(text);
    }
  };
  const lines = parseRichText(raw).flatMap((block) => (block.kind === "p" ? [block.spans] : block.items));
  lines.forEach((spans, i) => {
    if (i && left > 0) {
      html.push("\n");
      left--;
    }
    add(spans);
  });
  return html.join("");
}

// The text of a mention: what the board shows and what a rename looks for.
export const mentionLabel = (label: string) =>
  label.replace(/[[\]\n\r]/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
// A mention as it is written into the text.
export function mentionMarkup(label: string, target: Mention) {
  return `[${mentionLabel(label) || "…"}](${mentionHref(target)})`;
}
// The mentions of a page or record whose text is its old title get the
// new title (like links in documents, lib/link-titles.ts); a mention with
// its own wording (an alias) stays as it is. Null: the text is unchanged.
export function retitleMentions(raw: string, target: { pageId: string; rowId?: string }, before: string, after: string) {
  const old = mentionLabel(before),
    next = mentionLabel(after);
  if (!old || !next || old === next || !raw.includes(target.rowId || target.pageId)) return null;
  let changed = false;
  const text = raw.replace(/\[([^\]\n]{1,500})\]\(([^()\s]{1,2000})\)/g, (all, label: string, href: string) => {
    const mention = parseMention(href);
    if (mention?.kind !== "page" || mention.pageId !== target.pageId || mention.rowId !== target.rowId) return all;
    if (label.trim() !== old) return all;
    changed = true;
    return `[${next}](${href})`;
  });
  return changed ? text : null;
}

// ---- editing helpers (the text field of the board) ----
export type Edit = { text: string; start: number; end: number };
function lineRange(text: string, start: number, end: number) {
  const from = text.lastIndexOf("\n", start - 1) + 1;
  const next = text.indexOf("\n", end);
  return { from, to: next < 0 ? text.length : next };
}
// Bullets or numbers on the selected lines, or off when all have them.
export function toggleList(text: string, start: number, end: number, kind: "ul" | "ol"): Edit {
  const { from, to } = lineRange(text, start, end);
  const lines = text.slice(from, to).split("\n");
  const has = (line: string) => (kind === "ul" ? BULLET.test(line) : NUMBER.test(line));
  const strip = (line: string) => line.replace(/^\s*([-*•]|\d{1,4}[.)])\s+/, "");
  const off = lines.every(has);
  const next = lines.map((line, i) => (off ? strip(line) : `${kind === "ul" ? "- " : `${i + 1}. `}${strip(line)}`)).join("\n");
  const result = text.slice(0, from) + next + text.slice(to);
  return { text: result, start: from, end: from + next.length };
}
// Enter in a list: the next item; Enter on an empty item ends the list.
export function continueList(text: string, caret: number): Edit | null {
  const { from, to } = lineRange(text, caret, caret);
  const line = text.slice(from, to);
  const bullet = /^(\s*)([-*•])\s+(.*)$/.exec(line),
    number = bullet ? null : /^(\s*)(\d{1,4})([.)])\s+(.*)$/.exec(line);
  if (!bullet && !number) return null;
  const content = bullet ? bullet[3] : number![4];
  if (!content.trim()) {
    const result = text.slice(0, from) + text.slice(to);
    return { text: result, start: from, end: from };
  }
  const prefix = bullet ? `${bullet[1]}${bullet[2]} ` : `${number![1]}${Number(number![2]) + 1}${number![3]} `;
  const insert = `\n${prefix}`;
  const result = text.slice(0, caret) + insert + text.slice(caret);
  return { text: result, start: caret + insert.length, end: caret + insert.length };
}
// Bold, italic or underline around the selection (or off again).
export function toggleMark(text: string, start: number, end: number, mark: "**" | "*" | "__"): Edit {
  const before = text.slice(Math.max(0, start - mark.length), start),
    after = text.slice(end, end + mark.length);
  if (before === mark && after === mark && !(mark === "*" && text.slice(start - 2, start) === "**"))
    return { text: text.slice(0, start - mark.length) + text.slice(start, end) + text.slice(end + mark.length), start: start - mark.length, end: end - mark.length };
  return { text: text.slice(0, start) + mark + text.slice(start, end) + mark + text.slice(end), start: start + mark.length, end: end + mark.length };
}
// A link around the selection (or the address itself as label).
export function insertLink(text: string, start: number, end: number, href: string): Edit | null {
  const safe = safeHref(href);
  if (!safe) return null;
  const label = text.slice(start, end).replace(/[[\]\n]/g, " ").trim() || safe;
  const link = `[${label}](${safe})`;
  return { text: text.slice(0, start) + link + text.slice(end), start: start + link.length, end: start + link.length };
}
