// Google Docs from Google Takeout (or single downloads): every .html or
// .docx document becomes a page, Drive folders become parent pages. In the
// HTML export, formatting sits in CSS classes and lists are flat per
// level; both are turned back into marks and nested lists. Google's
// redirect links point to their target again.
import { posix } from "node:path";
import { readZip } from "../archive";
import { docxEntriesToHtml } from "./docx";
import {
  attr, byTag, children, esc, fileRef, findOne, isElement, mimeOf, nestedList, parseHtml, renderNodes, styleMarks, text,
  type ChildNode, type Element, type ListItem, type Rule,
} from "./html";
import { warningList, type ImportFile, type ImportPage, type ImportTree } from "./types";

// Google wraps links: https://www.google.com/url?q=<target>&sa=…
export function unwrapGoogleLink(href: string) {
  try {
    const url = new URL(href);
    if (/(^|\.)google\.[a-z.]+$/.test(url.hostname) && url.pathname === "/url" && url.searchParams.get("q")) return url.searchParams.get("q")!;
  } catch {}
  return href;
}

// Class → marks from the <style> of a Google Docs export.
function classMarks(css: string) {
  const marks = new Map<string, ReturnType<typeof styleMarks>>();
  for (const rule of css.matchAll(/\.([A-Za-z0-9_-]+)\s*\{([^}]*)\}/g)) marks.set(rule[1], styleMarks(rule[2]));
  return marks;
}

