import { Window } from "happy-dom";
import { DOMParser as SchemaParser, DOMSerializer, Node as PMNode, type Schema } from "@tiptap/pm/model";
import { embedHosts, embedProvider } from "./embed-providers";
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from "y-prosemirror";
import * as Y from "yjs";
import sanitize from "sanitize-html";
import { documentSchema } from "./document-schema";
import { calloutColor, calloutIcon } from "./callout-types";
import { fenceLanguage } from "./code-languages";
import { importedCodeAttributes } from "./code-block-options";
import { sanitizeDrawioSvg } from "./drawio-svg";
import { MAX_DRAWIO_XML } from "./drawio";
const dir = { name: "dir", multiple: false, values: ["ltr", "rtl", "auto"] };
// cleanHtml with a transform that awaits (database lookups, #127): the
// tags are collected in a first pass, transformed one after the other, and
// the results applied in a second pass over the same HTML – sanitize-html
// calls its transforms synchronously, in document order, the same order
// both times. The transform must keep the tag name.
export async function cleanHtmlAsync(
  html: string,
  transform: (tagName: string, attribs: sanitize.Attributes) => Promise<{ tagName: string; attribs: sanitize.Attributes }> | { tagName: string; attribs: sanitize.Attributes },
) {
  const tags: [string, sanitize.Attributes][] = [];
  cleanHtml(html, (tagName, attribs) => {
    tags.push([tagName, { ...attribs }]);
    return { tagName, attribs };
  });
  const results: { tagName: string; attribs: sanitize.Attributes }[] = [];
  for (const [tagName, attribs] of tags) results.push(await transform(tagName, attribs));
  let next = 0;
  return cleanHtml(html, (tagName, attribs) => {
    const result = results[next++];
    if (!result || tags[next - 1][0] !== tagName) throw new Error("cleanHtmlAsync: the second pass met other tags");
    return result;
  });
}
export function cleanHtml(html: string, transform?: sanitize.Transformer) {
  return sanitize(html, {
    allowedTags: [
      ...sanitize.defaults.allowedTags,
      "img",
      "input",
      "label",
      "aside",
      "details",
      "summary",
      "mark",
      "s",
      "u",
      "video",
      "audio",
      "iframe",
    ],
    allowedAttributes: {
      ...sanitize.defaults.allowedAttributes,
      "*": [
        "class",
        "style",
        "data-type",
        "data-checked",
        "data-status",
        "data-symbol",
        "data-journal-since",
        "data-due",
        "data-reactions",
        "data-block-id",
        "data-synced-block",
        "data-suggestion",
        "data-suggestion-id",
        "data-suggestion-author",
        "data-suggestion-name",
        "data-suggestion-at",
        "data-pdf",
        "data-title",
        "data-spoiler",
        "data-indent",
        "data-callout",
        "data-math",
        "data-mermaid",
        "data-drawio",
        "data-drawio-svg",
        "data-function-plot",
        "data-metric",
        "data-plugin",
        "data-plugin-type",
        "data-plugin-label",
        "data-plugin-data",
        "data-workflow-button",
        "data-label",
        "data-code-wrap",
        "data-code-view",
        "data-line-numbers",
        "data-start-line",
        "data-highlight-lines",
        "data-collapsed",
        "data-collapsed-lines",
        "data-linked-database",
        "data-whiteboard",
        "data-whiteboard-height",
        "data-ink-block",
        "data-ink-height",
        "data-ink-paper",
        "data-ink-page",
        "data-ink-from",
        "data-linked-source",
        "data-linked-views",
        "data-linked-version",
        "data-mention",
        "data-columns",
        "data-column",
        "data-link-card",
        "data-link-title",
        "data-link-provider",
        "data-link-description",
        "data-link-image",
        "data-citation",
        "data-citation-item",
        "data-citation-locator",
        "data-bibliography",
        "data-bibliography-title",
        "data-footnote",
        // The meeting block (#199, lib/meeting-schema.ts).
        "data-meeting",
        "data-meeting-title",
        "data-meeting-date",
        "data-meeting-attendees",
        "data-meeting-event",
        "data-meeting-start",
        "data-meeting-instructions",
        "data-meeting-prompt",
        "data-meeting-part",
        "data-segment",
        "data-start",
        "data-end",
        "data-speaker",
        "data-track",
        "data-session",
        "data-meeting-cite",
        "data-n",
      ],
      // Text direction of blocks (lib/text-direction.ts), only its values.
      ...Object.fromEntries(
        ["p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "ul", "li", "table", "tr"].map((tag) => [tag, [dir]]),
      ),
      // A callout's own symbol and colour name (checked in transformTags).
      aside: [dir, "data-callout-icon", "data-callout-color"],
      a: ["href", "name", "target", "rel"],
      img: ["src", "alt", "width", "height", "data-original", "data-annotations"],
      input: ["type", "checked", "disabled"],
      ol: ["start", dir],
      td: ["colspan", "rowspan", "colwidth", dir],
      th: ["colspan", "rowspan", "colwidth", dir],
      details: ["open", dir],
      video: ["src", "controls", "preload"],
      audio: ["src", "controls", "preload"],
      iframe: ["src", "title", "allowfullscreen", "sandbox", "loading"],
    },
    allowedStyles: {
      "*": {
        "text-align": [/^(left|center|right|justify)$/],
        color: [/^#[0-9a-f]{3,8}$/i],
        "background-color": [/^#[0-9a-f]{3,8}$/i],
        width: [/^(25|50|75)%$/],
      },
    },
    allowedIframeHostnames: embedHosts,
    exclusiveFilter: (frame) => frame.tag === "iframe" && !frame.attribs.src,
    transformTags: {
      // A draw.io block's picture is cleaned as SVG (lib/drawio-svg.ts),
      // its diagram kept only within the limit.
      "*": (tagName, attribs) => {
        const result = transform ? transform(tagName, attribs) : { tagName, attribs };
        return "data-drawio" in result.attribs || "data-drawio-svg" in result.attribs ? drawioAttributes(result) : result;
      },
      // Only the known providers' player URLs survive, not any page on
      // their hosts.
      iframe: (tagName, attribs) =>
        embedProvider(attribs.src || "")
          ? {
              tagName,
              attribs: {
                ...attribs,
                sandbox: "allow-scripts allow-same-origin allow-presentation",
                loading: "lazy",
              },
            }
          : { tagName: "iframe", attribs: {} },
      a: (tagName, attribs) => ({
        tagName,
        attribs: { ...attribs, rel: "noopener noreferrer" },
      }),
      // Only a single emoji or symbol stays a callout's symbol, only a
      // colour name of the palette its colour.
      aside: (tagName, attribs) => {
        const { "data-callout-icon": rawIcon, "data-callout-color": rawColor, ...rest } = attribs;
        const icon = calloutIcon(rawIcon),
          color = calloutColor(rawColor);
        return {
          tagName,
          attribs: { ...rest, ...(icon ? { "data-callout-icon": icon } : {}), ...(color ? { "data-callout-color": color } : {}) },
        };
      },
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowProtocolRelative: false,
  });
}
function drawioAttributes(result: sanitize.Tag): sanitize.Tag {
  const { "data-drawio": xml, "data-drawio-svg": svg, ...rest } = result.attribs;
  if (result.tagName !== "div") return { ...result, attribs: rest };
  return {
    ...result,
    attribs: {
      ...rest,
      "data-drawio": xml && xml.length <= MAX_DRAWIO_XML ? xml : "",
      "data-drawio-svg": svg ? sanitizeDrawioSvg(svg) : "",
    },
  };
}
// HTML ⇄ the editor's Yjs state on the server, as @tiptap/html/server's
// generateJSON/generateHTML do – but with one DOM (happy-dom) for the whole
// process instead of a new window per call (#163). A window let go is only
// torn down once the event loop turns; an import writes thousands of pages
// in one transaction, and every page's window (with its parsed
// document) stayed in memory until the end – the heap ran out.
let shared: { window: Window; schema: Schema } | null = null;
function serverDom() {
  shared ??= {
    window: new Window({
      settings: {
        disableJavaScriptEvaluation: true,
        disableJavaScriptFileLoading: true,
        disableCSSFileLoading: true,
        disableIframePageLoading: true,
        disableComputedStyleRendering: true,
      },
    }),
    schema: documentSchema(),
  };
  return shared;
}
// What @tiptap/html/server's generateJSON(html, documentExtensions) gives.
// The parsed nodes are taken apart afterwards: happy-dom keeps query results
// (querySelector, as parse rules of figures and details use it) in WeakRefs,
// and V8 keeps every WeakRef's target until the running task ends – in a
// synchronous import that would again be every page's whole DOM.
export function htmlJson(html: string): Record<string, unknown> {
  const { window, schema } = serverDom();
  const body = window.document.createElement("body");
  body.innerHTML = html;
  try {
    return SchemaParser.fromSchema(schema).parse(body as unknown as globalThis.Node).toJSON();
  } finally {
    const stack: { lastChild: unknown; removeChild: (child: never) => unknown }[] = [body];
    while (stack.length) {
      const node = stack.pop()!;
      for (let child = node.lastChild; child; child = node.lastChild) {
        node.removeChild(child as never);
        stack.push(child as (typeof stack)[number]);
      }
    }
  }
}
// What generateHTML(json, documentExtensions) gives.
export function jsonHtml(json: Record<string, unknown>) {
  const { window, schema } = serverDom();
  const wrap = window.document.createElement("div");
  DOMSerializer.fromSchema(schema).serializeFragment(
    PMNode.fromJSON(schema, json).content,
    { document: window.document as unknown as Document },
    wrap as unknown as HTMLElement,
  );
  const html = wrap.innerHTML;
  wrap.innerHTML = "";
  return html;
}
export function htmlState(html: string) {
  const doc = prosemirrorJSONToYDoc(serverDom().schema, htmlJson(cleanHtml(html) || "<p></p>"), "default");
  const state = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return state;
}
export function stateHtml(doc: Y.Doc) {
  return cleanHtml(jsonHtml(yDocToProsemirrorJSON(doc, "default")));
}
export function escaped(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
export function markdownHtml(text: string) {
  let html = "",
    inCode = false,
    code = "",
    codeLanguage = "",
    codeMeta = "",
    marker = "";
  // Mermaid fences become code blocks showing the diagram (#95); the fence
  // meta keeps line numbers and the like (lib/code-block-options.ts).
  const renderCode = () =>
    `<pre${importedCodeAttributes(codeLanguage, codeMeta)}><code${codeLanguage ? ` class="language-${escaped(fenceLanguage(codeLanguage))}"` : ""}>${escaped(code)}</code></pre>`;
  for (const line of text.split("\n")) {
    const fence = /^(`{3,}|~{3,})([\w#+.-]*)(?:[ \t]+([^`\n]*?))?\s*$/.exec(line);
    if (
      fence &&
      (!inCode ||
        (!fence[2] &&
          !fence[3] &&
          fence[1][0] === marker[0] &&
          fence[1].length >= marker.length))
    ) {
      if (inCode) {
        html += renderCode();
        code = "";
      } else {
        marker = fence[1];
        codeLanguage = fence[2];
        codeMeta = fence[3] || "";
      }
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      code += line + "\n";
      continue;
    }
    let content = escaped(line)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2">$1</a>');
    const heading = /^(#{1,3}) (.*)$/.exec(content);
    if (heading) {
      html += `<h${heading[1].length}>${heading[2]}</h${heading[1].length}>`;
    } else if (/^[-*] /.test(content)) {
      html += `<ul><li><p>${content.slice(2)}</p></li></ul>`;
    } else if (/^\d+\. /.test(content)) {
      html += `<ol><li><p>${content.replace(/^\d+\. /, "")}</p></li></ol>`;
    } else if (content.startsWith("&gt; ")) {
      html += `<blockquote><p>${content.slice(5)}</p></blockquote>`;
    } else html += `<p>${content}</p>`;
  }
  if (inCode) html += renderCode();
  return cleanHtml(html);
}
