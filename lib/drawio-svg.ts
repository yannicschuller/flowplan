// The picture of a draw.io block (lib/drawio.ts), cleaned before it is
// stored (editor) and whenever stored HTML is cleaned (lib/document-server.ts):
// only drawing elements and the HTML of draw.io's labels (in
// <foreignObject>), no scripts, styles sheets, event handlers, frames or
// animations, and no address that loads anything – only references within
// the picture (#id) and embedded data: images. Links on shapes keep their
// web address (they load nothing). It is shown as an <img> anyway
// (lib/drawio-preview.ts), where nothing of it could run.
import sanitize from "sanitize-html";
import { MAX_DRAWIO_SVG } from "./drawio";

const SVG_TAGS = [
  "svg", "g", "defs", "symbol", "use", "title", "desc", "switch", "a",
  "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
  "text", "tspan", "textPath", "image", "foreignObject",
  "clipPath", "mask", "pattern", "marker", "linearGradient", "radialGradient", "stop",
  "filter", "feGaussianBlur", "feOffset", "feBlend", "feFlood", "feComposite", "feMerge", "feMergeNode",
  "feColorMatrix", "feDropShadow", "feMorphology", "feComponentTransfer", "feFuncA", "feFuncR", "feFuncG", "feFuncB",
];
// Labels with formatting are HTML inside <foreignObject>.
const LABEL_TAGS = [
  "div", "span", "p", "br", "b", "strong", "i", "em", "u", "s", "strike", "sub", "sup", "font", "small", "big",
  "ul", "ol", "li", "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "colgroup", "col",
  "h1", "h2", "h3", "h4", "h5", "h6", "pre", "code", "blockquote", "hr", "img",
];
const REFERENCES = new Set(["href", "xlink:href", "src"]);
// Attributes that load, submit or redirect anything.
const DROPPED = new Set(["srcset", "action", "formaction", "srcdoc", "xml:base", "ping", "background", "poster", "data", "codebase", "dynsrc", "lowsrc"]);
// Presentation attributes that may hold url(…).
const PAINT = /^(fill|stroke|filter|clip-path|mask|marker|marker-start|marker-mid|marker-end|cursor)$/i;
const DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp|bmp|svg\+xml)[;,]/i;

// A reference that stays: #id everywhere, data: images in pictures, web
// and mail addresses on links.
function reference(tag: string, value: string): string | null {
  const text = value.trim();
  if (text.startsWith("#")) return text;
  if ((tag === "image" || tag === "img") && DATA_IMAGE.test(text)) return text;
  if (tag === "a" && /^(https?:|mailto:)/i.test(text)) return text;
  return null;
}
// CSS without anything that loads or runs: url() only within the picture
// or for data: images, no @import, no expression() or bindings.
export function inertSvgCss(css: string) {
  return css
    .replace(/@import[^;]*;?/gi, "")
    .replace(/expression\s*\(/gi, "none(")
    .replace(/(-moz-binding|behavior)\s*:[^;]*;?/gi, "")
    .replace(/(?:-webkit-)?image-set\s*\([^)]*\)/gi, "none")
    .replace(/url\s*\(\s*(["']?)([^)]*?)\1\s*\)/gi, (whole, _quote, address: string) =>
      address.trim().startsWith("#") || DATA_IMAGE.test(address.trim()) ? whole : "none",
    );
}
function attributes(tag: string, input: Record<string, string>) {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(input)) {
    const lower = name.toLowerCase();
    if (lower.startsWith("on") || DROPPED.has(lower)) continue;
    // The diagram itself is stored next to the picture (lib/drawio.ts
    // puts it back for exported files).
    if (tag === "svg" && lower === "content") continue;
    if (REFERENCES.has(lower)) {
      const kept = reference(tag, value);
      if (kept !== null) out[name] = kept;
      continue;
    }
    if (lower === "style") {
      out[name] = inertSvgCss(value);
      continue;
    }
    if (PAINT.test(lower) && /url\s*\(/i.test(value)) {
      out[name] = inertSvgCss(value);
      continue;
    }
    // <a target=…> opens nothing by itself; anything javascript: is gone above.
    if (/javascript:|vbscript:/i.test(value)) continue;
    out[name] = value;
  }
  return out;
}

const cache = new Map<string, string>();
// The cleaned picture, or "" when nothing usable (no <svg>, too large).
export function sanitizeDrawioSvg(svg: string): string {
  if (typeof svg !== "string" || !svg) return "";
  const cached = cache.get(svg);
  if (cached !== undefined) return cached;
  let result = "";
  // Without XML declaration and DOCTYPE (no entities of its own).
  const start = svg.search(/<svg[\s>]/i);
  if (start >= 0 && svg.length <= MAX_DRAWIO_SVG * 2) {
    // XML knows no &nbsp; (labels written as HTML may carry it).
    const clean = sanitize(svg.slice(start).replaceAll("&nbsp;", "&#160;"), {
      parser: { xmlMode: true, decodeEntities: true },
      allowedTags: [...SVG_TAGS, ...LABEL_TAGS],
      // Every attribute passes to transformTags, which keeps the safe ones.
      allowedAttributes: false,
      allowedSchemes: ["http", "https", "mailto"],
      allowedSchemesByTag: { image: ["data"], img: ["data"] },
      allowProtocolRelative: false,
      disallowedTagsMode: "discard",
      nonTextTags: ["script", "style", "textarea", "option", "noscript", "iframe", "object", "embed"],
      selfClosing: ["br", "hr", "img", "col"],
      transformTags: { "*": (tagName, attribs) => ({ tagName, attribs: attributes(tagName, attribs) }) },
    }).trim();
    if (/^<svg[\s>]/.test(clean) && clean.length <= MAX_DRAWIO_SVG) result = clean;
  }
  cache.set(svg, result);
  if (cache.size > 16) cache.delete(cache.keys().next().value!);
  return result;
}
