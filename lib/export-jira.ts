// A page (or one record) as Jira wiki markup (#221), to paste into an issue
// description or a comment of Jira Server / Data Center (and Jira Cloud's
// "wiki markup" fields). Walks the ProseMirror tree of the sanitised HTML
// (lib/export-content.ts) like the other document exports: headings h1.–h6.,
// *bold*, _italic_, -strike-, +underline+, {{monospace}}, {code:language},
// {noformat}, {quote}, lists with * and # nesting, tasks as [ ] / [x] text,
// tables ||head|| / |cell|, links [text|url], pictures !url!, callouts as
// {info} {tip} {note} {warning}, toggles and meetings as {panel}, ----.
// Text is escaped so that it shows as typed. Links and pictures keep
// absolute addresses of this instance (Jira cannot reach the files).
import type { Node } from "@tiptap/pm/model";
import { audit } from "./db";
import { calloutType, type CalloutType } from "./document-schema";
import { taskStatusOf, type TaskStatus } from "./task-status";
import { citedWorks, formatReference, inlineCitation, parseItemAttribute } from "./citations";
import { ct } from "./content-locale";
import { footnoteText } from "./footnotes";
import { captionCounter, captionText } from "./block-captions";
import { citeScope } from "./meeting-core";
import { formatTimestamp } from "./transcript";
import { exportName } from "./export-name";
import { collectExportContent, documentNode, withExportLookups, type ExportContent, type ExportPage } from "./export-content";
import { exportUrl } from "./export-docx";
import type { Identity } from "./types";

export type TextExportContext = {
  // The address a link keeps (absolute), null to keep only its text.
  url: (raw: string) => string | null;
  // The absolute address of a picture, null when it is not available.
  image: (raw: string) => string | null;
  // An embedded whiteboard or a linked database: title and link.
  whiteboard?: (pageId: string) => { title: string; url: string } | null;
  linked?: (source: string) => { title: string; url: string } | null;
  // A drawing block (or notebook sheet): its typed and recognised text.
  ink?: (attrs: Record<string, unknown>) => { text: string } | null;
  captionNumbers?: boolean;
};

