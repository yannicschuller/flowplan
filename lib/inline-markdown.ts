// Formatted text properties (#126): the value of a "text" property (every
// one but the title, the database's first property) is a string with
// INLINE Markdown – **bold**, _italic_ (*italic* is read too), ~~strike~~,
// `code`, [label](https://…) links (http, https and mailto only) and line
// breaks (\n). No blocks: a "# ", "- " or "> " stays text. A backslash
// keeps one of \ * _ ~ ` [ ] literal.
//
// Everything that treats a value as text (search, filters, sorting,
// grouping, formulas, CSV, notifications) reads `toPlain`; the table, the
// record and published pages render `parseInline` (components/
// inline-text.tsx, never as HTML); the editor (components/
// rich-text-input.tsx) reads and writes runs. Values that arrive as plain
// text (a CSV, a form) are stored through `escapeInline`.
import type { Field } from "./types";

export type InlineRun = {
  // May contain "\n" (a line break).
  text: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  // Only a safe link (see safeHref).
  href?: string;
};

const ESCAPABLE = new Set(["\\", "*", "_", "~", "`", "[", "]"]);
const SPECIAL = /[\\*_~`[\]]/g;

// Every text property but the title (the first property) carries inline
// Markdown; the title stays plain text.
export function isFormattedText(field: Pick<Field, "id" | "type"> | undefined, fields: Pick<Field, "id">[]): boolean {
  return !!field && field.type === "text" && fields[0]?.id !== field.id;
}

// Plain text → inline Markdown that shows exactly this text.
export function escapeInline(text: string): string {
  // U+0001/U+0002 are the serializer's italic placeholders.
  return normalizeBreaks(text).replace(/[\u0001\u0002]/g, "").replace(SPECIAL, (c) => `\\${c}`);
}

function normalizeBreaks(text: string) {
  return text.replace(/\r\n?/g, "\n");
}

// Links open only with these schemes; everything else shows its label.
export function safeHref(href: string): string | undefined {
  const value = href.trim();
  if (!value || value.length > 2000) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (!["http:", "https:", "mailto:"].includes(url.protocol)) return undefined;
  // The written form (not url.href) so "https://a.b" stays as typed; the
  // scheme check above is on the parsed URL, which ignores tabs and the like.
  if (/[\u0000-\u001f\u007f\s]/.test(value)) return url.href;
  return value;
}

type Marks = Omit<InlineRun, "text">;

const isSpace = (c: string | undefined) => c === undefined || /\s/.test(c);
const isWord = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

// Inline Markdown → runs of text with their marks (adjacent runs with the
// same marks merged).
export function parseInline(markdown: unknown): InlineRun[] {
  if (typeof markdown !== "string" || !markdown) return [];
  const source = normalizeBreaks(markdown);
  const runs: InlineRun[] = [];
  parseRange(source, 0, source.length, {}, runs, 0);
  return mergeRuns(runs);
}

function sameMarks(a: Marks, b: Marks) {
  return !!a.bold === !!b.bold && !!a.italic === !!b.italic && !!a.strike === !!b.strike && !!a.code === !!b.code && a.href === b.href;
}

export function mergeRuns(runs: InlineRun[]): InlineRun[] {
  const out: InlineRun[] = [];
  for (const run of runs) {
    if (!run.text) continue;
    const last = out[out.length - 1];
    if (last && sameMarks(last, run)) last.text += run.text;
    else out.push(cleanRun(run));
  }
  return out;
}

function cleanRun(run: InlineRun): InlineRun {
  const out: InlineRun = { text: run.text };
  if (run.bold) out.bold = true;
  if (run.italic) out.italic = true;
  if (run.strike) out.strike = true;
  if (run.code) out.code = true;
  if (run.href) out.href = run.href;
  return out;
}

// The end of a code span opened by `count` backticks at `from`, or -1.
function codeEnd(s: string, from: number, end: number, count: number) {
  let i = from;
  while (i < end) {
    if (s[i] !== "`") {
      i++;
      continue;
    }
    let n = 0;
    while (i + n < end && s[i + n] === "`") n++;
    if (n === count) return i;
    i += n;
  }
  return -1;
}

