import { generateJSON, generateHTML } from "@tiptap/html/server";
import { embedHosts, embedProvider } from "./embed-providers";
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from "y-prosemirror";
import * as Y from "yjs";
import sanitize from "sanitize-html";
import { documentExtensions, documentSchema } from "./document-schema";
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
        "data-spoiler",
        "data-callout",
        "data-math",
        "data-mermaid",
        "data-code-wrap",
        "data-linked-database",
        "data-whiteboard",
        "data-whiteboard-height",
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
      ],
      a: ["href", "name", "target", "rel"],
      img: ["src", "alt", "width", "height"],
      input: ["type", "checked", "disabled"],
      ol: ["start"],
      td: ["colspan", "rowspan", "colwidth"],
      th: ["colspan", "rowspan", "colwidth"],
      details: ["open"],
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
      ...(transform ? { "*": transform } : {}),
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
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowProtocolRelative: false,
  });
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
    marker = "";
  const renderCode = () =>
    codeLanguage.toLowerCase() === "mermaid"
      ? `<div class="mermaid-block" data-mermaid="${escaped(code)}">${escaped(code)}</div>`
      : `<pre><code${codeLanguage ? ` class="language-${escaped(codeLanguage)}"` : ""}>${escaped(code)}</code></pre>`;
  for (const line of text.split("\n")) {
    const fence = /^(`{3,}|~{3,})([\w#+.-]*)\s*$/.exec(line);
    if (
      fence &&
      (!inCode ||
        (!fence[2] &&
          fence[1][0] === marker[0] &&
          fence[1].length >= marker.length))
    ) {
      if (inCode) {
        html += renderCode();
        code = "";
      } else {
        marker = fence[1];
        codeLanguage = fence[2];
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