// Code block languages under the names Jira's and Confluence's code macro
// know; anything else goes as it is (both fall back to plain text).
const LANGUAGE_ALIASES: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  rb: "ruby",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  shellscript: "bash",
  console: "bash",
  ps1: "powershell",
  yml: "yaml",
  cs: "csharp",
  "c#": "csharp",
  "c++": "cpp",
  kt: "kotlin",
  md: "markdown",
  htm: "html",
  golang: "go",
  rs: "rust",
  dockerfile: "docker",
};
// The language for a code macro, null for none (plain text, empty).
export function codeLanguage(value: unknown): string | null {
  const id = String(value || "").trim().toLowerCase();
  if (!id || id === "plaintext" || id === "text" || id === "plain" || id === "txt") return null;
  const name = LANGUAGE_ALIASES[id] || id;
  return /^[a-z0-9#+_-]{1,30}$/.test(name) ? name : null;
}

// The callout boxes of both: blue note and purple important as info,
// green tip as tip, amber warning as note (yellow), red caution as warning.
export const CALLOUT_MACROS: Record<CalloutType, "info" | "tip" | "note" | "warning"> = {
  note: "info",
  tip: "tip",
  important: "info",
  warning: "note",
  caution: "warning",
};
export const calloutLabel = (type: CalloutType) =>
  ({
    note: ct("Hinweis", "Note"),
    tip: ct("Tipp", "Tip"),
    important: ct("Wichtig", "Important"),
    warning: ct("Warnung", "Warning"),
    caution: ct("Achtung", "Caution"),
  })[type];
// Done and cancelled tasks are ticked, all others open.
export const taskDone = (status: TaskStatus) => status === "done" || status === "cancelled";

// Jira's icons from text: (y), (n), (i), (/), (x), (!), (+), (-), (?),
// (on), (off), (*), (*r) … and (flag), (flagoff).
const EMOTICON = /\((?=(?:y|n|i|\/|x|!|\+|-|\?|on|off|\*[rgby]?|flag|flagoff)\))/gi;
// Plain text as Jira shows it: every character that starts markup gets a
// backslash. A dash only where it could strike through, make a list or a
// dash ("--"); a backslash itself as an entity, since "\\" is a line break.
export function jiraText(text: string): string {
  return text
    .replace(/[\r\n]+/g, " ")
    .replace(/\\/g, "&#92;")
    .replace(/[*_{}[\]|!^~+]/g, "\\$&")
    .replace(/\?\?/g, "\\?\\?")
    .replace(/-/g, (dash, index: number, all: string) => {
      const before = all[index - 1],
        after = all[index + 1];
      return before === undefined || after === undefined || /[\s-]/.test(before) || /[\s-]/.test(after) ? "\\-" : dash;
    })
    .replace(EMOTICON, "\\(");
}
// A line that would start markup (a numbered list, a heading, a quote, a
// table, a rule) keeps its first character as text.
const lineStart = (line: string) => line.replace(/^(#|h[1-6]\.|bq\.)/, "\\$1");
// An address inside [text|url] or !url!: the characters that end it encoded.
const jiraUrl = (url: string) => url.replace(/[|\]!\s{}]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"));
// Marks need a word boundary on the outside: spaces at the edge go outside.
function wrap(text: string, open: string, close = open) {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!;
  return match[2] ? `${match[1]}${open}${match[2]}${close}${match[3]}` : text;
}
// The body of a {code} or {noformat} block: everything as typed, only the
// closing tag itself cannot appear (a zero-width space after its brace).
const macroBody = (text: string, name: string) => text.replace(new RegExp(`\\{(${name})`, "gi"), "{​$1");

export function documentJira(html: string, context: TextExportContext): string {
  const doc = documentNode(html);
  const notes: string[] = [];
  const cites = citeScope();
  const nextLabel = captionCounter(!!context.captionNumbers, ct);
  const caption = (node: Node) => {
    const label = nextLabel(node),
      text = captionText(node.attrs.caption);
    return text ? `_${jiraText(label ? `${label}: ${text}` : text)}_` : "";
  };
  const cited: { key: string; item: string }[] = [];
  let bibliographies = 0;
  doc.descendants((node) => {
    if (node.type.name === "citation") cited.push({ key: String(node.attrs.key || ""), item: String(node.attrs.item || "") });
    if (node.type.name === "bibliography") bibliographies++;
  });
  const bibliography = (title: string) =>
    [
      `h2. ${jiraText(title)}`,
      ...citedWorks(cited).map(
        (item) =>
          "* " +
          formatReference(item, ct)
            .map((part) => (/^https?:\/\/\S+$/.test(part.text) ? `[${jiraText(part.text)}|${jiraUrl(part.text)}]` : part.italic ? wrap(jiraText(part.text), "_") : jiraText(part.text)))
            .join(""),
      ),
    ].join("\n");
  const link = (title: string, url: string | null) => (url ? `[${jiraText(title || url)}|${jiraUrl(url)}]` : jiraText(title));
  const placeholder = (text: string) => `_${jiraText(text)}_`;

  // Inline content (a paragraph, a heading, a table cell's line).
  function inline(node: Node): string {
    let result = "";
    node.forEach((child) => (result += inlineNode(child)));
    return result;
  }
  function inlineNode(node: Node): string {
    switch (node.type.name) {
      case "hardBreak":
        return "\\\\ ";
      case "citation":
        return jiraText(inlineCitation(parseItemAttribute(node.attrs.item), String(node.attrs.locator || ""), ct));
      case "footnote":
        notes.push(footnoteText(node.attrs.note));
        return `^${notes.length}^`;
      case "mention":
        return jiraText(`@${String(node.attrs.label || "")}`);
      case "meetingCite":
        return jiraText(cites.label(node.attrs));
      case "mathInline":
        return `{{${jiraText(String(node.attrs.expression || ""))}}}`;
    }
    if (!node.isText) return inline(node);
    let text = jiraText(node.text || "");
    let href: string | null = null;
    for (const mark of node.marks) {
      switch (mark.type.name) {
        case "bold":
          text = wrap(text, "*");
          break;
        case "italic":
          text = wrap(text, "_");
          break;
        case "underline":
          text = wrap(text, "+");
          break;
        case "strike":
          text = wrap(text, "-");
          break;
        case "code":
          text = wrap(text, "{{", "}}");
          break;
        case "superscript":
          text = wrap(text, "^");
          break;
        case "subscript":
          text = wrap(text, "~");
          break;
        case "textColor":
          if (/^#[0-9a-f]{6}$/i.test(String(mark.attrs.color || ""))) text = `{color:${mark.attrs.color}}${text}{color}`;
          break;
        case "link":
          href = context.url(String(mark.attrs.href || ""));
          break;
      }
    }
    // The link goes around the marks: [*bold*|url].
    return href ? `[${text}|${jiraUrl(href)}]` : text;
  }
  // A paragraph's text on one line.
  const line = (node: Node) => lineStart(inline(node).trim());

  // A list with its nesting prefix ("*", "#", "#*" …): one line per item,
  // further paragraphs of an item as line breaks, nested lists deeper.
  function list(node: Node, prefix: string): string[] {
    const own = prefix + (node.type.name === "orderedList" ? "#" : "*");
    const lines: string[] = [];
    node.forEach((item) => {
      let text = "",
        first = true;
      const after: string[] = [];
      if (item.type.name === "taskItem") {
        const status = taskStatusOf(item.attrs);
        text = taskDone(status) ? "\\[x\\] " : "\\[ \\] ";
      }
      item.forEach((child) => {
        if (["bulletList", "orderedList", "taskList"].includes(child.type.name)) after.push(...list(child, own));
        else if (child.type.name === "paragraph" || child.type.name === "heading") {
          const part = inline(child).trim();
          const shown = item.type.name === "taskItem" && taskStatusOf(item.attrs) === "cancelled" && first ? wrap(part, "-") : part;
          text += (first ? "" : " \\\\ ") + shown;
          first = false;
        } else {
          // Blocks a Jira list cannot hold (code, tables …) follow the list.
          after.push(block(child));
        }
      });
      if (item.type.name === "taskItem" && /^\d{4}-\d{2}-\d{2}$/.test(String(item.attrs.due || ""))) text += ` (📅 ${item.attrs.due})`;
      lines.push(`${own} ${text.trim()}`.trimEnd(), ...after);
    });
    return lines;
  }
  function cellText(cell: Node) {
    const parts: string[] = [];
    cell.forEach((child) => {
      if (child.type.name === "paragraph" || child.type.name === "heading") parts.push(inline(child).trim());
      else if (["bulletList", "orderedList", "taskList"].includes(child.type.name)) parts.push(...list(child, "").map((l) => l.replace(/^[*#]+ /, "• ")));
      else parts.push(jiraText(child.textContent));
    });
    // An empty cell needs a space, or two bars read as a header bar.
    return parts.filter(Boolean).join(" \\\\ ") || " ";
  }
  function table(node: Node) {
    const label = caption(node);
    const rows: string[] = [];
    node.forEach((row) => {
      let line = "";
      row.forEach((cell) => {
        const bar = cell.type.name === "tableHeader" ? "||" : "|";
        line += bar + cellText(cell);
        // Jira knows no merged cells: the span becomes empty cells.
        for (let i = 1; i < Math.max(1, Number(cell.attrs.colspan) || 1); i++) line += bar + " ";
      });
      const last = row.lastChild?.type.name === "tableHeader" ? "||" : "|";
      rows.push(line + last);
    });
    return (label ? `${label}\n` : "") + rows.join("\n");
  }
  const panel = (title: string, body: string) => `{panel${title ? `:title=${title.replace(/[|}=]/g, " ")}` : ""}}\n${body}\n{panel}`;
  function children(node: Node) {
    const parts: string[] = [];
    node.forEach((child) => {
      const part = block(child);
      if (part) parts.push(part);
    });
    return parts.join("\n\n");
  }
  function block(node: Node): string {
    switch (node.type.name) {
      case "paragraph":
        return line(node);
      case "heading": {
        const level = Math.max(1, Math.min(6, Number(node.attrs.level) || 1));
        return `h${level}. ${inline(node).trim()}`;
      }
      case "horizontalRule":
        return "----";
      case "codeBlock": {
        const label = caption(node);
        const language = codeLanguage(node.attrs.language);
        const code = language
          ? `{code:${language}}\n${macroBody(node.textContent, "code")}\n{code}`
          : `{noformat}\n${macroBody(node.textContent, "noformat")}\n{noformat}`;
        return label ? `${code}\n${label}` : code;
      }
      case "mathBlock":
        return `{noformat}\n${macroBody(String(node.attrs.expression || ""), "noformat")}\n{noformat}`;
      case "mermaidBlock":
        return `{code}\n${macroBody(String(node.attrs.source || ""), "code")}\n{code}`;
      case "functionPlot":
        return placeholder(ct("Funktionsgraph (nur in Flowplan)", "Function plot (only in Flowplan)"));
      case "metricBlock":
        return placeholder(ct("Kennzahl (nur in Flowplan)", "Metric (only in Flowplan)"));
      case "drawioBlock":
        return placeholder(ct("draw.io-Diagramm (nur in Flowplan)", "draw.io diagram (only in Flowplan)"));
      case "bibliography":
        return bibliography(String(node.attrs.title || ct("Literaturverzeichnis", "References")));
      case "image": {
        const src = context.image(String(node.attrs.src || "")),
          alt = String(node.attrs.alt || ""),
          label = caption(node);
        if (!src) return placeholder(`${alt || ct("Bild", "Image")} ${ct("(nicht verfügbar)", "(not available)")}`) + (label ? ` – ${label}` : "");
        const width = /^\d+$/.test(String(node.attrs.width || "")) ? `|width=${node.attrs.width}` : "";
        return `!${jiraUrl(src)}${width}!` + (label ? `\n${label}` : "");
      }
      case "media": {
        const url = context.url(String(node.attrs.src || "")),
          title = String(node.attrs.title || { audio: "Audio", video: "Video", embed: "Video", pdf: "PDF" }[String(node.attrs.kind)] || ct("Medium", "Media"));
        return url ? link(title, url) : jiraText(`${title} ${ct("(nicht verfügbar)", "(not available)")}`);
      }
      case "linkCard": {
        const url = context.url(String(node.attrs.url || ""));
        const title = String(node.attrs.title || node.attrs.url || "");
        return link(title, url) + (node.attrs.description ? ` – ${jiraText(String(node.attrs.description))}` : "");
      }
      case "bulletList":
      case "orderedList":
      case "taskList":
        return list(node, "").join("\n");
      case "blockquote":
        return `{quote}\n${children(node)}\n{quote}`;
      case "callout": {
        const type = calloutType(node.attrs.type);
        const macro = CALLOUT_MACROS[type];
        // Important shares the blue box with note: its title tells them apart.
        return `{${macro}${type === "important" ? `:title=${calloutLabel(type)}` : ""}}\n${children(node)}\n{${macro}}`;
      }
      case "toggle":
        return panel(String(node.attrs.title || "Details"), children(node));
      case "meeting":
        return cites.within(node, () => panel(String(node.attrs.title || ct("Besprechung", "Meeting")), children(node)));
      case "meetingSummary":
      case "meetingAgenda":
      case "meetingTranscript": {
        if (!node.textContent.trim()) return "";
        const label =
          node.type.name === "meetingSummary" ? ct("Zusammenfassung", "Summary") : node.type.name === "meetingAgenda" ? ct("Notizen", "Notes") : ct("Transkript", "Transcript");
        return `*${jiraText(label)}*\n\n${children(node)}`;
      }
      case "meetingSegment": {
        const speaker = String(node.attrs.speaker || "");
        return `{{${formatTimestamp(Number(node.attrs.start) || 0)}}}${speaker ? ` *${jiraText(speaker)}:*` : ""} ${jiraText(node.textContent)}`;
      }
      case "columns": {
        const parts: string[] = [];
        node.forEach((column) => parts.push(children(column)));
        return parts.filter(Boolean).join("\n\n");
      }
      case "whiteboardEmbed": {
        const board = context.whiteboard?.(String(node.attrs.pageId || ""));
        return board ? `Whiteboard: ${link(board.title || "Whiteboard", board.url)}` : placeholder(ct("Whiteboard nicht verfügbar", "Whiteboard not available"));
      }
      case "drawBlock": {
        const text = context.ink?.(node.attrs)?.text || "";
        return text ? text.split(/\n+/).map((l) => lineStart(jiraText(l))).join(" \\\\ ") : "";
      }
      case "linkedDatabase": {
        const linked = context.linked?.(String(node.attrs.source || ""));
        return linked
          ? `${jiraText(ct("Verknüpfte Datenbank", "Linked database"))}: ${link(linked.title, linked.url)}`
          : placeholder(ct("Verknüpfte Datenbank nicht verfügbar", "Linked database not available"));
      }
      case "table":
        return table(node);
      default:
        return node.isTextblock ? line(node) : children(node);
    }
  }
  let body = children(doc);
  if (cited.length && !bibliographies) body += (body ? "\n\n" : "") + bibliography(ct("Literaturverzeichnis", "References"));
  // Jira has no footnotes: the numbers as superscript, the notes at the end.
  if (notes.length)
    body +=
      (body ? "\n\n" : "") +
      `----\n*${jiraText(ct("Fußnoten", "Footnotes"))}*\n` +
      notes
        .map((note) => `# ${note.split(/(https?:\/\/[^\s<>"]+)/).map((part, i) => (i % 2 ? `[${jiraText(part)}|${jiraUrl(part)}]` : jiraText(part))).join("")}`)
        .join("\n");
  return body.replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

// The context of the text exports (Jira, Confluence) for one page of a
// collected export: absolute links, pictures only when the person may see
// them (as the instance's address), whiteboards and databases as links.
export function textExportContext(content: ExportContent, page: ExportPage): TextExportContext {
  return {
    url: (raw) => exportUrl(raw, content.readable, content.pageUrl, content.fileInfo),
    image: (raw) => {
      const url = exportUrl(raw, content.readable, content.pageUrl, content.fileInfo);
      return url && /^https?:/.test(url) ? url : null;
    },
    captionNumbers: !!page.page.caption_numbers,
    whiteboard: (pageId) => {
      const board = content.readable(pageId);
      return board && board.kind === "whiteboard" ? { title: board.title, url: content.pageUrl(board.id) } : null;
    },
    linked: (source) => {
      const db = content.readable(source);
      return db && db.kind === "database" ? { title: db.title, url: content.pageUrl(db.id) } : null;
    },
    ink: (attrs) => content.ink(page.page.id, attrs),
  };
}

export type TextExportFormat = "jira" | "confluence";
// One page (or one record of a database) as text for Jira or Confluence;
// like the single Markdown file, without sub-pages. A whiteboard page is
// its link.
export async function exportText(
  user: Identity,
  options: { pageId: string; rowId?: string },
  format: TextExportFormat,
  render: (html: string, context: TextExportContext) => string,
  boardLink: (title: string, url: string) => string,
) {
  const collected = await collectExportContent(user, {
    pageId: options.pageId,
    rowId: options.rowId,
    children: false,
    maxPages: 1,
    format: format === "jira" ? "Jira" : "Confluence",
  });
  const page = collected.pages[0];
  const text = await withExportLookups(collected, (content) =>
    page.page.kind === "whiteboard" ? boardLink(page.title || "Whiteboard", content.pageUrl(page.page.id)) : render(page.html, textExportContext(content, page)),
  );
  await audit(user.id, `${options.rowId ? "record" : "page"}.${format}.export`, options.pageId);
  return {
    bytes: Buffer.from(text, "utf8"),
    text,
    name: `${exportName(collected.name)}.${format === "jira" ? "jira.txt" : "confluence.xhtml"}`,
    mime: "text/plain; charset=utf-8",
  };
}

export async function exportJira(user: Identity, options: { pageId: string; rowId?: string }) {
  return await exportText(user, options, "jira", documentJira, (title, url) => `Whiteboard: [${jiraText(title)}|${jiraUrl(url)}]\n`);
}
