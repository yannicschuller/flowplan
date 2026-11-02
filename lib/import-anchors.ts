// Links to a block or heading of another document in imports (#88): the
// sources name the target with an anchor – a block id (AFFiNE, Notion,
// Obsidian "^id", Flowplan's own markers) or a heading ("#Heading",
// "#my-heading", Confluence's "#PageTitle-Heading"). The importers keep
// the source's ids on the blocks (data-block-id) and write links with the
// anchor; once every document is converted, these helpers give the blocks
// their Flowplan ids and turn the anchors into block links
// (/#page=…&block=…). An anchor nothing matches leads to the page.
import { parseDocument, DomUtils } from "htmlparser2";
import type { Element } from "domhandler";
import { newBlockId, validBlockId } from "./block-ids";

// Letters and digits only, lower case: "My Heading!", "my-heading" and
// "My_Heading" are the same heading.
const norm = (text: string) => text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const idKeys = (id: string) => [...new Set([`id:${id}`, `id:${id.replace(/-/g, "").toLowerCase()}`])];

// The keys an anchor may be found under, most specific first.
export function anchorKeys(raw: string): string[] {
  let anchor = raw.replace(/^#/, "");
  try {
    anchor = decodeURIComponent(anchor);
  } catch {}
  anchor = anchor.trim();
  if (!anchor) return [];
  if (anchor.startsWith("^")) return idKeys(anchor.slice(1));
  // Notion and AFFiNE give block ids in parameters (…?blockIds=x, #x).
  return [...idKeys(anchor), `h:${norm(anchor)}`].filter((key) => key !== "h:");
}

export type DocumentAnchors = { html: string; anchors: Map<string, string> };
const HEADING = /^h[1-6]$/;
// Gives the blocks of a converted document their ids – new ones when
// `fresh` (ids of other tools), else the source's own (valid) ones – and
// every heading one, and lists the anchors that lead to them.
export function documentAnchors(html: string, title = "", fresh = true): DocumentAnchors {
  const anchors = new Map<string, string>();
  if (!html || (!html.includes("data-block-id") && !/<h[1-6]/i.test(html))) return { html, anchors };
  const doc = parseDocument(html, { decodeEntities: true });
  const taken = new Set<string>();
  const add = (key: string, id: string) => {
    if (!anchors.has(key)) anchors.set(key, id);
  };
  const elements = DomUtils.findAll((el: Element) => !!el.attribs["data-block-id"] || HEADING.test(el.name), doc.children);
  for (const el of elements) {
    const source = el.attribs["data-block-id"] || "";
    let id = !fresh ? validBlockId(source) : null;
    if (id && taken.has(id)) id = null;
    if (!id) {
      id = newBlockId();
      while (taken.has(id)) id = newBlockId();
    }
    taken.add(id);
    el.attribs["data-block-id"] = id;
    if (source) for (const key of idKeys(source)) add(key, id);
    for (const key of idKeys(id)) add(key, id);
    if (HEADING.test(el.name)) {
      const text = DomUtils.textContent(el).trim();
      if (text) {
        add(`h:${norm(text)}`, id);
        if (title) add(`h:${norm(title + text)}`, id);
      }
    }
  }
  return { html: DomUtils.getOuterHTML(doc.children, { encodeEntities: "utf8" }), anchors };
}

export function findAnchor(anchors: Map<string, string> | undefined, raw: string) {
  if (!anchors) return null;
  for (const key of anchorKeys(raw)) {
    const id = anchors.get(key);
    if (id) return id;
  }
  return null;
}

// Links written while converting, before the targets were known:
// /#page=<id>&anchor=<anchor> (zip import). Each becomes a block link, or
// the page link when the anchor names nothing there.
const PENDING = /(href=")(\/#page=[0-9a-f-]{36}(?:&amp;row=[0-9a-f-]{36})?)&amp;anchor=([^"]*)"/g;
export const pendingAnchor = (pageHref: string, anchor: string) => `${pageHref}&anchor=${encodeURIComponent(anchor)}`;
export function resolvePendingAnchors(html: string, lookup: (pageId: string, anchor: string) => string | null) {
  if (!html.includes("anchor=")) return html;
  return html.replace(PENDING, (_all, attr: string, page: string, anchor: string) => {
    const pageId = /#page=([0-9a-f-]{36})/.exec(page)![1];
    let decoded = anchor.replaceAll("&amp;", "&");
    try {
      decoded = decodeURIComponent(decoded);
    } catch {}
    const blockId = lookup(pageId, decoded);
    return `${attr}${page}${blockId ? `&amp;block=${blockId}` : ""}"`;
  });
}
