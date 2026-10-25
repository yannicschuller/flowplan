// A document as well-formed XHTML, for EPUB chapters and the combined print
// view (lib/export-pdf.ts). Walks the ProseMirror tree of the sanitised HTML
// (lib/export-content.ts), so every block gets a plain, self-contained form:
// no scripts, no app classes, pictures where the context allows them.
import type { Node } from "@tiptap/pm/model";
import { calloutType } from "./document-schema";
import { citedWorks, formatReference, inlineCitation, parseItemAttribute } from "./citations";
import { ct } from "./content-locale";
import { footnoteText, URL_PATTERN } from "./footnotes";
import { documentNode } from "./export-content";

export type XhtmlContext = {
  // The address a link may keep (absolute, or relative within the export),
  // null to drop the link and keep its text.
  url: (raw: string) => string | null;
  // The address of a picture in the export, null when it is not available.
  image: (raw: string) => string | null;
  // An embedded whiteboard: its picture (address) and the link to the board.
  whiteboard?: (pageId: string) => { title: string; image: string | null; url: string } | null;
  // A linked database: title and link.
  linked?: (source: string) => { title: string; url: string } | null;
  // A drawing block (or notebook sheet): its picture (address) and text.
  ink?: (attrs: Record<string, unknown>) => { image: string | null; text: string } | null;
  // Prefix for ids (footnotes), unique per document in a combined file.
  prefix?: string;
};
export const xml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
const attr = (name: string, value: string | null | undefined) => (value ? ` ${name}="${xml(value)}"` : "");
const calloutTitle = (type: string) =>
  ({
    note: ct("Hinweis", "Note"),
    tip: ct("Tipp", "Tip"),
    important: ct("Wichtig", "Important"),
    warning: ct("Warnung", "Warning"),
    caution: ct("Achtung", "Caution"),
  })[type] || ct("Hinweis", "Note");
// Text with web addresses as links (footnotes).
const linkified = (text: string) =>
  text
    .split(URL_PATTERN)
    .map((part, index) => (index % 2 ? `<a href="${xml(part)}">${xml(part)}</a>` : xml(part)))
    .join("");

