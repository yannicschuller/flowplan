import { Window } from "happy-dom";
import { DOMParser as SchemaParser, DOMSerializer, Node as PMNode, type Schema } from "@tiptap/pm/model";
import { embedHosts, embedProvider } from "./embed-providers";
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from "y-prosemirror";
import * as Y from "yjs";
import sanitize from "sanitize-html";
import { documentSchema } from "./document-schema";
import { calloutColor, calloutIcon } from "./callout-types";
import { BLOCK_COLOR_VALUES } from "./block-colors";
import { fenceLanguage } from "./code-languages";
import { importedCodeAttributes } from "./code-block-options";
import { sanitizeDrawioSvg } from "./drawio-svg";
import { MAX_DRAWIO_XML } from "./drawio";
import { cleanFlowSource, cleanFlowUnit } from "./flow-diagram";
import { isPageBreakStyle } from "./page-break-node";
import { occlusionAttribute } from "./study-occlusion";
import { MEETING_LANGUAGES } from "./meeting-core";
import { COLUMN_WIDTH_VALUES } from "./columns-block";
const dir = { name: "dir", multiple: false, values: ["ltr", "rtl", "auto"] };
// Block and cell colours (#238, #240, lib/block-colors.ts) and toggle headings: only their names.
const blockColorAttr = { name: "data-block-color", multiple: false, values: BLOCK_COLOR_VALUES };
const toggleHeadingAttr = { name: "data-heading", multiple: false, values: ["1", "2", "3", "4"] };
// A meeting's language (lib/meeting-schema.ts): only the languages it offers.
const meetingLanguageAttr = { name: "data-meeting-language", multiple: false, values: [...MEETING_LANGUAGES] };
// A column's width in percent (lib/columns-block.ts): only the whole numbers it may have.
const columnWidthAttr = { name: "data-width", multiple: false, values: COLUMN_WIDTH_VALUES };
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
        "data-journal-continued",
        "data-journal-was",
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
        // A 3D file's card (#384, lib/document-schema.ts).
        "data-model",
        // An HTML file's card (#398, lib/document-schema.ts).
        "data-html-file",
        // A spreadsheet's card (#402, lib/document-schema.ts).
        "data-sheet-file",
        // A presentation's or text document's card (#562, lib/document-schema.ts).
        "data-office-file",
        "data-title",
        "data-spoiler",
        // A gap of a flashcard (lib/cloze-mark.ts).
        "data-cloze",
        "data-cloze-hint",
        "data-indent",
        "data-callout",
        "data-math",
        "data-mermaid",
        "data-drawio",
        "data-drawio-svg",
        "data-function-plot",
        // A flow diagram's text and unit (#427), cut to their limits below.
        "data-flow-diagram",
        "data-flow-unit",
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
        // The tabs block (#272, lib/tabs-block.ts).
        "data-tabs",
        "data-tab",
        "data-tab-body",
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
        // The page break block (#216, lib/page-break-node.ts).
        "data-page-break",
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
        "data-hallucination",
        "data-edited",
        "data-hash",
        "data-meeting-cite",
        "data-n",
        "data-cite-start",
      ],
      // Text direction of blocks (lib/text-direction.ts), only its values.
      ...Object.fromEntries(
        ["p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "ul", "li", "table", "tr"].map((tag) => [
          tag,
          ["p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "li"].includes(tag) ? [dir, blockColorAttr] : [dir],
        ]),
      ),
      // A callout's own symbol and colour name (checked in transformTags).
      aside: [dir, "data-callout-icon", "data-callout-color"],
      // data-page-link: a page link as a chip (#466, lib/page-chip.ts).
      a: ["href", "name", "target", "rel", { name: "data-page-link", multiple: false, values: [""] }],
      img: ["src", "alt", "width", "height", "data-original", "data-annotations", "data-occlusion", { name: "data-align", multiple: false, values: ["center", "right"] }],
      input: ["type", "checked", "disabled"],
      ol: ["start", dir],
      // Cell colours (#240): only the names, like blocks.
      td: ["colspan", "rowspan", "colwidth", dir, blockColorAttr],
      th: ["colspan", "rowspan", "colwidth", dir, blockColorAttr],
      details: ["open", dir, blockColorAttr, toggleHeadingAttr],
      // The meeting block's language (on its <div data-meeting>), a
      // column's width.
      div: [meetingLanguageAttr, columnWidthAttr],
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
      // A page break from Word, Google Docs or Markdown
      // (<div style="page-break-after: always">) becomes the block (#216).
      "*": (tagName, attribs) => {
        const result = transform ? transform(tagName, attribs) : { tagName, attribs };
        if (result.tagName === "div" && isPageBreakStyle(result.attribs.style)) result.attribs = { ...result.attribs, "data-page-break": "", class: "page-break" };
        // Image occlusion masks only as Flowplan writes them (lib/study-occlusion.ts).
        if ("data-occlusion" in result.attribs) {
          const { "data-occlusion": raw, ...rest } = result.attribs;
          const masks = result.tagName === "img" ? occlusionAttribute(raw) : null;
          result.attribs = masks ? { ...rest, "data-occlusion": masks } : rest;
        }
        if ("data-flow-diagram" in result.attribs || "data-flow-unit" in result.attribs) result.attribs = flowAttributes(result);
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
// A flow diagram's source and unit only on its <div>, within their limits.
function flowAttributes(result: sanitize.Tag): sanitize.Attributes {
  const { "data-flow-diagram": source, "data-flow-unit": unit, ...rest } = result.attribs;
  if (result.tagName !== "div" || source === undefined) return rest;
  return { ...rest, "data-flow-diagram": cleanFlowSource(source), "data-flow-unit": cleanFlowUnit(unit) };
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
  return cleanHtmlState(cleanHtml(html));
}
// The same for HTML that has been through cleanHtml already (the import
// writes thousands of pages, #594: it cleans each page once).
export function cleanHtmlState(clean: string) {
  const doc = prosemirrorJSONToYDoc(serverDom().schema, htmlJson(clean || "<p></p>"), "default");
  const state = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return state;
}
// Merges a saved update into the stored document. A new page starts as a
// single empty paragraph (htmlState("") when it is first opened). Content
// written from scratch for it – "Umwandeln in → Seite", scripts and tests
// that build a document on their own – does not build on that paragraph,
// so Yjs keeps both, and the random client ids decide whether the empty
// line ends up above or below the content. Such an update replaces the
// blank page instead: the empty paragraph is deleted (a tombstone, so a
// copy of it that comes back later stays deleted). Updates of editors that
// loaded the page refer to its paragraph and merge as usual.
//
// An editor may have typed into that paragraph before it heard of the
// replacement. Yjs drops an insert into a deleted element (it lands deleted
// and is garbage-collected), so such text is re-attached: the deleted
// paragraph's id is recorded in the document (REPLACED_BLANKS), and an
// update that puts something into it gets the paragraph rebuilt from the
// update alone (rebuiltBlank) and inserted as a new paragraph where the
// deleted one stands. That is where Yjs puts the paragraph when the typed
// text arrives first (the page is not blank then and both merge as usual),
// so both orders give the same document: the typed text above or below the
// content, as the client ids order the two. The other ways out do not work
// with Yjs: a deleted item cannot be revived, nothing moves an item, and
// handing the editor's own items to another parent would leave the editor
// and the server with different documents (the editor keeps its items where
// it put them). Keeping the empty paragraph until it gets text would leave
// the empty line this replacement exists to avoid. Limits: what the editor
// sends in a later update into the text it already sent (keystrokes made
// while that save was on its way, before the editor applied the answer) is
// not re-attached, nor is a second editor's text into the same paragraph
// merged into the first one's copy – each becomes a paragraph of its own.
//
// Returns the state vector of what was written for the sender – the update
// and text re-attached for it, not the record of a replaced paragraph – for
// "who wrote what" (lib/document-authors.ts).
export function applyDocumentUpdate(doc: Y.Doc, update: Uint8Array) {
  const fragment = doc.getXmlFragment("default");
  const only = fragment.length === 1 ? fragment.get(0) : null;
  const blank = only instanceof Y.XmlElement && only.nodeName === "paragraph" && only.length === 0;
  // The server's own changes go in a transaction apart from the update's:
  // Yjs takes one that applies an update for a remote one and gives the
  // document a new client id when it also wrote with its own.
  if (blank && independentUpdate(doc, update)) {
    Y.applyUpdate(doc, update);
    const written = Y.encodeStateVector(doc);
    const id = only._item!.id;
    // Its blocks deleted again within it: the page keeps its paragraph.
    if (fragment.length > 1)
      doc.transact(() => {
        fragment.delete(fragment.toArray().indexOf(only), 1);
        doc.getMap(REPLACED_BLANKS).set(`${id.client}:${id.clock}`, true);
      });
    return written;
  }
  const replaced = doc.getMap(REPLACED_BLANKS);
  const copies = replaced.size ? reattached(doc, update, replaced) : [];
  Y.applyUpdate(doc, update);
  if (copies.length)
    doc.transact(() => {
      for (const { at, paragraph } of copies) {
        const index = liveBefore(fragment, at);
        if (index !== null) fragment.insert(index, [paragraph]);
      }
    });
  return Y.encodeStateVector(doc);
}
// The ids ("client:clock") of blank paragraphs replaced by content written
// from scratch (applyDocumentUpdate), a map at the document's root: editors
// read only the "default" fragment.
const REPLACED_BLANKS = "replacedBlanks";
// For each replaced blank paragraph that `update` puts something new into:
// the paragraph as the update makes it, as a copy to insert.
function reattached(doc: Y.Doc, update: Uint8Array, replaced: Y.Map<unknown>) {
  const known = Y.decodeStateVector(Y.encodeStateVector(doc));
  const targets = new Map<string, Y.ID>();
  for (const s of Y.decodeUpdate(update).structs) {
    if (!(s instanceof Y.Item) || !(s.parent instanceof Y.ID)) continue;
    // Repeated delivery: only what the document does not have yet.
    if (s.id.clock + s.length <= (known.get(s.id.client) || 0)) continue;
    const key = `${s.parent.client}:${s.parent.clock}`;
    if (replaced.has(key)) targets.set(key, s.parent);
  }
  const copies: { at: Y.ID; paragraph: Y.XmlElement }[] = [];
  for (const at of targets.values()) {
    const paragraph = rebuiltBlank(doc, update, at);
    if (paragraph) copies.push({ at, paragraph });
  }
  return copies;
}
// The blank paragraph `at` as `update` fills it, rebuilt in a document of
// its own where it is not deleted: the paragraph at the same id (after
// filler for the client's earlier clocks), then the update and whatever the
// stored document holds back for missing parts (updates out of order).
// A copy of its content, or null when nothing visible came into it.
function rebuiltBlank(doc: Y.Doc, update: Uint8Array, at: Y.ID) {
  const scratch = new Y.Doc({ gc: false });
  try {
    scratch.clientID = at.client;
    if (at.clock) scratch.getText("filler").insert(0, "x".repeat(at.clock));
    const paragraph = new Y.XmlElement("paragraph");
    scratch.getXmlFragment("default").insert(0, [paragraph]);
    // Done writing as that client (Yjs warns when an update brings its own id).
    scratch.clientID = at.client ? 0 : 1;
    Y.applyUpdate(scratch, update);
    const pending = (doc.store as unknown as { pendingStructs: { update: Uint8Array } | null; pendingDs: Uint8Array | null });
    if (pending.pendingStructs) Y.applyUpdate(scratch, pending.pendingStructs.update);
    if (pending.pendingDs) Y.applyUpdate(scratch, pending.pendingDs);
    const visible = paragraph.toArray().some((child) => !(child instanceof Y.XmlText) || child.length > 0);
    return visible ? (paragraph.clone() as Y.XmlElement) : null;
  } finally {
    scratch.destroy();
  }
}
// How many visible blocks of the fragment come before the (deleted) item
// with id `at`; null when it is not in the fragment.
function liveBefore(fragment: Y.XmlFragment, at: Y.ID) {
  let index = 0;
  for (let item = fragment._start; item; item = item.right) {
    if (item.id.client === at.client && item.id.clock <= at.clock && at.clock < item.id.clock + item.length) return index;
    if (!item.deleted && item.countable) index += item.length;
  }
  return null;
}
// Whether an update neither contains nor refers to anything of `doc` and
// puts content into the page (a block at the fragment's top level): one
// without any keeps the blank paragraph.
function independentUpdate(doc: Y.Doc, update: Uint8Array) {
  const known = Y.decodeStateVector(Y.encodeStateVector(doc));
  const ours = (id: unknown) => id instanceof Y.ID && known.has(id.client);
  const { structs, ds } = Y.decodeUpdate(update);
  if (!structs.some((s) => s instanceof Y.Item && (s.parent as unknown) === "default")) return false;
  if ([...ds.clients.keys()].some((client) => known.has(client))) return false;
  return structs.every(
    (s) =>
      !known.has(s.id.client) &&
      !(s instanceof Y.Item && (ours(s.origin) || ours(s.rightOrigin) || ours(s.parent))),
  );
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
