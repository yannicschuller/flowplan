"use client";
import { renderFootnotes } from "./footnotes";
import { applyTextDirections } from "./text-direction";
import { captionLabel, type CaptionKind } from "./block-captions";
import { tr } from "./locale-tag";

type FinishOptions = { links?: boolean; captionNumbers?: boolean };
// Stored document HTML as people read it outside the editor: the direction
// of right-to-left blocks, numbered footnotes with their list at the end
// and, when the page numbers them, numbered captions.
export function finishDocumentHtml(root: HTMLElement, options: FinishOptions = {}) {
  applyTextDirections(root);
  renderFootnotes(root, options);
  if (options.captionNumbers) numberCaptions(root);
}
// Wide tables scroll sideways in a box of their own, as in the editor
// (Tiptap's .tableWrapper, app/globals.css), instead of pushing the whole
// read-only page wider than the screen (#256). Linked databases on public
// pages (.public-embed) scroll in their own frame. Again on the same DOM
// changes nothing.
export function wrapTables(root: HTMLElement) {
  for (const table of root.querySelectorAll<HTMLTableElement>("table")) {
    if (table.parentElement?.classList.contains("tableWrapper") || table.closest(".public-embed")) continue;
    const wrapper = table.ownerDocument.createElement("div");
    wrapper.className = "tableWrapper";
    table.replaceWith(wrapper);
    wrapper.append(table);
  }
}
// "Abbildung 1:" in front of the captions of images, tables and code
// blocks, counted per kind in document order (lib/block-captions.ts).
export function numberCaptions(root: HTMLElement) {
  const counts: Record<CaptionKind, number> = { figure: 0, table: 0, listing: 0 };
  for (const caption of root.querySelectorAll<HTMLElement>("figure.block-figure > figcaption, table > caption")) {
    if (!caption.textContent?.trim()) continue;
    const kind: CaptionKind =
      caption.tagName === "CAPTION" ? "table" : caption.parentElement?.firstElementChild?.tagName === "PRE" ? "listing" : "figure";
    counts[kind]++;
    if (caption.firstElementChild?.classList.contains("caption-label")) continue;
    const label = document.createElement("span");
    label.className = "caption-label";
    label.textContent = `${captionLabel(kind, counts[kind], tr)}:`;
    caption.prepend(label, " ");
  }
}
// The same for a file of its own (HTML export).
export function exportDocumentHtml(html: string, options: { captionNumbers?: boolean } = {}) {
  const holder = document.createElement("div");
  holder.innerHTML = html;
  finishDocumentHtml(holder, { links: true, ...options });
  return holder.innerHTML;
}
