// DOM helpers shared by the importers (Confluence, Evernote, Google Docs,
// DOCX): parse HTML or XML with htmlparser2 and write it back as the
// simple HTML the editor understands. The result is still sanitised by
// cleanHtml when it is stored (lib/importers/write.ts); these helpers only
// shape the structure (blocks, lists, marks, placeholders for files and
// pages).
import { parseDocument, DomUtils } from "htmlparser2";
import type { ChildNode, Element } from "domhandler";

export type { ChildNode, Element };

export const esc = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// HTML (forgiving, entities decoded) or XML (CDATA kept as text).
export function parseHtml(source: string) {
  return parseDocument(source, { decodeEntities: true, recognizeSelfClosing: true, recognizeCDATA: true });
}
export function parseXml(source: string) {
  return parseDocument(source, { xmlMode: true, decodeEntities: true });
}

export const isElement = (node: ChildNode | null | undefined): node is Element =>
  !!node && (node.type === "tag" || node.type === "script" || node.type === "style");
export const text = (node: ChildNode | ChildNode[]) => DomUtils.textContent(node);
export const attr = (el: Element, name: string) => el.attribs[name] ?? "";
export const children = (el: Element) => el.children.filter(isElement);
export function find(root: ChildNode | ChildNode[], test: (el: Element) => boolean, recurse = true) {
  return DomUtils.findAll(test, Array.isArray(root) ? root : [root]).filter(
    (el) => recurse || el.parent === root || (Array.isArray(root) && root.includes(el)),
  );
}
export function findOne(root: ChildNode | ChildNode[], test: (el: Element) => boolean) {
  return DomUtils.findOne(test, Array.isArray(root) ? root : [root], true);
}
export const byTag = (name: string) => (el: Element) => el.name.toLowerCase() === name;
export const hasClass = (el: Element, name: string) => (el.attribs.class || "").split(/\s+/).includes(name);

// Placeholders the importers write for files and pages of the import; the
// writer replaces them with real addresses (or drops them).
export const fileRef = (key: string) => `fp-import://file/${encodeURIComponent(key)}`;
export const pageRef = (key: string) => `fp-import://page/${encodeURIComponent(key)}`;

const INLINE = new Set([
  "a", "abbr", "b", "br", "cite", "code", "del", "em", "font", "i", "img", "kbd", "mark", "q", "s", "samp",
  "small", "span", "strike", "strong", "sub", "sup", "time", "tt", "u", "var",
]);
const CONTAINERS = new Set(["div", "section", "article", "main", "body", "html", "center", "header", "footer", "figure", "en-note", "font"]);
// Elements whose content is never shown.
const DROP = new Set(["script", "style", "noscript", "template", "head", "title", "meta", "link", "iframe", "object", "embed", "svg", "form", "button", "input", "select", "textarea", "nav"]);

// A conversion rule may answer for an element: a string replaces it,
// undefined falls back to the default handling.
export type Rule = (el: Element, inner: () => string, render: (nodes: ChildNode[]) => string) => string | undefined;

type Marks = { bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean };
// Bold, italic, underline and strike-through from inline styles (Google
// Docs, Evernote and Word write formatting that way).
export function styleMarks(style: string): Marks {
  const s = style.toLowerCase().replace(/\s+/g, "");
  return {
    bold: /font-weight:(bold|[6-9]00)/.test(s),
    italic: /font-style:italic/.test(s),
    underline: /text-decoration[a-z-]*:[^;]*underline/.test(s),
    strike: /text-decoration[a-z-]*:[^;]*line-through/.test(s),
  };
}
export function wrapMarks(html: string, marks: Marks) {
  if (!html.trim()) return html;
  let out = html;
  if (marks.strike) out = `<s>${out}</s>`;
  if (marks.underline) out = `<u>${out}</u>`;
  if (marks.italic) out = `<em>${out}</em>`;
  if (marks.bold) out = `<strong>${out}</strong>`;
  return out;
}

export type RenderOptions = {
  rule?: Rule;
  // Extra marks of an element (Google Docs: formatting by CSS class).
  marks?: (el: Element) => Marks;
  // Further tags that sit inside a paragraph (en-media, ac:image, …).
  inline?: Set<string>;
};

