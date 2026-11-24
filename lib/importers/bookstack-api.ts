// A one-time import from BookStack through its REST API (#329). The person
// gives the address of their BookStack, the ID and secret of an API token
// (BookStack: profile → API tokens; the role needs "Access system API"),
// loads the shelves and books the token sees (listBookStack), picks some or
// all and gets a preview (readBookStack with dryRun: counts, nothing
// downloaded) before the import reads everything into an import tree that
// lib/importers/write.ts writes like any other.
//
// Mapping: a shelf becomes a top-level page, its books pages below it (a
// book on several shelves once, below the first; the preview says so),
// books on no shelf top-level pages; chapters become sub-pages of their
// book, pages sub-pages of their chapter or book, in BookStack's order
// (priority). Descriptions of shelves, books and chapters are the text of
// their page. Page content comes from the rendered HTML (callouts, code,
// tables, task lists, collapsible blocks) or, for Markdown pages without
// HTML in them, from the Markdown. Images of the same BookStack
// (uploads/images/…, gallery and draw.io) and file attachments are
// downloaded and stored as files of the page, within the person's upload
// limit; link attachments stay links, failures are listed in the import
// report. Links to pages, chapters, books and shelves of the import
// (/books/<book>/page/<page>, /link/<id>, …) lead to the new pages; tags
// (name: value) become tags of the page. Drafts and revisions stay out.
//
// The token is used for these requests only: it is never stored, logged or
// part of a job's label, result or error (messages are scrubbed of it);
// while a background import runs it lives in that job's memory and nowhere
// else. It is sent only to the given address (requests with credentials
// follow no redirects, lib/safe-fetch.ts), through the safe fetch: internal
// addresses (a BookStack in the LAN) only with
// FLOWPLAN_IMPORT_ALLOW_PRIVATE=true, http:// only then as well. Lists are
// read in pages of 500 (count/offset); 429 waits as Retry-After or
// X-RateLimit-Reset say (at most a minute each, ten minutes in all).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { HttpError } from "../auth";
import { privateAddress, safeFetch } from "../safe-fetch";
import { securityEvent } from "../security-events";
import { jobProgress } from "../background-jobs";
import { ct } from "../content-locale";
import { markdownToRawHtml } from "../markdown-html";
import { attr, esc, fileRef, find, hasClass, isElement, isImage, mimeOf, pageRef, parseHtml, renderNodes, text, type Element, type Rule } from "./html";
import { importReport, isoDate, maxImportFiles, maxImportPages, tooManyFiles, tooManyPages, warningList, type ImportFile, type ImportPage, type ImportReport, type ImportTree } from "./types";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const BOOKSTACK_PAGE_SIZE = 500;
const MAX_LIST_ITEMS = 200_000;
const MAX_RETRIES = 8;
const MAX_WAIT_S = 60;
const MAX_TOTAL_WAIT_MS = 10 * 60_000;
const MAX_JSON_BYTES = 30_000_000;
const USER_AGENT = "Flowplan-Import/1.0";

export const bookStackPrivateAllowed = () => process.env.FLOWPLAN_IMPORT_ALLOW_PRIVATE === "true";
export const BOOKSTACK_PRIVATE = "Interne Adressen sind für den BookStack-Import nur mit FLOWPLAN_IMPORT_ALLOW_PRIVATE=true erlaubt.";
const UNREACHABLE = "BookStack ist unter dieser Adresse nicht erreichbar. Bitte prüfe die Adresse und versuche es erneut.";
const NOT_BOOKSTACK = "Unter dieser Adresse antwortet keine BookStack-API. Bitte prüfe die Adresse deiner BookStack-Instanz.";
const NO_PERMISSION = "Das Token darf die BookStack-API nicht nutzen: Die Rolle des Kontos braucht in BookStack die Berechtigung „Access system API“.";

export type BookStackCredentials = { base: string; tokenId: string; tokenSecret: string };
// Test hook only: no waiting. Not reachable through any request or setting.
export type BookStackOptions = { sleep?: (ms: number) => Promise<void> };

