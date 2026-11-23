// Inline formatting of footnotes (design review): a note is stored as plain
// text with a small Markdown-like syntax – **bold**, *italic*, `code` and
// links as [text](https://…) – plus bare web addresses. The text is never
// read as HTML: it is split into spans here, and every renderer builds its
// own markup from them (DOM nodes with textContent, escaped XHTML, Word
// runs, Jira wiki text). Links only to http(s) and mailto. Notes written
// before keep working: plain text is one span, addresses stay links.

export type NoteSpan = { text: string; bold?: true; italic?: true; code?: true; href?: string };
type Marks = Omit<NoteSpan, "text">;

// Web addresses in running text (as before: no trailing punctuation).
export const NOTE_URL = /https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]]/y;
const LINK = /\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^\s()<>"]+)\)/y;
const ESCAPABLE = "\\*`[]()_";

export function safeHref(value: string): string | null {
  return /^(?:https?:\/\/|mailto:)[^\s<>"]+$/i.test(value) ? value : null;
}

// The closing `*` of an italic run that opens at `from` (skipping `**`
// pairs, which belong to bold inside it); -1 when there is none.
function italicEnd(source: string, from: number) {
  for (let k = from; k < source.length; k++) {
    if (source[k] === "\\") {
      k++;
      continue;
    }
    if (source[k] === "`") {
      const close = source.indexOf("`", k + 1);
      if (close > k) k = close;
      continue;
    }
    if (source.startsWith("**", k)) {
      k++;
      continue;
    }
    if (source[k] === "*") return k;
  }
  return -1;
}

function parse(source: string, marks: Marks, out: NoteSpan[]) {
  let text = "";
  const flush = () => {
    if (text) out.push({ text, ...marks });
    text = "";
  };
  for (let i = 0; i < source.length; ) {
    const c = source[i];
    if (c === "\\" && i + 1 < source.length && ESCAPABLE.includes(source[i + 1])) {
      text += source[i + 1];
      i += 2;
      continue;
    }
    if (c === "`") {
      const close = source.indexOf("`", i + 1);
      if (close > i + 1) {
        flush();
        out.push({ text: source.slice(i + 1, close), ...marks, code: true });
        i = close + 1;
        continue;
      }
    }
    if (source.startsWith("**", i)) {
      const close = source.indexOf("**", i + 2);
      const inner = close > i + 2 ? source.slice(i + 2, close) : "";
      if (inner.trim() && !/^\s/.test(inner) && !/\s$/.test(inner)) {
        flush();
        parse(inner, { ...marks, bold: true }, out);
        i = close + 2;
        continue;
      }
    }
    if (c === "*" && !source.startsWith("**", i)) {
      const close = italicEnd(source, i + 1);
      const inner = close > i + 1 ? source.slice(i + 1, close) : "";
      if (inner.trim() && !/^\s/.test(inner) && !/\s$/.test(inner)) {
        flush();
        parse(inner, { ...marks, italic: true }, out);
        i = close + 1;
        continue;
      }
    }
    if (c === "[" && !marks.href) {
      LINK.lastIndex = i;
      const link = LINK.exec(source);
      if (link) {
        flush();
        parse(link[1], { ...marks, href: link[2] }, out);
        i = LINK.lastIndex;
        continue;
      }
    }
    if ((c === "h" || c === "H") && !marks.href) {
      NOTE_URL.lastIndex = i;
      const url = NOTE_URL.exec(source);
      if (url && (i === 0 || !/[\w/]/.test(source[i - 1]))) {
        flush();
        out.push({ text: url[0], ...marks, href: url[0] });
        i = NOTE_URL.lastIndex;
        continue;
      }
    }
    text += c;
    i++;
  }
  flush();
}

/** The note as spans of text with their formatting. */
export function noteSpans(note: string): NoteSpan[] {
  const out: NoteSpan[] = [];
  parse(String(note ?? ""), {}, out);
  return out;
}

/** The note without its formatting marks (tooltips, search, plain exports);
 *  a link whose text is not its address keeps the address in brackets. */
export function notePlain(note: string): string {
  return noteSpans(note)
    .map((span) => (span.href && span.href !== span.text ? `${span.text} (${span.href})` : span.text))
    .join("");
}

const escapeXml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** The note as (X)HTML: <strong>, <em>, <code> and <a href>, all text escaped. */
export function noteHtml(note: string, escape: (text: string) => string = escapeXml): string {
  return noteSpans(note)
    .map((span) => {
      let html = escape(span.text);
      if (span.code) html = `<code>${html}</code>`;
      if (span.italic) html = `<em>${html}</em>`;
      if (span.bold) html = `<strong>${html}</strong>`;
      const href = span.href && safeHref(span.href);
      if (href) html = `<a href="${escape(href)}">${html}</a>`;
      return html;
    })
    .join("");
}

/** Appends the note to `target` as DOM nodes (no HTML is ever parsed);
 *  links open in a new tab and do not reach the note's own click. */
export function renderNote(target: HTMLElement, note: string) {
  const doc = target.ownerDocument;
  for (const span of noteSpans(note)) {
    let node: Node = doc.createTextNode(span.text);
    const wrap = (tag: string) => {
      const el = doc.createElement(tag);
      el.append(node);
      node = el;
    };
    if (span.code) wrap("code");
    if (span.italic) wrap("em");
    if (span.bold) wrap("strong");
    const href = span.href && safeHref(span.href);
    if (href) {
      const link = doc.createElement("a");
      link.href = href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.append(node);
      link.addEventListener("click", (event) => event.stopPropagation());
      node = link;
    }
    target.append(node);
  }
}

/** Marked's inline HTML of a note (Markdown import) back in the note's own
 *  syntax: bold, italic, code and links stay, other markup goes. */
export function noteFromHtml(html: string, decode: (text: string) => string): string {
  // Only what would read as a mark is escaped: asterisks, backticks, a
  // backslash before one of them, and brackets that would make a link.
  const esc = (text: string) =>
    text
      .replace(/\\(?=[\\*`[\]()_])/g, "\\\\")
      .replace(/[*`]/g, "\\$&")
      .replace(/\[(?=[^\]\n]+\]\()/g, "\\[");
  let out = "";
  const re = /<(\/?)(strong|b|em|i|code|a)\b([^>]*)>|<[^>]*>|([^<]+)/gi;
  const open: string[] = [];
  let href = "";
  for (const m of html.matchAll(re)) {
    if (m[4] !== undefined) {
      const text = decode(m[4]);
      out += open.includes("code") ? text.replace(/`/g, "'") : esc(text);
      continue;
    }
    if (!m[2]) continue;
    const tag = m[2].toLowerCase();
    const closing = m[1] === "/";
    const mark = tag === "strong" || tag === "b" ? "**" : tag === "em" || tag === "i" ? "*" : tag === "code" ? "`" : "";
    if (tag === "a") {
      if (!closing) {
        const found = /\bhref="([^"]*)"/.exec(m[3]);
        href = found ? safeHref(decode(found[1])) || "" : "";
        if (href) out += "[";
      } else if (href) {
        out += `](${href})`;
        href = "";
      }
      continue;
    }
    if (closing) open.splice(open.lastIndexOf(tag), 1);
    else open.push(tag);
    out += mark;
  }
  // A link whose text is its address is a bare address again.
  return out.replace(/\[(https?:\/\/[^\]\s]+)\]\(\1\)/g, "$1");
}
