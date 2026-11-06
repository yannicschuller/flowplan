// Page titles in an AI answer that stayed plain text (#134): the writing
// assistant offers the model only a few pages by handle (lib/ai/links.ts),
// so in a long list ("all pages about Docker Compose") most items arrive as
// plain titles. After the answer is complete, the browser collects the list
// items that look like a title, the server resolves them against the titles
// of pages the person (and the AI) may read – exact after normalising, and
// only when exactly one page matches (lib/ai/link-candidates.ts
// resolveLinkTitles) – and the items become the same handle links as the
// model's own. Shared by server and browser (no server imports).
import { linkHandle, type LinkTarget } from "./links";

// At most this many titles are sent to be resolved, each this long.
export const TITLE_LINK_LIMITS = { titles: 200, titleChars: 200 } as const;

// Pictographs, their modifiers and joiners: "🐳 Docker" is "Docker".
const PICTOGRAPHS = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\u{FE0E}\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu;
// A title as compared: Unicode-normalised, without emoji, lower case,
// dashes and underscores as spaces, whitespace collapsed, no quotes or
// punctuation around it.
export function normalizeTitle(title: string) {
  return title
    .normalize("NFKC")
    .replace(PICTOGRAPHS, " ")
    .toLowerCase()
    .replace(/[_‐-―-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s"'„“”‚‘’«»`*:.,;!?()[\]{}]+|[\s"'„“”‚‘’«»`*:.,;!?()[\]{}]+$/g, "")
    .trim();
}
// The same without any spaces: "Pocket ID" and "PocketID".
export const compactTitle = (title: string) => normalizeTitle(title).replace(/\s+/g, "");

const ITEM = /^(\s*(?:[-*+]|\d{1,3}[.)])\s+(?:\[[ xX]\]\s+)?)(.*\S)\s*$/;
// Where a title ends inside a list item: "Title – what it is", "Title: …".
const SEPARATOR = /\s+[–—-]\s+|:\s+|\s+\(/;

type Part = { text: string; start: number; end: number; bold: boolean };
// The part of a list item that may be a page title: the whole item, or a
// bold start ("**Title** – …"), or what comes before a separator.
function titleParts(item: string): Part[] {
  const parts: Part[] = [];
  const bold = /^(\*\*|__)(.+?)\1/.exec(item);
  if (bold) parts.push({ text: bold[2], start: 0, end: bold[0].length, bold: true });
  else {
    parts.push({ text: item.replace(/[.;,]$/, ""), start: 0, end: item.replace(/[.;,]$/, "").length, bold: false });
    const separator = SEPARATOR.exec(item);
    if (separator && separator.index > 0) parts.push({ text: item.slice(0, separator.index), start: 0, end: separator.index, bold: false });
  }
  return parts.filter((p) => p.text.trim() && p.text.length <= TITLE_LINK_LIMITS.titleChars);
}
// List items that already link something, or show code, stay as they are.
const linked = (item: string) => /\]\(|\[\[|<https?:|`/.test(item);

// The texts to resolve: the title parts of list items without links.
export function listTitleCandidates(markdown: string): string[] {
  const found: string[] = [];
  let fence = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) continue;
    const item = ITEM.exec(line);
    if (!item || linked(item[2])) continue;
    for (const part of titleParts(item[2])) if (!found.includes(part.text)) found.push(part.text);
    if (found.length >= TITLE_LINK_LIMITS.titles) break;
  }
  return found.slice(0, TITLE_LINK_LIMITS.titles);
}

// What the server answers: for a text sent, the one page it names.
export type ResolvedTitle = { text: string; pageId: string; title: string };

// The answer with resolved list items as handle links, and the targets
// (the offered ones plus the resolved pages under new handles).
export function applyTitleLinks(markdown: string, resolved: readonly ResolvedTitle[], targets: readonly LinkTarget[]) {
  const next = [...targets];
  if (!resolved.length) return { markdown, targets: next };
  const byText = new Map(resolved.map((r) => [r.text, r]));
  const handleFor = (page: ResolvedTitle) => {
    const known = next.find((t) => t.pageId === page.pageId);
    if (known) return known.handle;
    const numbers = next.map((t) => Number(t.handle.slice(1)) || 0);
    const handle = linkHandle(Math.max(0, ...numbers) + 1);
    next.push({ handle, pageId: page.pageId, title: page.title });
    return handle;
  };
  let fence = false;
  const lines = markdown.split("\n").map((line) => {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) return line;
    const item = ITEM.exec(line);
    if (!item || linked(item[2])) return line;
    for (const part of titleParts(item[2])) {
      const page = byText.get(part.text);
      if (!page) continue;
      const words = part.text.replace(/[[\]]/g, "\\$&");
      const link = `[${words}](flowplan:${handleFor(page)})`;
      const replaced = part.bold ? `**${link}**` : link;
      return item[1] + replaced + item[2].slice(part.end);
    }
    return line;
  });
  return { markdown: lines.join("\n"), targets: next };
}