export function googleHtmlToHtml(source: string, path: string, entries: Map<string, Buffer>, files: Map<string, ImportFile>) {
  const doc = parseHtml(source);
  const css = [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n");
  const marks = classMarks(css);
  const dir = posix.dirname(path);
  let images = 0;
  const rule: Rule = (el, inner) => {
    if (el.name === "a") {
      const href = unwrapGoogleLink(attr(el, "href"));
      const content = inner();
      if (!href || href.startsWith("#") || !/^(https?:|mailto:)/i.test(href)) return content;
      return `<a href="${esc(href)}">${content}</a>`;
    }
    if (el.name === "img") {
      const src = attr(el, "src");
      const data = /^data:([a-z]+\/[a-z0-9.+-]+);base64,(.*)$/i.exec(src);
      if (data) {
        const key = `${path}#image${++images}`;
        files.set(key, { key, name: `bild-${images}.${data[1].split("/")[1].replace("jpeg", "jpg")}`, mime: data[1].toLowerCase(), data: Buffer.from(data[2], "base64") });
        return `<img src="${fileRef(key)}" alt="${esc(attr(el, "alt"))}">`;
      }
      if (/^https?:/i.test(src)) return `<img src="${esc(src)}" alt="${esc(attr(el, "alt"))}">`;
      let target: string;
      try {
        target = posix.normalize(posix.join(dir, decodeURIComponent(src)));
      } catch {
        return "";
      }
      if (!entries.has(target)) return "";
      files.set(target, { key: target, name: posix.basename(target), mime: mimeOf(target), data: entries.get(target)! });
      return `<img src="${fileRef(target)}" alt="${esc(attr(el, "alt"))}">`;
    }
    // The document title repeats the page title.
    if (el.name === "p" && /\btitle\b/.test(el.attribs.class || "")) return "";
    if (el.name === "sup" && findOne(el, byTag("a")) && /^#(ftnt|cmnt)/.test(attr(findOne(el, byTag("a"))!, "href"))) return "";
    return undefined;
  };
  const options = {
    rule,
    marks: (el: Element) => {
      const result: ReturnType<typeof styleMarks> = {};
      for (const name of (el.attribs.class || "").split(/\s+/)) {
        const m = marks.get(name);
        if (m) for (const [k, v] of Object.entries(m)) if (v) result[k as keyof typeof result] = true;
      }
      return result;
    },
  };
  const body = findOne(doc.children, byTag("body"));
  const nodes: ChildNode[] = body ? body.children : doc.children;
  // Flat lists (class lst-kix_…-<level>) become nested ones.
  let out = "";
  let list: ListItem[] = [];
  const flush = () => {
    if (list.length) out += nestedList(list);
    list = [];
  };
  for (const node of nodes) {
    if (isElement(node) && (node.name === "ul" || node.name === "ol")) {
      const level = Number(/lst-[A-Za-z0-9_]+-(\d+)/.exec(node.attribs.class || "")?.[1] || 0);
      for (const li of children(node).filter((c) => c.name === "li"))
        list.push({ level, ordered: node.name === "ol", html: renderNodes(li.children, options) || "<p></p>" });
      continue;
    }
    // Comments and footnotes at the end of the export.
    if (isElement(node) && node.name === "div" && /^(cmnt|ftnt)\d+$/.test(attr(findOne(node, byTag("a")) || node, "id"))) continue;
    if (node.type === "text" && !node.data.trim()) continue;
    flush();
    out += renderNodes([node], options);
  }
  flush();
  const title = findOne(doc.children, byTag("title"));
  return { html: out, title: title ? text(title).trim() : "" };
}

export function isGoogleTakeout(entries: Map<string, Buffer>) {
  const names = [...entries.keys()];
  return names.some((n) => /\.(docx|html?)$/i.test(n)) && !names.some((n) => /\.md$/i.test(n));
}

export function parseGoogleDocs(entries: Map<string, Buffer>, name = "Google Docs"): ImportTree {
  const warnings = warningList();
  const files = new Map<string, ImportFile>();
  // Takeout/Drive/<folders>/<document>
  const strip = (n: string) => n.replace(/^Takeout\//, "").replace(/^(Drive|Google Drive)\//, "");
  const docs = [...entries.keys()].filter((n) => /\.(docx|html?)$/i.test(n)).sort((a, b) => strip(a).localeCompare(strip(b)));
  const pages: ImportPage[] = [];
  const folders = new Set<string>();
  const folderPage = (dir: string): string | null => {
    if (!dir || dir === ".") return null;
    const key = `folder:${dir}`;
    if (!folders.has(dir)) {
      folders.add(dir);
      const parent = folderPage(posix.dirname(dir));
      pages.push({ key, parent, title: posix.basename(dir), html: "", folder: true });
    }
    return key;
  };
  for (const path of docs) {
    const shown = strip(path);
    const parent = folderPage(posix.dirname(shown));
    const base = posix.basename(shown).replace(/\.(docx|html?)$/i, "");
    if (/\.docx$/i.test(path)) {
      warnings.add("__docx__");
      pages.push({ key: path, parent, title: base, html: `<!--docx:${encodeURIComponent(path)}-->` });
      continue;
    }
    const { html, title } = googleHtmlToHtml(entries.get(path)!.toString("utf8"), path, entries, files);
    pages.push({ key: path, parent, title: title || base, html });
  }
  if (!docs.length) warnings.add("Keine Google-Docs-Dokumente (.html oder .docx) gefunden.");
  return { source: "gdocs", title: name, pages, files, warnings: warnings.list().filter((w) => !w.startsWith("__docx__")) };
}

// DOCX documents of a Takeout are ZIPs themselves; they are converted
// after the tree is known (readZip is asynchronous).
export async function resolveDocx(tree: ImportTree, entries: Map<string, Buffer>, budget: { left: number }) {
  for (const page of tree.pages) {
    const marker = /^<!--docx:([^>]*)-->$/.exec(page.html);
    if (!marker) continue;
    const path = decodeURIComponent(marker[1]);
    try {
      const inner = await readZip(entries.get(path)!, { foreign: true, maxEntries: 2000, budget });
      const result = docxEntriesToHtml(inner, path);
      page.html = result.html;
      for (const [key, file] of result.files) tree.files.set(key, file);
    } catch {
      page.html = "";
      tree.warnings.push(`${posix.basename(path)}: Word-Datei konnte nicht gelesen werden.`);
    }
  }
  return tree;
}
