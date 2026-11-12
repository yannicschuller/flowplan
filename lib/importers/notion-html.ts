// Notion's HTML export ("Export → HTML", #234): one .html file per page,
// subpages and files in a folder named like the page, databases as CSV
// beside their HTML table. The Markdown/CSV ZIP import (lib/zip-import.ts)
// reads the files, the page tree and the databases; this turns one page's
// HTML into the HTML the editor understands. Unlike the Markdown export it
// keeps toggles, toggle headings, callouts, colours and to-dos.
//
// What Notion writes (the parts that matter here):
// - every list item as a list of its own (<ul class="bulleted-list">,
//   <ol class="numbered-list" type="a" start="2">, <ul class="to-do-list">),
//   nested lists inside the item – neighbours are merged into one list;
// - toggles as <ul class="toggle"><li><details><summary>, toggle headings
//   as <details> with an <h1>–<h3> in the summary (or a summary styled as
//   one);
// - callouts as <figure class="callout block-color-…"> with the icon in
//   the first <div>, the text in the second;
// - colours as classes: highlight-red (text) and highlight-red_background
//   (highlight) on <mark>, block-color-… on blocks;
// - images as <figure class="image"><a><img></a><figcaption>, other files
//   as <figure><div class="source"><a href>…</a></div></figure>.
// The result is still sanitised when it is stored (cleanHtml).
import {
  attr, byTag, children, esc, find, findOne, hasClass, isElement, parseHtml, renderNodes,
  type ChildNode, type Element, type Rule,
} from "./html";
import { DomUtils } from "htmlparser2";
import { CALLOUT_COLORS, calloutIcon, type CalloutColor } from "../callout-types";
import { highlightColors } from "../text-marks";
import type { PageTagColor } from "../page-properties";

// Notion's colour names → the editor's palette (lib/text-marks.ts).
const COLOR_NAMES: Record<string, CalloutColor> = {
  gray: "gray",
  grey: "gray",
  brown: "brown",
  orange: "orange",
  yellow: "yellow",
  teal: "green",
  green: "green",
  blue: "blue",
  purple: "purple",
  pink: "pink",
  red: "red",
};
const PALETTE = Object.keys(CALLOUT_COLORS) as CalloutColor[];
// "red" / "red_background" from a class list with the given prefix.
export function notionColor(el: Element, prefix: "highlight-" | "block-color-") {
  for (const name of (el.attribs.class || "").split(/\s+/)) {
    if (!name.startsWith(prefix)) continue;
    const [base, background] = name.slice(prefix.length).split("_");
    const color = COLOR_NAMES[base];
    if (color) return { color, background: background === "background" };
  }
  return null;
}
// Text coloured or highlighted as the editor stores it.
function colored(html: string, color: { color: CalloutColor; background: boolean } | null) {
  if (!color || !html.trim()) return html;
  if (color.background) {
    const hex = highlightColors[PALETTE.indexOf(color.color)][1];
    return `<mark data-color="${hex}" style="background-color: ${hex}">${html}</mark>`;
  }
  return `<span style="color: ${CALLOUT_COLORS[color.color]}">${html}</span>`;
}

const LIST_KINDS = ["bulleted-list", "numbered-list", "to-do-list"];
const listKind = (el: Element) => (["ul", "ol"].includes(el.name) ? LIST_KINDS.find((kind) => hasClass(el, kind)) : undefined);
const nextElement = (node: ChildNode) => {
  for (let at = node.next; at; at = at.next) {
    if (isElement(at)) return at;
    if (at.type === "text" && at.data.trim()) return null;
  }
  return null;
};
// One list per run of neighbouring items of the same kind, at every depth.
function mergeLists(root: Element) {
  for (const el of find(root, (e) => !!listKind(e))) {
    if (!el.parent) continue;
    const kind = listKind(el);
    let next = nextElement(el);
    while (next && next.name === el.name && listKind(next) === kind) {
      for (const li of children(next)) DomUtils.appendChild(el, li);
      const after = nextElement(next);
      DomUtils.removeElement(next);
      next = after;
    }
  }
}

// A toggle heading's level (1–3): an <h1>–<h3> in its summary, or a summary
// styled as one (font-size 1.875em, 1.5em, 1.25em).
export function summaryHeading(summary: Element | undefined) {
  if (!summary) return null;
  const heading = children(summary).find((c) => /^h[1-6]$/.test(c.name));
  if (heading) return Math.min(3, Number(heading.name[1]));
  const size = /font-size:\s*([\d.]+)em/.exec(attr(summary, "style"))?.[1];
  return size ? ({ "1.875": 1, "1.5": 2, "1.25": 3 } as Record<string, number>)[size] ?? null : null;
}
const summaryOf = (details: Element) => children(details).find((c) => c.name === "summary");
// The <details> of a toggle block: itself, or inside <ul class="toggle"><li>.
function toggleDetails(el: Element): Element | null {
  if (el.name === "details") return el;
  if (el.name === "ul" && hasClass(el, "toggle")) {
    const items = children(el).filter((c) => c.name === "li");
    const details = items.length === 1 ? children(items[0]).find((c) => c.name === "details") : undefined;
    return details || null;
  }
  return null;
}
const headingLevel = (el: Element) => {
  if (/^h[1-6]$/.test(el.name)) return Number(el.name[1]);
  const details = toggleDetails(el);
  return details ? summaryHeading(summaryOf(details)) : null;
};

