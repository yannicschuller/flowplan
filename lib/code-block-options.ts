import { canonicalLanguage } from "./code-languages";

// The per-block options of code blocks (#92 preview, #93 line numbers,
// #94 collapse): their values as stored in the node's attributes and the
// HTML (data-… on <pre>), the Markdown fence meta they travel in, and the
// rules that decide what a block shows. Pure, for the server, the editor
// and the read-only views alike.

// ------------------------------------------------------------- preview (#92)
export type CodeView = "code" | "preview" | "split";
export const CODE_VIEWS: CodeView[] = ["code", "preview", "split"];
export const codeView = (value: unknown): CodeView | null =>
  typeof value === "string" && (CODE_VIEWS as string[]).includes(value) ? (value as CodeView) : null;

export type PreviewKind = "html" | "svg" | "markdown" | "mermaid" | "latex" | "typst";
// An SVG picture (Shiki has no language of its own for it: ```svg fences
// become "xml").
const SVG_ROOT = /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i;
// What a block of this language and text can show as a preview, or null.
export function previewKind(language: string | null | undefined, text = ""): PreviewKind | null {
  const id = canonicalLanguage(language);
  switch (id) {
    case "html":
      return "html";
    case "xml":
      return SVG_ROOT.test(text) ? "svg" : null;
    case "markdown":
      return "markdown";
    case "mermaid":
      return "mermaid";
    case "latex":
    case "tex":
      return "latex";
    case "typst":
      return "typst";
    default:
      return null;
  }
}
// Languages whose preview is what people want to see first: blocks of them
// that arrive from an import (AFFiNE, Markdown, HTML …) or get the language
// in the editor show the preview (#95). Other languages keep the code.
export const PREVIEW_FIRST = new Set(["mermaid"]);
export const previewFirst = (language: string | null | undefined) => PREVIEW_FIRST.has(canonicalLanguage(language));

// The view a block shows: its own setting; without one, readers see the
// preview where there is one, editors the code.
export function effectiveView(view: unknown, kind: PreviewKind | null, editable: boolean): CodeView {
  if (!kind) return "code";
  return codeView(view) ?? (editable ? "code" : "preview");
}

// ------------------------------------------------------- line numbers (#93)
export const MAX_LINE_NUMBER = 1_000_000;
export const lineCount = (text: string) => (text ? text.replace(/\n$/, "").split("\n").length : 1);
export const startLine = (value: unknown) => {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n >= 0 && n <= MAX_LINE_NUMBER ? n : 1;
};

// Highlighted lines as written ("3-5, 8"): ranges of line numbers, counted
// from 1 for the block's first line whatever its start number (as Markdown
// fences count them). Kept normalised: "3-5,8".
const MAX_RANGES = 100;
export type LineRange = [number, number];
export function parseLineRanges(value: unknown, offset = 0): LineRange[] {
  if (typeof value !== "string") return [];
  const ranges: LineRange[] = [];
  for (const part of value.replace(/\s*[-–]\s*/g, "-").split(/[,;\s]+/)) {
    const match = /^(\d{1,7})(?:\s*[-–]\s*(\d{1,7}))?$/.exec(part.trim());
    if (!match) continue;
    let from = Number(match[1]) - offset,
      to = Number(match[2] ?? match[1]) - offset;
    if (to < from) [from, to] = [to, from];
    from = Math.max(1, from);
    if (to < 1 || from > MAX_LINE_NUMBER) continue;
    ranges.push([from, Math.min(to, MAX_LINE_NUMBER)]);
    if (ranges.length >= MAX_RANGES) break;
  }
  // Sorted, overlapping and touching ranges merged.
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: LineRange[] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  return merged;
}
export const formatLineRanges = (ranges: LineRange[], offset = 0) =>
  ranges.map(([from, to]) => (from === to ? `${from + offset}` : `${from + offset}-${to + offset}`)).join(",");
// The stored form of what someone typed (numbers as shown, from `start`).
export const normalizeLineRanges = (value: unknown, start = 1) => formatLineRanges(parseLineRanges(value, start - 1));
export function highlightedLines(value: unknown): Set<number> {
  const lines = new Set<number>();
  for (const [from, to] of parseLineRanges(value)) for (let n = from; n <= to && lines.size < 10_000; n++) lines.add(n);
  return lines;
}

// ----------------------------------------------------------- collapse (#94)
// A collapsed block shows this many lines and scrolls inside; blocks longer
// than AUTO_COLLAPSE_LINES start collapsed.
export const DEFAULT_COLLAPSED_LINES = 10;
export const AUTO_COLLAPSE_LINES = 25;
export const COLLAPSED_LINE_CHOICES = [5, 10, 15, 20, 30];
export const collapsedLines = (value: unknown) => {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n >= 3 && n <= 200 ? n : DEFAULT_COLLAPSED_LINES;
};
// Collapsed or not: the block's own setting, otherwise by its length.
export function isCollapsed(collapsed: unknown, lines: number, limit: unknown) {
  if (lines <= collapsedLines(limit)) return false;
  return typeof collapsed === "boolean" ? collapsed : lines > AUTO_COLLAPSE_LINES;
}

// ------------------------------------------------------- the stored values
export type CodeBlockOptions = {
  view: CodeView | null;
  // null: the reader's own default (Settings → Appearance).
  lineNumbers: boolean | null;
  startLine: number;
  highlightLines: string;
  // null: by length (AUTO_COLLAPSE_LINES).
  collapsed: boolean | null;
  collapsedLines: number | null;
};
const bool = (value: string | null | undefined) => (value === "true" ? true : value === "false" ? false : null);

