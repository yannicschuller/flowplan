// Markdown to editor HTML without sanitizing: the conversion the Markdown
// import uses (lib/markdown-import.ts adds sanitizing on the server). Safe
// for the browser – the editor's schema drops what it does not know, and AI
// answers are inserted through it (lib/ai/insert.ts).
import { Marked, type Tokens, type TokenizerAndRendererExtension } from "marked";
import type { CalloutType } from "./document-schema";
import { footnoteText } from "./footnotes";

const escaped = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
// A block of the source view kept aside (lib/markdown.ts writes it).
export const BLOCK_MARKER = /^<!-- flowplan:block (\d{1,5})(?: [^\n]*?)? -->\s*$/;

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

const decode = (text: string) =>
  text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
// A note's Markdown as plain text; links keep their address in brackets.
function plainNote(markdown: string) {
  const html = new Marked({ gfm: true, async: false }).parseInline(markdown) as string;
  const text = html
    .replace(/<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g, (_, href: string, label: string) => {
      const target = decode(href),
        shown = decode(label.replace(/<[^>]*>/g, ""));
      return shown === target || !shown ? target : `${shown} (${target})`;
    })
    .replace(/<[^>]*>/g, "");
  return footnoteText(decode(text));
}
// Footnote definitions ("[^1]: Text", continued by indented lines) are taken
// out of the text; code blocks stay untouched.
function footnoteDefinitions(markdown: string) {
  const notes = new Map<string, string>();
  const out: string[] = [];
  let fence: string | null = null,
    current: string | null = null;
  for (const line of markdown.split("\n")) {
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      out.push(line);
      if (opening && opening[1][0] === fence[0] && opening[1].length >= fence.length && /^ {0,3}[`~]+\s*$/.test(line)) fence = null;
      continue;
    }
    if (opening) {
      fence = opening[1];
      current = null;
      out.push(line);
      continue;
    }
    const definition = /^ {0,3}\[\^([^\]\s]{1,64})\]:[ \t]?(.*)$/.exec(line);
    if (definition) {
      current = notes.has(definition[1]) ? null : definition[1];
      if (current !== null) notes.set(current, definition[2]);
      continue;
    }
    if (current !== null && /^(?: {2,}|\t)\S/.test(line)) {
      notes.set(current, `${notes.get(current)} ${line.trim()}`);
      continue;
    }
    current = null;
    out.push(line);
  }
  return {
    markdown: out.join("\n"),
    notes: new Map([...notes].map(([label, text]) => [label, plainNote(text)])),
  };
}
const footnote = (note: string) => `<sup data-footnote="${escaped(footnoteText(note))}"></sup>`;

export type MarkdownImportOptions = {
  // Embedded whiteboards from Flowplan's own export (lib/markdown.ts): the
  // marker, the SVG and the link become the embed again when the board may
  // be embedded here; otherwise the image and link stay as they are.
  whiteboard?: (pageId: string) => boolean;
  // Source view (lib/markdown.ts markdownSource): the blocks kept aside,
  // by the number in their marker, and inline HTML read as such.
  blocks?: (index: number) => string | null;
  source?: boolean;
};

// GitHub-flavoured Markdown to editor HTML. `resolve` maps link and image
// targets (e.g. files inside an export) and may drop them by returning null.
export function markdownToRawHtml(
  markdown: string,
  resolve: (href: string, kind: "link" | "image") => string | null = (href) =>
    href,
  options: MarkdownImportOptions = {},
) {
  // The link parts match in linear time ("\]" and "\)" end them), so a large
  // file cannot hold up the server.
  markdown = markdown.replace(
    /<!-- flowplan:whiteboard ([0-9a-f-]{36}) (\d{2,4}) -->\n(?:!\[(?:\\.|[^\]\\\n])*\]\((?:<[^>\n]*>|[^)\n]*)\)\n\n)?\[(?:\\.|[^\]\\\n])*\]\((?:<[^>\n]*>|[^)\n]*)\)/g,
    (block, pageId: string, height: string) =>
      options.whiteboard?.(pageId) ? `<!-- flowplan:whiteboard ${pageId} ${height} -->` : block.replace(/^<!--[^\n]*-->\n/, ""),
  );
  const { markdown: body, notes } = footnoteDefinitions(markdown);
  const footnoteRef: TokenizerAndRendererExtension = {
    name: "footnoteRef",
    level: "inline",
    start(src: string) {
      const index = src.search(/\[\^|\^\[/);
      return index < 0 ? undefined : index;
    },
    tokenizer(src: string) {
      const reference = /^\[\^([^\]\s]{1,64})\]/.exec(src);
      if (reference && notes.has(reference[1]))
        return { type: "footnoteRef", raw: reference[0], note: notes.get(reference[1]) };
      // Obsidian's inline notes: ^[Text]
      const inline = /^\^\[((?:\\.|\[[^\]\n]*\]|[^\]\\\n]){1,2000})\]/.exec(src);
      if (inline) return { type: "footnoteRef", raw: inline[0], note: plainNote(inline[1]) };
      return undefined;
    },
    renderer: (token) => footnote(String(token.note || "")),
  };
  const marked = new Marked({ gfm: true, breaks: false, async: false });
  marked.use({
    extensions: [footnoteRef],
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
      // ~~strike~~ as the editor stores it (<del> does not pass the cleaning).
      del({ tokens }: Tokens.Del) {
        return `<s>${this.parser.parseInline(tokens)}</s>`;
      },
      // Formulas and diagrams from math and mermaid fences.
      code({ text, lang }: Tokens.Code) {
        const language = (lang || "").trim().split(/\s+/)[0].toLowerCase();
        if (language === "math") return `<div data-math="${escaped(text)}">${escaped(text)}</div>`;
        if (language === "mermaid") return `<div class="mermaid-block" data-mermaid="${escaped(text)}">${escaped(text)}</div>`;
        return false;
      },
      // Raw HTML in Markdown is shown as text, never interpreted – except
      // the few tags Flowplan's own export writes.
      html({ text }: Tokens.HTML | Tokens.Tag) {
        // Only a marker the caller vouched for above becomes an embed.
        const board = /^<!-- flowplan:whiteboard ([0-9a-f-]{36}) (\d{2,4}) -->\s*$/.exec(text);
        if (board && options.whiteboard?.(board[1]))
          return `<div data-whiteboard="${board[1]}" data-whiteboard-height="${Math.min(2000, Math.max(120, Number(board[2])))}"></div>`;
        if (board) return "";
        const kept = BLOCK_MARKER.exec(text);
        if (kept && options.blocks) return options.blocks(Number(kept[1])) ?? "";
        // Toggles: <details><summary>Title</summary> … </details>
        const details = /^<details>\s*<summary>([\s\S]*?)<\/summary>\s*$/i.exec(text);
        if (details) return `<details><summary>${escaped(decode(details[1].replace(/<[^>]*>/g, "")))}</summary><div>`;
        if (/^<\/details>\s*$/i.test(text)) return "</div></details>";
        if (/^<\/?(?:u|mark|sup|sub)>$|^<br\s*\/?>$/i.test(text)) return text;
        // In the source view inline formatting comes as HTML; what is kept
        // is decided by the cleaning below and the editor's schema.
        if (options.source && /^<\/?(?:u|mark|sup|sub|s|span)\b[^<>]*>$|^<br\s*\/?>$/i.test(text)) return text;
        return escaped(text);
      },
    },
  });
  const html = (marked.parse(body) as string)
    // Inline formulas: $`a^2`$
    .replace(/\$<code>([^<]*)<\/code>\$/g, (_, expression: string) => `<span data-math="${expression}">${expression}</span>`)
    // Task list items become editor task items; "📅 2026-05-04" (Obsidian
    // Tasks) at the end of the text becomes the due date.
    .replace(
      /<ul>\s*((?:<li><input[^>]*type="checkbox"[^>]*>[\s\S]*?<\/li>\s*)+)<\/ul>/g,
      (_, items: string) =>
        `<ul data-type="taskList">${items.replace(
          /<li><input([^>]*)>\s*([\s\S]*?)<\/li>/g,
          (_m: string, attrs: string, body: string) => {
            let due = "";
            body = body.replace(/\s*📅\s*(\d{4}-\d{2}-\d{2})(?=\s*(?:<\/p>|<ul|<ol|$))/, (_d: string, date: string) => {
              due = ` data-due="${date}"`;
              return "";
            });
            return `<li data-type="taskItem" data-checked="${/checked/.test(attrs)}"${due}><p>${body.replace(/^<p>|<\/p>$/g, "")}</p></li>`;
          },
        )}</ul>`,
    );
  return html;
}