// HTML of the given nodes: known tags stay (with the few attributes the
// editor reads), containers become paragraphs or their blocks, everything
// else is unwrapped.
export function renderNodes(nodes: ChildNode[], options: RenderOptions = {}): string {
  const { rule, marks: extraMarks, inline: extraInline } = options;
  const isInlineNode = (node: ChildNode): boolean =>
    node.type === "text" ||
    node.type === "cdata" ||
    (isElement(node) && (INLINE.has(node.name.toLowerCase()) || !!extraInline?.has(node.name.toLowerCase())));
  const render = (list: ChildNode[]): string => list.map(one).join("");
  // Block content: runs of inline nodes become paragraphs.
  const blocks = (list: ChildNode[]): string => {
    let out = "",
      run: ChildNode[] = [];
    const flush = () => {
      const inline = render(run).trim();
      if (inline && inline.replace(/<br\s*\/?>/g, "").trim()) out += `<p>${inline.replace(/^(<br>)+|(<br>)+$/g, "")}</p>`;
      run = [];
    };
    for (const node of list) {
      if (isInlineNode(node)) run.push(node);
      else {
        flush();
        out += one(node);
      }
    }
    flush();
    return out;
  };
  function one(node: ChildNode): string {
    if (node.type === "text") return esc(node.data.replace(/[\r\n\t]+/g, " "));
    if (node.type === "cdata") return esc(text(node));
    if (!isElement(node)) return "";
    const el = node;
    const tag = el.name.toLowerCase();
    const inner = () => render(el.children);
    const custom = rule?.(el, inner, render);
    if (custom !== undefined) return custom;
    if (DROP.has(tag)) return "";
    const marks = { ...styleMarks(el.attribs.style || ""), ...(extraMarks?.(el) || {}) };
    if (CONTAINERS.has(tag)) {
      const allInline = el.children.every(isInlineNode);
      if (allInline && tag !== "body" && tag !== "html") {
        const content = wrapMarks(inner(), marks).trim();
        return content && content.replace(/<br\s*\/?>/g, "").trim() ? `<p>${content.replace(/^(<br>)+|(<br>)+$/g, "")}</p>` : "";
      }
      return blocks(el.children);
    }
    switch (tag) {
      case "p": {
        const content = wrapMarks(inner(), marks).trim();
        if (!el.children.every(isInlineNode)) return blocks(el.children);
        return content ? `<p>${content}</p>` : "";
      }
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": {
        const content = inner().trim();
        return content ? `<${tag}>${content}</${tag}>` : "";
      }
      case "b": case "strong": return wrapMarks(inner(), { ...marks, bold: !/font-weight:\s*(normal|[1-4]00)/i.test(el.attribs.style || "") });
      case "i": case "em": return wrapMarks(inner(), { ...marks, italic: true });
      case "u": return wrapMarks(inner(), { ...marks, underline: true });
      case "s": case "strike": case "del": return wrapMarks(inner(), { ...marks, strike: true });
      case "span": case "font": return wrapMarks(inner(), marks);
      case "code": case "tt": case "kbd": case "samp": {
        if (el.parent && isElement(el.parent) && el.parent.name === "pre") return esc(text(el));
        return `<code>${esc(text(el))}</code>`;
      }
      case "pre": return `<pre><code>${esc(text(el))}</code></pre>`;
      case "mark": case "sub": case "sup": return `<${tag}>${inner()}</${tag}>`;
      case "br": return "<br>";
      case "hr": return "<hr>";
      case "a": {
        const href = el.attribs.href || "";
        const content = inner();
        return href ? `<a href="${esc(href)}">${content || esc(href)}</a>` : content;
      }
      case "img": {
        const src = el.attribs.src || "";
        return src ? `<img src="${esc(src)}" alt="${esc(el.attribs.alt || "")}">` : "";
      }
      case "ul": case "ol": {
        const items = el.children.filter(isElement).map((child) => (child.name.toLowerCase() === "li" ? one(child) : `<li>${one(child)}</li>`));
        const start = tag === "ol" && Number(el.attribs.start) > 1 ? ` start="${Number(el.attribs.start)}"` : "";
        return items.length ? `<${tag}${start}>${items.join("")}</${tag}>` : "";
      }
      case "li": return `<li>${blocks(el.children) || "<p></p>"}</li>`;
      case "blockquote": return `<blockquote>${blocks(el.children) || "<p></p>"}</blockquote>`;
      case "table": {
        const rows = find(el, byTag("tr")).filter((tr) => closestTable(tr) === el);
        if (!rows.length) return "";
        return `<table><tbody>${rows.map((tr) => `<tr>${tr.children.filter(isElement).filter((c) => /^t[dh]$/i.test(c.name)).map((cell) => {
          const span = (name: string) => (Number(cell.attribs[name]) > 1 ? ` ${name}="${Math.min(50, Number(cell.attribs[name]))}"` : "");
          const name = cell.name.toLowerCase();
          return `<${name}${span("colspan")}${span("rowspan")}>${blocks(cell.children) || "<p></p>"}</${name}>`;
        }).join("")}</tr>`).join("")}</tbody></table>`;
      }
      case "details": {
        const summary = el.children.find((c) => isElement(c) && c.name === "summary");
        const rest = el.children.filter((c) => c !== summary);
        return `<details><summary>${summary ? esc(text(summary).trim()) : ""}</summary><div>${blocks(rest) || "<p></p>"}</div></details>`;
      }
      case "aside": {
        const type = el.attribs["data-callout"] || "note";
        return `<aside data-callout="${esc(type)}">${blocks(el.children) || "<p></p>"}</aside>`;
      }
      default:
        if (el.children.some((c) => !isInlineNode(c))) return blocks(el.children);
        {
          const content = wrapMarks(inner(), marks).trim();
          return content ? `<p>${content}</p>` : "";
        }
    }
  }
  return blocks(nodes);
}
function closestTable(el: Element) {
  let node = el.parent;
  while (node && !(isElement(node as ChildNode) && (node as Element).name.toLowerCase() === "table")) node = node.parent;
  return node;
}

