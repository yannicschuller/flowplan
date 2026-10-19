import { cleanHtml } from "./document-server";
import { markdownToRawHtml } from "./markdown-html";

export type { MarkdownImportOptions } from "./markdown-html";

// GitHub-flavoured Markdown to sanitized editor HTML (lib/markdown-html.ts
// does the conversion). `resolve` maps link and image targets (e.g. files
// inside an export) and may drop them by returning null.
export function markdownToHtml(...args: Parameters<typeof markdownToRawHtml>) {
  return cleanHtml(markdownToRawHtml(...args));
}
