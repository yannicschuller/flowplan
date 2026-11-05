// HTML → inline Markdown on the server (imports): htmlparser2's tree mapped
// to the small element tree of lib/inline-markdown.ts.
import { parseDocument } from "htmlparser2";
import type { ChildNode } from "domhandler";
import { htmlNodesToInline, type HtmlNode } from "./inline-markdown";

export function domToHtmlNodes(nodes: ChildNode[]): HtmlNode[] {
  const out: HtmlNode[] = [];
  for (const node of nodes) {
    if (node.type === "text") out.push({ type: "text", text: (node as { data: string }).data });
    else if (node.type === "tag" || node.type === "script" || node.type === "style") {
      const el = node as unknown as { name: string; attribs: Record<string, string>; children: ChildNode[] };
      out.push({ type: "element", name: el.name, attrs: el.attribs || {}, children: domToHtmlNodes(el.children || []) });
    }
  }
  return out;
}

// An HTML fragment (a table cell, a pasted snippet) → inline Markdown.
export function htmlToInline(html: string): string {
  return htmlNodesToInline(domToHtmlNodes(parseDocument(html, { decodeEntities: true }).children));
}

// Element children (e.g. a <td> of htmlparser2) → inline Markdown.
export function elementToInline(nodes: ChildNode[]): string {
  return htmlNodesToInline(domToHtmlNodes(nodes));
}
