// Import from Notion through its API, as an alternative to the export file.
// The person creates an internal integration in Notion, shares the pages
// and databases with it and pastes its token: the server lists what the
// token sees (listNotionRoots), the person picks top-level pages and
// databases, and the import (parseNotionApi) reads them with everything
// below – blocks, sub-pages, databases with their records, files – into an
// import tree that lib/importers/write.ts writes like any other.
//
// The token is used for these requests only: it is never stored, logged
// or part of a job's label or result; while a background import runs it
// lives in that job's memory (the closure that runs it) and nowhere else.
//
// Requests go to https://api.notion.com/v1 only (fixed; a test may point
// the client at a mock server, nothing a person can set), at most three per
// second as Notion asks, with Retry-After honoured on 429 and retries on
// 5xx. Files Notion hosts are downloaded during the import (their
// addresses expire after an hour), only from Notion's file hosts and
// within the person's upload limit; external files stay links.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { HttpError } from "../auth";
import { safeFetch } from "../safe-fetch";
import { jobProgress } from "../background-jobs";
import { ct } from "../content-locale";
import { escapeInline } from "../inline-markdown";
import { calloutIcon } from "../callout-types";
import { CALLOUT_COLORS } from "../callout-types";
import { codeBlockHtml, esc, fileRef, pageRef } from "./html";
import { colored, notionColorName, notionOptionColor } from "./notion-html";
import { notionFormula, notionType, ROLLUP_FUNCTIONS } from "./notion-props";
import { importReport, MAX_IMPORT_ROWS, maxImportPages, type ImportFile, type ImportPage, type ImportReport, type ImportTree, type ReportKind } from "./types";
import type { Field, View } from "../types";

export const NOTION_API = "https://api.notion.com/v1";
export const NOTION_VERSION = "2022-06-28";
const MIN_INTERVAL_MS = 340;
const MAX_RETRIES = 6;
const MAX_RETRY_AFTER_S = 60;
const MAX_DEPTH = 30;

// An internal integration token: "ntn_…" (current) or "secret_…" (older).
export const NOTION_TOKEN = /^(?:ntn_|secret_)[A-Za-z0-9_-]{20,200}$/;
export function checkNotionToken(token: unknown): string {
  if (typeof token !== "string" || !NOTION_TOKEN.test(token.trim()))
    throw new HttpError(400, "Das sieht nicht nach einem Notion-Integrations-Token aus (es beginnt mit „ntn_“ oder „secret_“).");
  return token.trim();
}

// Test hooks only: the mock server's address, no waiting. Not reachable
// through any request or setting.
export type NotionClientOptions = { base?: string; minIntervalMs?: number; sleep?: (ms: number) => Promise<void> };

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export class NotionMissing extends Error {}

