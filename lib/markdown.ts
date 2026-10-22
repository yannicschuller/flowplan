import { generateHTML, generateJSON } from "@tiptap/html/server";
import type { DOMOutputSpec, Mark, Node } from "@tiptap/pm/model";
import { calloutType, documentExtensions, documentSchema } from "./document-schema";
import { cleanHtml } from "./document-server";
import { citedWorks, formatReference, pandocCitation } from "./citations";
import { ct } from "./content-locale";
import { URL_PATTERN, footnoteText } from "./footnotes";
import { ct as tr } from "./content-locale";
export type MarkdownContext = {
  url: (url: string) => string | null;
  linked: (source: string) => { title: string; url: string } | null;
  // Embedded whiteboards: an image (SVG in the ZIP export) and the link.
  whiteboard?: (pageId: string) => { title: string; image: string | null; url: string } | null;
  // Blocks of block extensions: the plugin's name and address.
  plugin?: (pluginId: string) => { name: string; url: string } | null;
};
export function markdownText(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replace(/\\/g, "\\\\")
    .replace(/[`*_{}\[\]<>|~$]/g, "\\$&")
    .replace(/^(\s*)(#{1,6}|[-+])(?=\s)/gm, "$1\\$2")
    .replace(/^(\s*\d+)([.)])(?=\s)/gm, "$1\\$2")
    .replace(/^(\s*)(=+|-+)\s*$/gm, "$1\\$2");
}
export function markdownUrl(url: string) {
  return url.replace(/[\s<>\\"()|]/g, (c) => encodeURIComponent(c));
}
export function markdownLink(label: string, url: string) {
  return `[${markdownText(label)}](<${markdownUrl(url)}>)`;
}
export function fencedCode(source: string, language = "") {
  const runs = source.match(/`+/g) || [],
    fence = "`".repeat(Math.max(3, ...runs.map((run) => run.length + 1)));
  const lang = /^[\w#+.-]*$/.test(language) ? language : "";
  return `${fence}${lang}\n${source}${source.endsWith("\n") ? "" : "\n"}${fence}`;
}
function inlineCode(source: string, inTable = false) {
  if (inTable)
    return `<code>${htmlText(source).replaceAll("|", "&#124;").replace(/\n/g, "<br>")}</code>`;
  const fence = "`".repeat(
    Math.max(1, ...(source.match(/`+/g) || []).map((run) => run.length + 1)),
  );
  const value = source.replace(/\n/g, " "),
    pad = /^`|`$|^ .* $/.test(value) && !/^[ ]+$/.test(value) ? " " : "";
  return `${fence}${pad}${value}${pad}${fence}`;
}
const htmlText = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
function wrapMark(text: string, delimiter: string) {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!;
  return match[2]
    ? match[1] + delimiter + match[2] + delimiter + match[3]
    : text;
}
// Source view ("Als Markdown bearbeiten"): what Markdown cannot hold stays
// intact. Blocks without a Markdown form become a marker
// <!-- flowplan:block N … --> naming blocks[N]; marks and inline nodes
// without one are written as inline HTML, which the import reads back.
export type MarkdownSource = {
  blocks: { html: string; label: string }[];
  // What gets lost anyway (alignment, indent …), for the notice.
  lossy: Set<string>;
};
export { BLOCK_MARKER } from "./markdown-html";
// Blocks Markdown holds completely (with their content).
const MARKDOWN_BLOCKS = new Set([
  "paragraph",
  "heading",
  "horizontalRule",
  "codeBlock",
  "mathBlock",
  "mermaidBlock",
  "bulletList",
  "orderedList",
  "taskList",
  "listItem",
  "taskItem",
  "blockquote",
  "callout",
  "toggle",
  "table",
  "tableRow",
  "tableCell",
  "tableHeader",
  "image",
]);
const attributeText = (value: unknown) =>
  String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
// A schema's DOM description as HTML: [tag, attrs?, ...children | 0].
function specHtml(spec: DOMOutputSpec, content = ""): string | null {
  if (typeof spec === "string") return htmlText(spec);
  if (!Array.isArray(spec) || typeof spec[0] !== "string" || !/^[a-z][a-z0-9]*$/i.test(spec[0])) return null;
  const [tag, ...rest] = spec as unknown as [string, ...unknown[]];
  let attrs = "",
    inner = "";
  for (const [index, part] of rest.entries()) {
    if (index === 0 && part && typeof part === "object" && !Array.isArray(part)) {
      for (const [name, value] of Object.entries(part as Record<string, unknown>))
        if (value !== null && value !== undefined && value !== false && /^[a-z][\w-]*$/i.test(name))
          attrs += ` ${name}="${attributeText(value)}"`;
      continue;
    }
    if (part === 0) inner += content;
    else {
      const child = specHtml(part as DOMOutputSpec, content);
      if (child === null) return null;
      inner += child;
    }
  }
  return `<${tag}${attrs}>${inner}</${tag}>`;
}
function markHtml(mark: Mark) {
  const spec = mark.type.spec.toDOM?.(mark, true);
  if (!spec) return null;
  const html = specHtml(spec, "\u0000");
  if (!html) return null;
  const [open, close] = html.split("\u0000");
  return close === undefined ? null : { open, close };
}
const blockLabels: Record<string, () => string> = {
  linkedDatabase: () => tr("Verknüpfte Datenbank", "Linked database"),
  syncedBlock: () => tr("Synchronisierter Block", "Synced block"),
  whiteboardEmbed: () => tr("Whiteboard", "Whiteboard"),
  media: () => tr("Medium", "Media"),
  linkCard: () => tr("Linkvorschau", "Link preview"),
  functionPlot: () => tr("Funktionsgraph", "Function graph"),
  metricBlock: () => tr("Kennzahl", "Metric"),
  pluginBlock: () => tr("Erweiterung", "Extension"),
  columns: () => tr("Spalten", "Columns"),
  table: () => tr("Tabelle", "Table"),
  image: () => tr("Bild", "Image"),
};
// Tables Markdown holds: no merged cells, widths, or more than one
// paragraph per cell.
function plainTable(node: Node) {
  let plain = true;
  node.descendants((child) => {
    if (!plain) return false;
    if (child.type.name === "tableCell" || child.type.name === "tableHeader") {
      if (
        (Number(child.attrs.colspan) || 1) > 1 ||
        (Number(child.attrs.rowspan) || 1) > 1 ||
        child.attrs.colwidth ||
        child.childCount > 1 ||
        child.firstChild?.type.name !== "paragraph"
      )
        plain = false;
      return false;
    }
    return true;
  });
  return plain;
}
export function htmlToMarkdown(
  html: string,
  context: MarkdownContext,
  options: { source?: MarkdownSource } = {},
): string {
  const doc = documentSchema().nodeFromJSON(
    generateJSON(cleanHtml(html), documentExtensions),
  );
  // Citations as Pandoc "[@key]"; the bibliography lists every cited work.
  const cited: { key: string; item: string }[] = [];
  let bibliographies = 0;
  doc.descendants((node) => {
    if (node.type.name === "citation") cited.push({ key: String(node.attrs.key || ""), item: String(node.attrs.item || "") });
    if (node.type.name === "bibliography") bibliographies++;
  });
  const references = () =>
    citedWorks(cited)
      .map(
        (item) =>
          "- " +
          formatReference(item, ct)
            .map((part) =>
              /^https?:\/\/\S+$/.test(part.text)
                ? `<${markdownUrl(part.text)}>`
                : part.italic
                  ? wrapMark(markdownText(part.text), "*")
                  : markdownText(part.text),
            )
            .join(""),
      )
      .join("\n");
  const bibliography = (title: string) => {
    const list = references();
    return `## ${markdownText(title)}` + (list ? `\n\n${list}` : "");
  };
  const source = options.source;
  const notes: string[] = [];
  // Whole blocks Markdown cannot hold, as a marker (source view only).
  function placeholder(node: Node) {
    if (!source) return null;
    const keep =
      !MARKDOWN_BLOCKS.has(node.type.name) ||
      (node.type.name === "table" && !plainTable(node)) ||
      (node.type.name === "image" && !!(node.attrs.width || node.attrs.height || node.attrs.annotations || node.attrs.title));
    if (!keep) return null;
    const index = source.blocks.length;
    const label = (blockLabels[node.type.name]?.() || node.type.name).replace(/-{2,}|>/g, " ");
    source.blocks.push({
      html: generateHTML({ type: "doc", content: [node.toJSON()] }, documentExtensions),
      label,
    });
    return `<!-- flowplan:block ${index} ${label} -->`;
  }
  function lose(node: Node) {
    if (!source) return;
    if (node.attrs.textAlign && node.attrs.textAlign !== "left") source.lossy.add(tr("Ausrichtung", "Alignment"));
    if (node.attrs.indent) source.lossy.add(tr("Einzug", "Indent"));
    if (node.attrs.dir) source.lossy.add(tr("Textrichtung", "Text direction"));
    if (node.attrs.reactions) source.lossy.add(tr("Reaktionen", "Reactions"));
    if (node.attrs.journalSince) source.lossy.add(tr("Übertragene Aufgaben", "Carried-over tasks"));
  }
  function inline(node: Node, inTable = false): string {
    if (node.type.name === "hardBreak") return "  \n";
    // In the source view a citation stays as HTML, so applying keeps it.
    if (node.type.name === "citation" && source) {
      const spec = node.type.spec.toDOM?.(node);
      const html = spec && specHtml(spec);
      if (html) return html;
    }
    if (node.type.name === "citation")
      return pandocCitation(String(node.attrs.key || ""), String(node.attrs.locator || ""));
    if (node.type.name === "footnote") {
      notes.push(footnoteText(node.attrs.note));
      return `[^${notes.length}]`;
    }
    if (node.type.name === "mention" && source) {
      const spec = node.type.spec.toDOM?.(node);
      const html = spec && specHtml(spec);
      if (html) return html;
    }
    if (node.type.name === "mention")
      return markdownText("@" + String(node.attrs.label || ""));
    if (node.type.name === "mathInline") {
      const value = String(node.attrs.expression || "");
      return inTable
        ? inlineCode(value, true)
        : /[`\n]/.test(value)
          ? inlineCode(value)
          : `$${inlineCode(value)}$`;
    }
    if (!node.isText) {
      let result = "";
      node.forEach((child) => (result += inline(child, inTable)));
      return result;
    }
    const isCode = node.marks.some((mark) => mark.type.name === "code");
    let result = isCode
      ? inlineCode(node.text || "", inTable)
      : markdownText(node.text || "");
    for (const mark of node.marks) {
      if (mark.type.name === "bold") result = wrapMark(result, "**");
      if (mark.type.name === "italic") result = wrapMark(result, "*");
      if (mark.type.name === "strike") result = wrapMark(result, "~~");
      if (mark.type.name === "underline") result = `<u>${result}</u>`;
      if (mark.type.name === "highlight" && !(source && mark.attrs.color)) result = `<mark>${result}</mark>`;
      if (mark.type.name === "link") {
        const url = context.url(String(mark.attrs.href || ""));
        if (url) result = `[${result}](<${markdownUrl(url)}>)`;
      }
      // Without a Markdown form: as inline HTML in the source view.
      if (
        source &&
        !["bold", "italic", "strike", "underline", "link", "code"].includes(mark.type.name) &&
        !(mark.type.name === "highlight" && !mark.attrs.color)
      ) {
        const wrap = markHtml(mark);
        if (wrap) result = wrap.open + result + wrap.close;
        else source.lossy.add(mark.type.name);
      }
    }
    return result;
  }
  function children(node: Node, inTable = false) {
    const result: string[] = [];
    node.forEach((child) => result.push(block(child, inTable)));
    return result.filter(Boolean).join("\n\n");
  }
  function block(node: Node, inTable = false): string {
    const kept = placeholder(node);
    if (kept !== null) return kept;
    lose(node);
    switch (node.type.name) {
      case "paragraph":
        return inline(node, inTable);
      case "heading":
        return (
          "#".repeat(Math.max(1, Math.min(6, Number(node.attrs.level) || 1))) +
          " " +
          inline(node, inTable)
        );
      case "horizontalRule":
        return "---";
      case "bibliography":
        return bibliography(String(node.attrs.title || ct("Literaturverzeichnis", "References")));
      case "codeBlock":
        return inTable
          ? inlineCode(node.textContent, true)
          : fencedCode(node.textContent, String(node.attrs.language || ""));
      case "mathBlock":
        return inTable
          ? inlineCode(String(node.attrs.expression || ""), true)
          : fencedCode(String(node.attrs.expression || ""), "math");
      case "mermaidBlock":
        return inTable
          ? inlineCode(String(node.attrs.source || ""), true)
          : fencedCode(String(node.attrs.source || ""), "mermaid");
      case "image": {
        const url = context.url(String(node.attrs.src || "")),
          alt = String(node.attrs.alt || ct("Bild", "Image"));
        return url
          ? `![${markdownText(alt)}](<${markdownUrl(url)}>)`
          : `${markdownText(alt)} ${ct("(nicht verfügbar)", "(not available)")}`;
      }
      case "media": {
        const url = context.url(String(node.attrs.src || "")),
          title = String(
            node.attrs.title ||
              { audio: "Audio", video: "Video", embed: "Video" }[
                node.attrs.kind as string
              ] ||
              ct("Medium", "Media"),
          );
        return url
          ? markdownLink(title, url)
          : `${markdownText(title)} ${ct("nicht verfügbar", "not available")}`;
      }
      case "bulletList":
      case "orderedList":
      case "taskList": {
        const result: string[] = [];
        node.forEach((item, _offset, index) => {
          const prefix =
            node.type.name === "orderedList"
              ? `${(Number(node.attrs.start) || 1) + index}. `
              : node.type.name === "taskList"
                ? `- [${item.attrs.checked ? "x" : " "}] `
                : "- ";
          lose(item);
          const content = children(item, inTable).split("\n");
          // Due dates as in Obsidian Tasks: "- [ ] Call 📅 2026-05-04".
          if (node.type.name === "taskList" && /^\d{4}-\d{2}-\d{2}$/.test(String(item.attrs.due || "")))
            content[0] += ` 📅 ${item.attrs.due}`;
          result.push(
            prefix +
              content[0] +
              content
                .slice(1)
                .map((line) => "\n" + " ".repeat(prefix.length) + line)
                .join(""),
          );
        });
        return result.join("\n");
      }
      case "blockquote":
      case "callout":
        // Callouts as GitHub alerts: > [!WARNING] …
        return (node.type.name === "callout" ? `[!${calloutType(node.attrs.type).toUpperCase()}]\n\n` : "")
          .concat(children(node, inTable))
          .split("\n")
          .map((line) => "> " + line)
          .join("\n");
      case "toggle":
        return `<details>\n<summary>${htmlText(String(node.attrs.title || "Details")).replaceAll("|", "&#124;")}</summary>\n\n${children(node, inTable)}\n\n</details>`;
      case "columns": {
        const columns: string[] = [];
        node.forEach((column, _offset, index) =>
          columns.push(
            `**${ct(`Spalte ${index + 1}`, `Column ${index + 1}`)}**\n\n${children(column, inTable)}`,
          ),
        );
        return columns.join("\n\n");
      }
      case "whiteboardEmbed": {
        const board = context.whiteboard?.(String(node.attrs.pageId || ""));
        if (!board) return ct("Whiteboard nicht verfügbar", "Whiteboard not available");
        const link = markdownLink(board.title || "Whiteboard", board.url);
        // The marker lets a re-import (Git, lib/git-export.ts) restore the embed.
        const marker = `<!-- flowplan:whiteboard ${String(node.attrs.pageId)} ${Math.round(Number(node.attrs.height) || 380)} -->\n`;
        return marker + (board.image ? `![${markdownText(board.title || "Whiteboard")}](<${markdownUrl(board.image)}>)\n\n${link}` : link);
      }
      case "pluginBlock": {
        // A placeholder link: the frame cannot live in Markdown; its text can.
        const plugin = context.plugin?.(String(node.attrs.pluginId || ""));
        const label = `${ct("Erweiterung", "Extension")}: ${String(node.attrs.label || plugin?.name || node.attrs.blockType || "")}`.trim();
        const text = String(node.attrs.text || "").trim();
        const head = plugin ? markdownLink(label, plugin.url) : `*${markdownText(label)}*`;
        return text ? `${head}\n\n${markdownText(text)}` : head;
      }
      case "linkedDatabase": {
        const linked = context.linked(String(node.attrs.source || ""));
        return linked
          ? markdownLink(`${ct("Verknüpfte Datenbank", "Linked database")}: ${linked.title}`, linked.url)
          : ct("Verknüpfte Datenbank nicht verfügbar", "Linked database not available");
      }
      case "table": {
        const grid: string[][] = [],
          occupied = new Set<string>();
        let width = 0;
        if (node.childCount > 1000)
          throw new Error("Markdown-Tabelle überschreitet 1.000 Zeilen.");
        node.forEach((row, _offset, rowIndex) => {
          grid[rowIndex] ||= [];
          let column = 0;
          row.forEach((cell) => {
            while (occupied.has(`${rowIndex}:${column}`)) column++;
            const colspan = Math.max(1, Number(cell.attrs.colspan) || 1),
              rowspan = Math.max(1, Number(cell.attrs.rowspan) || 1);
            if (column + colspan > 1000 || rowIndex + rowspan > 1000)
              throw new Error(
                "Markdown-Tabelle überschreitet 1.000 Zeilen oder Spalten.",
              );
            grid[rowIndex][column] = children(cell, true).replace(
              /\n/g,
              "<br>",
            );
            for (let r = rowIndex; r < rowIndex + rowspan; r++)
              for (let c = column; c < column + colspan; c++) {
                occupied.add(`${r}:${c}`);
                grid[r] ||= [];
                if (r !== rowIndex || c !== column) grid[r][c] = "";
              }
            column += colspan;
            width = Math.max(width, column);
          });
        });
        const lines = grid.map(
          (row) =>
            "| " +
            Array.from({ length: width }, (_, i) => row[i] || "").join(" | ") +
            " |",
        );
        if (!lines.length) return "";
        // A synthetic empty header preserves a first row made entirely of data cells.
        if (
          !Array.from(
            { length: node.firstChild!.childCount },
            (_, i) => node.firstChild!.child(i).type.name,
          ).includes("tableHeader")
        )
          lines.unshift("| " + " | ".repeat(width - 1) + " |");
        lines.splice(1, 0, "| " + Array(width).fill("---").join(" | ") + " |");
        return lines.join("\n");
      }
      default:
        return children(node, inTable);
    }
  }
  const body = children(doc).trim();
  // Cited works without a bibliography block: listed at the end.
  const withReferences =
    cited.length && !bibliographies ? `${body}\n\n${bibliography(ct("Literaturverzeichnis", "References"))}` : body;
  // Web addresses stay as they are, so they remain links.
  const noteText = (note: string) =>
    note
      .split(URL_PATTERN)
      .map((part, index) => (index % 2 ? part : markdownText(part)))
      .join("");
  const definitions = notes.map((note, index) => `[^${index + 1}]: ${noteText(note) || " "}`).join("\n");
  return (definitions ? `${withReferences}\n\n${definitions}` : withReferences) + "\n";
}
// The page as Markdown for the source view, and the blocks kept aside.
export function markdownSource(html: string) {
  const source: MarkdownSource = { blocks: [], lossy: new Set() };
  const markdown = htmlToMarkdown(
    html,
    {
      // Links and files stay as they are (relative to Flowplan).
      url: (url) => (/^(https?:|mailto:|\/)/i.test(url) ? url : null),
      linked: () => null,
    },
    { source },
  );
  return { markdown, blocks: source.blocks, lossy: [...source.lossy] };
}