// Skips one unit that a delimiter search must not look into: an escape or
// a code span. Returns the next index.
function skipUnit(s: string, i: number, end: number) {
  if (s[i] === "\\" && i + 1 < end && ESCAPABLE.has(s[i + 1])) return i + 2;
  if (s[i] === "`") {
    let n = 0;
    while (i + n < end && s[i + n] === "`") n++;
    const close = codeEnd(s, i + n, end, n);
    return close < 0 ? i + n : close + n;
  }
  return i + 1;
}

// A link at `i` ("[label](url)"): the label's range and the end, or null.
function linkAt(s: string, i: number, end: number) {
  let depth = 0,
    j = i;
  while (j < end) {
    const c = s[j];
    if (c === "\\" || c === "`") {
      j = skipUnit(s, j, end);
      continue;
    }
    if (c === "[") depth++;
    else if (c === "]" && --depth === 0) break;
    j++;
  }
  if (j >= end || s[j] !== "]" || s[j + 1] !== "(") return null;
  let k = j + 2,
    parens = 0;
  while (k < end) {
    const c = s[k];
    if (/\s/.test(c)) return null;
    if (c === "(") parens++;
    else if (c === ")") {
      if (parens === 0) break;
      parens--;
    }
    k++;
  }
  if (k >= end) return null;
  return { labelStart: i + 1, labelEnd: j, url: s.slice(j + 2, k), next: k + 1 };
}

type TextNode = { kind: "text"; text: string; marks: Marks };
type DelimNode = { kind: "delim"; ch: string; len: number; orig: number; open: boolean; close: boolean; marks: Marks };

// Emphasis with a delimiter stack like CommonMark: a run of * or _ opens
// when no space follows (_ also not after a letter or digit) and closes
// when no space precedes it (_ also not before a letter or digit); ~~ is
// strike. Inner delimiters close first ("***a***", "**a*b***").
function parseRange(s: string, start: number, end: number, marks: Marks, out: InlineRun[], depth: number) {
  const nodes: (TextNode | DelimNode)[] = [];
  let buf = "";
  const flush = () => {
    if (buf) nodes.push({ kind: "text", text: buf, marks: { ...marks } });
    buf = "";
  };
  let i = start;
  while (i < end) {
    const c = s[i];
    if (c === "\\" && i + 1 < end && ESCAPABLE.has(s[i + 1])) {
      buf += s[i + 1];
      i += 2;
      continue;
    }
    if (c === "`") {
      let n = 0;
      while (i + n < end && s[i + n] === "`") n++;
      const close = codeEnd(s, i + n, end, n);
      if (close < 0) {
        buf += s.slice(i, i + n);
        i += n;
        continue;
      }
      flush();
      let code = s.slice(i + n, close);
      // "`` `a` ``": one space on both sides is padding.
      if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim()) code = code.slice(1, -1);
      nodes.push({ kind: "text", text: code, marks: { ...marks, code: true } });
      i = close + n;
      continue;
    }
    if (c === "[" && !marks.href && depth < 20) {
      const link = linkAt(s, i, end);
      if (link) {
        flush();
        const href = safeHref(link.url);
        const label: InlineRun[] = [];
        parseRange(s, link.labelStart, link.labelEnd, href ? { ...marks, href } : marks, label, depth + 1);
        if (!label.length && href) label.push({ ...marks, href, text: link.url });
        for (const run of label) {
          const { text, ...runMarks } = run;
          nodes.push({ kind: "text", text, marks: runMarks });
        }
        i = link.next;
        continue;
      }
    }
    if (c === "*" || c === "_" || c === "~") {
      let n = 0;
      while (i + n < end && s[i + n] === c) n++;
      if (c === "~" && n !== 2) {
        buf += s.slice(i, i + n);
        i += n;
        continue;
      }
      flush();
      const prev = i > 0 ? s[i - 1] : undefined,
        next = s[i + n];
      let open = !isSpace(next),
        close = i > start && !isSpace(prev);
      if (c === "_") {
        open = open && !isWord(prev);
        close = close && !isWord(next);
      }
      nodes.push({ kind: "delim", ch: c, len: n, orig: n, open, close, marks: { ...marks } });
      i += n;
      continue;
    }
    buf += c;
    i++;
  }
  flush();
  // Process the emphasis.
  for (let ci = 0; ci < nodes.length; ci++) {
    const closer = nodes[ci];
    if (closer.kind !== "delim" || !closer.close) continue;
    while (closer.len > 0) {
      let oi = ci - 1;
      for (; oi >= 0; oi--) {
        const o = nodes[oi];
        if (o.kind !== "delim" || o.ch !== closer.ch || !o.open || o.len === 0) continue;
        if (closer.ch === "~") {
          if (o.len === 2 && closer.len === 2) break;
          continue;
        }
        // CommonMark's "rule of 3".
        if ((o.close || closer.open) && (o.orig + closer.orig) % 3 === 0 && !(o.orig % 3 === 0 && closer.orig % 3 === 0)) continue;
        break;
      }
      if (oi < 0) break;
      const opener = nodes[oi] as DelimNode;
      const use = closer.ch === "~" ? 2 : opener.len >= 2 && closer.len >= 2 ? 2 : 1;
      const mark = closer.ch === "~" ? "strike" : use === 2 ? "bold" : "italic";
      for (let k = oi + 1; k < ci; k++) {
        const node = nodes[k];
        node.marks = { ...node.marks, [mark]: true };
        // Delimiters inside become text.
        if (node.kind === "delim") node.open = node.close = false;
      }
      opener.len -= use;
      closer.len -= use;
    }
  }
  for (const node of nodes) {
    const text = node.kind === "text" ? node.text : node.ch.repeat(node.len);
    if (text) out.push({ ...node.marks, text });
  }
}

