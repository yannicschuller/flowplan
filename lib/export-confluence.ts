// A page (or one record) in Confluence's storage format (#221): the XHTML
// Confluence keeps its pages in, for its source editor, the REST API
// (representation "storage") and tools that publish to Confluence. Built on
// the XHTML of the e-book and print view (lib/export-xhtml.ts) with
// Confluence's own forms where it has them: the code macro (language and
// the text as CDATA), info/tip/note/warning macros for callouts, expand for
// toggles, panel for meetings, <ac:task-list> for tasks, <ac:image> with an
// <ri:url> for pictures, tables in a <tbody>. Links and pictures keep
// absolute addresses of this instance.
import type { Node } from "@tiptap/pm/model";
import { calloutType } from "./document-schema";
import { taskStatusOf } from "./task-status";
import { ct } from "./content-locale";
import { documentXhtml, xml } from "./export-xhtml";
import { CALLOUT_MACROS, calloutLabel, codeLanguage, exportText, taskDone, type TextExportContext } from "./export-jira";
import type { Identity } from "./types";

// Text inside <![CDATA[ … ]]>: only "]]>" ends it, so it is split there.
export const cdata = (text: string) =>
  `<![CDATA[${text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").replace(/\]\]>/g, "]]]]><![CDATA[>")}]]>`;
const parameter = (name: string, value: string) => `<ac:parameter ac:name="${name}">${xml(value)}</ac:parameter>`;
const macro = (name: string, params: string, body: string) => `<ac:structured-macro ac:name="${name}">${params}${body}</ac:structured-macro>`;
const richBody = (body: string) => `<ac:rich-text-body>${body || "<p></p>"}</ac:rich-text-body>`;
export const codeMacro = (text: string, language: string | null) =>
  macro("code", language ? parameter("language", language) : "", `<ac:plain-text-body>${cdata(text)}</ac:plain-text-body>`);
const placeholder = (text: string) => `<p><em>${xml(text)}</em></p>`;

export function documentConfluence(html: string, context: TextExportContext): string {
  let taskIds = 0;
  const body = documentXhtml(html, {
    url: context.url,
    image: context.image,
    captionNumbers: context.captionNumbers,
    whiteboard: (pageId) => {
      const board = context.whiteboard?.(pageId);
      return board ? { ...board, image: null } : null;
    },
    linked: context.linked,
    ink: (attrs) => {
      const ink = context.ink?.(attrs);
      return ink ? { image: null, text: ink.text } : null;
    },
    block: (node: Node, render) => {
      switch (node.type.name) {
        case "codeBlock": {
          const label = render.caption(node);
          return codeMacro(node.textContent, codeLanguage(node.attrs.language)) + (label ? `<p><em>${label}</em></p>` : "");
        }
        case "mathBlock":
          return codeMacro(String(node.attrs.expression || ""), null);
        case "mermaidBlock":
          return codeMacro(String(node.attrs.source || ""), null);
        case "drawioBlock":
          return placeholder(ct("draw.io-Diagramm (nur in Flowplan)", "draw.io diagram (only in Flowplan)"));
        case "image": {
          const src = context.image(String(node.attrs.src || "")),
            alt = String(node.attrs.alt || ""),
            label = render.caption(node);
          if (!src) return placeholder(`${alt || ct("Bild", "Image")} ${ct("(nicht verfügbar)", "(not available)")}`);
          const width = /^\d+$/.test(String(node.attrs.width || "")) ? ` ac:width="${node.attrs.width}"` : "";
          const below = label || (node.attrs.title ? xml(String(node.attrs.title)) : "");
          return `<p><ac:image${alt ? ` ac:alt="${xml(alt)}"` : ""}${width}><ri:url ri:value="${xml(src)}" /></ac:image></p>${below ? `<p><em>${below}</em></p>` : ""}`;
        }
        case "callout": {
          const type = calloutType(node.attrs.type);
          return macro(CALLOUT_MACROS[type], type === "important" ? parameter("title", calloutLabel(type)) : "", richBody(render.children(node)));
        }
        case "toggle":
          return macro("expand", parameter("title", String(node.attrs.title || "Details")), richBody(render.children(node)));
        case "meeting":
          return macro("panel", parameter("title", String(node.attrs.title || ct("Besprechung", "Meeting"))), richBody(render.children(node)));
        case "columns": {
          let result = "";
          node.forEach((column) => (result += render.children(column)));
          return result;
        }
        case "taskList":
          return `<ac:task-list>${render.children(node)}</ac:task-list>`;
        case "taskItem": {
          // The first paragraph is the task's text, the rest (nested tasks
          // and lists) follows inside its body.
          const taskId = ++taskIds;
          let first = true,
            text = "",
            rest = "";
          node.forEach((child) => {
            if (first && child.type.name === "paragraph") {
              text = render.inline(child);
              first = false;
            } else rest += render.block(child);
          });
          const status = taskStatusOf(node.attrs);
          if (status === "cancelled") text = `<s>${text}</s>`;
          const due = /^\d{4}-\d{2}-\d{2}$/.test(String(node.attrs.due || "")) ? ` <time datetime="${node.attrs.due}" />` : "";
          return `<ac:task><ac:task-id>${taskId}</ac:task-id><ac:task-status>${taskDone(status) ? "complete" : "incomplete"}</ac:task-status><ac:task-body>${text}${due}${rest}</ac:task-body></ac:task>`;
        }
        case "table": {
          // The caption above the table; the rows in a <tbody>.
          const table = render.fallback(node);
          const match = /^<table>(?:<caption>([\s\S]*?)<\/caption>)?([\s\S]*)<\/table>$/.exec(table);
          return match ? `${match[1] ? `<p><em>${match[1]}</em></p>` : ""}<table><tbody>${match[2]}</tbody></table>` : table;
        }
      }
      return null;
    },
    footnotes: (notes) =>
      `<hr /><p><strong>${xml(ct("Fußnoten", "Footnotes"))}</strong></p><ol>${notes
        .map((note) => `<li>${note.split(/(https?:\/\/[^\s<>"]+)/).map((part, i) => (i % 2 ? `<a href="${xml(part)}">${xml(part)}</a>` : xml(part))).join("")}</li>`)
        .join("")}</ol>`,
  });
  // Confluence keeps no ids, sections or figures of its own: footnote
  // references become plain superscript numbers (the anchors would lead
  // nowhere), wrappers go, highlights become spans. Code (CDATA) stays as
  // it is.
  return (
    body
      .split(/(<!\[CDATA\[[\s\S]*?\]\]>)/)
      .map((part, index) =>
        index % 2
          ? part
          : part
              .replace(/<sup class="footnote-ref" id="[^"]*"><a href="[^"]*">(\d+)<\/a><\/sup>/g, "<sup>$1</sup>")
              .replace(/<\/?(?:section|figure|aside)\b[^>]*>/g, "")
              .replace(/<figcaption>([\s\S]*?)<\/figcaption>/g, "<p><em>$1</em></p>")
              .replace(/<mark\b([^>]*)>/g, "<span$1>")
              .replace(/<\/mark>/g, "</span>")
              .replace(/<(br|hr)\/>/g, "<$1 />"),
      )
      .join("") + "\n"
  );
}

export async function exportConfluence(user: Identity, options: { pageId: string; rowId?: string }) {
  return await exportText(
    user,
    options,
    "confluence",
    documentConfluence,
    (title, url) => `<p>Whiteboard: <a href="${xml(url)}">${xml(title)}</a></p>\n`,
  );
}
