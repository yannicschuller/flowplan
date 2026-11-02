import { parseDocument, DomUtils } from "htmlparser2";
import type { ChildNode, Element } from "domhandler";
import { cleanHtml } from "./document-server";
import { markdownToRawHtml } from "./markdown-html";

export type { MarkdownImportOptions } from "./markdown-html";

// GitHub-flavoured Markdown to sanitized editor HTML (lib/markdown-html.ts
// does the conversion). `resolve` maps link and image targets (e.g. files
// inside an export) and may drop them by returning null.
export function markdownToHtml(...args: Parameters<typeof markdownToRawHtml>) {
  return cleanHtml(blockMarkers(markdownToRawHtml(...args)));
}

// Block ids from markers (#88), as Obsidian writes them and Flowplan's
// export does (lib/markdown.ts): " ^id" at the end of a paragraph, heading
// or list item, or a line "^id" of its own right after any other block
// (table, code, quote, list …). The marker goes; the block keeps the id.
const TRAILING = /\s\^([A-Za-z0-9-]{1,64})\s*$/;
const ALONE = /^\s*\^([A-Za-z0-9-]{1,64})\s*$/;
const isTag = (node: ChildNode | null | undefined): node is Element => !!node && node.type === "tag";
// The plain text an element's own content ends with (nested lists and
// blocks skipped); null when it ends with formatting, code or a link.
function lastText(el: Element): (ChildNode & { data: string }) | null {
  for (let i = el.children.length - 1; i >= 0; i--) {
    const child = el.children[i];
    if (child.type === "text") {
      if ((child as unknown as { data: string }).data.trim()) return child as ChildNode & { data: string };
      continue;
    }
    if (isTag(child) && ["ul", "ol", "pre", "table", "blockquote", "div", "details", "aside"].includes(child.name)) continue;
    return null;
  }
  return null;
}
function takeTrailing(el: Element) {
  const text = lastText(el);
  const match = text && TRAILING.exec(text.data);
  if (!text || !match) return null;
  text.data = text.data.slice(0, match.index);
  return match[1];
}
export function blockMarkers(html: string) {
  if (!html.includes("^")) return html;
  const doc = parseDocument(html, { decodeEntities: true });
  const handled = new Set<Element>();
  // List items: the marker at the end of the item's own line.
  for (const li of DomUtils.findAll((el) => el.name === "li", doc.children)) {
    const head = li.children.find((c) => isTag(c) || (c.type === "text" && (c as unknown as { data: string }).data.trim()));
    const own = isTag(head) && head.name === "p" ? head : li;
    if (own !== li) handled.add(own);
    const id = takeTrailing(own);
    if (id && !li.attribs["data-block-id"]) li.attribs["data-block-id"] = id;
  }
  for (const el of DomUtils.findAll((el) => /^(p|h[1-6])$/.test(el.name), doc.children)) {
    if (handled.has(el)) continue;
    const alone = el.name === "p" && el.children.every((c) => c.type === "text") ? ALONE.exec(DomUtils.textContent(el)) : null;
    if (alone) {
      // A marker line of its own names the block before it.
      let previous = el.prev;
      while (previous && !isTag(previous)) previous = previous.prev;
      if (isTag(previous)) {
        const target = previous.name === "figure" ? previous.children.find((c): c is Element => isTag(c) && (c.name === "img" || c.name === "pre")) || previous : previous;
        if (!target.attribs["data-block-id"]) target.attribs["data-block-id"] = alone[1];
        DomUtils.removeElement(el);
        continue;
      }
    }
    const id = takeTrailing(el);
    if (id && !el.attribs["data-block-id"]) el.attribs["data-block-id"] = id;
  }
  return DomUtils.getOuterHTML(doc.children, { encodeEntities: "utf8" });
}
