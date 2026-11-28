// Embedded notes of an Obsidian vault as content (#672): with the option
// switched on in the import preview, a line of its own that embeds a note
// (![[Note]]), the section under one of its headings (![[Note#Heading]]) or
// one of its blocks (![[Note#^id]]) becomes a copy of that content in a
// callout headed "Aus [[Note]]" – the link to the source stays. Embeds in
// the middle of a line stay links. A note that embeds itself (directly or
// through others), embeds deeper than MAX_EMBED_DEPTH and content beyond
// the budget per page and per import fall back to links and are reported.
// Every inserted piece counts its bytes before anything below it is
// expanded, so the work never grows beyond the budget.
import { ct } from "../content-locale";
import type { ImportReport } from "./types";

export const MAX_EMBED_DEPTH = 3;
export const EMBED_PAGE_BUDGET = 200 * 1024;
export const EMBED_IMPORT_BUDGET = 5 * 1024 * 1024;

export type EmbedSource = {
  // A note's text as imported (no frontmatter, no title heading); null if
  // there is no such note.
  body: (path: string) => string | null;
  // The note a link target names, seen from the note `from`.
  resolve: (from: string, target: string) => string | null;
};
export type EmbedLimits = { depth: number; perPage: number; perImport: number };

const NOTE = /\.(md|markdown)$/i;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const EMBED_LINE = /^(\s*)!\[\[([^\]\n|]*?)(?:\|([^\]\n]*))?\]\]\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s/;
const MARKER_END = /\s+\^([A-Za-z0-9-]+)\s*$/;
const MARKER_ALONE = /^\s*\^([A-Za-z0-9-]+)\s*$/;

// Each line with whether it lies in a fenced code block.
function scan(lines: string[]) {
  let fence: string | null = null;
  return lines.map((line) => {
    const opening = FENCE.exec(line);
    if (fence) {
      if (opening && opening[1][0] === fence[0] && opening[1].length >= fence.length) fence = null;
      return true;
    }
    if (opening) {
      fence = opening[1];
      return true;
    }
    return false;
  });
}