export function documentXhtml(html: string, context: XhtmlContext): string {
  const doc = documentNode(html);
  const prefix = context.prefix ? `${context.prefix}-` : "";
  const notes: string[] = [];
  const cited: { key: string; item: string }[] = [];
  let bibliographies = 0;
  doc.descendants((node) => {
    if (node.type.name === "citation") cited.push({ key: String(node.attrs.key || ""), item: String(node.attrs.item || "") });
    if (node.type.name === "bibliography") bibliographies++;
  });
  const bibliography = (title: string) => {
    const items = citedWorks(cited).map(
      (item) =>
        `<li>${formatReference(item, ct)
          .map((part) =>
            /^https?:\/\/\S+$/.test(part.text)
              ? `<a href="${xml(part.text)}">${xml(part.text)}</a>`
              : part.italic
                ? `<em>${xml(part.text)}</em>`
                : xml(part.text),
          )
          .join("")}</li>`,
    );
    return `<section class="bibliography"><h2>${xml(title)}</h2>${items.length ? `<ul>${items.join("")}</ul>` : ""}</section>`;
  };
  function inline(node: Node): string {
    if (node.type.name === "hardBreak") return "<br/>";
    if (node.type.name === "citation")
      return `<span class="citation">${xml(inlineCitation(parseItemAttribute(node.attrs.item), String(node.attrs.locator || ""), ct))}</span>`;
    if (node.type.name === "footnote") {
      notes.push(footnoteText(node.attrs.note));
      const number = notes.length;
      return `<sup class="footnote-ref" id="${prefix}fnref-${number}"><a href="#${prefix}fn-${number}">${number}</a></sup>`;
    }
    if (node.type.name === "mention") return `<span class="mention">@${xml(String(node.attrs.label || ""))}</span>`;
    if (node.type.name === "mathInline") return `<code class="math">${xml(String(node.attrs.expression || ""))}</code>`;
    if (!node.isText) {
      let result = "";
      node.forEach((child) => (result += inline(child)));
      return result;
    }
    let result = xml(node.text || "");
    for (const mark of node.marks) {
      switch (mark.type.name) {
        case "bold":
          result = `<strong>${result}</strong>`;
          break;
        case "italic":
          result = `<em>${result}</em>`;
          break;
        case "underline":
          result = `<u>${result}</u>`;
          break;
        case "strike":
          result = `<s>${result}</s>`;
          break;
        case "code":
          result = `<code>${result}</code>`;
          break;
        case "highlight":
          result = `<mark${/^#[0-9a-f]{6}$/i.test(String(mark.attrs.color || "")) ? attr("style", `background-color:${mark.attrs.color}`) : ""}>${result}</mark>`;
          break;
        case "textColor":
          if (/^#[0-9a-f]{6}$/i.test(String(mark.attrs.color || ""))) result = `<span style="color:${mark.attrs.color}">${result}</span>`;
          break;
        case "superscript":
          result = `<sup>${result}</sup>`;
          break;
        case "subscript":
          result = `<sub>${result}</sub>`;
          break;
        case "link": {
          const url = context.url(String(mark.attrs.href || ""));
          if (url) result = `<a href="${xml(url)}">${result}</a>`;
          break;
        }
      }
    }
    return result;
  }
  const blockAttrs = (node: Node) => {
    const styles: string[] = [];
    if (node.attrs.textAlign && node.attrs.textAlign !== "left") styles.push(`text-align:${node.attrs.textAlign}`);
    if (Number(node.attrs.indent) > 0) styles.push(`margin-left:${Math.min(8, Number(node.attrs.indent)) * 2}em`);
    return attr("style", styles.join(";")) + (node.attrs.dir && node.attrs.dir !== "ltr" ? attr("dir", String(node.attrs.dir)) : "");
  };
  function children(node: Node) {
    let result = "";
    node.forEach((child) => (result += block(child)));
    return result;
  }
  function block(node: Node): string {
    switch (node.type.name) {
      case "paragraph":
        return `<p${blockAttrs(node)}>${inline(node)}</p>`;
      case "heading": {
        const level = Math.max(1, Math.min(6, Number(node.attrs.level) || 1));
        return `<h${level}${blockAttrs(node)}>${inline(node)}</h${level}>`;
      }
      case "horizontalRule":
        return "<hr/>";
      case "codeBlock":
        return `<pre><code${attr("class", node.attrs.language ? `language-${String(node.attrs.language)}` : "")}>${xml(node.textContent)}</code></pre>`;
      case "mathBlock":
        return `<pre class="math">${xml(String(node.attrs.expression || ""))}</pre>`;
      case "mermaidBlock":
        return `<pre class="mermaid">${xml(String(node.attrs.source || ""))}</pre>`;
      case "functionPlot":
        return `<p class="placeholder">${xml(ct("Funktionsgraph (nur in Flowplan)", "Function plot (only in Flowplan)"))}</p>`;
      case "metricBlock":
        return `<p class="placeholder">${xml(ct("Kennzahl (nur in Flowplan)", "Metric (only in Flowplan)"))}</p>`;
      case "bibliography":
        return bibliography(String(node.attrs.title || ct("Literaturverzeichnis", "References")));
      case "image": {
        const src = context.image(String(node.attrs.src || "")),
          alt = String(node.attrs.alt || "");
        if (!src) return `<p class="placeholder">${xml(alt || ct("Bild", "Image"))} ${xml(ct("(nicht verfügbar)", "(not available)"))}</p>`;
        const width = /^\d+$/.test(String(node.attrs.width || "")) ? ` width="${node.attrs.width}"` : "";
        return `<figure><img src="${xml(src)}" alt="${xml(alt)}"${width}/>${node.attrs.title ? `<figcaption>${xml(String(node.attrs.title))}</figcaption>` : ""}</figure>`;
      }
      case "media": {
        const url = context.url(String(node.attrs.src || "")),
          title = String(node.attrs.title || { audio: "Audio", video: "Video", embed: "Video", pdf: "PDF" }[String(node.attrs.kind)] || ct("Medium", "Media"));
        return `<p class="media">${url ? `<a href="${xml(url)}">${xml(title)}</a>` : `${xml(title)} ${xml(ct("(nicht verfügbar)", "(not available)"))}`}</p>`;
      }
      case "linkCard": {
        const url = context.url(String(node.attrs.url || ""));
        const title = String(node.attrs.title || node.attrs.url || "");
        return `<p class="link-card">${url ? `<a href="${xml(url)}">${xml(title)}</a>` : xml(title)}${node.attrs.description ? ` – ${xml(String(node.attrs.description))}` : ""}</p>`;
      }
      case "bulletList":
        return `<ul>${children(node)}</ul>`;
      case "orderedList":
        return `<ol${Number(node.attrs.start) > 1 ? ` start="${Number(node.attrs.start)}"` : ""}>${children(node)}</ol>`;
      case "taskList":
        return `<ul class="task-list">${children(node)}</ul>`;
      case "listItem":
        return `<li>${children(node)}</li>`;
      case "taskItem": {
        const done = !!node.attrs.checked;
        const due = /^\d{4}-\d{2}-\d{2}$/.test(String(node.attrs.due || "")) ? ` <span class="due">📅 ${node.attrs.due}</span>` : "";
        // The box goes in front of the first paragraph's text.
        let first = true,
          body = "";
        node.forEach((child) => {
          if (first && child.type.name === "paragraph") {
            body += `<p${blockAttrs(child)}><span class="task-box">${done ? "☑" : "☐"}</span> ${inline(child)}${due}</p>`;
            first = false;
          } else body += block(child);
        });
        if (first) body = `<p><span class="task-box">${done ? "☑" : "☐"}</span>${due}</p>${body}`;
        return `<li class="task${done ? " done" : ""}">${body}</li>`;
      }
      case "blockquote":
        return `<blockquote${blockAttrs(node)}>${children(node)}</blockquote>`;
      case "callout": {
        const type = calloutType(node.attrs.type);
        return `<aside class="callout callout-${type}"><p class="callout-title">${xml(calloutTitle(type))}</p>${children(node)}</aside>`;
      }
      case "toggle":
        return `<section class="toggle"><p class="toggle-title">${xml(String(node.attrs.title || "Details"))}</p>${children(node)}</section>`;
      case "columns": {
        let result = "";
        node.forEach((column) => (result += `<div class="column">${children(column)}</div>`));
        return `<div class="columns">${result}</div>`;
      }
      case "whiteboardEmbed": {
        const board = context.whiteboard?.(String(node.attrs.pageId || ""));
        if (!board) return `<p class="placeholder">${xml(ct("Whiteboard nicht verfügbar", "Whiteboard not available"))}</p>`;
        const link = `<a href="${xml(board.url)}">${xml(board.title || "Whiteboard")}</a>`;
        return board.image
          ? `<figure class="whiteboard"><img src="${xml(board.image)}" alt="${xml(board.title || "Whiteboard")}"/><figcaption>${link}</figcaption></figure>`
          : `<p class="whiteboard">${link}</p>`;
      }
      case "drawBlock": {
        const ink = context.ink?.(node.attrs);
        const text = ink?.text ? `<figcaption>${xml(ink.text).replace(/\n/g, "<br/>")}</figcaption>` : "";
        return ink?.image
          ? `<figure class="ink-block"><img src="${xml(ink.image)}" alt="${xml(ink.text || ct("Handschrift", "Handwriting"))}"/>${text}</figure>`
          : ink?.text
            ? `<p class="ink-block">${xml(ink.text)}</p>`
            : "";
      }
      case "linkedDatabase": {
        const linked = context.linked?.(String(node.attrs.source || ""));
        return `<p class="linked-database">${
          linked
            ? `${xml(ct("Verknüpfte Datenbank", "Linked database"))}: <a href="${xml(linked.url)}">${xml(linked.title)}</a>`
            : xml(ct("Verknüpfte Datenbank nicht verfügbar", "Linked database not available"))
        }</p>`;
      }
      case "table": {
        let rows = "";
        node.forEach((row) => {
          let cells = "";
          row.forEach((cell) => {
            const tag = cell.type.name === "tableHeader" ? "th" : "td";
            const span =
              (Number(cell.attrs.colspan) > 1 ? ` colspan="${Number(cell.attrs.colspan)}"` : "") +
              (Number(cell.attrs.rowspan) > 1 ? ` rowspan="${Number(cell.attrs.rowspan)}"` : "");
            cells += `<${tag}${span}>${children(cell)}</${tag}>`;
          });
          rows += `<tr>${cells}</tr>`;
        });
        return `<table>${rows}</table>`;
      }
      default:
        return children(node);
    }
  }
  let body = children(doc);
  if (cited.length && !bibliographies) body += bibliography(ct("Literaturverzeichnis", "References"));
  if (notes.length)
    body +=
      `<section class="footnotes"><p class="footnotes-title">${xml(ct("Fußnoten", "Footnotes"))}</p><ol>` +
      notes
        .map(
          (note, index) =>
            `<li id="${prefix}fn-${index + 1}">${linkified(note) || " "} <a href="#${prefix}fnref-${index + 1}" class="footnote-back">↩</a></li>`,
        )
        .join("") +
      "</ol></section>";
  return body;
}
