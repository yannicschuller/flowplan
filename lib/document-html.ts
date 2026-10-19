"use client";
import { renderFootnotes } from "./footnotes";
import { applyTextDirections } from "./text-direction";

// Stored document HTML as people read it outside the editor: the direction
// of right-to-left blocks, numbered footnotes with their list at the end.
export function finishDocumentHtml(root: HTMLElement, options: { links?: boolean } = {}) {
  applyTextDirections(root);
  renderFootnotes(root, options);
}
// The same for a file of its own (HTML export).
export function exportDocumentHtml(html: string) {
  const holder = document.createElement("div");
  holder.innerHTML = html;
  finishDocumentHtml(holder, { links: true });
  return holder.innerHTML;
}
