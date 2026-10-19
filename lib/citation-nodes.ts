// Citations in documents: an inline "(Müller 2021)" that carries its work
// as CSL-JSON (so copies, exports and shared pages need nothing else), and a
// "Literaturverzeichnis" block that lists every cited work of the document.
// The block stores only its title; its list is drawn from the citations
// (editor: components/citation-views.ts, read-only pages:
// components/read-only-document.tsx, Markdown: lib/markdown.ts).
import { Node } from "@tiptap/core";
import { citationKey, inlineCitation, parseItemAttribute } from "./citations";
import { tr } from "./locale-tag";

const itemAttribute = (value: unknown) => {
  const item = parseItemAttribute(value);
  return item ? JSON.stringify(item) : "";
};
export const Citation = Node.create({
  name: "citation",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { key: { default: "" }, item: { default: "" }, locator: { default: "" } };
  },
  parseHTML: () => [
    {
      tag: "span[data-citation]",
      getAttrs: (element) => {
        const el = element as HTMLElement;
        const item = itemAttribute(el.getAttribute("data-citation-item"));
        const key = citationKey(el.getAttribute("data-citation"));
        if (!key && !item) return false;
        return { key, item, locator: (el.getAttribute("data-citation-locator") || "").slice(0, 100) };
      },
    },
  ],
  renderHTML: ({ node }) => {
    const item = parseItemAttribute(node.attrs.item);
    return [
      "span",
      {
        class: "citation",
        "data-citation": citationKey(node.attrs.key),
        "data-citation-item": item ? JSON.stringify(item) : "",
        "data-citation-locator": String(node.attrs.locator || "").slice(0, 100),
      },
      inlineCitation(item, node.attrs.locator, tr),
    ];
  },
  renderText: ({ node }) => inlineCitation(parseItemAttribute(node.attrs.item), node.attrs.locator, tr),
});
export const Bibliography = Node.create({
  name: "bibliography",
  group: "block",
  atom: true,
  addAttributes() {
    return { title: { default: "Literaturverzeichnis" } };
  },
  parseHTML: () => [
    {
      tag: "div[data-bibliography]",
      getAttrs: (element) => ({
        title: ((element as HTMLElement).getAttribute("data-bibliography-title") || "Literaturverzeichnis").slice(0, 200),
      }),
    },
  ],
  renderHTML: ({ node }) => [
    "div",
    { class: "bibliography", "data-bibliography": "true", "data-bibliography-title": node.attrs.title },
    ["p", { class: "bibliography-title" }, node.attrs.title || "Literaturverzeichnis"],
  ],
});