// Toggle headings at the top of the page become headings – which fold in
// Flowplan (#71) – when the heading's section is exactly the toggle's
// content: the next block is a heading of the same or a higher level (or
// there is none) and the content has no such heading itself. Any other
// toggle heading becomes a toggle with the heading's text as its title.
function headingToggles(body: Element) {
  const result = new Set<Element>();
  for (const block of children(body)) {
    const details = toggleDetails(block);
    const level = details && summaryHeading(summaryOf(details));
    if (!details || !level) continue;
    const next = nextElement(block);
    const nextLevel = next ? headingLevel(next) : 0;
    if (next && !(nextLevel && nextLevel <= level)) continue;
    const content = children(details).filter((c) => c.name !== "summary");
    const inner = content.flatMap((c) => (c.name === "div" && hasClass(c, "indented") ? children(c) : [c]));
    if (inner.some((c) => (headingLevel(c) ?? 9) <= level)) continue;
    result.add(details);
  }
  return result;
}

// The TeX of a KaTeX formula as Notion exports it.
const tex = (el: Element) => {
  const annotation = findOne(el, (c) => c.name === "annotation" && attr(c, "encoding") === "application/x-tex");
  return annotation ? DomUtils.textContent(annotation).trim() : DomUtils.textContent(el).trim();
};

export type NotionPage = { title: string | null; html: string };

// One page of the export: its title (the page's <h1 class="page-title">)
// and its content as editor HTML. Links and images keep the export's
// relative addresses; the import resolves them.
export function notionHtmlPage(source: string): NotionPage {
  const doc = parseHtml(source);
  const titleEl = findOne(doc.children, (el) => el.name === "h1" && hasClass(el, "page-title"));
  const title = titleEl ? DomUtils.textContent(titleEl).replace(/\s+/g, " ").trim() || null : null;
  const body =
    findOne(doc.children, (el) => hasClass(el, "page-body")) ||
    findOne(doc.children, byTag("article")) ||
    findOne(doc.children, byTag("body"));
  if (!body) return { title, html: "" };
  // Scripts and styles never count (KaTeX brings a <style> per formula).
  for (const el of find(body, (e) => ["script", "style", "noscript", "template"].includes(e.name))) DomUtils.removeElement(el);
  mergeLists(body);
  const asHeading = headingToggles(body);
  const options = {
    rule: undefined as Rule | undefined,
    // Notion underlines with a border.
    marks: (el: Element) => ({ underline: /border-bottom:\s*0\.05em solid/.test(attr(el, "style")) }),
  };
  const blocks = (nodes: ChildNode[]) => renderNodes(nodes, options);
  const toggle = (details: Element) => {
    const summary = summaryOf(details);
    const rest = details.children.filter((c) => c !== summary);
    const level = summaryHeading(summary);
    const titleText = summary ? DomUtils.textContent(summary).replace(/\s+/g, " ").trim() : "";
    if (level && asHeading.has(details)) return `<h${level}>${esc(titleText)}</h${level}>${blocks(rest)}`;
    return `<details><summary>${esc(titleText)}</summary><div>${blocks(rest) || "<p></p>"}</div></details>`;
  };
  const rule: Rule = (el, inner, render) => {
    const tag = el.name;
    // Icons of links and page mentions: the page's emoji or picture.
    if ((tag === "span" || tag === "img") && hasClass(el, "icon")) return "";
    if (tag === "mark" || (tag === "span" && notionColor(el, "highlight-"))) return colored(inner(), notionColor(el, "highlight-"));
    if (tag === "span" && hasClass(el, "notion-text-equation-token")) return `<code>${esc(tex(el))}</code>`;
    if (tag === "details") return toggle(el);
    if (tag === "ul" && hasClass(el, "toggle"))
      return children(el)
        .filter((li) => li.name === "li")
        .map((li) => {
          const details = children(li).find((c) => c.name === "details");
          return details ? toggle(details) : blocks(li.children);
        })
        .join("");
    if (tag === "ul" && hasClass(el, "to-do-list")) {
      const items = children(el)
        .filter((li) => li.name === "li")
        .map((li) => {
          const box = find(li, (c) => hasClass(c, "checkbox"), true)[0];
          const checked = !!box && hasClass(box, "checkbox-on");
          const label = children(li).find((c) => c.name === "span" && /\bto-do-children-/.test(attr(c, "class")));
          const rest = li.children.filter((c) => c !== label && c !== box && !(isElement(c) && hasClass(c, "checkbox")));
          const text = label ? render(label.children).trim() : "";
          return `<li data-type="taskItem" data-checked="${checked}"><p>${text}</p>${blocks(rest)}</li>`;
        });
      return items.length ? `<ul data-type="taskList">${items.join("")}</ul>` : "";
    }
    if (tag === "figure" && hasClass(el, "callout")) {
      const parts = children(el).filter((c) => c.name === "div");
      const iconPart = parts.length > 1 ? parts[0] : undefined;
      const iconText = iconPart ? DomUtils.textContent(iconPart).trim() : "";
      const icon = calloutIcon(iconText);
      const color = notionColor(el, "block-color-");
      const content = parts.length > 1 ? parts.slice(1).flatMap((p) => p.children) : el.children.filter((c) => c !== iconPart);
      const own = (icon ? ` data-callout-icon="${esc(icon)}"` : "") + (color ? ` data-callout-color="${color.color}"` : "");
      return `<aside data-callout="note"${own}>${blocks(content) || "<p></p>"}</aside>`;
    }
    if (tag === "figure" && hasClass(el, "image")) {
      const img = findOne(el, byTag("img"));
      const link = findOne(el, byTag("a"));
      const src = (img && attr(img, "src")) || (link && attr(link, "href")) || "";
      if (!src) return "";
      const caption = findOne(el, byTag("figcaption"));
      const captionText = caption ? DomUtils.textContent(caption).replace(/\s+/g, " ").trim() : "";
      const image = `<img src="${esc(src)}" alt="${esc((img && attr(img, "alt")) || captionText)}">`;
      return captionText ? `<figure>${image}<figcaption>${esc(captionText)}</figcaption></figure>` : image;
    }
    const bookmark = tag === "figure" ? findOne(el, (c) => c.name === "a" && hasClass(c, "bookmark") && !!attr(c, "href")) : null;
    if (bookmark) {
      const link = bookmark;
      const titleEl = findOne(el, (c) => hasClass(c, "bookmark-title"));
      const label = (titleEl && DomUtils.textContent(titleEl).trim()) || attr(link, "href");
      return `<p><a href="${esc(attr(link, "href"))}">${esc(label)}</a></p>`;
    }
    if (tag === "figure" && hasClass(el, "equation")) return `<div data-math="${esc(tex(el))}"></div>`;
    // A block's colour: on its text (the editor has no block colours).
    if (/^(p|h[1-6])$/.test(tag)) {
      const color = notionColor(el, "block-color-");
      if (!color || !el.children.every((c) => !isElement(c) || !["div", "ul", "ol", "figure", "details"].includes(c.name))) return undefined;
      const content = inner().trim();
      return content ? `<${tag}>${colored(content, color)}</${tag}>` : "";
    }
    return undefined;
  };
  options.rule = rule;
  return { title, html: blocks(body.children) };
}