// The text without its formatting (line breaks stay "\n").
export function toPlain(markdown: unknown): string {
  if (typeof markdown !== "string") return markdown === null || markdown === undefined ? "" : String(markdown);
  if (!/[\\*_~`[]/.test(markdown)) return normalizeBreaks(markdown);
  return parseInline(markdown)
    .map((run) => run.text)
    .join("");
}

// Whether the value shows any formatting (or an escape) – plain values
// render as plain strings.
export function hasInlineMarkup(markdown: unknown): boolean {
  return typeof markdown === "string" && /[\\*_~`[]/.test(markdown);
}

const ORDER = ["href", "bold", "italic", "strike"] as const;

// Runs → inline Markdown. Marks never start or end with whitespace (a
// space moves outside), italic is _x_ unless a letter touches it (then *x*).
export function serializeInline(runs: InlineRun[]): string {
  return resolveItalics(serializeLevel(mergeRuns(runs), 0));
}

// Italic is written with placeholders first; _x_ needs no letter or digit
// right outside, otherwise *x*.
const OPEN = "\u0001",
  CLOSE = "\u0002";
function resolveItalics(text: string): string {
  if (!text.includes(OPEN)) return text;
  const chars = [...text];
  const neighbour = (from: number, step: number) => {
    for (let k = from; k >= 0 && k < chars.length; k += step) if (chars[k] !== OPEN && chars[k] !== CLOSE) return chars[k];
    return undefined;
  };
  for (let p = 0; p < chars.length; p++) {
    if (chars[p] !== OPEN) continue;
    const q = chars.indexOf(CLOSE, p);
    const before = neighbour(p - 1, -1),
      after = neighbour(q + 1, 1);
    const mark = isWord(before) || isWord(after) ? "*" : "_";
    chars[p] = mark;
    chars[q] = mark;
  }
  return chars.join("");
}

function codeSpan(text: string) {
  let longest = 0;
  for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") || (text.startsWith(" ") && text.endsWith(" ") && text.trim()) ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

function escapeUrl(url: string) {
  return url.replace(/[\s()<>\\]/g, (c) => encodeURIComponent(c));
}

function serializeLevel(runs: InlineRun[], level: number): string {
  if (level === ORDER.length) {
    let out = "";
    // Whitespace alone is never code (two code spans must not touch).
    for (const run of runs) out += run.code ? run.text.split("\n").map((part) => (part.trim() ? codeSpan(part) : part)).join("\n") : escapeInline(run.text);
    return out;
  }
  const key = ORDER[level];
  let out = "";
  let i = 0;
  while (i < runs.length) {
    const value = runs[i][key];
    let j = i + 1;
    while (j < runs.length && runs[j][key] === value) j++;
    const group = runs.slice(i, j);
    i = j;
    if (!value) {
      out += serializeLevel(group, level + 1);
      continue;
    }
    // Leading and trailing whitespace goes outside the mark.
    const lead = /^\s*/.exec(group.map((r) => r.text).join(""))![0];
    const trail = /\s*$/.exec(group.map((r) => r.text).join(""))![0];
    const inner = trimRuns(group, lead.length, trail.length);
    if (!inner.length) {
      out += serializeLevel(group.map((r) => ({ ...r, [key]: undefined })), level + 1);
      continue;
    }
    const body = serializeLevel(inner, level + 1);
    let wrapped: string;
    if (key === "href") wrapped = `[${body}](${escapeUrl(String(value))})`;
    else if (key === "bold") wrapped = `**${body}**`;
    else if (key === "strike") wrapped = `~~${body}~~`;
    else wrapped = `${OPEN}${body}${CLOSE}`;
    out += serializeLevel(edgeRuns(group, lead.length, true, key), level + 1) + wrapped + serializeLevel(edgeRuns(group, trail.length, false, key), level + 1);
  }
  return out;
}

// The whitespace cut off a group's start or end, with the deeper marks.
function edgeRuns(group: InlineRun[], length: number, start: boolean, key: (typeof ORDER)[number]): InlineRun[] {
  if (!length) return [];
  const out: InlineRun[] = [];
  const list = start ? group : [...group].reverse();
  let left = length;
  for (const run of list) {
    if (left <= 0) break;
    const cut = Math.min(left, run.text.length);
    // Whitespace outside a mark carries no code either: two code spans
    // must not touch ("`a`` `").
    out.push({ ...run, [key]: undefined, code: undefined, text: start ? run.text.slice(0, cut) : run.text.slice(run.text.length - cut) });
    left -= cut;
  }
  return start ? out : out.reverse();
}

function trimRuns(group: InlineRun[], lead: number, trail: number): InlineRun[] {
  const out = group.map((r) => ({ ...r }));
  let skip = lead;
  while (skip > 0 && out.length) {
    const cut = Math.min(skip, out[0].text.length);
    out[0].text = out[0].text.slice(cut);
    skip -= cut;
    if (!out[0].text) out.shift();
  }
  skip = trail;
  while (skip > 0 && out.length) {
    const last = out[out.length - 1];
    const cut = Math.min(skip, last.text.length);
    last.text = last.text.slice(0, last.text.length - cut);
    skip -= cut;
    if (!last.text) out.pop();
  }
  return out;
}

// Normalises inline Markdown (e.g. from the API): the same text and marks,
// written the way the editor writes them; unsafe links keep their label.
export function normalizeInline(markdown: string): string {
  return serializeInline(parseInline(markdown));
}

// ---- HTML → inline Markdown (paste, imports) ----------------------------
// A tiny element tree that both the browser's DOM and htmlparser2 map to.
export type HtmlNode =
  | { type: "text"; text: string }
  | { type: "element"; name: string; attrs: Record<string, string>; children: HtmlNode[] };

const SKIP = new Set(["script", "style", "head", "template", "title", "noscript", "iframe", "object", "svg", "math", "img", "video", "audio", "canvas", "select", "button", "input", "textarea"]);
const BLOCKS = new Set([
  "p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li", "ul", "ol", "dl", "dt", "dd", "blockquote", "pre", "section", "article", "header", "footer",
  "aside", "nav", "main", "figure", "figcaption", "table", "thead", "tbody", "tfoot", "tr", "hr", "address", "details", "summary", "form", "fieldset", "center",
]);
const CELLS = new Set(["td", "th"]);

function styleOf(attrs: Record<string, string>) {
  const style = (attrs.style || "").toLowerCase();
  const prop = (name: string) => new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`).exec(style)?.[1].trim();
  return { weight: prop("font-weight"), fontStyle: prop("font-style"), decoration: [prop("text-decoration"), prop("text-decoration-line")].filter(Boolean).join(" ") };
}

// The runs of an element tree: inline marks kept, blocks become line breaks.
export function htmlRuns(nodes: HtmlNode[]): InlineRun[] {
  const out: InlineRun[] = [];
  const walk = (list: HtmlNode[], marks: Marks, pre: boolean) => {
    for (const node of list) {
      if (node.type === "text") {
        const text = pre ? node.text : node.text.replace(/[\t\n\r\f ]+/g, " ");
        if (text) out.push({ ...marks, text });
        continue;
      }
      const name = node.name.toLowerCase();
      if (SKIP.has(name)) continue;
      if (name === "br") {
        out.push({ text: "\n" });
        continue;
      }
      const next: Marks = { ...marks };
      const style = styleOf(node.attrs);
      if (name === "b" || name === "strong") next.bold = true;
      if (style.weight) next.bold = style.weight === "bold" || style.weight === "bolder" || Number(style.weight) >= 600;
      if (name === "i" || name === "em" || name === "cite" || name === "var") next.italic = true;
      if (style.fontStyle) next.italic = style.fontStyle === "italic" || style.fontStyle === "oblique";
      if (name === "s" || name === "strike" || name === "del") next.strike = true;
      if (style.decoration.includes("line-through")) next.strike = true;
      if (name === "code" || name === "kbd" || name === "samp" || name === "tt") next.code = true;
      if (name === "a" && node.attrs.href) {
        const href = safeHref(node.attrs.href);
        if (href) next.href = href;
      }
      if (/^h[1-6]$/.test(name) || name === "th") next.bold = next.bold ?? true;
      const block = BLOCKS.has(name);
      if (block) out.push({ text: "\n" });
      if (name === "hr") continue;
      walk(node.children, next, pre || name === "pre");
      if (block) out.push({ text: "\n" });
      if (CELLS.has(name)) out.push({ text: " " });
    }
  };
  walk(nodes, {}, false);
  return tidyRuns(out);
}

// Collapses the whitespace around line breaks: no space at a line's start
// or end, at most one empty line, none at the start or end.
function tidyRuns(runs: InlineRun[]): InlineRun[] {
  const text = runs.map((r) => r.text).join("");
  const keep: boolean[] = new Array(text.length).fill(true);
  // Spaces and tabs next to a line break, and runs of spaces.
  for (let i = 0; i < text.length; i++) {
    if (text[i] === " " || text[i] === "\t") {
      let j = i;
      while (j < text.length && (text[j] === " " || text[j] === "\t")) j++;
      const atBreak = i === 0 || text[i - 1] === "\n" || j === text.length || text[j] === "\n";
      for (let k = atBreak ? i : i + 1; k < j; k++) keep[k] = false;
      i = j - 1;
    }
  }
  // Line breaks: none at the ends, at most two in a row.
  let first = 0;
  while (first < text.length && (!keep[first] || text[first] === "\n")) keep[first++] = false;
  let last = text.length - 1;
  while (last >= 0 && (!keep[last] || text[last] === "\n")) keep[last--] = false;
  let breaks = 0;
  for (let i = 0; i < text.length; i++) {
    if (!keep[i]) continue;
    if (text[i] === "\n") {
      if (++breaks > 2) keep[i] = false;
    } else breaks = 0;
  }
  const out: InlineRun[] = [];
  let at = 0;
  for (const run of runs) {
    let kept = "";
    for (let i = 0; i < run.text.length; i++) if (keep[at + i]) kept += run.text[i];
    at += run.text.length;
    // A line break carries no marks.
    for (const part of kept.split(/(\n)/))
      if (part === "\n") out.push({ text: "\n" });
      else if (part) out.push({ ...run, text: part });
  }
  return mergeRuns(out);
}

export function htmlNodesToInline(nodes: HtmlNode[]): string {
  return serializeInline(htmlRuns(nodes));
}

// Rich text with annotations (Notion's API, AFFiNE's Yjs deltas and the
// like) → inline Markdown.
export function annotatedToInline(
  parts: { text: string; bold?: boolean; italic?: boolean; strike?: boolean; code?: boolean; link?: string | null }[],
): string {
  return serializeInline(
    parts.map((p) => ({
      text: normalizeBreaks(p.text),
      bold: !!p.bold,
      italic: !!p.italic,
      strike: !!p.strike,
      code: !!p.code,
      href: p.link ? safeHref(p.link) : undefined,
    })),
  );
}

// Inline Markdown → HTML for exports that write HTML (escaped, safe links).
export function inlineToHtml(markdown: unknown): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return parseInline(typeof markdown === "string" ? markdown : "")
    .map((run) => {
      let html = esc(run.text).replace(/\n/g, "<br>");
      if (run.code) html = `<code>${html}</code>`;
      if (run.strike) html = `<s>${html}</s>`;
      if (run.italic) html = `<em>${html}</em>`;
      if (run.bold) html = `<strong>${html}</strong>`;
      if (run.href) html = `<a href="${esc(run.href)}" target="_blank" rel="noopener noreferrer">${html}</a>`;
      return html;
    })
    .join("");
}