// The instance's address as the API's base: https (http only where
// internal addresses are allowed), no credentials, query or fragment, a
// trailing "/api" or slash dropped; a path (BookStack below /wiki) stays.
export function bookStackBase(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) throw new HttpError(400, "Bitte gib die Adresse deiner BookStack-Instanz an.");
  if (raw.length > 500) throw new HttpError(400, "Die Adresse der BookStack-Instanz ist ungültig.");
  let value = raw.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, "Die Adresse der BookStack-Instanz ist ungültig.");
  }
  const allowPrivate = bookStackPrivateAllowed();
  if (url.protocol !== "https:" && !(allowPrivate && url.protocol === "http:"))
    throw new HttpError(400, "Die BookStack-Adresse muss mit https:// beginnen (http:// nur mit FLOWPLAN_IMPORT_ALLOW_PRIVATE=true).");
  if (url.username || url.password || url.search || url.hash) throw new HttpError(400, "Die Adresse der BookStack-Instanz ist ungültig.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!allowPrivate && (host === "localhost" || host.endsWith(".localhost") || (isIP(host) && privateAddress(host)))) {
    securityEvent("blocked.ssrf", { detail: host });
    throw new HttpError(400, BOOKSTACK_PRIVATE);
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "").replace(/\/api$/i, "")}`;
}

// Token ID and secret (BookStack makes both 32 letters and digits).
const TOKEN_PART = /^[A-Za-z0-9._~-]{8,200}$/;
export function bookStackCredentials(input: { url?: unknown; tokenId?: unknown; tokenSecret?: unknown }): BookStackCredentials {
  const base = bookStackBase(input.url);
  const tokenId = typeof input.tokenId === "string" ? input.tokenId.trim() : "";
  const tokenSecret = typeof input.tokenSecret === "string" ? input.tokenSecret.trim() : "";
  if (!TOKEN_PART.test(tokenId) || !TOKEN_PART.test(tokenSecret))
    throw new HttpError(400, "Bitte gib Token-ID und Token-Secret eines BookStack-API-Tokens an (BookStack: Profil → API-Tokens).");
  return { base, tokenId, tokenSecret };
}

// The wait a 429 asks for: Retry-After (seconds or a date), else
// X-RateLimit-Reset (a time or seconds), else five seconds; one to sixty.
export function retryWait(headers: Record<string, string>, now = Date.now()) {
  const after = (headers["retry-after"] || "").trim();
  let seconds = after ? Number(after) : NaN;
  if (!Number.isFinite(seconds) && after) {
    const date = Date.parse(after);
    if (!Number.isNaN(date)) seconds = (date - now) / 1000;
  }
  if (!(seconds > 0)) {
    const reset = Number(headers["x-ratelimit-reset"]);
    if (reset > 0) seconds = reset > 1e9 ? reset - now / 1000 : reset;
  }
  if (!(seconds > 0)) seconds = 5;
  return Math.min(MAX_WAIT_S, Math.max(1, Math.ceil(seconds))) * 1000;
}

// The answer to an item that is gone or hidden from the token.
export class BookStackMissing extends Error {
  constructor(readonly status: number) {
    super(`BookStack ${status}`);
  }
}
class BookStackTooLarge extends Error {}

// Whatever leaves this module – errors, warnings – never carries the token.
export function scrubToken(message: string, credentials: Pick<BookStackCredentials, "tokenId" | "tokenSecret">) {
  let out = message;
  for (const part of [credentials.tokenId, credentials.tokenSecret]) if (part) out = out.split(part).join("…");
  return out;
}

export function bookStackClient(credentials: BookStackCredentials, options: BookStackOptions = {}) {
  const { base } = credentials;
  const sleep = options.sleep || ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const allowPrivate = bookStackPrivateAllowed();
  const authorization = `Token ${credentials.tokenId}:${credentials.tokenSecret}`;
  const root = new URL(`${base}/`);
  let waited = 0;
  let requests = 0;
  // Only addresses of this BookStack (its origin, below its path) get the token.
  const inside = (url: URL) => url.origin === root.origin && url.pathname.startsWith(root.pathname);
  async function send(url: string, accept: string, maxBytes: number) {
    for (let attempt = 0; ; attempt++) {
      requests++;
      let response;
      try {
        response = await safeFetch(url, { headers: { authorization, "user-agent": USER_AGENT }, accept, maxBytes, timeout: 30_000, allowPrivate });
      } catch (error) {
        const message = String((error as Error)?.message || "");
        if (/Interne Adressen/.test(message)) throw new HttpError(400, BOOKSTACK_PRIVATE);
        if (/zu groß/.test(message)) throw new BookStackTooLarge();
        if (attempt < 2) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        throw new HttpError(502, UNREACHABLE, { service: "bookstack", host: url });
      }
      if (response.status === 429 && attempt < MAX_RETRIES && waited < MAX_TOTAL_WAIT_MS) {
        const ms = retryWait(response.headers);
        waited += ms;
        await sleep(ms);
        continue;
      }
      if (response.status >= 500 && attempt < 3) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      return response;
    }
  }
  async function call(path: string, maxBytes = MAX_JSON_BYTES): Promise<Json> {
    const response = await send(`${base}/api${path}`, "application/json", maxBytes);
    if (response.status === 401) throw new HttpError(400, "BookStack hat das API-Token abgelehnt. Bitte prüfe Token-ID und Token-Secret.");
    if (response.status === 403 || response.status === 404) throw new BookStackMissing(response.status);
    if (response.status === 429) throw new HttpError(429, "BookStack begrenzt gerade die Anfragen. Bitte versuche es später erneut.");
    if (response.status < 200 || response.status >= 300) throw new HttpError(502, response.status >= 300 && response.status < 400 ? NOT_BOOKSTACK : "BookStack hat die Anfrage nicht beantwortet. Bitte versuche es später erneut.", { service: "bookstack", host: base });
    try {
      const data = JSON.parse(response.body);
      if (data && typeof data === "object") return data as Json;
    } catch {}
    throw new HttpError(502, NOT_BOOKSTACK, { service: "bookstack", host: base });
  }
  // Every item of a list endpoint, 500 at a time.
  async function list(path: string): Promise<Json[]> {
    const items: Json[] = [];
    for (let offset = 0; items.length < MAX_LIST_ITEMS; ) {
      const page = await call(`${path}${path.includes("?") ? "&" : "?"}count=${BOOKSTACK_PAGE_SIZE}&offset=${offset}&sort=%2Bid`);
      const data = Array.isArray(page.data) ? (page.data as Json[]) : null;
      if (!data) throw new HttpError(502, NOT_BOOKSTACK, { service: "bookstack", host: base });
      items.push(...data);
      offset += data.length;
      if (!data.length || offset >= Number(page.total ?? 0)) break;
    }
    return items;
  }
  // A file of this BookStack (an image), with the token; another address
  // is not fetched.
  async function file(raw: string, maxBytes: number): Promise<{ data: Buffer; mime: string } | { error: "size" | "failed" | "outside" }> {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { error: "failed" };
    }
    if (!inside(url)) return { error: "outside" };
    const fetchOne = async (address: string) => {
      try {
        const got = await send(address, "image/*,*/*;q=0.8", maxBytes);
        const mime = got.type.split(";")[0].trim().toLowerCase();
        return got.status >= 200 && got.status < 300 && got.data.length && !/^(text\/html|application\/json)$/.test(mime) ? { data: got.data, mime } : null;
      } catch (error) {
        if (error instanceof BookStackTooLarge) return "size" as const;
        if (error instanceof HttpError && error.message === BOOKSTACK_PRIVATE) throw error;
        return null;
      }
    };
    // Straight from the uploads folder (BookStack's default storage), else
    // through the API (BookStack's image data endpoint; needed where images
    // are only served to signed-in people).
    let got = await fetchOne(url.href);
    if (got === null) got = await fetchOne(`${base}/api/image-gallery/url/data?url=${encodeURIComponent(url.href)}`);
    if (got === "size") return { error: "size" };
    return got || { error: "failed" };
  }
  // A file attachment's content (base64 in the answer).
  async function attachment(id: number, maxBytes: number): Promise<{ data: Buffer } | { link: string } | { error: "size" | "failed" }> {
    let detail: Json;
    try {
      detail = await call(`/attachments/${id}`, Math.ceil((maxBytes * 4) / 3) + 1_000_000);
    } catch (error) {
      if (error instanceof BookStackTooLarge) return { error: "size" };
      if (error instanceof BookStackMissing) return { error: "failed" };
      throw error;
    }
    const content = typeof detail.content === "string" ? detail.content : "";
    if (detail.external) return /^(https?:|mailto:)/i.test(content.trim()) ? { link: content.trim() } : { error: "failed" };
    const data = Buffer.from(content, "base64");
    if (!data.length) return { error: "failed" };
    if (data.length > maxBytes) return { error: "size" };
    return { data };
  }
  return { base, root, inside, call, list, file, attachment, requests: () => requests };
}
export type BookStackClient = ReturnType<typeof bookStackClient>;

const num = (value: unknown) => (typeof value === "number" && Number.isInteger(value) ? value : Number.isInteger(Number(value)) ? Number(value) : -1);
const nameOf = (item: Json) => String(item.name ?? "").trim().slice(0, 500) || ct("Ohne Titel", "Untitled");
const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, "de");

// Shelves (with their books, in the shelf's order) and the books.
type Shelf = { id: number; name: string; slug: string; books: number[]; detail: Json };
type Book = { id: number; name: string; slug: string };
async function readShelvesAndBooks(client: BookStackClient) {
  let shelfItems: Json[];
  try {
    shelfItems = await client.list("/shelves");
  } catch (error) {
    if (error instanceof BookStackMissing) throw new HttpError(error.status === 403 ? 403 : 400, error.status === 403 ? NO_PERMISSION : NOT_BOOKSTACK);
    throw error;
  }
  const shelves: Shelf[] = [];
  for (const item of shelfItems) {
    try {
      const detail = await client.call(`/shelves/${num(item.id)}`);
      shelves.push({ id: num(item.id), name: nameOf(item), slug: String(item.slug || ""), books: (Array.isArray(detail.books) ? detail.books : []).map((b: Json) => num(b.id)), detail });
    } catch (error) {
      if (!(error instanceof BookStackMissing)) throw error;
    }
  }
  const books: Book[] = (await client.list("/books")).map((b) => ({ id: num(b.id), name: nameOf(b), slug: String(b.slug || "") }));
  shelves.sort(byName);
  return { shelves, books };
}

// What the token sees, for the choice: the shelves with their books and
// the books on no shelf.
export type BookStackListing = {
  shelves: { id: number; name: string; books: { id: number; name: string }[] }[];
  books: { id: number; name: string }[];
};
export async function listBookStack(credentials: BookStackCredentials, options: BookStackOptions = {}): Promise<BookStackListing> {
  const client = bookStackClient(credentials, options);
  const { shelves, books } = await readShelvesAndBooks(client);
  const byId = new Map(books.map((b) => [b.id, b]));
  const shelved = new Set(shelves.flatMap((s) => s.books));
  return {
    shelves: shelves.map((s) => ({ id: s.id, name: s.name, books: s.books.flatMap((id) => (byId.has(id) ? [{ id, name: byId.get(id)!.name }] : [])) })),
    books: books.filter((b) => !shelved.has(b.id)).sort(byName).map(({ id, name }) => ({ id, name })),
  };
}

// The choice: no lists for everything; `shelves` alone for those shelves
// with all their books; `books` for exactly those books, each below the
// first chosen shelf it is on (`shelves`, else at the top).
export type BookStackSelection = { shelves?: number[]; books?: number[] };

export type BookStackCounts = { shelves: number; books: number; chapters: number; pages: number; images: number; attachments: number; links: number; tags: number };
export type BookStackImportOptions = BookStackOptions & {
  dryRun?: boolean;
  // The person's largest upload.
  maxFileBytes?: number;
  tmpDir?: string;
};

type Context = {
  client: BookStackClient;
  dryRun: boolean;
  report: ImportReport;
  warnings: ReturnType<typeof warningList>;
  files: Map<string, ImportFile>;
  maxFileBytes: number;
  maxFiles: number;
  skippedFiles: number;
  tmp: string;
  // Image addresses (absolute) → the file's key; in a preview only counted.
  images: Map<string, string | null>;
  imageCount: number;
  // Attachment id → the file's key (downloaded files).
  attachmentFiles: Map<number, string>;
  links: { pageById: Map<number, string>; pageBySlug: Map<string, string>; chapterBySlug: Map<string, string>; bookBySlug: Map<string, string>; shelfBySlug: Map<string, string> };
};

const CALLOUTS: Record<string, string> = { info: "note", success: "tip", warning: "warning", danger: "caution" };
const decode = (part: string) => {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
};
// Gallery thumbnails (scaled-…/thumbs-…) lead to the original upload.
const originalImage = (url: URL) => {
  const copy = new URL(url.href);
  copy.pathname = copy.pathname.replace(/\/(?:scaled|thumbs)-\d+-\d*\//, "/");
  return copy;
};
const isUpload = (ctx: Context, url: URL) => ctx.client.inside(url) && /\/uploads\/images\//.test(url.pathname.slice(ctx.client.root.pathname.length - 1));

function storeFile(ctx: Context, prefix: string, name: string, mime: string, data: Buffer) {
  const key = `bookstack-${prefix}-${ctx.files.size + 1}`;
  const path = resolve(ctx.tmp, key);
  mkdirSync(ctx.tmp, { recursive: true, mode: 0o700 });
  writeFileSync(path, data, { mode: 0o600 });
  ctx.files.set(key, { key, name: name.slice(0, 200) || key, mime, size: data.length, read: () => readFileSync(path) });
  return key;
}
const tooLarge = (ctx: Context, name: string) =>
  ct(`„${name}“ ist größer als ${Math.round(ctx.maxFileBytes / 1048576)} MB`, `“${name}” is larger than ${Math.round(ctx.maxFileBytes / 1048576)} MB`);
// Room for one more file within FLOWPLAN_IMPORT_MAX_FILES.
const roomForFile = (ctx: Context) => {
  if (ctx.files.size < ctx.maxFiles) return true;
  ctx.skippedFiles++;
  return false;
};

// The images a page shows, downloaded (or counted) before its HTML is
// converted: same-BookStack uploads and embedded data: images.
async function collectImages(ctx: Context, html: string, markdown: string, page: string) {
  const sources = new Set<string>();
  for (const img of find(parseHtml(html).children, (el) => el.name.toLowerCase() === "img")) if (attr(img, "src")) sources.add(attr(img, "src"));
  for (const [, src] of markdown.matchAll(/!\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?/g)) sources.add(src);
  for (const src of sources) {
    const key = imageKey(ctx, src);
    if (!key || ctx.images.has(key)) continue;
    ctx.imageCount++;
    if (ctx.dryRun) {
      ctx.images.set(key, null);
      continue;
    }
    if (!roomForFile(ctx)) {
      ctx.images.set(key, null);
      continue;
    }
    if (key.startsWith("data:")) {
      const match = /^data:(image\/(?:png|jpeg|gif|webp|avif));base64,([A-Za-z0-9+/=\s]+)$/i.exec(key);
      const data = match ? Buffer.from(match[2], "base64") : Buffer.alloc(0);
      if (!data.length || data.length > ctx.maxFileBytes) {
        ctx.report.add("file", data.length ? tooLarge(ctx, ct("Eingebettetes Bild", "Embedded image")) : ct("Ein eingebettetes Bild konnte nicht gelesen werden", "An embedded image could not be read"), page);
        ctx.warnings.add("Ein Bild konnte nicht übernommen werden.");
        ctx.images.set(key, null);
        continue;
      }
      const mime = match![1].toLowerCase();
      ctx.images.set(key, storeFile(ctx, "image", `bild.${mime.split("/")[1] === "jpeg" ? "jpg" : mime.split("/")[1]}`, mime, data));
      continue;
    }
    const url = new URL(key);
    const name = decode(url.pathname.split("/").pop() || "") || "bild.png";
    const got = await ctx.client.file(url.href, ctx.maxFileBytes);
    if ("error" in got) {
      ctx.report.add("file", got.error === "size" ? tooLarge(ctx, name) : ct(`„${name}“ konnte nicht geladen werden`, `“${name}” could not be downloaded`), page);
      ctx.warnings.add(got.error === "size" ? "Ein Bild ist größer als die Grenze beim Hochladen und wurde ausgelassen." : "Ein Bild konnte nicht geladen werden.");
      ctx.images.set(key, null);
      continue;
    }
    const mime = isImage(got.mime) ? got.mime : mimeOf(name);
    ctx.images.set(key, storeFile(ctx, "image", name, mime, got.data));
  }
}
// The key of an image source to import (its original's absolute address,
// or the data: address), null for images elsewhere (they stay as they are).
function imageKey(ctx: Context, src: string): string | null {
  const value = src.trim();
  if (/^data:image\//i.test(value)) return value.replace(/\s+/g, "");
  let url: URL;
  try {
    url = new URL(value, `${ctx.client.base}/`);
  } catch {
    return null;
  }
  return isUpload(ctx, url) ? originalImage(url).href : null;
}

// The target of a link: pages, chapters, books and shelves of the import,
// attachments brought along; other addresses stay (made absolute).
function linkTarget(ctx: Context, raw: string, self: string): string | null {
  const href = raw.trim();
  if (!href) return null;
  if (href.startsWith("#")) return pageRef(self, decode(href.slice(1)) || null);
  let url: URL;
  try {
    url = new URL(href, `${ctx.client.base}/`);
  } catch {
    return null;
  }
  if (!/^(https?|mailto):$/.test(url.protocol)) return null;
  if (ctx.client.inside(url)) {
    const rest = url.pathname.slice(ctx.client.root.pathname.length - 1).replace(/\/+$/, "");
    const anchor = url.hash ? decode(url.hash.slice(1)) : "";
    const { links } = ctx;
    let key: string | undefined;
    let m: RegExpExecArray | null;
    if ((m = /^\/link\/(\d+)$/.exec(rest))) key = links.pageById.get(Number(m[1]));
    else if ((m = /^\/books\/([^/]+)\/page\/([^/]+)$/.exec(rest))) key = links.pageBySlug.get(`${decode(m[1])}/${decode(m[2])}`);
    else if ((m = /^\/books\/([^/]+)\/chapter\/([^/]+)$/.exec(rest))) key = links.chapterBySlug.get(`${decode(m[1])}/${decode(m[2])}`);
    else if ((m = /^\/books\/([^/]+)$/.exec(rest))) key = links.bookBySlug.get(decode(m[1]));
    else if ((m = /^\/shelves\/([^/]+)$/.exec(rest))) key = links.shelfBySlug.get(decode(m[1]));
    else if ((m = /^\/attachments\/(\d+)$/.exec(rest))) {
      const file = ctx.attachmentFiles.get(Number(m[1]));
      if (file) return fileRef(file);
    }
    if (key) return pageRef(key, anchor || null);
  }
  return url.href;
}
function imageTarget(ctx: Context, src: string) {
  const key = imageKey(ctx, src);
  if (!key) return /^https?:/i.test(src.trim()) ? src.trim() : null;
  const file = ctx.images.get(key);
  return file ? fileRef(file) : null;
}

// BookStack's editor HTML as editor HTML: callouts, task lists, images of
// the instance, links between pages; the rest is the importers' common
// conversion (headings, lists, tables, code, collapsible blocks; the
// bkmrk-… ids stay as block ids, so links to a paragraph find it).
function convertBookStackHtml(ctx: Context, html: string, self: string): string {
  const rule: Rule = (el, inner, render) => {
    const tag = el.name.toLowerCase();
    if ((tag === "p" || tag === "div" || tag === "blockquote") && hasClass(el, "callout")) {
      const kind = (el.attribs.class || "").split(/\s+/).find((c) => CALLOUTS[c]);
      return `<aside data-callout="${CALLOUTS[kind || "info"]}">${renderNodes(el.children, { rule }) || "<p></p>"}</aside>`;
    }
    if (tag === "input") return "";
    if ((tag === "ul" || tag === "ol") && isTaskList(el)) {
      const items = el.children.filter(isElement).filter((li) => li.name.toLowerCase() === "li");
      return `<ul data-type="taskList">${items
        .map((li) => {
          const box = li.children.find((c) => isElement(c) && c.name.toLowerCase() === "input") as Element | undefined;
          const checked = !!box && box.attribs.checked !== undefined;
          return `<li data-type="taskItem" data-checked="${checked}">${renderNodes(li.children.filter((c) => c !== box), { rule }) || "<p></p>"}</li>`;
        })
        .join("")}</ul>`;
    }
    if (tag === "a") {
      // A link around an image (the gallery links each image to its
      // original): the image alone.
      const kids = el.children.filter((c) => !(c.type === "text" && !c.data.trim()));
      if (kids.length === 1 && isElement(kids[0]) && kids[0].name.toLowerCase() === "img") return render(kids);
      const target = linkTarget(ctx, attr(el, "href"), self);
      const content = inner().trim() || esc(text(el).trim());
      return target ? `<a href="${esc(target)}">${content || esc(target)}</a>` : content;
    }
    if (tag === "img") {
      const src = imageTarget(ctx, attr(el, "src"));
      return src ? `<img src="${esc(src)}" alt="${esc(attr(el, "alt"))}">` : "";
    }
    return undefined;
  };
  return renderNodes(parseHtml(html).children, { rule });
}
const isTaskList = (el: Element) =>
  hasClass(el, "task-list") ||
  el.children.some((li) => isElement(li) && (hasClass(li, "task-list-item") || li.children.some((c) => isElement(c) && c.name.toLowerCase() === "input" && (c.attribs.type || "").toLowerCase() === "checkbox")));

// Markdown pages: the Markdown, unless it holds HTML (BookStack's callouts
// are HTML in Markdown) – then the rendered HTML.
const outsideCode = (markdown: string) => markdown.replace(/^\s{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s{0,3}\1[^\n]*$/gm, "").replace(/`+[^`\n]*`+/g, "");
const hasHtml = (markdown: string) => /<\/?[a-z][a-z0-9-]*(?:\s[^>]*)?\/?>/i.test(outsideCode(markdown));