// A one-item task list; neighbouring ones (one per Evernote or Confluence
// line) become one list through mergeLists.
export const taskItem = (checked: boolean, content: string) =>
  `<ul data-type="taskList"><li data-type="taskItem" data-checked="${checked}"><p>${content}</p></li></ul><!--task-->`;
export const mergeLists = (html: string) =>
  html.replace(/<\/ul><!--task--><ul data-type="taskList">/g, "").replace(/<!--task-->/g, "");

// A file name's MIME type, by extension.
const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif",
  svg: "image/svg+xml", bmp: "image/bmp", pdf: "application/pdf", txt: "text/plain", csv: "text/csv", zip: "application/zip",
  mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
export const mimeOf = (name: string) => MIME[name.split(".").pop()?.toLowerCase() || ""] || "application/octet-stream";
export const isImage = (mime: string) => /^image\/(png|jpeg|gif|webp|avif)$/.test(mime);
export const EXT_BY_MIME: Record<string, string> = Object.fromEntries(
  Object.entries(MIME).map(([ext, mime]) => [mime, ext]).reverse(),
);

// Nested lists from items with a level (Word and Google Docs write every
// level as a list of its own).
export type ListItem = { level: number; ordered: boolean; html: string };
export function nestedList(items: ListItem[]) {
  let out = "";
  const stack: boolean[] = [];
  for (const item of items) {
    while (stack.length > item.level + 1) out += `</li></${stack.pop() ? "ol" : "ul"}>`;
    if (stack.length === item.level + 1) out += "</li>";
    while (stack.length < item.level + 1) {
      stack.push(item.ordered);
      out += item.ordered ? "<ol>" : "<ul>";
    }
    out += `<li>${/^<(p|ul|ol|table|blockquote|pre|h\d)\b/.test(item.html) ? item.html : `<p>${item.html}</p>`}`;
  }
  while (stack.length) out += `</li></${stack.pop() ? "ol" : "ul"}>`;
  return out;
}
