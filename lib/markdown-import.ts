import { Marked, type Tokens } from "marked";
import { cleanHtml, escaped } from "./document-server";
import type { CalloutType } from "./document-schema";

// GitHub alerts (> [!WARNING]) and Obsidian callouts (> [!danger] Title)
// become callouts; Obsidian's further kinds map to the nearest of the five.
const ALERTS: Record<string, CalloutType> = {
  note: "note", info: "note", todo: "note", abstract: "note", summary: "note", tldr: "note",
  question: "note", help: "note", faq: "note", example: "note", quote: "note", cite: "note",
  tip: "tip", hint: "tip", success: "tip", check: "tip", done: "tip",
  important: "important",
  warning: "warning", attention: "warning",
  caution: "caution", danger: "caution", error: "caution", bug: "caution", failure: "caution", fail: "caution", missing: "caution",
};
function alert(body: string) {
  const match = /^<p>\[!([A-Za-z]+)\][+-]?[ \t]*([^\n<]*)(?:\n|<br>)?/.exec(body);
  if (!match) return null;
  const type = ALERTS[match[1].toLowerCase()] ?? "note";
  const title = match[2].trim();
  const rest = ("<p>" + body.slice(match[0].length)).replace(/^<p>\s*<\/p>\s*/, "");
  return `<aside data-callout="${type}">${title ? `<p><strong>${title}</strong></p>` : ""}${rest || "<p></p>"}</aside>`;
}

// GitHub-flavoured Markdown to editor HTML. `resolve` maps link and image
// targets (e.g. files inside an export) and may drop them by returning null.
export function markdownToHtml(
  markdown: string,
  resolve: (href: string, kind: "link" | "image") => string | null = (href) =>
    href,
) {
  const marked = new Marked({ gfm: true, breaks: false, async: false });
  marked.use({
    renderer: {
      link({ href, tokens }: Tokens.Link) {
        const text = this.parser.parseInline(tokens);
        const target = resolve(href, "link");
        return target ? `<a href="${escaped(target)}">${text}</a>` : text;
      },
      image({ href, text }: Tokens.Image) {
        const target = resolve(href, "image");
        return target
          ? `<img src="${escaped(target)}" alt="${escaped(text)}">`
          : escaped(text);
      },
      blockquote({ tokens }: Tokens.Blockquote) {
        const body = this.parser.parse(tokens);
        return alert(body) ?? `<blockquote>${body}</blockquote>`;
      },
      // Raw HTML in Markdown is shown as text, never interpreted.
      html({ text }: Tokens.HTML | Tokens.Tag) {
        return escaped(text);
      },
    },
  });
  const html = (marked.parse(markdown) as string)
    // Task list items become editor task items.
    .replace(
      /<ul>\s*((?:<li><input[^>]*type="checkbox"[^>]*>[\s\S]*?<\/li>\s*)+)<\/ul>/g,
      (_, items: string) =>
        `<ul data-type="taskList">${items.replace(
          /<li><input([^>]*)>\s*([\s\S]*?)<\/li>/g,
          (_m: string, attrs: string, body: string) =>
            `<li data-type="taskItem" data-checked="${/checked/.test(attrs)}"><p>${body.replace(/^<p>|<\/p>$/g, "")}</p></li>`,
        )}</ul>`,
    );
  return cleanHtml(html);
}
