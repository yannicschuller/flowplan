import { generateJSON, generateHTML } from "@tiptap/html/server";
import { embedHosts, embedProvider } from "./embed-providers";
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from "y-prosemirror";
import * as Y from "yjs";
import sanitize from "sanitize-html";
import { documentExtensions, documentSchema } from "./document-schema";
import { calloutColor, calloutIcon } from "./callout-types";
import { fenceLanguage } from "./code-languages";
import { importedCodeAttributes } from "./code-block-options";
import { sanitizeDrawioSvg } from "./drawio-svg";
import { MAX_DRAWIO_XML } from "./drawio";
const dir = { name: "dir", multiple: false, values: ["ltr", "rtl", "auto"] };
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
export function htmlState(html: string) {
  const json = generateJSON(cleanHtml(html) || "<p></p>", documentExtensions);
  const doc = prosemirrorJSONToYDoc(documentSchema(), json, "default");
  const state = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return state;
}
export function stateHtml(doc: Y.Doc) {
  return cleanHtml(
    generateHTML(yDocToProsemirrorJSON(doc, "default"), documentExtensions),
  );
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
