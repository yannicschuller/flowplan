// Web clipper: the readable text of an article (loaded server-side through
// the SSRF-safe fetch), a bookmarks database per space, and importing the
// bookmarks file browsers export (Netscape format).
import { escapeInline } from "./inline-markdown";
import sanitize from "sanitize-html";
import { z } from "zod";
import { all, id, one, run, nowText } from "./db";
import { createPage } from "./seed";
import { HttpError } from "./auth";
import { safeFetch } from "./safe-fetch";
import { scanHtml, VOID_ELEMENTS } from "./html-tokens";
import type { Field, View } from "./types";

const ARTICLE_LIMIT = 200_000;
// Pages larger than this are cut before they are read.
const HTML_LIMIT = 2_000_000;
// &amp; last, so "&amp;lt;" stays the text "&lt;".
const decode = (text: string) =>
  text
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d{1,7});/g, (entity, n) => (Number(n) <= 0x10ffff ? String.fromCodePoint(Number(n)) : entity))
    .replace(/&amp;/g, "&");

const ARTICLE_TAGS = ["p", "h1", "h2", "h3", "h4", "ul", "ol", "li", "blockquote", "pre", "code", "a", "strong", "em", "b", "i", "br"];
// Left out together with everything inside.
const DROPPED = new Set(["script", "style", "noscript", "svg", "math", "nav", "header", "footer", "aside", "form", "iframe", "template", "title", "textarea", "select", "object"]);
// Open elements that an opening tag ends (the common cases of HTML's implied
// end tags), so that unclosed <p> and <li> do not pile up.
const BLOCKS = ["address", "article", "aside", "blockquote", "details", "div", "dl", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "main", "nav", "ol", "p", "pre", "section", "table", "ul"];
const ENDS = new Map<string, string[]>([
  ["li", ["li"]],
  ["dt", ["dt", "dd"]],
  ["dd", ["dt", "dd"]],
  ["tr", ["tr", "td", "th"]],
  ["td", ["td", "th"]],
  ["th", ["td", "th"]],
  ["option", ["option"]],
  ...BLOCKS.map((block): [string, string[]] => [block, ["p"]]),
]);
// Deeper markup loses its tags (the text stays); keeps sanitizing linear.
const MAX_OPEN = 512;
const MAX_KEPT = 32;
const attribute = (value: string) => value.replace(/"/g, "&quot;");

// The main text of a page: <article> or <main> if present, else the body,
// without navigation, ads and scripts; only simple text markup remains.
// One pass over the page (see scanHtml), then sanitize-html on markup whose
// nesting is bounded.
export function extractArticle(page: string, baseUrl: string) {
  const html = page.length > HTML_LIMIT ? page.slice(0, HTML_LIMIT) : page;
  let ogTitle = "";
  let title: string | undefined;
  let titleOpen = false;
  let description = "";
  let out = "";
  type Open = { name: string; kept: boolean; start: number };
  const stack: Open[] = [];
  const count = new Map<string, number>();
  let kept = 0;
  let dropped = 0;
  const regions = new Map<string, [number, number][]>([
    ["article", []],
    ["main", []],
    ["body", []],
  ]);
  const pop = () => {
    const open = stack.pop()!;
    count.set(open.name, count.get(open.name)! - 1);
    // A space in place of the left-out part keeps the words around apart.
    if (DROPPED.has(open.name)) {
      if (!--dropped) out += " ";
    } else if (open.kept) {
      kept--;
      out += `</${open.name}>`;
    }
    regions.get(open.name)?.push([open.start, out.length]);
  };
  scanHtml(html, {
    open: ({ name, attrs }) => {
      if (name === "meta") {
        const key = (attrs.get("property") || attrs.get("name") || "").toLowerCase();
        const content = attrs.get("content") || "";
        if (key === "og:title" && !ogTitle) ogTitle = content;
        if ((key === "description" || key === "og:description") && !description) description = content;
      }
      if (name === "title" && title === undefined) {
        title = "";
        titleOpen = true;
      }
      while (stack.length && ENDS.get(name)?.includes(stack[stack.length - 1].name)) pop();
      if (VOID_ELEMENTS.has(name)) {
        if (name === "br" && !dropped && kept < MAX_KEPT) out += "<br>";
        return;
      }
      if (stack.length >= MAX_OPEN) return;
      const keep = !dropped && kept < MAX_KEPT && ARTICLE_TAGS.includes(name);
      if (DROPPED.has(name)) dropped++;
      if (keep) {
        kept++;
        out += name === "a" ? `<a href="${attribute(attrs.get("href") || "")}">` : `<${name}>`;
      }
      stack.push({ name, kept: keep, start: out.length });
      count.set(name, (count.get(name) || 0) + 1);
    },
    close: (name) => {
      if (name === "title") titleOpen = false;
      // Closes the element and the ones still open inside it; an end tag
      // without an open element is ignored.
      if (!count.get(name)) return;
      while (stack[stack.length - 1].name !== name) pop();
      pop();
    },
    text: (raw) => {
      if (titleOpen) title += raw;
      else if (!dropped) out += raw.replace(/</g, "&lt;");
    },
  });
  while (stack.length) pop();
  const longest = (tag: string) =>
    regions.get(tag)!.reduce<[number, number] | undefined>((a, b) => (!a || b[1] - b[0] > a[1] - a[0] ? b : a), undefined);
  const region = longest("article") || longest("main") || longest("body");
  // The markup is compact by now (only the kept tags, no attributes but
  // href); more than this would not fit the clipped article anyway.
  const [from, to] = region || [0, out.length];
  const body = out.slice(from, Math.min(to, from + 2 * ARTICLE_LIMIT));
  const clean = sanitize(body, {
    allowedTags: ARTICLE_TAGS,
    allowedAttributes: { a: ["href"] },
    allowedSchemes: ["http", "https", "mailto"],
    transformTags: {
      h1: "h2",
      h4: "h3",
      b: "strong",
      i: "em",
      a: (tagName, attribs) => {
        try {
          return { tagName, attribs: { href: new URL(attribs.href || "", baseUrl).toString() } };
        } catch {
          return { tagName: "span", attribs: {} as Record<string, string> };
        }
      },
    },
    exclusiveFilter: (frame) =>
      ["p", "li", "h2", "h3", "blockquote"].includes(frame.tag) && !frame.text.trim(),
  })
    .replace(/\s{2,}/g, " ")
    .trim();
  const text = decode(clean.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
  return {
    title: (decode(ogTitle) || decode(title || "").trim()).slice(0, 200),
    description: decode(description).slice(0, 500),
    html: clean.length > ARTICLE_LIMIT ? clean.slice(0, ARTICLE_LIMIT).replace(/<[^>]*$/, "") : clean,
    words: text ? text.split(" ").length : 0,
  };
}

export async function clipArticle(url: string) {
  const parsed = z.url().max(2000).parse(url);
  const page = await safeFetch(parsed, {
    maxBytes: 3_000_000,
    timeout: 8000,
    accept: "text/html,application/xhtml+xml;q=0.9",
  });
  if (!/html/i.test(page.type)) throw new HttpError(415, "Die Adresse liefert keine Webseite.");
  return { url: page.url, ...extractArticle(page.data.toString("utf8"), page.url) };
}

// ---- Bookmarks database ----

export const BOOKMARK_FIELDS: Field[] = [
  { id: "title", name: "Titel", type: "text" },
  { id: "bm_url", name: "Link", type: "url" },
  { id: "bm_site", name: "Website", type: "select", options: [] },
  { id: "bm_folder", name: "Ordner", type: "select", options: [] },
  { id: "bm_note", name: "Notiz", type: "text" },
  { id: "bm_added", name: "Hinzugefügt", type: "date" },
  { id: "bm_read", name: "Gelesen", type: "checkbox" },
];
const BOOKMARK_VIEWS: View[] = [
  { id: "bm_all", name: "Alle", type: "table", filters: [], sorts: [{ field: "bm_added", direction: "desc" }] } as unknown as View,
  { id: "bm_gallery", name: "Karten", type: "gallery", filters: [], sorts: [{ field: "bm_added", direction: "desc" }] } as unknown as View,
  { id: "bm_unread", name: "Ungelesen", type: "list", filters: [{ field: "bm_read", op: "unchecked", value: "" }], sorts: [{ field: "bm_added", direction: "desc" }] } as unknown as View,
];
// The bookmarks database of a space; created on first use.
export function bookmarksDatabase(workspaceId: string, spaceId: string, userId: string) {
  const existing = one<{ id: string }>(
    `SELECT p.id FROM pages p JOIN databases d ON d.page_id=p.id
     WHERE p.workspace_id=? AND p.space_id=? AND p.deleted_at IS NULL AND d.fields LIKE '%"id":"bm_url"%'
     ORDER BY p.created_at,p.id LIMIT 1`,
    workspaceId,
    spaceId,
  );
  if (existing) return existing.id;
  const pageId = createPage(workspaceId, spaceId, userId, "Lesezeichen", "database");
  run(
    "UPDATE databases SET fields=?,views=? WHERE page_id=?",
    JSON.stringify(BOOKMARK_FIELDS),
    JSON.stringify(BOOKMARK_VIEWS),
    pageId,
  );
  run("UPDATE pages SET icon='🔖' WHERE id=?", pageId);
  return pageId;
}
function site(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
// Adds options to the select fields as needed and stores the records.
export function addBookmarks(
  pageId: string,
  userId: string,
  items: { title: string; url: string; folder?: string; note?: string; added?: string; content?: string }[],
) {
  const db = one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", pageId)!;
  const fields = JSON.parse(db.fields) as Field[];
  const known = new Set(
    all<{ url: string }>("SELECT json_extract(cells,'$.bm_url') url FROM rows WHERE page_id=?", pageId).map((r) => r.url),
  );
  const addOption = (fieldId: string, value: string) => {
    const field = fields.find((f) => f.id === fieldId);
    if (field && value && !(field.options || []).includes(value) && (field.options || []).length < 300)
      field.options = [...(field.options || []), value];
  };
  let added = 0;
  const ids: string[] = [];
  const today = new Date().toISOString().slice(0, 10);
  items.forEach((item, i) => {
    if (!/^https?:\/\//i.test(item.url) || known.has(item.url)) return;
    known.add(item.url);
    const host = site(item.url);
    addOption("bm_site", host);
    if (item.folder) addOption("bm_folder", item.folder);
    const rid = id();
    run(
      "INSERT INTO rows(id,page_id,cells,position,created_by,updated_by,content) VALUES(?,?,?,?,?,?,?)",
      rid,
      pageId,
      JSON.stringify({
        title: (item.title || host || item.url).slice(0, 300),
        bm_url: item.url.slice(0, 2000),
        ...(host ? { bm_site: host } : {}),
        ...(item.folder ? { bm_folder: item.folder.slice(0, 100) } : {}),
        // The note is plain text; the property is formatted text (#126).
        ...(item.note ? { bm_note: escapeInline(item.note.slice(0, 2000)) } : {}),
        bm_added: item.added || today,
        bm_read: false,
      }),
      Date.now() + i,
      userId,
      userId,
      item.content || "",
    );
    ids.push(rid);
    added++;
  });
  run("UPDATE databases SET fields=? WHERE page_id=?", JSON.stringify(fields), pageId);
  run("UPDATE pages SET updated_at=? WHERE id=?", nowText(), pageId);
  return { added, skipped: items.length - added, ids };
}

// Bookmarks exported from Chrome, Firefox, Safari or Edge.
export function parseBookmarksHtml(html: string) {
  const items: { title: string; url: string; folder?: string; added?: string }[] = [];
  const folders: string[] = [];
  const token = /<DT>\s*<H3[^>]*>([\s\S]*?)<\/H3>|<DT>\s*<A\s([^>]*)>([\s\S]*?)<\/A>|<\/DL>/gi;
  let pendingFolder: string | null = null;
  for (const match of html.matchAll(new RegExp(`${token.source}|<DL>`, "gi"))) {
    const [all, folder, attrs, text] = match;
    if (folder !== undefined) {
      pendingFolder = decode(folder.replace(/<[^>]+>/g, "")).trim();
    } else if (/^<DL>$/i.test(all)) {
      folders.push(pendingFolder || "");
      pendingFolder = null;
    } else if (/^<\/DL>$/i.test(all)) {
      folders.pop();
    } else if (attrs !== undefined) {
      const href = attrs.match(/HREF="([^"]+)"/i)?.[1];
      if (!href) continue;
      const date = Number(attrs.match(/ADD_DATE="(\d+)"/i)?.[1] || 0);
      const folder = folders.filter(Boolean).at(-1);
      items.push({
        title: decode(text.replace(/<[^>]+>/g, "")).trim(),
        url: decode(href),
        ...(folder ? { folder } : {}),
        ...(date > 0 && date < 4e9 ? { added: new Date(date * 1000).toISOString().slice(0, 10) } : {}),
      });
      if (items.length >= 5000) break;
    }
  }
  return items;
}