// From the data-… attributes of a <pre> (paste, import, stored HTML). A
// block of a preview-first language without a view of its own (an import,
// HTML from another app) shows the preview.
export function optionsFromAttributes(get: (name: string) => string | null | undefined, language?: string | null): CodeBlockOptions {
  const start = get("data-start-line");
  const limit = get("data-collapsed-lines");
  return {
    view: codeView(get("data-code-view")) ?? (previewFirst(language) ? "preview" : null),
    lineNumbers: bool(get("data-line-numbers")),
    startLine: start == null ? 1 : startLine(start),
    highlightLines: normalizeLineRanges(get("data-highlight-lines") || ""),
    collapsed: bool(get("data-collapsed")),
    collapsedLines: limit == null ? null : collapsedLines(limit),
  };
}
// The data-… attributes for a <pre>: only what differs from the defaults
// (an explicit view always, so a block keeps it through copy and paste).
export function optionAttributes(options: Partial<CodeBlockOptions>): Record<string, string> {
  const attrs: Record<string, string> = {};
  const view = codeView(options.view);
  if (view) attrs["data-code-view"] = view;
  if (typeof options.lineNumbers === "boolean") attrs["data-line-numbers"] = String(options.lineNumbers);
  const start = startLine(options.startLine);
  if (start !== 1) attrs["data-start-line"] = String(start);
  const lines = normalizeLineRanges(options.highlightLines || "");
  if (lines) attrs["data-highlight-lines"] = lines;
  if (typeof options.collapsed === "boolean") attrs["data-collapsed"] = String(options.collapsed);
  if (options.collapsedLines != null) attrs["data-collapsed-lines"] = String(collapsedLines(options.collapsedLines));
  return attrs;
}

// ------------------------------------------------------------- Markdown meta
// The info string after a fence's language, in the common conventions:
//   ```ts {3-5,8} showLineNumbers startLine=10
//   ```ts showLineNumbers{10}            (rehype-pretty-code)
//   ```ts showLineNumbers=10             (Docusaurus' start number)
//   ```py hl_lines="3 4 5" linenums="10" (MkDocs)
// plus Flowplan's own view=…, collapsed and collapsedLines=….
export function parseFenceMeta(meta: string | null | undefined): Partial<CodeBlockOptions> {
  const options: Partial<CodeBlockOptions> = {};
  const text = String(meta || "").slice(0, 1000);
  const ranges: string[] = [];
  for (const match of text.matchAll(/\{([\d\s,–-]+)\}|([A-Za-z_][\w-]*)(?:=(?:"([^"]*)"|'([^']*)'|\{([^}]*)\}|([^\s{]+))|\{([^}]*)\})?/g)) {
    if (match[1] !== undefined) {
      ranges.push(match[1]);
      continue;
    }
    const key = match[2].toLowerCase();
    const value = match[3] ?? match[4] ?? match[5] ?? match[6] ?? match[7];
    switch (key) {
      case "showlinenumbers":
      case "linenumbers":
      case "linenums":
      case "numberlines":
        if (value === undefined || value === "" || value === "true") options.lineNumbers = true;
        else if (value === "false") options.lineNumbers = false;
        else if (/^\d+$/.test(value)) {
          options.lineNumbers = true;
          options.startLine = startLine(value);
        }
        break;
      case "nolinenumbers":
        options.lineNumbers = false;
        break;
      case "startline":
      case "start":
        if (value && /^\d+$/.test(value)) options.startLine = startLine(value);
        break;
      case "hl_lines":
      case "highlight":
      case "highlightlines":
      case "mark":
        if (value) ranges.push(value);
        break;
      case "view":
        if (codeView(value)) options.view = codeView(value);
        break;
      case "preview":
        options.view = "preview";
        break;
      case "collapsed":
      case "collapse":
        options.collapsed = value === "false" ? false : true;
        break;
      case "collapsedlines":
        if (value && /^\d+$/.test(value)) options.collapsedLines = collapsedLines(value);
        break;
    }
  }
  if (ranges.length) {
    const lines = formatLineRanges(parseLineRanges(ranges.join(",")));
    if (lines) options.highlightLines = lines;
  }
  return options;
}
// The meta for a fence (empty without options), in the order of the brief:
// {3-5} showLineNumbers startLine=10 view=preview collapsed collapsedLines=15
export function fenceMeta(options: Partial<CodeBlockOptions>): string {
  const parts: string[] = [];
  const lines = normalizeLineRanges(options.highlightLines || "");
  if (lines) parts.push(`{${lines}}`);
  if (options.lineNumbers === true) parts.push("showLineNumbers");
  if (options.lineNumbers === false) parts.push("showLineNumbers=false");
  const start = startLine(options.startLine ?? 1);
  if (start !== 1) parts.push(`startLine=${start}`);
  const view = codeView(options.view);
  if (view) parts.push(`view=${view}`);
  if (options.collapsed === true) parts.push("collapsed");
  if (options.collapsed === false) parts.push("collapsed=false");
  if (options.collapsedLines != null) parts.push(`collapsedLines=${collapsedLines(options.collapsedLines)}`);
  return parts.join(" ");
}
// The language and meta of an info string ("ts {3} showLineNumbers").
export function splitInfo(info: string | null | undefined) {
  const text = String(info || "").trim();
  const space = text.search(/[\s{]/);
  return space < 0 ? { language: text, meta: "" } : { language: text.slice(0, space), meta: text.slice(space).trim() };
}
// <pre> attributes for a code block an importer writes: preview-first
// languages show the preview (#95).
export function importedCodeAttributes(language: string | null | undefined, meta = ""): string {
  const options = parseFenceMeta(meta);
  if (!options.view && previewFirst(language)) options.view = "preview";
  return Object.entries(optionAttributes(options))
    .map(([name, value]) => ` ${name}="${value.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"`)
    .join("");
}
