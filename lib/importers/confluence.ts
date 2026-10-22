// Confluence space exports. The HTML export (index.html with the page tree,
// one HTML file per page, attachments/<page>/<file>) and the XML export
// (entities.xml with pages, bodies in storage format and attachments under
// attachments/<page>/<attachment>/<version>) both become a page tree.
// Info, tip, note and warning panels become callouts, code macros code
// blocks, expand macros toggles, task lists task lists.
import { posix } from "node:path";
import {
  attr, byTag, children, esc, fileRef, find, findOne, hasClass, isElement, mergeLists, mimeOf, pageRef,
  parseHtml, parseXml, renderNodes, taskItem, text, type ChildNode, type Element, type Rule,
} from "./html";
import { isoDate, warningList, type ImportFile, type ImportPage, type ImportTree } from "./types";

const CALLOUTS: Record<string, string> = { info: "note", information: "note", tip: "tip", note: "warning", warning: "caution", panel: "note" };
const decodePath = (href: string) => {
  try {
    return decodeURIComponent(href.split(/[?#]/)[0]);
  } catch {
    return href.split(/[?#]/)[0];
  }
};

export function isConfluence(entries: Map<string, Buffer>) {
  const names = [...entries.keys()];
  if (names.includes("entities.xml")) return true;
  if (!names.includes("index.html")) return false;
  const index = entries.get("index.html")!.toString("utf8");
  return /confluence|Available Pages|pageSection/i.test(index) || names.some((n) => /^attachments\/\d+\//.test(n));
}

export function parseConfluence(entries: Map<string, Buffer>): ImportTree {
  return entries.has("entities.xml") ? parseConfluenceXml(entries) : parseConfluenceHtml(entries);
}

// ---- HTML export ----

function parseConfluenceHtml(entries: Map<string, Buffer>): ImportTree {
  const warnings = warningList();
  const files = new Map<string, ImportFile>();
  const pagePaths = [...entries.keys()].filter(
    (n) => /\.html?$/i.test(n) && n !== "index.html" && !/^(attachments|images|styles)\//.test(n),
  );
  const parents = new Map<string, string | null>();
  const order = new Map<string, number>();
  let spaceName = "Confluence";
  // The page tree of index.html: nested lists of links.
  if (entries.has("index.html")) {
    const index = parseHtml(entries.get("index.html")!.toString("utf8"));
    spaceName = text(findOne(index.children, byTag("title")) || []).replace(/^\s*Space\s*:?\s*/i, "").trim() || spaceName;
    const walk = (ul: Element, parent: string | null) => {
      for (const li of children(ul).filter((c) => c.name === "li")) {
        const link = children(li).find((c) => c.name === "a");
        const href = link ? decodePath(attr(link, "href")) : "";
        const key = href && entries.has(href) ? href : null;
        if (key && !parents.has(key)) {
          parents.set(key, parent);
          order.set(key, order.size);
        }
        for (const nested of children(li).filter((c) => c.name === "ul")) walk(nested, key || parent);
      }
    };
    const lists = find(index.children, byTag("ul")).filter((ul) => {
      for (let node = ul.parent; node; node = node.parent) if (isElement(node as ChildNode) && (node as Element).name === "ul") return false;
      return true;
    });
    for (const ul of lists) walk(ul, null);
  }
  const pages: ImportPage[] = [];
  const known = new Set(pagePaths);
  for (const path of pagePaths.sort((a, b) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9) || a.localeCompare(b))) {
    const doc = parseHtml(entries.get(path)!.toString("utf8"));
    const titleEl = findOne(doc.children, (el) => attr(el, "id") === "title-text") || findOne(doc.children, byTag("title"));
    const title = (titleEl ? text(titleEl) : posix.basename(path, ".html")).replace(/^[^:]{1,100}\s:\s/, "").trim() || "Ohne Titel";
    // Pages missing from the tree: the breadcrumbs name the parent.
    if (!parents.has(path)) {
      const crumbs = findOne(doc.children, (el) => attr(el, "id") === "breadcrumbs");
      const links = crumbs ? find(crumbs, byTag("a")).map((a) => decodePath(attr(a, "href"))).filter((h) => known.has(h) && h !== path) : [];
      parents.set(path, links.at(-1) || null);
    }
    const main = findOne(doc.children, (el) => attr(el, "id") === "main-content") || findOne(doc.children, byTag("body"));
    const dir = posix.dirname(path);
    const target = (href: string) => {
      if (/^(https?:|mailto:)/i.test(href)) return href;
      if (!href || /^[a-z]+:/i.test(href) || href.startsWith("#")) return null;
      const resolved = posix.normalize(posix.join(dir, decodePath(href)));
      if (known.has(resolved)) return pageRef(resolved);
      if (entries.has(resolved) && !resolved.startsWith("images/")) {
        if (!files.has(resolved)) files.set(resolved, { key: resolved, name: posix.basename(resolved), mime: mimeOf(resolved), data: entries.get(resolved)! });
        return fileRef(resolved);
      }
      return null;
    };
    const used = new Set<string>();
    const rule: Rule = (el, inner, render) => {
      if (["script", "style"].includes(el.name)) return "";
      if (el.name === "a") {
        const href = target(attr(el, "href"));
        if (href?.startsWith("fp-import://file/")) used.add(href);
        const content = inner().trim() || esc(text(el));
        return href ? `<a href="${esc(href)}">${content}</a>` : content;
      }
      if (el.name === "img") {
        const src = attr(el, "data-image-src") && !/^https?:/i.test(attr(el, "data-image-src")) ? attr(el, "data-image-src") : attr(el, "src");
        if (/^(images\/icons|\/images\/icons)/.test(src)) return "";
        const resolved = target(src);
        if (!resolved) {
          if (src) warnings.add("Bild ohne Datei im Export übersprungen.");
          return "";
        }
        used.add(resolved);
        return `<img src="${esc(resolved)}" alt="${esc(attr(el, "alt"))}">`;
      }
      if (el.name === "div" && hasClass(el, "confluence-information-macro")) {
        const kind = (el.attribs.class || "").match(/confluence-information-macro-(\w+)/g)?.map((c) => c.split("-").pop()!).find((c) => CALLOUTS[c] && c !== "macro") || "information";
        const titleEl = children(el).find((c) => hasClass(c, "title"));
        const body = find(el, (c) => hasClass(c, "confluence-information-macro-body"))[0];
        const heading = titleEl ? `<p><strong>${esc(text(titleEl).trim())}</strong></p>` : "";
        return `<aside data-callout="${CALLOUTS[kind] || "note"}">${heading}${body ? renderNodes(body.children, { rule }) : ""}</aside>`;
      }
      if (el.name === "div" && hasClass(el, "expand-container")) {
        const summary = find(el, (c) => hasClass(c, "expand-control-text"))[0];
        const content = find(el, (c) => hasClass(c, "expand-content"))[0];
        return `<details><summary>${esc(summary ? text(summary).trim() : "")}</summary><div>${content ? renderNodes(content.children, { rule }) || "<p></p>" : "<p></p>"}</div></details>`;
      }
      if (el.name === "div" && hasClass(el, "panel") && !hasClass(el, "code")) {
        const content = find(el, (c) => hasClass(c, "panelContent"))[0];
        const header = find(el, (c) => hasClass(c, "panelHeader"))[0];
        return `<aside data-callout="note">${header ? `<p><strong>${esc(text(header).trim())}</strong></p>` : ""}${renderNodes((content || el).children, { rule })}</aside>`;
      }
      if (el.name === "ul" && hasClass(el, "inline-task-list"))
        return children(el)
          .filter((li) => li.name === "li")
          .map((li) => taskItem(hasClass(li, "checked"), render(li.children).trim()))
          .join("");
      return undefined;
    };
    let html = main ? mergeLists(renderNodes(main.children, { rule })) : "";
    // The attachment list below the page: files the text does not show.
    const section = findOne(doc.children, (el) => attr(el, "id") === "attachments");
    if (section?.parent) {
      const extra = find(section.parent as Element, byTag("a"))
        .map((a) => ({ href: target(attr(a, "href")), name: text(a).trim() }))
        .filter((a): a is { href: string; name: string } => !!a.href?.startsWith("fp-import://file/") && !used.has(a.href));
      if (extra.length) html += `<p>${extra.map((a) => `<a href="${esc(a.href)}">${esc(a.name)}</a>`).join("<br>")}</p>`;
    }
    pages.push({ key: path, parent: parents.get(path) ?? null, title: title.slice(0, 200), html });
  }
  if (!pages.length) warnings.add("Keine Confluence-Seiten gefunden.");
  return { source: "confluence", title: spaceName, pages, files, warnings: warnings.list() };
}

// ---- XML export (entities.xml) ----

type XmlObject = { cls: string; id: string; el: Element };
const prop = (el: Element, name: string) => children(el).find((c) => c.name === "property" && attr(c, "name") === name);
const propText = (el: Element, name: string) => {
  const found = prop(el, name);
  return found ? text(found).trim() : "";
};
const refId = (el: Element, name: string) => {
  const found = prop(el, name);
  const idEl = found && children(found).find((c) => c.name === "id");
  return idEl ? text(idEl).trim() : "";
};
const objectId = (el: Element) => {
  const idEl = children(el).find((c) => c.name === "id");
  return idEl ? text(idEl).trim() : "";
};
const current = (el: Element) => (!propText(el, "contentStatus") || propText(el, "contentStatus") === "current") && !refId(el, "originalVersion");

function parseConfluenceXml(entries: Map<string, Buffer>): ImportTree {
  const warnings = warningList();
  const doc = parseXml(entries.get("entities.xml")!.toString("utf8"));
  const objects: XmlObject[] = find(doc.children, byTag("object")).map((el) => ({ cls: attr(el, "class"), id: objectId(el), el }));
  const pagesById = new Map(objects.filter((o) => o.cls === "Page" && current(o.el)).map((o) => [o.id, o.el]));
  const blogPosts = objects.filter((o) => o.cls === "BlogPost" && current(o.el)).length;
  if (blogPosts) warnings.add(`${blogPosts} Blogbeiträge werden nicht übernommen.`);
  const spaceName = objects.find((o) => o.cls === "Space") ? propText(objects.find((o) => o.cls === "Space")!.el, "name") : "";
  // The newest body per page.
  const bodies = new Map<string, { id: number; body: string }>();
  for (const o of objects.filter((o) => o.cls === "BodyContent")) {
    const page = refId(o.el, "content");
    if (!pagesById.has(page)) continue;
    const previous = bodies.get(page);
    if (!previous || Number(o.id) > previous.id) bodies.set(page, { id: Number(o.id), body: propText(o.el, "body") });
  }
  // Attachments by page and file name.
  const files = new Map<string, ImportFile>();
  const attachments = new Map<string, Map<string, string>>();
  for (const o of objects.filter((o) => o.cls === "Attachment" && current(o.el))) {
    const page = refId(o.el, "containerContent") || refId(o.el, "content");
    const name = propText(o.el, "title") || propText(o.el, "fileName");
    if (!page || !name) continue;
    const version = propText(o.el, "version") || propText(o.el, "attachmentVersion") || "1";
    const prefix = `attachments/${page}/${o.id}/`;
    const path = entries.has(prefix + version)
      ? prefix + version
      : [...entries.keys()].filter((n) => n.startsWith(prefix)).sort((a, b) => Number(a.slice(prefix.length)) - Number(b.slice(prefix.length))).at(-1);
    if (!path) {
      warnings.add("Anhang fehlt im Export.");
      continue;
    }
    files.set(path, { key: path, name, mime: mimeOf(name), data: entries.get(path)! });
    if (!attachments.has(page)) attachments.set(page, new Map());
    attachments.get(page)!.set(name.toLowerCase(), path);
  }
  const titleIds = new Map([...pagesById].map(([pid, el]) => [propText(el, "title").toLowerCase(), pid]));
  const pages: ImportPage[] = [];
  const ordered = [...pagesById].sort(([, a], [, b]) => Number(propText(a, "position") || 0) - Number(propText(b, "position") || 0));
  for (const [pid, el] of ordered) {
    const used = new Set<string>();
    const attachmentOf = (ref: Element | undefined, ownPage: string) => {
      if (!ref) return null;
      const owner = children(ref).find((c) => c.name === "ri:page");
      const page = owner ? titleIds.get(attr(owner, "ri:content-title").toLowerCase()) || ownPage : ownPage;
      const path = attachments.get(page)?.get(attr(ref, "ri:filename").toLowerCase());
      if (path) used.add(path);
      return path ? fileRef(path) : null;
    };
    const rule: Rule = (node, inner, render) => {
      const name = node.name;
      if (name === "ac:image") {
        const ref = children(node).find((c) => c.name === "ri:attachment");
        const url = children(node).find((c) => c.name === "ri:url");
        const src = url ? attr(url, "ri:value") : attachmentOf(ref, pid);
        if (!src) {
          warnings.add("Bild ohne Datei im Export übersprungen.");
          return "";
        }
        return `<img src="${esc(src)}" alt="${esc(attr(node, "ac:alt") || (ref ? attr(ref, "ri:filename") : ""))}">`;
      }
      if (name === "ac:link") {
        const pageEl = children(node).find((c) => c.name === "ri:page");
        const fileEl = children(node).find((c) => c.name === "ri:attachment");
        const bodyEl = children(node).find((c) => c.name === "ac:link-body" || c.name === "ac:plain-text-link-body");
        const label = bodyEl ? (bodyEl.name === "ac:link-body" ? render(bodyEl.children) : esc(text(bodyEl))) : "";
        if (pageEl) {
          const title = attr(pageEl, "ri:content-title");
          const target = titleIds.get(title.toLowerCase());
          return target ? `<a href="${pageRef(target)}">${label || esc(title)}</a>` : label || esc(title);
        }
        if (fileEl) {
          const href = attachmentOf(fileEl, pid);
          const shown = label || esc(attr(fileEl, "ri:filename"));
          return href ? `<a href="${href}">${shown}</a>` : shown;
        }
        return label;
      }
      if (name === "ac:structured-macro" || name === "ac:macro") {
        const macro = attr(node, "ac:name").toLowerCase();
        const param = (key: string) => {
          const found = children(node).find((c) => c.name === "ac:parameter" && attr(c, "ac:name") === key);
          return found ? text(found).trim() : "";
        };
        const rich = children(node).find((c) => c.name === "ac:rich-text-body");
        const plain = children(node).find((c) => c.name === "ac:plain-text-body");
        if (CALLOUTS[macro]) {
          const title = param("title");
          return `<aside data-callout="${CALLOUTS[macro]}">${title ? `<p><strong>${esc(title)}</strong></p>` : ""}${rich ? renderNodes(rich.children, { rule, inline: INLINE_AC }) : ""}</aside>`;
        }
        if (macro === "code" || macro === "noformat") return `<pre><code>${esc(plain ? text(plain) : "")}</code></pre>`;
        if (macro === "expand")
          return `<details><summary>${esc(param("title"))}</summary><div>${rich ? renderNodes(rich.children, { rule, inline: INLINE_AC }) || "<p></p>" : "<p></p>"}</div></details>`;
        if (rich) return renderNodes(rich.children, { rule, inline: INLINE_AC });
        warnings.add(`Makro „${macro || "?"}“ wird nicht übernommen.`);
        return "";
      }
      if (name === "ac:task-list")
        return children(node)
          .filter((c) => c.name === "ac:task")
          .map((task) => {
            const status = children(task).find((c) => c.name === "ac:task-status");
            const body = children(task).find((c) => c.name === "ac:task-body");
            return taskItem(!!status && text(status).trim() === "complete", body ? render(body.children).trim() : "");
          })
          .join("");
      if (name === "time") return esc(attr(node, "datetime") || text(node));
      if (["ac:parameter", "ac:emoticon", "ac:placeholder"].includes(name) || name.startsWith("ri:")) return "";
      if (name.startsWith("ac:") && ["ac:layout", "ac:layout-section", "ac:layout-cell"].includes(name)) return renderNodes(node.children, { rule, inline: INLINE_AC });
      if (name === "ac:inline-comment-marker") return inner();
      return undefined;
    };
    const storage = bodies.get(pid)?.body || "";
    let html = mergeLists(renderNodes(parseHtml(storage).children, { rule, inline: INLINE_AC }));
    const rest = [...(attachments.get(pid) || new Map<string, string>()).values()].filter((path) => !used.has(path));
    if (rest.length) html += `<p>${rest.map((path) => `<a href="${fileRef(path)}">${esc(files.get(path)!.name)}</a>`).join("<br>")}</p>`;
    const parent = refId(el, "parent");
    pages.push({
      key: pid,
      parent: pagesById.has(parent) ? parent : null,
      title: propText(el, "title").slice(0, 200) || "Ohne Titel",
      html,
      created: isoDate(propText(el, "creationDate")),
      updated: isoDate(propText(el, "lastModificationDate")),
    });
  }
  if (!pages.length) warnings.add("Keine Confluence-Seiten gefunden.");
  return { source: "confluence", title: spaceName || "Confluence", pages, files, warnings: warnings.list() };
}
const INLINE_AC = new Set(["ac:image", "ac:link", "ac:emoticon", "ac:placeholder", "ac:inline-comment-marker", "time", "ri:attachment", "ri:page", "ri:url"]);
