// Markdown to editor HTML without sanitizing: the conversion the Markdown
// import uses (lib/markdown-import.ts adds sanitizing on the server). Safe
// for the browser – the editor's schema drops what it does not know, and AI
// answers are inserted through it (lib/ai/insert.ts).
import { Marked, type Tokens } from "marked";
import type { CalloutType } from "./document-schema";

const escaped = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

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
export function markdownToRawHtml(
  markdown: string,
  resolve: (href: string, kind: "link" | "image") => string | null = (href) =>
    href,
  // Embedded whiteboards from Flowplan's own export (lib/markdown.ts): the
  // marker, the SVG and the link become the embed again when the board may
  // be embedded here; otherwise the image and link stay as they are.
  options: { whiteboard?: (pageId: string) => boolean } = {},
) {
  // The link parts match in linear time ("\]" and "\)" end them), so a large
  // file cannot hold up the server.
  markdown = markdown.replace(
    /<!-- flowplan:whiteboard ([0-9a-f-]{36}) (\d{2,4}) -->\n(?:!\[(?:\\.|[^\]\\\n])*\]\((?:<[^>\n]*>|[^)\n]*)\)\n\n)?\[(?:\\.|[^\]\\\n])*\]\((?:<[^>\n]*>|[^)\n]*)\)/g,
    (block, pageId: string, height: string) =>
      options.whiteboard?.(pageId) ? `<!-- flowplan:whiteboard ${pageId} ${height} -->` : block.replace(/^<!--[^\n]*-->\n/, ""),
  );
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
        // Only a marker the caller vouched for above becomes an embed.
        const board = /^<!-- flowplan:whiteboard ([0-9a-f-]{36}) (\d{2,4}) -->\s*$/.exec(text);
        if (board && options.whiteboard?.(board[1]))
          return `<div data-whiteboard="${board[1]}" data-whiteboard-height="${Math.min(2000, Math.max(120, Number(board[2])))}"></div>`;
        if (board) return "";
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
  return html;
}
