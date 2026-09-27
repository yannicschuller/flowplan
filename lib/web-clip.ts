// Web clipper: the readable text of an article (loaded server-side through
// the SSRF-safe fetch), a bookmarks database per space, and importing the
// bookmarks file browsers export (Netscape format).
import sanitize from "sanitize-html";
import { z } from "zod";
import { all, id, one, run } from "./db";
import { createPage } from "./seed";
import { HttpError } from "./auth";
import { safeFetch } from "./safe-fetch";
import type { Field, View } from "./types";

const ARTICLE_LIMIT = 200_000;
const decode = (text: string) =>
  text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));

// The main text of a page: <article> or <main> if present, else the body,
// without navigation, ads and scripts; only simple text markup remains.
export function extractArticle(html: string, baseUrl: string) {
  const title =
    decode(html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1] || "") ||
    decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").trim();
  const description = decode(
    html.match(/<meta[^>]+(?:name|property)=["'](?:og:)?description["'][^>]+content=["']([^"']+)["']/i)?.[1] || "",
  );
  const without = html
    .replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|iframe|template)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const pick = (tag: string) => {
    const matches = [...without.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi"))];
    return matches.sort((a, b) => b[1].length - a[1].length)[0]?.[1];
  };
  const body = pick("article") || pick("main") || without.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] || without;
  const clean = sanitize(body, {
    allowedTags: ["p", "h1", "h2", "h3", "h4", "ul", "ol", "li", "blockquote", "pre", "code", "a", "strong", "em", "b", "i", "br"],
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
    title: title.slice(0, 200),
    description: description.slice(0, 500),
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
     ORDER BY p.rowid LIMIT 1`,
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
        ...(item.note ? { bm_note: item.note.slice(0, 2000) } : {}),
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
  run("UPDATE pages SET updated_at=CURRENT_TIMESTAMP WHERE id=?", pageId);
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