export function notionClient(token: string, options: NotionClientOptions = {}) {
  const base = (options.base || NOTION_API).replace(/\/$/, "");
  const testing = !!options.base;
  const sleep = options.sleep || ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const interval = options.minIntervalMs ?? MIN_INTERVAL_MS;
  let last = 0;
  let requests = 0;
  async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<Json> {
    for (let attempt = 0; ; attempt++) {
      const wait = last + interval - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      requests++;
      let response;
      try {
        response = await safeFetch(`${base}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            "notion-version": NOTION_VERSION,
            "content-type": "application/json",
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          accept: "application/json",
          maxBytes: 20_000_000,
          timeout: 30_000,
          allowPrivate: testing,
        });
      } catch (error) {
        if (attempt < 2) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        void error;
        throw new HttpError(502, "Notion ist gerade nicht erreichbar. Bitte versuche es später erneut.", { service: "notion", host: "api.notion.com" });
      }
      if (response.status === 429 && attempt < MAX_RETRIES) {
        const after = Number(response.headers["retry-after"]);
        await sleep(Math.min(MAX_RETRY_AFTER_S, Number.isFinite(after) && after > 0 ? after : 1) * 1000);
        continue;
      }
      if (response.status >= 500 && attempt < 3) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      let data: Json = {};
      try {
        data = JSON.parse(response.body || "{}");
      } catch {}
      if (response.status === 401) throw new HttpError(400, "Notion hat das Integrations-Token abgelehnt. Bitte prüfe es und versuche es erneut.");
      if (response.status === 403 || response.status === 404) throw new NotionMissing(String(data.code || response.status));
      if (response.status === 429) throw new HttpError(429, "Notion begrenzt gerade die Anfragen. Bitte versuche es später erneut.");
      if (response.status < 200 || response.status >= 300) throw new HttpError(502, "Notion hat die Anfrage nicht beantwortet. Bitte versuche es später erneut.", { service: "notion", host: "api.notion.com" });
      return data;
    }
  }
  // All results of a paginated list (start_cursor / next_cursor), at most `max`.
  async function* list(method: "GET" | "POST", path: string, body: Json = {}, max = Infinity) {
    let cursor: string | undefined;
    let count = 0;
    do {
      const page =
        method === "GET"
          ? await call("GET", `${path}${path.includes("?") ? "&" : "?"}page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`)
          : await call("POST", path, { ...body, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
      for (const item of (page.results as Json[]) || []) {
        if (count++ >= max) return;
        yield item;
      }
      cursor = page.has_more && typeof page.next_cursor === "string" ? page.next_cursor : undefined;
    } while (cursor);
  }
  // A file Notion hosts (an S3 address valid for an hour): only from its
  // hosts (or the mock server), within `maxBytes`.
  async function download(url: string, maxBytes: number) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { error: "invalid" as const };
    }
    const own = testing && parsed.origin === new URL(base).origin;
    if (!own && (parsed.protocol !== "https:" || !NOTION_FILE_HOSTS.test(parsed.hostname))) return { error: "host" as const };
    try {
      const file = await safeFetch(url, { maxBytes, timeout: 60_000, accept: "*/*", allowPrivate: own });
      if (file.status < 200 || file.status >= 300) return { error: "failed" as const };
      return { data: file.data, mime: file.type.split(";")[0].trim().toLowerCase() };
    } catch (error) {
      return { error: /zu groß/.test(String((error as Error).message)) ? ("size" as const) : ("failed" as const) };
    }
  }
  return { call, list, download, requests: () => requests };
}
export type NotionClient = ReturnType<typeof notionClient>;
const NOTION_FILE_HOSTS = /(^|\.)(amazonaws\.com|notion\.so|notion\.site|notion-static\.com|notionusercontent\.com)$/i;

const bareId = (id: unknown) => (typeof id === "string" ? id.replaceAll("-", "").toLowerCase() : "");
const plain = (rich: unknown) => (Array.isArray(rich) ? rich.map((r: Json) => String(r?.plain_text ?? "")).join("") : "");
const titleOf = (object: Json) => {
  if (object.object === "database") return plain(object.title).trim();
  for (const value of Object.values((object.properties || {}) as Record<string, Json>)) if (value?.type === "title") return plain(value.title).trim();
  return "";
};
const emojiIcon = (object: Json) => (object.icon?.type === "emoji" && typeof object.icon.emoji === "string" ? object.icon.emoji : undefined);

// What the token sees, for the choice: pages and databases whose parent is
// the workspace or not shared with the integration.
export type NotionRoot = { id: string; title: string; kind: "page" | "database"; icon?: string };
export async function listNotionRoots(token: string, options: NotionClientOptions = {}): Promise<NotionRoot[]> {
  const client = notionClient(token, options);
  const found = new Map<string, Json>();
  for await (const item of client.list("POST", "/search", {}, 5000)) if (item.object === "page" || item.object === "database") found.set(bareId(item.id), item);
  const roots: NotionRoot[] = [];
  for (const [id, item] of found) {
    const parent = item.parent || {};
    const parentId = bareId(parent.page_id || parent.database_id || parent.block_id);
    if (parent.type !== "workspace" && parentId && found.has(parentId)) continue;
    // Records of a database the integration does not see stay out.
    if (parent.type === "database_id") continue;
    if (item.archived || item.in_trash) continue;
    roots.push({ id, title: titleOf(item).slice(0, 300) || ct("Ohne Titel", "Untitled"), kind: item.object, ...(emojiIcon(item) ? { icon: emojiIcon(item) } : {}) });
  }
  return roots.sort((a, b) => a.title.localeCompare(b.title, "de")).slice(0, 1000);
}

type Context = {
  client: NotionClient;
  report: ImportReport;
  files: Map<string, ImportFile>;
  member: (person: { name?: string; email?: string }) => string | undefined;
  maxFileBytes: number;
  tmp: string;
  // Pages and databases to read, and what was read.
  queue: { id: string; kind: "page" | "database"; parent: string | null }[];
  seen: Set<string>;
  // Titles of link_to_page targets and mentions, filled in at the end.
  titles: Map<string, string>;
  warnings: Set<string>;
  limit: number;
  pages: ImportPage[];
};
const TITLE_MARK = (id: string) => `\u0001${id}\u0001`;

async function fileFor(ctx: Context, page: string, value: Json | undefined, fallbackName: string) {
  if (!value) return null;
  if (value.type === "external") return { external: String(value.external?.url || "") };
  if (value.type !== "file" || typeof value.file?.url !== "string") return null;
  const url = value.file.url as string;
  let name = fallbackName;
  try {
    name = decodeURIComponent(new URL(url).pathname.split("/").pop() || "") || fallbackName;
  } catch {}
  name = typeof value.name === "string" && value.name.trim() ? value.name.trim() : name;
  const got = await ctx.client.download(url, ctx.maxFileBytes);
  if ("error" in got) {
    ctx.report.add(
      "file",
      got.error === "size"
        ? ct(`„${name}“ ist größer als ${Math.round(ctx.maxFileBytes / 1048576)} MB`, `“${name}” is larger than ${Math.round(ctx.maxFileBytes / 1048576)} MB`)
        : ct(`„${name}“ konnte nicht geladen werden`, `“${name}” could not be downloaded`),
      page,
    );
    return null;
  }
  const key = `notion-file-${ctx.files.size + 1}`;
  const path = resolve(ctx.tmp, key);
  mkdirSync(ctx.tmp, { recursive: true, mode: 0o700 });
  writeFileSync(path, got.data, { mode: 0o600 });
  ctx.files.set(key, { key, name: name.slice(0, 200), mime: got.mime || "application/octet-stream", size: got.data.length, read: () => readFileSync(path) });
  return { key, name };
}

// Rich text with its annotations, colours, links and mentions.
function richText(ctx: Context, rich: unknown): string {
  if (!Array.isArray(rich)) return "";
  return rich
    .map((item: Json) => {
      let html: string;
      let href: string | null = null;
      if (item.type === "equation") html = `<code>${esc(String(item.equation?.expression ?? item.plain_text ?? ""))}</code>`;
      else if (item.type === "mention") {
        const m = item.mention || {};
        if (m.type === "page" || m.type === "database") {
          const id = bareId(m.page?.id || m.database?.id);
          href = id ? pageRef(id) : null;
          html = esc(String(item.plain_text || ""));
          if (id && item.plain_text) ctx.titles.set(id, ctx.titles.get(id) || String(item.plain_text));
        } else if (m.type === "link_preview" || m.type === "link_mention") {
          href = String(m.link_preview?.url || m.link_mention?.href || item.href || "");
          html = esc(String(item.plain_text || href));
        } else if (m.type === "user") html = esc(`@${String(m.user?.name || item.plain_text || "").replace(/^@/, "")}`);
        else html = esc(String(item.plain_text || ""));
      } else {
        html = esc(String(item.text?.content ?? item.plain_text ?? ""));
        href = item.text?.link?.url || item.href || null;
      }
      const a = item.annotations || {};
      if (a.code && item.type !== "equation") html = `<code>${html}</code>`;
      if (a.strikethrough) html = `<s>${html}</s>`;
      if (a.underline) html = `<u>${html}</u>`;
      if (a.italic) html = `<em>${html}</em>`;
      if (a.bold) html = `<strong>${html}</strong>`;
      html = colored(html, notionColorName(a.color));
      const target = href ? linkTarget(String(href)) : null;
      return target ? `<a href="${esc(target)}">${html}</a>` : html;
    })
    .join("")
    .replace(/\n/g, "<br>");
}
// Links to Notion pages (/<id>, notion.so/…-<id>) name the page of the
// import; other web addresses stay.
function linkTarget(href: string) {
  const internal = /^(?:https?:\/\/(?:www\.)?notion\.(?:so|site)\/(?:[^?#]*?[-/])?|\/)([0-9a-f]{32})(?:[?#].*)?$/i.exec(href);
  if (internal) return pageRef(internal[1].toLowerCase());
  return /^(https?:|mailto:)/i.test(href) ? href : null;
}

async function blockChildren(ctx: Context, id: string) {
  const blocks: Json[] = [];
  try {
    for await (const block of ctx.client.list("GET", `/blocks/${id}/children`)) blocks.push(block);
  } catch (error) {
    if (!(error instanceof NotionMissing)) throw error;
  }
  return blocks;
}

// A page's (or record's) blocks as editor HTML. `page` is the key the
// report names.
async function renderBlocks(ctx: Context, blocks: Json[], page: string, depth = 0, top = false): Promise<string> {
  const out: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const type = block.type as string;
    // Neighbouring list items form one list.
    if (type === "bulleted_list_item" || type === "numbered_list_item" || type === "to_do") {
      const items: string[] = [];
      let j = i;
      while (j < blocks.length && blocks[j].type === type) {
        const item = blocks[j];
        const data = item[type] || {};
        const body = `<p>${colorBlock(richText(ctx, data.rich_text), data.color)}</p>${item.has_children && depth < MAX_DEPTH ? await renderBlocks(ctx, await blockChildren(ctx, item.id), page, depth + 1) : ""}`;
        items.push(type === "to_do" ? `<li data-type="taskItem" data-checked="${!!data.checked}">${body}</li>` : `<li>${body}</li>`);
        j++;
      }
      out.push(type === "to_do" ? `<ul data-type="taskList">${items.join("")}</ul>` : type === "numbered_list_item" ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
      i = j - 1;
      continue;
    }
    // Toggle headings at the top of the page become headings (which fold in
    // Flowplan) when their content is exactly the heading's section – as
    // with the export (lib/importers/notion-html.ts) –, else toggles.
    const heading = /^heading_([123])$/.exec(type);
    if (heading && block[type]?.is_toggleable) {
      const level = Number(heading[1]);
      const inner = block.has_children && depth < MAX_DEPTH ? await blockChildren(ctx, block.id) : [];
      const next = blocks[i + 1];
      const nextLevel = next && /^heading_([123])$/.exec(next.type)?.[1];
      const fits = top && (!next || (nextLevel && Number(nextLevel) <= level)) && !inner.some((b: Json) => Number(/^heading_([123])$/.exec(b.type)?.[1] || 9) <= level);
      const content = await renderBlocks(ctx, inner, page, depth + 1);
      out.push(fits ? `<h${level}>${richText(ctx, block[type].rich_text)}</h${level}>${content}` : `<details><summary>${esc(plain(block[type].rich_text))}</summary><div>${content || "<p></p>"}</div></details>`);
      continue;
    }
    out.push(await renderBlock(ctx, block, page, depth));
  }
  return out.join("");
}
const colorBlock = (html: string, color: unknown) => colored(html, notionColorName(typeof color === "string" ? color : null));

async function renderBlock(ctx: Context, block: Json, page: string, depth: number): Promise<string> {
  const type = block.type as string;
  const data = block[type] || {};
  const kids = async () => (block.has_children && depth < MAX_DEPTH ? await renderBlocks(ctx, await blockChildren(ctx, block.id), page, depth + 1) : "");
  const caption = (value: Json) => plain(value?.caption).trim();
  const note = (kind: ReportKind, detail: string) => ctx.report.add(kind, detail, page);
  switch (type) {
    case "paragraph": {
      const text = richText(ctx, data.rich_text);
      return `<p>${colorBlock(text, data.color)}</p>${await kids()}`;
    }
    case "heading_1":
    case "heading_2":
    case "heading_3": {
      const level = type.slice(-1);
      return `<h${level}>${colorBlock(richText(ctx, data.rich_text), data.color)}</h${level}>${await kids()}`;
    }
    case "toggle":
      return `<details><summary>${esc(plain(data.rich_text))}</summary><div>${(await kids()) || "<p></p>"}</div></details>`;
    case "quote":
      return `<blockquote><p>${richText(ctx, data.rich_text)}</p>${await kids()}</blockquote>`;
    case "callout": {
      const icon = data.icon?.type === "emoji" ? calloutIcon(data.icon.emoji) : null;
      const color = notionColorName(data.color);
      const own = (icon ? ` data-callout-icon="${esc(icon)}"` : "") + (color && color.color in CALLOUT_COLORS ? ` data-callout-color="${color.color}"` : "");
      return `<aside data-callout="note"${own}><p>${richText(ctx, data.rich_text)}</p>${await kids()}</aside>`;
    }
    case "code":
      return codeBlockHtml(plain(data.rich_text), typeof data.language === "string" ? data.language.replace(/\s+/g, "") : null);
    case "equation":
      return `<div data-math="${esc(String(data.expression || ""))}"></div>`;
    case "divider":
      return "<hr>";
    case "table": {
      const rows = await blockChildren(ctx, block.id);
      const header = !!data.has_column_header,
        rowHeader = !!data.has_row_header;
      const body = rows
        .filter((r: Json) => r.type === "table_row")
        .map((r: Json, ri: number) => {
          const cells = ((r.table_row?.cells as unknown[]) || []).map((cell, ci) => {
            const tag = (header && ri === 0) || (rowHeader && ci === 0) ? "th" : "td";
            return `<${tag}><p>${richText(ctx, cell)}</p></${tag}>`;
          });
          return `<tr>${cells.join("")}</tr>`;
        });
      return body.length ? `<table><tbody>${body.join("")}</tbody></table>` : "";
    }
    case "image": {
      const text = caption(data);
      if (data.type === "external") {
        const url = String(data.external?.url || "");
        return /^https:\/\//i.test(url) ? (text ? `<figure><img src="${esc(url)}" alt="${esc(text)}"><figcaption>${esc(text)}</figcaption></figure>` : `<img src="${esc(url)}">`) : "";
      }
      const file = await fileFor(ctx, page, data, ct("Bild", "Image"));
      if (!file || "external" in file) return text ? `<p>${esc(text)}</p>` : "";
      const image = `<img src="${fileRef(file.key)}" alt="${esc(text || file.name)}">`;
      return text ? `<figure>${image}<figcaption>${esc(text)}</figcaption></figure>` : image;
    }
    case "file":
    case "pdf":
    case "audio":
    case "video": {
      const file = await fileFor(ctx, page, data, ct("Datei", "File"));
      if (file && "external" in file) {
        const url = String(file.external || "");
        if (!/^https?:\/\//i.test(url)) return "";
        note("embed", `${type}: ${url.slice(0, 200)}`);
        return `<p><a href="${esc(url)}">${esc(caption(data) || url)}</a></p>`;
      }
      if (!file) return "";
      return `<div data-import-file="${fileRef(file.key)}" data-title="${esc(caption(data) || file.name)}"></div>`;
    }
    case "bookmark":
    case "embed":
    case "link_preview": {
      const url = String(data.url || "");
      if (!/^https?:\/\//i.test(url)) return "";
      note("embed", `${type}: ${url.slice(0, 200)}`);
      return `<p><a href="${esc(url)}">${esc(caption(data) || url)}</a></p>`;
    }
    case "child_page": {
      const id = bareId(block.id);
      const title = String(data.title || "").trim();
      ctx.titles.set(id, title);
      enqueue(ctx, id, "page", page);
      return `<p><a href="${pageRef(id)}">${esc(title || ct("Ohne Titel", "Untitled"))}</a></p>`;
    }
    case "child_database": {
      const id = bareId(block.id);
      ctx.titles.set(id, String(data.title || "").trim());
      enqueue(ctx, id, "database", page);
      const views = JSON.stringify([{ id: randomUUID(), name: ct("Tabelle", "Table"), type: "table", filters: [], sorts: [] }]);
      return `<div data-linked-database="${randomUUID()}" data-linked-source="${esc(pageRef(id))}" data-linked-views="${esc(views)}" data-linked-version="1"></div>`;
    }
    case "link_to_page": {
      const id = bareId(data.page_id || data.database_id);
      if (!id) return "";
      return `<p><a href="${pageRef(id)}">${TITLE_MARK(id)}</a></p>`;
    }
    case "synced_block": {
      // The original shows its children; a copy those of the original.
      const original = bareId(data.synced_from?.block_id);
      if (!original) return await kids();
      if (depth >= MAX_DEPTH) return "";
      const blocks = await blockChildren(ctx, original);
      if (!blocks.length) {
        note("block", ct("Synchronisierter Block, dessen Original nicht geteilt ist", "Synced block whose original is not shared"));
        return "";
      }
      note("synced", ct("Inhalt des synchronisierten Blocks kopiert (er synchronisiert nicht mehr)", "Content of the synced block copied (it no longer syncs)"));
      return await renderBlocks(ctx, blocks, page, depth + 1);
    }
    case "column_list":
    case "column":
      // Columns one after the other.
      return await kids();
    case "table_of_contents":
    case "breadcrumb":
      note("block", type === "breadcrumb" ? ct("Brotkrumen-Navigation", "Breadcrumb") : ct("Inhaltsverzeichnis", "Table of contents"));
      return "";
    default:
      note("block", type || "unsupported");
      return await kids();
  }
}

function enqueue(ctx: Context, id: string, kind: "page" | "database", parent: string | null) {
  if (!id || ctx.seen.has(id)) return;
  if (ctx.seen.size >= ctx.limit) {
    ctx.warnings.add(`Mehr als ${ctx.limit} Seiten: weitere Seiten werden nicht übernommen (FLOWPLAN_IMPORT_MAX_DOCS).`);
    ctx.report.add("other", ct(`Mehr als ${ctx.limit} Seiten: weitere Seiten nicht übernommen`, `More than ${ctx.limit} pages: further pages not imported`), parent);
    return;
  }
  ctx.seen.add(id);
  ctx.queue.push({ id, kind, parent });
}

// A record's (or page's) properties: Flowplan's cells, by the database's
// field map.
type FieldPlan = { field: Field; notionId: string; notionName: string; notionType: string; convert: (value: Json) => unknown; relation?: string; rollup?: Json };
type DatabasePlan = { key: string; plans: FieldPlan[]; byNotionId: Map<string, FieldPlan> };

async function propertyItems(ctx: Context, page: string, prop: Json, propId: string) {
  // More than 25 relations: the property's own list.
  if (prop.type === "relation" && prop.has_more) {
    const items: Json[] = [];
    for await (const item of ctx.client.list("GET", `/pages/${page}/properties/${encodeURIComponent(propId)}`)) items.push(item);
    return { ...prop, relation: items.map((i) => i.relation).filter(Boolean) };
  }
  return prop;
}

function planDatabase(ctx: Context, key: string, database: Json): DatabasePlan {
  const props = Object.entries((database.properties || {}) as Record<string, Json>);
  const names = new Map(props.map(([name, p]) => [String(p.id), name]));
  // The title first, then Notion's order.
  props.sort(([, a], [, b]) => (a.type === "title" ? -1 : b.type === "title" ? 1 : 0));
  const plans: FieldPlan[] = [];
  let n = 0;
  for (const [rawName, prop] of props) {
    const name = rawName.slice(0, 200);
    const fid = prop.type === "title" ? "title" : `n${++n}`;
    const textOf = (value: Json) => propertyText(value);
    const plan = (field: Omit<Field, "id" | "name">, convert: (v: Json) => unknown, relation?: string): FieldPlan => ({
      field: { id: fid, name, ...field } as Field,
      notionId: String(prop.id),
      notionName: rawName,
      notionType: prop.type,
      convert,
      ...(relation ? { relation } : {}),
    });
    const options = (list: Json[] | undefined) => {
      const opts = (list || []).map((o) => String(o.name || "").slice(0, 500)).filter(Boolean);
      const colors = Object.fromEntries((list || []).flatMap((o) => (notionOptionColor(o.color) && o.name ? [[String(o.name).slice(0, 500), notionOptionColor(o.color)!]] : [])));
      return { options: [...new Set(opts)], ...(Object.keys(colors).length ? { optionColors: colors } : {}) };
    };
    const approximate = (kind: "formula" | "rollup" | "property", detail: string) => {
      ctx.report.add(kind, detail, key);
      return plan({ type: "text" }, (v) => escapeInline(textOf(v).slice(0, 10000)) || null);
    };
    switch (prop.type) {
      case "title":
        plans.push(plan({ type: "text" }, (v) => plain(v.title).slice(0, 1000)));
        break;
      case "rich_text":
        plans.push(plan({ type: "text" }, (v) => escapeInline(plain(v.rich_text).slice(0, 10000)) || null));
        break;
      case "number":
        plans.push(plan({ type: "number" }, (v) => (typeof v.number === "number" ? v.number : null)));
        break;
      case "select":
      case "status":
        plans.push(plan({ type: "select", ...options(prop[prop.type]?.options) }, (v) => v[prop.type]?.name?.slice(0, 500) || null));
        break;
      case "multi_select":
        plans.push(plan({ type: "multiselect", ...options(prop.multi_select?.options) }, (v) => ((v.multi_select as Json[]) || []).map((o) => String(o.name).slice(0, 500))));
        break;
      case "date":
        plans.push(plan({ type: "date" }, (v) => notionApiDate(v.date?.start)));
        break;
      case "checkbox":
        plans.push(plan({ type: "checkbox" }, (v) => !!v.checkbox));
        break;
      case "url":
        plans.push(plan({ type: "url" }, (v) => (typeof v.url === "string" ? v.url.slice(0, 2000) : null)));
        break;
      case "email":
        plans.push(plan({ type: "email" }, (v) => (typeof v.email === "string" ? v.email.slice(0, 500) : null)));
        break;
      case "phone_number":
        plans.push(plan({ type: "phone" }, (v) => (typeof v.phone_number === "string" ? v.phone_number.slice(0, 100) : null)));
        break;
      case "created_time":
        plans.push(plan({ type: "created_at" }, () => undefined));
        break;
      case "last_edited_time":
        plans.push(plan({ type: "updated_at" }, () => undefined));
        break;
      case "people":
      case "created_by":
      case "last_edited_by":
        // Decided once the records are read: person when all are members.
        plans.push(plan({ type: "person" }, (v) => {
          const people = (prop.type === "people" ? (v.people as Json[]) || [] : [v[prop.type]]).filter(Boolean);
          return people.map((p) => ({ name: p.name, email: p.person?.email }));
        }));
        break;
      case "relation":
        plans.push(plan({ type: "relation", relationPage: pageRef(bareId(prop.relation?.database_id)) }, (v) => ((v.relation as Json[]) || []).map((r) => bareId(r.id)), bareId(prop.relation?.database_id)));
        break;
      case "rollup":
        // Checked once every database is read (rollupPlan).
        plans.push(plan({ type: "rollup" }, (v) => propertyText(v)));
        break;
      case "formula": {
        const formula = notionFormula(String(prop.formula?.expression || ""), names);
        if (formula) plans.push(plan({ type: "formula", formula }, () => undefined));
        else plans.push(approximate("formula", ct(`Formel „${name}“: Werte als Text übernommen`, `Formula “${name}”: values kept as text`)));
        break;
      }
      case "files":
        plans.push(approximate("property", ct(`Dateien-Eigenschaft „${name}“: Dateinamen als Text`, `Files property “${name}”: file names as text`)));
        break;
      case "unique_id":
        plans.push(plan({ type: "text" }, (v) => propertyText(v) || null));
        break;
      default:
        plans.push(approximate("property", ct(`Eigenschaft „${name}“ (${String(prop.type).slice(0, 40)}) als Text`, `Property “${name}” (${String(prop.type).slice(0, 40)}) as text`)));
    }
  }
  // Rollup configuration kept for the check after reading.
  for (const p of plans) {
    const prop = props.find(([, v]) => String(v.id) === p.notionId)?.[1];
    if (p.notionType === "rollup" && prop) p.rollup = prop.rollup;
  }
  return { key, plans, byNotionId: new Map(plans.map((p) => [p.notionId, p])) };
}

const notionApiDate = (value: unknown) => {
  if (typeof value !== "string") return null;
  const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/.exec(value);
  return m ? (m[2] && !/T00:00:00(\.000)?(Z|[+-]00:00)?$/.test(value) ? `${m[1]}T${m[2]}` : m[1]) : null;
};
// Any property value as text (formulas, rollups, files, unique ids).
function propertyText(value: Json | undefined): string {
  if (!value) return "";
  switch (value.type) {
    case "title":
    case "rich_text":
      return plain(value[value.type]);
    case "number":
      return typeof value.number === "number" ? String(value.number) : "";
    case "select":
    case "status":
      return value[value.type]?.name || "";
    case "multi_select":
      return ((value.multi_select as Json[]) || []).map((o) => o.name).join(", ");
    case "date":
      return value.date?.start ? [value.date.start, value.date.end].filter(Boolean).join(" → ") : "";
    case "checkbox":
      return value.checkbox ? "✓" : "";
    case "url":
    case "email":
    case "phone_number":
      return value[value.type] || "";
    case "files":
      return ((value.files as Json[]) || []).map((f) => f.name || f.external?.url || "").filter(Boolean).join(", ");
    case "people":
      return ((value.people as Json[]) || []).map((p) => p.name || p.person?.email || "").filter(Boolean).join(", ");
    case "created_by":
    case "last_edited_by":
      return value[value.type]?.name || "";
    case "created_time":
    case "last_edited_time":
      return value[value.type] || "";
    case "unique_id":
      return value.unique_id?.number != null ? `${value.unique_id.prefix ? `${value.unique_id.prefix}-` : ""}${value.unique_id.number}` : "";
    case "formula": {
      const f = value.formula || {};
      return f.type === "boolean" ? (f.boolean ? "✓" : "") : f.type === "date" ? f.date?.start || "" : f[f.type] != null ? String(f[f.type]) : "";
    }
    case "rollup": {
      const r = value.rollup || {};
      if (r.type === "array") return ((r.array as Json[]) || []).map(propertyText).filter(Boolean).join(", ");
      return r.type === "date" ? r.date?.start || "" : r[r.type] != null ? String(r[r.type]) : "";
    }
    case "relation":
      return ((value.relation as Json[]) || []).map((r) => bareId(r.id)).join(", ");
  }
  return "";
}

export type NotionImportOptions = NotionClientOptions & {
  member?: (person: { name?: string; email?: string }) => string | undefined;
  maxFileBytes?: number;
  tmpDir?: string;
};

// Reads the chosen pages and databases (ids from listNotionRoots) with
// everything below them into an import tree.
export async function parseNotionApi(token: string, chosen: { id: string; kind: "page" | "database" }[], options: NotionImportOptions = {}): Promise<ImportTree> {
  const tmp = options.tmpDir || resolve(process.env.FLOWPLAN_DATA_DIR || "./data", "tmp", "imports", `notion-${randomUUID()}`);
  const ctx: Context = {
    client: notionClient(token, options),
    report: importReport(),
    files: new Map(),
    member: options.member || (() => undefined),
    maxFileBytes: options.maxFileBytes || 100 * 1048576,
    tmp,
    queue: [],
    seen: new Set(),
    titles: new Map(),
    warnings: new Set(),
    limit: maxImportPages(),
    pages: [],
  };
  try {
    for (const item of chosen) enqueue(ctx, bareId(item.id), item.kind, null);
    const databases: (DatabasePlan & { page: ImportPage; raw: Json[] })[] = [];
    let done = 0;
    while (ctx.queue.length) {
      const item = ctx.queue.shift()!;
      done++;
      await jobProgress((0.85 * done) / (done + ctx.queue.length + 1));
      try {
        if (item.kind === "page") await readPage(ctx, item.id, item.parent);
        else {
          const db = await readDatabase(ctx, item.id, item.parent);
          if (db) databases.push(db);
        }
      } catch (error) {
        if (!(error instanceof NotionMissing)) throw error;
        ctx.report.add("other", ct("Eine Seite oder Datenbank ist nicht (mehr) mit der Integration geteilt", "A page or database is not (or no longer) shared with the integration"), item.parent);
      }
    }
    finishDatabases(ctx, databases);
    // Titles of link_to_page targets; links to what the import does not
    // bring keep their Notion address.
    const imported = new Set(ctx.pages.map((p) => p.key));
    const rows = new Set(ctx.pages.flatMap((p) => (p.database?.rows || []).map((r) => r.key!)));
    for (const p of ctx.pages) for (const r of p.database?.rows || []) ctx.titles.set(r.key!, String(r.cells.title || ""));
    for (const p of ctx.pages) ctx.titles.set(p.key, p.title);
    const fix = (html: string) =>
      html
        .replace(/\u0001([0-9a-f]{32})\u0001/g, (_, id: string) => esc(ctx.titles.get(id) || ct("Seite in Notion", "Page in Notion")))
        .replace(/fp-import:\/\/page\/([0-9a-f]{32})/g, (all, id: string) => (imported.has(id) || rows.has(id) ? all : `https://www.notion.so/${id}`));
    for (const p of ctx.pages) {
      p.html = fix(p.html);
      for (const r of p.database?.rows || []) r.html = fix(r.html);
    }
    return {
      source: "notion",
      title: chosen.length === 1 ? ctx.pages[0]?.title || "Notion" : "Notion",
      pages: ctx.pages,
      files: ctx.files,
      warnings: [...ctx.warnings],
      report: ctx.report,
      close: () => rmSync(tmp, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(tmp, { recursive: true, force: true });
    throw error;
  }
}

async function readPage(ctx: Context, id: string, parent: string | null) {
  const page = await ctx.client.call("GET", `/pages/${id}`);
  if (page.archived || page.in_trash) return;
  const key = bareId(page.id) || id;
  const title = titleOf(page).slice(0, 500) || ct("Ohne Titel", "Untitled");
  const entry: ImportPage = { key, parent, title, html: "", created: page.created_time, updated: page.last_edited_time };
  ctx.pages.push(entry);
  const icon = emojiIcon(page);
  if (icon) entry.icon = icon;
  if (page.cover) {
    const cover = await fileFor(ctx, key, page.cover, ct("Titelbild", "Cover"));
    if (cover && !("external" in cover)) entry.cover = cover.key;
  }
  entry.html = await renderBlocks(ctx, await blockChildren(ctx, id), key, 0, true);
}

async function readDatabase(ctx: Context, id: string, parent: string | null) {
  const database = await ctx.client.call("GET", `/databases/${id}`);
  if (database.archived || database.in_trash) return null;
  const key = bareId(database.id) || id;
  const title = titleOf(database).slice(0, 500) || ctx.titles.get(key) || ct("Ohne Titel", "Untitled");
  const plan = planDatabase(ctx, key, database);
  const page: ImportPage = { key, parent, title, html: "", kind: "database", database: { fields: [], views: [], rows: [] } };
  const icon = emojiIcon(database);
  if (icon) page.icon = icon;
  ctx.pages.push(page);
  const raw: Json[] = [];
  let skipped = 0;
  for await (const row of ctx.client.list("POST", `/databases/${id}/query`, {})) {
    if (raw.length >= MAX_IMPORT_ROWS) {
      skipped++;
      continue;
    }
    if (row.archived || row.in_trash) continue;
    const rowKey = bareId(row.id);
    // Properties with more than 25 relations come in full from their own list.
    for (const [name, value] of Object.entries((row.properties || {}) as Record<string, Json>))
      if (value?.type === "relation" && value.has_more) row.properties[name] = await propertyItems(ctx, row.id, value, String(value.id));
    // The record's text; sub-pages of a record go below the database.
    const html = await renderBlocks(ctx, await blockChildren(ctx, row.id), rowKey, 0, true);
    raw.push({ ...row, __html: html });
    for (const p of ctx.pages) if (p.parent === rowKey) p.parent = key;
    for (const q of ctx.queue) if (q.parent === rowKey) q.parent = key;
  }
  if (skipped) ctx.warnings.add(`Maximal ${MAX_IMPORT_ROWS} Einträge je Tabelle.`);
  return { ...plan, page, raw };
}

// Once every database is read: relations to imported databases, rollups
// whose relation and property came along, people who are members; then
// the records' cells.
function finishDatabases(ctx: Context, databases: (DatabasePlan & { page: ImportPage; raw: Json[] })[]) {
  const byKey = new Map(databases.map((d) => [d.key, d]));
  const rowsOf = new Map(databases.map((d) => [d.key, new Set(d.raw.map((r) => bareId(r.id)))]));
  for (const db of databases) {
    const fields: Field[] = [];
    const convertors: { plan: FieldPlan; to: (value: Json, row: Json) => unknown }[] = [];
    for (const plan of db.plans) {
      const name = plan.field.name;
      const textPlan = (kind: ReportKind, detail: string) => {
        ctx.report.add(kind, detail, db.key);
        fields.push({ ...plan.field, type: "text", relationPage: undefined } as Field);
        convertors.push({ plan, to: (value) => escapeInline(propertyText(value).slice(0, 10000)) || null });
      };
      if (plan.field.type === "relation") {
        const target = plan.relation || "";
        if (!byKey.has(target)) {
          // Its database is not part of the import: the records' ids as Notion links.
          ctx.report.add("relation", ct(`„${name}“ verknüpft eine Datenbank, die nicht importiert wird`, `“${name}” relates to a database that is not imported`), db.key);
          fields.push({ id: plan.field.id, name, type: "text" });
          convertors.push({ plan, to: (value) => ((value.relation as Json[]) || []).map((r) => `https://www.notion.so/${bareId(r.id)}`).join(", ") || null });
          continue;
        }
        fields.push(plan.field);
        convertors.push({
          plan,
          to: (value, row) => {
            const ids = ((value.relation as Json[]) || []).map((r) => bareId(r.id));
            const known = ids.filter((rid) => rowsOf.get(target)!.has(rid));
            if (known.length < ids.length)
              ctx.report.add("relation", ct(`„${name}“: ${ids.length - known.length} verknüpfte Einträge sind nicht Teil des Imports`, `“${name}”: ${ids.length - known.length} related records are not part of the import`), bareId(row.id));
            return known.map((rid) => pageRef(rid));
          },
        });
        continue;
      }
      if (plan.field.type === "rollup") {
        const config = plan.rollup || {};
        const relation = db.plans.find((p) => p.field.type === "relation" && (p.notionId === String(config.relation_property_id) || p.notionName === config.relation_property_name));
        const targetDb = relation?.relation ? byKey.get(relation.relation) : undefined;
        const targetField = targetDb?.plans.find((p) => p.notionId === String(config.rollup_property_id) || p.notionName === config.rollup_property_name);
        const aggregate = ROLLUP_FUNCTIONS[String(config.function)];
        if (relation && targetDb && targetField && aggregate) {
          fields.push({ id: plan.field.id, name, type: "rollup", relationField: relation.field.id, rollupField: targetField.field.id, aggregate });
          convertors.push({ plan, to: () => undefined });
        } else textPlan("rollup", ct(`Rollup „${name}“: Werte als Text übernommen`, `Rollup “${name}”: values kept as text`));
        continue;
      }
      if (plan.field.type === "person") {
        const all = db.raw.flatMap((row) => plan.convert(row.properties?.[plan.notionName] || {}) as { name?: string; email?: string }[]);
        if (all.every((p) => ctx.member(p))) {
          fields.push(plan.field);
          convertors.push({ plan, to: (value) => [...new Set((plan.convert(value) as { name?: string; email?: string }[]).map((p) => ctx.member(p)!))] });
        } else textPlan("property", ct(`Personen in „${name}“ sind keine Mitglieder des Arbeitsbereichs: als Text`, `People in “${name}” are no members of the workspace: as text`));
        continue;
      }
      fields.push(plan.field);
      convertors.push({ plan, to: (value) => plan.convert(value) });
    }
    db.page.database = {
      fields,
      views: [{ id: randomUUID(), name: ct("Tabelle", "Table"), type: "table", filters: [], sorts: [] } as unknown as View],
      rows: db.raw.map((row) => {
        const cells: Record<string, unknown> = {};
        for (const { plan, to } of convertors) {
          const value = row.properties?.[plan.notionName] ?? Object.values((row.properties || {}) as Record<string, Json>).find((v) => String(v?.id) === plan.notionId);
          const cell = to(value || {}, row);
          if (cell !== undefined) cells[plan.field.id] = cell;
        }
        if (typeof cells.title !== "string") cells.title = "";
        return {
          cells,
          html: row.__html || "",
          key: bareId(row.id),
          created: row.created_time,
          updated: row.last_edited_time,
          ...(emojiIcon(row) ? { icon: emojiIcon(row) } : {}),
        };
      }),
    };
  }
}