function descriptionHtml(ctx: Context, detail: Json, self: string) {
  const html = typeof detail.description_html === "string" ? detail.description_html : "";
  if (html.trim()) return convertBookStackHtml(ctx, html, self);
  const plain = typeof detail.description === "string" ? detail.description.trim() : "";
  return plain
    ? plain
        .split(/\n{2,}/)
        .map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`)
        .join("")
    : "";
}
// "name: value" or "name", as the page's tags.
const tagsOf = (detail: Json) => [
  ...new Set(
    (Array.isArray(detail.tags) ? (detail.tags as Json[]) : [])
      .map((t) => {
        const name = String(t?.name ?? "").trim();
        const value = String(t?.value ?? "").trim();
        return name ? (value ? `${name}: ${value}` : name) : "";
      })
      .filter(Boolean),
  ),
];
const textOf = (html: string) => html.replace(/<[^>]*>/g, "").trim();

// Reads the chosen shelves and books into an import tree. A preview
// (dryRun) reads the structure, pages and attachment lists and counts the
// images and attachments without downloading them.
export async function readBookStack(credentials: BookStackCredentials, selection: BookStackSelection = {}, options: BookStackImportOptions = {}): Promise<{ tree: ImportTree; counts: BookStackCounts }> {
  const tmp = options.tmpDir || resolve(process.env.FLOWPLAN_DATA_DIR || "./data", "tmp", "imports", `bookstack-${randomUUID()}`);
  const client = bookStackClient(credentials, options);
  const ctx: Context = {
    client,
    dryRun: !!options.dryRun,
    report: importReport(),
    warnings: warningList(),
    files: new Map(),
    maxFileBytes: options.maxFileBytes || 100 * 1048576,
    maxFiles: maxImportFiles(),
    skippedFiles: 0,
    tmp,
    images: new Map(),
    imageCount: 0,
    attachmentFiles: new Map(),
    links: { pageById: new Map(), pageBySlug: new Map(), chapterBySlug: new Map(), bookBySlug: new Map(), shelfBySlug: new Map() },
  };
  try {
    await jobProgress(0.02);
    const { shelves, books } = await readShelvesAndBooks(client);
    const bookById = new Map(books.map((b) => [b.id, b]));
    // The choice.
    const everything = !selection.shelves && !selection.books;
    const chosenShelves = shelves.filter((s) => everything || (selection.shelves || []).includes(s.id));
    const chosenBooks = new Set(
      everything ? books.map((b) => b.id) : selection.books ? selection.books.filter((id) => bookById.has(id)) : chosenShelves.flatMap((s) => s.books.filter((id) => bookById.has(id))),
    );
    // Each book once, below the first chosen shelf it is on.
    const home = new Map<number, Shelf>();
    for (const shelf of chosenShelves)
      for (const id of shelf.books) {
        if (!chosenBooks.has(id)) continue;
        const first = home.get(id);
        if (!first) home.set(id, shelf);
        else ctx.warnings.add(`Das Buch „${bookById.get(id)!.name}“ steht in mehreren Regalen und wird nur einmal unter „${first.name}“ importiert.`);
      }
    const chapterItems = (await client.list("/chapters")).filter((c) => chosenBooks.has(num(c.book_id)));
    const pageItems = (await client.list("/pages")).filter((p) => chosenBooks.has(num(p.book_id)) && !p.draft);
    await jobProgress(0.06);
    const chapterIds = new Set(chapterItems.map((c) => num(c.id)));
    const counts: BookStackCounts = { shelves: chosenShelves.length, books: chosenBooks.size, chapters: chapterItems.length, pages: pageItems.length, images: 0, attachments: 0, links: 0, tags: 0 };
    const total = counts.shelves + counts.books + counts.chapters + counts.pages;
    const limit = maxImportPages();
    if (total > limit && !ctx.dryRun) throw new HttpError(413, tooManyPages(total, limit));

    // Keys, and the addresses links use.
    const shelfKey = (id: number) => `shelf-${id}`,
      bookKey = (id: number) => `book-${id}`,
      chapterKey = (id: number) => `chapter-${id}`,
      pageKey = (id: number) => `page-${id}`;
    for (const shelf of chosenShelves) if (shelf.slug) ctx.links.shelfBySlug.set(shelf.slug, shelfKey(shelf.id));
    for (const id of chosenBooks) if (bookById.get(id)!.slug) ctx.links.bookBySlug.set(bookById.get(id)!.slug, bookKey(id));
    for (const c of chapterItems) ctx.links.chapterBySlug.set(`${bookById.get(num(c.book_id))!.slug}/${c.slug}`, chapterKey(num(c.id)));
    for (const p of pageItems) {
      ctx.links.pageById.set(num(p.id), pageKey(num(p.id)));
      ctx.links.pageBySlug.set(`${bookById.get(num(p.book_id))!.slug}/${p.slug}`, pageKey(num(p.id)));
    }

    // The tree's order: shelves by name with their books in the shelf's
    // order, then the books on no chosen shelf by name; in a book its
    // chapters and pages by priority, in a chapter its pages.
    const pages: ImportPage[] = [];
    const entry = (key: string, parent: string | null, item: Json): ImportPage => ({
      key,
      parent,
      title: nameOf(item),
      html: "",
      folder: true,
      created: isoDate(item.created_at),
      updated: isoDate(item.updated_at),
    });
    const ordered: { kind: "shelf" | "book" | "chapter" | "page"; id: number; page: ImportPage }[] = [];
    const add = (kind: "shelf" | "book" | "chapter" | "page", id: number, page: ImportPage) => {
      pages.push(page);
      ordered.push({ kind, id, page });
    };
    const order = (a: Json, b: Json) => num(a.priority) - num(b.priority) || num(a.id) - num(b.id);
    const addBook = (id: number, parent: string | null) => {
      const book = bookById.get(id)!;
      add("book", id, entry(bookKey(id), parent, book));
      const inBook = [
        ...chapterItems.filter((c) => num(c.book_id) === id).map((c): Json => ({ ...c, __kind: "chapter" })),
        ...pageItems.filter((p) => num(p.book_id) === id && !chapterIds.has(num(p.chapter_id))).map((p): Json => ({ ...p, __kind: "page" })),
      ].sort((a, b) => order(a, b) || (a.__kind === b.__kind ? 0 : a.__kind === "chapter" ? -1 : 1));
      for (const item of inBook) {
        if (item.__kind === "page") {
          add("page", num(item.id), { ...entry(pageKey(num(item.id)), bookKey(id), item), folder: false });
          continue;
        }
        add("chapter", num(item.id), entry(chapterKey(num(item.id)), bookKey(id), item));
        for (const p of pageItems.filter((p) => num(p.chapter_id) === num(item.id)).sort(order))
          add("page", num(p.id), { ...entry(pageKey(num(p.id)), chapterKey(num(item.id)), p), folder: false });
      }
    };
    for (const shelf of chosenShelves) {
      add("shelf", shelf.id, entry(shelfKey(shelf.id), null, shelf.detail.name ? shelf.detail : { name: shelf.name }));
      for (const id of shelf.books) if (home.get(id) === shelf) addBook(id, shelfKey(shelf.id));
    }
    for (const book of books.filter((b) => chosenBooks.has(b.id) && !home.has(b.id)).sort(byName)) addBook(book.id, null);

    const tree = (): ImportTree => ({
      source: "bookstack",
      title: chosenShelves.length + [...chosenBooks].filter((id) => !home.has(id)).length === 1 ? pages[0]?.title || "BookStack" : "BookStack",
      pages,
      files: ctx.files,
      warnings: ctx.warnings.list(),
      report: ctx.report,
      close: () => rmSync(tmp, { recursive: true, force: true }),
    });
    // Too many for one import: the preview counts, nothing more is read.
    if (total > limit) return { tree: { ...tree(), tooMany: true }, counts };

    // Attachments of the chosen pages, by page in BookStack's order.
    const attachments = new Map<number, Json[]>();
    if (pageItems.length)
      for (const a of await client.list("/attachments")) {
        const page = num(a.uploaded_to);
        if (!ctx.links.pageById.has(page)) continue;
        if (!attachments.has(page)) attachments.set(page, []);
        attachments.get(page)!.push(a);
      }
    for (const list of attachments.values()) list.sort((a, b) => num(a.order) - num(b.order) || num(a.id) - num(b.id));

    // Details: descriptions, tags, page content, files.
    const tags = new Set<string>();
    let done = 0;
    for (const { kind, id, page } of ordered) {
      done++;
      await jobProgress(0.06 + (0.84 * done) / ordered.length);
      let detail: Json;
      try {
        detail = kind === "shelf" ? chosenShelves.find((s) => s.id === id)!.detail : await client.call(`/${kind}s/${id}`);
      } catch (error) {
        if (!(error instanceof BookStackMissing)) throw error;
        ctx.warnings.add("Ein Eintrag ist für das Token nicht (mehr) sichtbar und wurde nur mit seinem Titel übernommen.");
        ctx.report.add("other", ct("Nicht (mehr) für das Token sichtbar: nur der Titel übernommen", "Not (or no longer) visible to the token: title only"), page.key);
        continue;
      }
      page.tags = tagsOf(detail);
      for (const tag of page.tags) tags.add(tag);
      if (kind !== "page") {
        page.html = descriptionHtml(ctx, detail, page.key);
        page.folder = !textOf(page.html) && !/<img\b/.test(page.html);
        continue;
      }
      if (detail.draft) continue;
      const html = typeof detail.html === "string" ? detail.html : "";
      const markdown = typeof detail.markdown === "string" ? detail.markdown : "";
      // Attachments first: links to them in the text lead to the files.
      const appended: string[] = [];
      for (const a of attachments.get(id) || []) {
        const name = String(a.name || "").trim().slice(0, 200) || ct("Anhang", "Attachment");
        if (a.external) counts.links++;
        else counts.attachments++;
        if (ctx.dryRun) continue;
        if (!a.external && !roomForFile(ctx)) continue;
        const got = await client.attachment(num(a.id), ctx.maxFileBytes);
        if ("link" in got) appended.push(`<p><a href="${esc(got.link)}">${esc(name)}</a></p>`);
        else if ("data" in got) {
          const ext = String(a.extension || "").replace(/[^\w]/g, "").slice(0, 10);
          const file = `${name}${ext && !name.toLowerCase().endsWith(`.${ext.toLowerCase()}`) ? `.${ext}` : ""}`;
          const key = storeFile(ctx, "file", file, mimeOf(file), got.data);
          ctx.attachmentFiles.set(num(a.id), key);
          appended.push(`<div data-import-file="${fileRef(key)}" data-title="${esc(file)}"></div>`);
        } else {
          ctx.report.add("file", got.error === "size" ? tooLarge(ctx, name) : ct(`„${name}“ konnte nicht geladen werden`, `“${name}” could not be downloaded`), page.key);
          ctx.warnings.add(got.error === "size" ? "Ein Anhang ist größer als die Grenze beim Hochladen und wurde ausgelassen." : "Ein Anhang konnte nicht geladen werden.");
        }
      }
      const useMarkdown = !!markdown.trim() && !hasHtml(markdown);
      await collectImages(ctx, html, useMarkdown ? markdown : "", page.key);
      let content = useMarkdown
        ? markdownToRawHtml(markdown, (href, kindOf) => (kindOf === "image" ? imageTarget(ctx, href) : linkTarget(ctx, href, page.key)))
        : convertBookStackHtml(ctx, html, page.key);
      // Files linked in the text are not listed again below it.
      const extra = appended.filter((block) => {
        const ref = /fp-import:\/\/file\/[^"]*/.exec(block)?.[0];
        return !ref || !content.includes(`href="${ref}"`);
      });
      if (extra.length) content += extra.join("");
      page.html = content;
    }
    counts.images = ctx.imageCount;
    counts.tags = tags.size;
    if (ctx.skippedFiles) ctx.warnings.add(tooManyFiles(ctx.skippedFiles, ctx.maxFiles));
    await jobProgress(0.9);
    return { tree: tree(), counts };
  } catch (error) {
    rmSync(tmp, { recursive: true, force: true });
    throw error;
  }
}
