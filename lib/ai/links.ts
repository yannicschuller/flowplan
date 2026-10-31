// Automatic page links of the writing assistant: the parts the server and
// the browser share (no server imports).
//
// The server finds a few existing pages that fit the text being written
// (lib/ai/link-candidates.ts – every one passed aiFilter) and lists them in
// the prompt under handles: P1, P2, … with title and a short excerpt, never
// with an id or address. The model links a page by its handle only:
//   [[P3]]                    the page's title as the link text
//   [[P3|words]]              its own words
//   [words](flowplan:P3)      a Markdown link with the handle as address
// The handles and their pages reach the browser in a response header
// (X-Flowplan-Links), and the browser turns each known handle into the link
// the editor makes for a page itself ("[[" in the editor): a link mark with
// href "/#page=<id>" – so the link shows in backlinks, follows renames
// (lib/link-titles.ts) and survives the Markdown export like any other.
// Unknown handles stay plain text; a page address the model writes itself
// (an id or URL with "#page=") is never linked – it could name any page.

export type LinkTarget = { handle: string; pageId: string; title: string };
// What the prompt shows of a page: no id.
export type PromptLink = { handle: string; title: string; excerpt: string };

export const LINKS_HEADER = "X-Flowplan-Links";
// The person's choice in the writing assistant ("Mit bestehenden Seiten
// verlinken"), remembered in this browser.
export const LINKS_STORAGE_KEY = "flowplan.ai.links";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HANDLE = /^P[1-9]\d?$/;
export const linkHandle = (n: number) => `P${n}`;
const pageHref = (pageId: string) => `/#page=${pageId}`;

// The header's targets (base64 of UTF-8 JSON), checked: a handle, a page id
// and a title each. Anything else is dropped.
export function decodeLinkTargets(header: string | null | undefined): LinkTarget[] {
  if (!header) return [];
  try {
    const bytes = Uint8Array.from(atob(header), (c) => c.charCodeAt(0));
    const list = JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(list)) return [];
    return list
      .filter((t) => t && typeof t.handle === "string" && HANDLE.test(t.handle) && typeof t.pageId === "string" && UUID.test(t.pageId) && typeof t.title === "string")
      .map((t) => ({ handle: t.handle, pageId: t.pageId, title: t.title }));
  } catch {
    return [];
  }
}

const find = (targets: readonly LinkTarget[], handle: string) => targets.find((t) => t.handle.toUpperCase() === handle.toUpperCase());
// Link text in Markdown: the title's punctuation stays literal.
const markdownText = (text: string) => text.replace(/\s+/g, " ").trim().replace(/[\\`*_[\]<>~|!#]/g, "\\$&");

const WIKI = /\[\[\s*(P\d{1,2})\s*(?:\|([^\]\n]{1,200}))?\]\]/gi;
const ADDRESS = /^\s*flowplan:\/{0,2}(P\d{1,2})\/?\s*$/i;
const MARKDOWN = /\]\(\s*flowplan:\/{0,2}(P\d{1,2})\/?\s*\)/gi;

// [[P3]] and [[P3|words]] as Markdown links with the handle as address;
// unknown handles: their words, or nothing.
export function expandLinkHandles(markdown: string, targets: readonly LinkTarget[]): string {
  return markdown.replace(WIKI, (_all, handle: string, words?: string) => {
    const target = find(targets, handle);
    const text = words?.trim() ? markdownText(words) : target ? markdownText(target.title || "") : "";
    return target && text ? `[${text}](flowplan:${target.handle})` : text;
  });
}

// The address of a link the model wrote, when linking pages:
//   string    – the page link for a known handle,
//   null      – no link (an unknown handle, or a page address of its own),
//   undefined – not a page link; the usual rules apply.
export function pageLinkHref(href: string, targets: readonly LinkTarget[]): string | null | undefined {
  const handle = ADDRESS.exec(href);
  if (handle) {
    const target = find(targets, handle[1]);
    return target ? pageHref(target.pageId) : null;
  }
  if (/^\s*flowplan:/i.test(href) || /#page=/i.test(href)) return null;
  return undefined;
}

// The pages the answer links, in the order of their first link.
export function linkedTargets(markdown: string, targets: readonly LinkTarget[]): LinkTarget[] {
  const found: LinkTarget[] = [];
  const handles: { at: number; handle: string }[] = [];
  for (const m of markdown.matchAll(WIKI)) handles.push({ at: m.index!, handle: m[1] });
  for (const m of markdown.matchAll(MARKDOWN)) handles.push({ at: m.index!, handle: m[1] });
  handles.sort((a, b) => a.at - b.at);
  for (const { handle } of handles) {
    const target = find(targets, handle);
    if (target && !found.includes(target)) found.push(target);
  }
  return found;
}
