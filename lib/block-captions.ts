// Captions of images, tables and code blocks (issue #84): a short line of
// plain text below the block, kept as the block's `caption` attribute (so it
// collaborates, copies, moves and undoes with the block). Stored HTML gives
// them their meaning: <figure><img><figcaption> for images,
// <figure><pre><figcaption> for code and <table><caption> for tables.
// With a page's "Number captions" switch they read "Figure 1: …",
// "Table 1: …", "Listing 1: …" – counted per kind in document order, only
// blocks that have a caption. The editor shows them with
// components/block-captions-view.ts.
import type { Node as PMNode } from "@tiptap/pm/model";

export type CaptionKind = "figure" | "table" | "listing";
// The block types with a caption and what they count as.
export const CAPTION_KINDS: Readonly<Record<string, CaptionKind>> = {
  image: "figure",
  table: "table",
  codeBlock: "listing",
};
export const MAX_CAPTION = 500;

// A caption while it is typed: one line, not longer than the limit.
export const captionInput = (value: string) => value.replace(/[\r\n]+/g, " ").slice(0, MAX_CAPTION);
// A caption as it is shown and stored: one line of text, "" for none.
export function captionText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, MAX_CAPTION) : "";
}

type Translate = (de: string, en: string) => string;
// "Abbildung 3" / "Figure 3", in the language `t` speaks.
export function captionLabel(kind: CaptionKind, number: number, t: Translate) {
  const name = kind === "figure" ? t("Abbildung", "Figure") : kind === "table" ? t("Tabelle", "Table") : t("Listing", "Listing");
  return `${name} ${number}`;
}
// The caption with its number in front, when the page numbers them.
export const numberedCaption = (caption: string, label: string | null) => (label ? `${label}: ${caption}` : caption);

// The number of every captioned block, by its position: counted per kind in
// document order (blocks inside tables or columns included).
export function captionNumbers(doc: PMNode): Map<number, { kind: CaptionKind; number: number }> {
  const counts: Record<CaptionKind, number> = { figure: 0, table: 0, listing: 0 };
  const numbers = new Map<number, { kind: CaptionKind; number: number }>();
  doc.descendants((node, pos) => {
    const kind = CAPTION_KINDS[node.type.name];
    if (kind && captionText(node.attrs.caption)) numbers.set(pos, { kind, number: ++counts[kind] });
    return !node.isTextblock;
  });
  return numbers;
}
// A walk through a document in order that hands out the numbers (exports
// that render block by block): `next(node)` gives the label of a captioned
// block, null for others or when the page does not number captions.
export function captionCounter(numbered: boolean, t: Translate) {
  const counts: Record<CaptionKind, number> = { figure: 0, table: 0, listing: 0 };
  return (node: PMNode) => {
    const kind = CAPTION_KINDS[node.type.name];
    if (!kind || !captionText(node.attrs.caption)) return null;
    counts[kind]++;
    return numbered ? captionLabel(kind, counts[kind], t) : null;
  };
}

// Reading captions from HTML (pasted, imported, stored): the figure around
// an image, code block or table counts when it holds only that one block;
// an image may sit in a link or <picture> inside it (as Notion writes it).
type Element = {
  tagName: string;
  parentElement: Element | null;
  children: ArrayLike<Element>;
  textContent: string | null;
  querySelectorAll: (selectors: string) => ArrayLike<unknown>;
};
const tagOf = (el: Element | null | undefined) => (el?.tagName || "").toUpperCase();
const childNamed = (el: Element, name: string) => Array.from(el.children).find((child) => tagOf(child) === name) || null;
function soleFigure(figure: Element | null) {
  return figure && tagOf(figure) === "FIGURE" && figure.querySelectorAll("img, pre, table").length === 1 ? figure : null;
}
function figureAround(el: Element) {
  const parent = el.parentElement;
  if (tagOf(parent) === "FIGURE") return soleFigure(parent);
  if (tagOf(el) === "IMG" && ["A", "PICTURE"].includes(tagOf(parent))) return soleFigure(parent!.parentElement);
  return null;
}
// The caption of an <img>, <pre> or <table>; null without one.
export function captionFromElement(el: Element): string | null {
  if (tagOf(el) === "TABLE") {
    const caption = childNamed(el, "CAPTION");
    if (caption) return captionText(caption.textContent) || null;
  }
  const figure = figureAround(el);
  const caption = figure && childNamed(figure, "FIGCAPTION");
  return caption ? captionText(caption.textContent) || null : null;
}
// A <figcaption> that belongs to such a block: read with it, not as text.
export const blockFigcaption = (el: Element) => !!soleFigure(el.parentElement);

// The attribute as image, table and code block declare it.
export const captionAttribute = () => ({
  default: null as string | null,
  keepOnSplit: false,
  rendered: false,
  parseHTML: (el: HTMLElement) => captionFromElement(el as unknown as Element),
});

// Markdown files carry the page's numbering in their frontmatter
// (flowplan: captions: numbered), read back by the imports.
export function numberedInFrontmatter(data: Record<string, unknown>) {
  const flowplan = data.flowplan;
  return !!flowplan && typeof flowplan === "object" && !Array.isArray(flowplan) && (flowplan as Record<string, unknown>).captions === "numbered";
}
