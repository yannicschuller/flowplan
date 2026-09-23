import { generateJSON } from "@tiptap/html/server";
import type { Node } from "@tiptap/pm/model";
import { documentExtensions, documentSchema } from "./document-schema";
import { cleanHtml } from "./document-server";
export type MarkdownContext = {
  url: (url: string) => string | null;
  linked: (source: string) => { title: string; url: string } | null;
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
export function htmlToMarkdown(html: string, context: MarkdownContext): string {
  const doc = documentSchema().nodeFromJSON(
    generateJSON(cleanHtml(html), documentExtensions),
  );
  function inline(node: Node, inTable = false): string {
    if (node.type.name === "hardBreak") return "  \n";
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
      if (mark.type.name === "highlight") result = `<mark>${result}</mark>`;
      if (mark.type.name === "link") {
        const url = context.url(String(mark.attrs.href || ""));
        if (url) result = `[${result}](<${markdownUrl(url)}>)`;
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
          alt = String(node.attrs.alt || "Bild");
        return url
          ? `![${markdownText(alt)}](<${markdownUrl(url)}>)`
          : `${markdownText(alt)} (nicht verfügbar)`;
      }
      case "media": {
        const url = context.url(String(node.attrs.src || "")),
          title = String(
            node.attrs.title ||
              { audio: "Audio", video: "Video", embed: "Video" }[
                node.attrs.kind as string
              ] ||
              "Medium",
          );
        return url
          ? markdownLink(title, url)
          : `${markdownText(title)} nicht verfügbar`;
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
          const content = children(item, inTable).split("\n");
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
        return (node.type.name === "callout" ? "[!NOTE]\n\n" : "")
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
            `**Spalte ${index + 1}**\n\n${children(column, inTable)}`,
          ),
        );
        return columns.join("\n\n");
      }
      case "linkedDatabase": {
        const linked = context.linked(String(node.attrs.source || ""));
        return linked
          ? markdownLink(`Verknüpfte Datenbank: ${linked.title}`, linked.url)
          : "Verknüpfte Datenbank nicht verfügbar";
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
  return children(doc).trim() + "\n";
}