// Heading texts as links name them: case, spacing and the characters
// Obsidian leaves out of anchors do not matter.
const headingKey = (text: string) =>
  text
    .normalize("NFC")
    .replace(/[#|^:%[\]\\*_`]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

// "![[Note#A#B]]" → target "Note", part "B"; "![[#^id]]" → "", "^id".
export function splitEmbedTarget(raw: string) {
  const cut = raw.search(/[#^]/);
  const target = (cut < 0 ? raw : raw.slice(0, cut)).trim();
  const anchor = cut < 0 ? "" : raw.slice(cut);
  const part = anchor.replace(/^#/, "").split("#").pop()!.trim();
  return { target, part };
}

// The section under a heading (the heading included) up to the next
// heading of the same or a higher level.
function section(lines: string[], code: boolean[], heading: string) {
  const key = headingKey(heading);
  const start = lines.findIndex((line, i) => !code[i] && HEADING.test(line) && headingKey(HEADING.exec(line)![2]) === key);
  if (start < 0) return null;
  const level = HEADING.exec(lines[start])![1].length;
  let end = start + 1;
  while (end < lines.length && !(!code[end] && HEADING.test(lines[end]) && HEADING.exec(lines[end])![1].length <= level)) end++;
  return lines.slice(start, end).join("\n").replace(/\s+$/, "");
}

// The block carrying "^id": its paragraph, list item (with the items
// below it) or heading; a marker on a line of its own names the block
// before it (a table, a quote, a list).
function block(lines: string[], code: boolean[], id: string) {
  const at = lines.findIndex((line, i) => {
    if (code[i]) return false;
    const m = MARKER_END.exec(line) || MARKER_ALONE.exec(line);
    return !!m && m[1] === id;
  });
  if (at < 0) return null;
  const blank = (i: number) => !lines[i].trim();
  if (MARKER_ALONE.test(lines[at])) {
    let start = at - 1;
    while (start >= 0 && blank(start)) start--;
    if (start < 0) return null;
    const end = start;
    while (start > 0 && !blank(start - 1) && !HEADING.test(lines[start - 1])) start--;
    return lines.slice(start, end + 1).join("\n");
  }
  if (HEADING.test(lines[at])) return lines[at];
  const item = LIST_ITEM.exec(lines[at]);
  if (item) {
    const indent = item[1].length;
    let end = at + 1;
    while (end < lines.length && !blank(end) && /^(\s*)/.exec(lines[end])![1].length > indent) end++;
    return lines.slice(at, end).join("\n");
  }
  let start = at,
    end = at;
  while (start > 0 && !blank(start - 1) && !HEADING.test(lines[start - 1]) && !LIST_ITEM.test(lines[start - 1])) start--;
  while (end + 1 < lines.length && !blank(end + 1) && !HEADING.test(lines[end + 1]) && !LIST_ITEM.test(lines[end + 1])) end++;
  return lines.slice(start, end + 1).join("\n");
}

const labelOf = (text: string) => text.replace(/[[\]|]/g, "").trim();

export type Transcluder = ReturnType<typeof embedTranscluder>;

// One per import: the sliced content of each note and part is cut once.
export function embedTranscluder(source: EmbedSource, report: ImportReport, limits: EmbedLimits = { depth: MAX_EMBED_DEPTH, perPage: EMBED_PAGE_BUDGET, perImport: EMBED_IMPORT_BUDGET }) {
  const slices = new Map<string, string | null>();
  const total = { left: limits.perImport };
  let fallbacks = 0;

  // The part of a note an embed names, with block markers taken out (the
  // copy must not take the original's ids) and links to its own headings
  // pointing at the note.
  const slice = (path: string, part: string) => {
    const key = `${path}\u0000${part}`;
    if (slices.has(key)) return slices.get(key)!;
    const body = source.body(path);
    let text: string | null = null;
    if (body !== null) {
      const lines = body.split("\n");
      const code = scan(lines);
      text = !part ? body.replace(/^\s+|\s+$/g, "") : part.startsWith("^") ? block(lines, code, part.slice(1)) : section(lines, code, part);
      if (text !== null) {
        const own = path.replace(NOTE, "");
        const cut = text.split("\n");
        const inCode = scan(cut);
        text = cut
          .filter((line, i) => inCode[i] || !MARKER_ALONE.test(line))
          .map((line, i) =>
            inCode[i]
              ? line
              : line
                  .replace(MARKER_END, "")
                  // [[#Heading]] keeps showing "Heading", now from the note.
                  .replace(/(!?)\[\[([#^][^\]\n|]*)(\|[^\]\n]*)?\]\]/g, (_, bang: string, anchor: string, label?: string) =>
                    `${bang}[[${own}${anchor}${label ?? (bang ? "" : `|${labelOf(splitEmbedTarget(anchor).part.replace(/^\^/, ""))}`)}]]`,
                  ),
          )
          .join("\n");
      }
    }
    slices.set(key, text);
    return text;
  };

  const fallback = (line: string, detail: string, page: string) => {
    fallbacks++;
    report.add("embed", detail, page);
    // A plain link from here on (not reported a second time as an embed).
    return line.replace("![[", "[[");
  };

  function expand(markdown: string, from: string, page: string, depth: number, chain: string[], budget: { left: number }): string {
    const lines = markdown.split("\n");
    const code = scan(lines);
    return lines
      .map((line, i) => {
        if (code[i]) return line;
        const m = EMBED_LINE.exec(line);
        if (!m) return line;
        const [, indent, raw] = m;
        const { target, part } = splitEmbedTarget(raw);
        const path = target ? source.resolve(from, target) : from;
        // Images, files and links to nothing stay as they are.
        if (!path) return line;
        const name = labelOf(path.replace(NOTE, "").replace(/^.*\//, ""));
        const shown = part ? `${name} › ${labelOf(part.replace(/^\^/, ""))}` : name;
        const key = `${path}\u0000${part}`;
        if (chain.includes(key))
          return fallback(line, ct(`Eingebettete Notiz „${shown}“ bettet sich selbst ein – als Link übernommen`, `Embedded note “${shown}” embeds itself – kept as a link`), page);
        if (depth > limits.depth)
          return fallback(
            line,
            ct(`Eingebettete Notiz „${shown}“ liegt tiefer als ${limits.depth} Ebenen – als Link übernommen`, `Embedded note “${shown}” is nested deeper than ${limits.depth} levels – kept as a link`),
            page,
          );
        const text = slice(path, part);
        if (text === null)
          return fallback(line, ct(`Abschnitt „${shown}“ der eingebetteten Notiz nicht gefunden – als Link übernommen`, `Section “${shown}” of the embedded note not found – kept as a link`), page);
        const head = [`[!quote]`, `${ct("Aus", "From")} [[${path.replace(NOTE, "")}${part ? `#${part}` : ""}|${shown}]]`];
        const bytes = Buffer.byteLength(text) + Buffer.byteLength(head.join("\n")) + 8;
        if (bytes > budget.left || bytes > total.left)
          return fallback(line, ct(`Eingebettete Notiz „${shown}“ als Link übernommen: zu viel eingefügter Inhalt`, `Embedded note “${shown}” kept as a link: too much inserted content`), page);
        budget.left -= bytes;
        total.left -= bytes;
        const inner = expand(text, path, page, depth + 1, [...chain, key], budget);
        report.add("synced", ct(`Eingebettete Notiz „${shown}“ als Kopie eingefügt`, `Embedded note “${shown}” inserted as a copy`), page);
        return [...head, "", ...inner.split("\n")].map((l) => `${indent}>${l ? ` ${l}` : ""}`).join("\n");
      })
      .join("\n");
  }

  return {
    // The text of the note `path` with its embedded notes inserted.
    transclude(markdown: string, path: string) {
      return expand(markdown, path, path, 1, [`${path}\u0000`], { left: limits.perPage });
    },
    // How many embeds fell back to links so far.
    get fallbacks() {
      return fallbacks;
    },
  };
}

// Embeds of notes in a note's text (for the preview, whether or not they
// are inserted).
export function countNoteEmbeds(markdown: string, from: string, resolve: EmbedSource["resolve"]) {
  if (!markdown.includes("![[")) return 0;
  const lines = markdown.split("\n");
  const code = scan(lines);
  let n = 0;
  lines.forEach((line, i) => {
    if (code[i]) return;
    for (const m of line.matchAll(/!\[\[([^\]\n|]*?)(?:\|[^\]\n]*)?\]\]/g)) {
      const { target } = splitEmbedTarget(m[1]);
      if (!target || resolve(from, target)) n++;
    }
  });
  return n;
}