// Notion's own page files (an export may hold other HTML too).
export const isNotionHtml = (source: string) => /<div[^>]*\bclass="[^"]*\bpage-body\b/.test(source) || /<article[^>]*\bclass="page\b/.test(source);

// Colours of select and multi-select values (#242): Notion writes each
// value as <span class="selected-value select-value-color-blue">, in the
// database's table (<table class="collection-content">, the column's name
// in its <th>) and in the properties above a record page (<table
// class="properties">, a <th> per row). Property name → value → colour;
// Notion's "default" is our grey, its brown our orange.
const SELECT_COLORS: Record<string, PageTagColor> = {
  default: "gray",
  gray: "gray",
  grey: "gray",
  brown: "orange",
  orange: "orange",
  yellow: "yellow",
  green: "green",
  blue: "blue",
  purple: "purple",
  pink: "pink",
  red: "red",
  teal: "teal",
};
export function notionOptionColors(source: string, into = new Map<string, Map<string, PageTagColor>>()) {
  if (!source.includes("select-value-color-")) return into;
  const doc = parseHtml(source);
  const clean = (el: ChildNode) => DomUtils.textContent(el).replace(/\s+/g, " ").trim();
  const take = (property: string, cell: Element) => {
    if (!property) return;
    for (const value of find(cell, (e) => /\bselect-value-color-/.test(attr(e, "class")))) {
      const name = /\bselect-value-color-([a-z]+)/.exec(attr(value, "class"))?.[1] || "";
      const color = SELECT_COLORS[name];
      const text = clean(value).slice(0, 100);
      if (!color || !text) continue;
      const map = into.get(property) || new Map<string, PageTagColor>();
      if (!map.has(text)) map.set(text, color);
      into.set(property, map);
    }
  };
  for (const table of find(doc.children, (e) => e.name === "table" && hasClass(e, "properties")))
    for (const row of find(table, byTag("tr"))) {
      const head = findOne(row, byTag("th")),
        cell = findOne(row, byTag("td"));
      if (head && cell) take(clean(head), cell);
    }
  for (const table of find(doc.children, (e) => e.name === "table" && hasClass(e, "collection-content"))) {
    const thead = findOne(table, byTag("thead"));
    const names = thead ? find(thead, byTag("th")).map(clean) : [];
    const tbody = findOne(table, byTag("tbody"));
    for (const row of tbody ? find(tbody, byTag("tr")) : [])
      children(row)
        .filter((c) => c.name === "td")
        .forEach((cell, i) => take(names[i] || "", cell));
  }
  return into;
}
