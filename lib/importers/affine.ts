// AFFiNE workspaces (#65): the workspace file (.affine, SQLite) or a
// snapshot ZIP, read by lib/importers/affine-read.ts, as an import tree.
//
// - Folders ("Organize") become pages holding their documents; a document
//   in several folders lives in the first and is linked from the others.
//   A workspace file with several top-level items (folders, documents
//   outside folders, collections) arrives below one page named after the
//   workspace; a snapshot, or a single item, goes straight into the target
//   (#77) – an empty page above it would carry nothing.
// - Documents: the notes shown in the document as HTML (headings, lists,
//   to-dos, toggles, quotes, code, callouts, dividers, tables, LaTeX,
//   images, attachments, bookmarks, bold/italic/underline/strike/code,
//   links, text and highlight colours). Links to other documents (inline
//   references, linked-doc and synced-doc cards, AFFiNE app links) point to
//   the imported pages. Tags become the page's tags.
// - Databases (affine:database) become a database page below the document,
//   shown in it as an embedded (linked) database; rows keep their content.
// - The edgeless canvas: when it holds more than the document's note (or
//   the document opens as edgeless), a whiteboard "<Name> – Whiteboard"
//   next to it, linked both ways (link in the document, card on the board).
// - Collections: a page "Sammlung: <Name>" listing its documents as of the
//   import (fixed ones and those the rules match) with the rules as text.
// - Journals: into the matching day of the workspace's journal.
// All text is escaped; links keep http, https and mailto only.
import { randomUUID } from "node:crypto";
import { ct } from "../content-locale";
import { calloutIcon } from "../callout-types";
import { esc, fileRef, mimeOf, pageRef } from "./html";
import { AText, type ABlock, type ADoc, type AFilter, type AWorkspace, type DeltaOp } from "./affine-read";
import { affineBoard, edgelessExtras, noteDisplay } from "./affine-board";
import { warningList, MAX_IMPORT_ROWS, type ImportFile, type ImportPage, type ImportTree } from "./types";
import type { Field, View } from "../types";

const ROOT = "affine:root";
const docKey = (id: string) => `doc:${id}`;
const boardKey = (id: string) => `board:${id}`;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (value: unknown): string | undefined => {
  if (typeof value !== "string" || !DATE.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : undefined;
};
const iso = (ms?: number) => (ms && ms > 0 && ms < 8.64e15 ? new Date(ms).toISOString() : undefined);
// A day picked in AFFiNE is local midnight as a timestamp; the nearest UTC
// day is that day for every time zone between −12 and +12 hours.
const dayOf = (ms: number) => new Date(Math.round(ms + 12 * 3600e3)).toISOString().slice(0, 10);

// Only links a browser opens safely; AFFiNE app links to documents of the
// import become links to their pages.
export function safeHref(url: unknown, docLink?: (docId: string) => string | null): string | null {
  if (typeof url !== "string" || url.length > 4000) return null;
  const trimmed = url.trim();
  const app = /^https?:\/\/[^/]+\/workspace\/[^/?#]+\/([A-Za-z0-9_-]{3,100})(?:[/?#]|$)/i.exec(trimmed);
  if (app && docLink) {
    const page = docLink(app[1]);
    if (page) return page;
  }
  try {
    const parsed = new URL(trimmed);
    return ["http:", "https:", "mailto:"].includes(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

// AFFiNE colour variables of texts ("var(--affine-text-highlight-
// foreground-red)") and highlights ("var(--affine-text-highlight-red)") in
// Flowplan's palettes (lib/text-marks.ts).
const TEXT_COLORS: Record<string, string> = {
  grey: "#8b8a92", gray: "#8b8a92", brown: "#b5703c", orange: "#ec6c0e", yellow: "#d9a400", green: "#2f9e44",
  teal: "#2f9e44", blue: "#1c7ed6", purple: "#8f4ad9", magenta: "#d6336c", pink: "#d6336c", red: "#e03131",
};
const HIGHLIGHTS: Record<string, string> = {
  grey: "#e2e1dd", gray: "#e2e1dd", brown: "#efd9c7", orange: "#ffd8a8", yellow: "#ffec99", green: "#c3eecb",
  teal: "#c3eecb", blue: "#c5e0fa", purple: "#e3d3fa", magenta: "#fcc9dc", pink: "#fcc9dc", red: "#ffcaca",
};
function paletteColor(value: unknown, palette: Record<string, string>) {
  if (typeof value !== "string") return null;
  const v = value.toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  const name = Object.keys(palette).find((key) => new RegExp(`-${key}\\)?$`).test(v));
  return name ? palette[name] : null;
}
const CALLOUT_COLORS: Record<string, string> = { red: "caution", orange: "warning", yellow: "warning", green: "tip", teal: "tip", blue: "note", purple: "important", magenta: "important" };
const dbTitle = () => ct("Datenbank", "Database");

type Ctx = {
  ws: AWorkspace;
  warn: (message: string) => void;
  docLink: (docId: string) => string | null;
  title: (docId: string) => string;
  blob: (key: unknown, name?: string, mime?: string) => string | null;
  // The whiteboard of the document being converted, if it gets one.
  board: string | null;
  database: (block: ABlock) => string;
};

/* ---------- inline text ---------- */

function inline(text: unknown, ctx: Ctx): string {
  if (typeof text === "string") return esc(text).replace(/\n/g, "<br>");
  if (!(text instanceof AText)) return "";
  return text.delta.map((op) => inlineOp(op, ctx)).join("");
}
function inlineOp(op: DeltaOp, ctx: Ctx) {
  if (typeof op.insert !== "string") return "";
  const a = op.attributes || {};
  const reference = a.reference as { pageId?: unknown; title?: unknown } | undefined;
  if (reference && typeof reference.pageId === "string") {
    const shown = typeof reference.title === "string" && reference.title.trim() ? reference.title : ctx.title(reference.pageId);
    const href = ctx.docLink(reference.pageId);
    return href ? `<a href="${esc(href)}">${esc(shown)}</a>` : esc(shown);
  }
  if (typeof a.latex === "string" && a.latex.trim()) return `<span data-math="${esc(a.latex.slice(0, 5000))}"></span>`;
  let html = esc(op.insert).replace(/\n/g, "<br>");
  if (!html) return "";
  if (a.code) html = `<code>${html}</code>`;
  if (a.strike) html = `<s>${html}</s>`;
  if (a.underline) html = `<u>${html}</u>`;
  if (a.italic) html = `<em>${html}</em>`;
  if (a.bold) html = `<strong>${html}</strong>`;
  const color = paletteColor(a.color, TEXT_COLORS);
  if (color) html = `<span style="color: ${color}">${html}</span>`;
  const background = paletteColor(a.background, HIGHLIGHTS);
  if (background) html = `<mark style="background-color: ${background}">${html}</mark>`;
  if (a.link !== undefined) {
    const href = safeHref(a.link, ctx.docLink);
    if (href) html = `<a href="${esc(href)}">${html}</a>`;
  }
  return html;
}
// Plain text of a text with references shown by their target's title.
function plainOf(text: unknown, ctx: Pick<Ctx, "title">): string {
  if (typeof text === "string") return text;
  if (!(text instanceof AText)) return "";
  return text.delta
    .map((op) => {
      const ref = op.attributes?.reference as { pageId?: unknown } | undefined;
      if (ref && typeof ref.pageId === "string") return ctx.title(ref.pageId);
      return typeof op.insert === "string" ? op.insert : "";
    })
    .join("");
}
export function blocksPlain(blocks: ABlock[], ctx: Pick<Ctx, "title">, depth = 0): string {
  if (depth > 40) return "";
  return blocks
    .map((b) => [plainOf(b.props.text, ctx), blocksPlain(b.children, ctx, depth + 1)].filter(Boolean).join("\n"))
    .filter(Boolean)
    .join("\n");
}

/* ---------- blocks ---------- */

function renderBlocks(blocks: ABlock[], ctx: Ctx, depth = 0): string {
  if (depth > 40) return "";
  let html = "";
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.flavour === "affine:list" && block.props.type !== "toggle") {
      const type = block.props.type === "numbered" ? "numbered" : block.props.type === "todo" ? "todo" : "bulleted";
      const items: ABlock[] = [];
      while (i < blocks.length && blocks[i].flavour === "affine:list") {
        const t = blocks[i].props.type === "numbered" ? "numbered" : blocks[i].props.type === "todo" ? "todo" : blocks[i].props.type === "toggle" ? "toggle" : "bulleted";
        if (t !== type) break;
        items.push(blocks[i++]);
      }
      i--;
      const body = items
        .map((item) => {
          const children = renderBlocks(item.children, ctx, depth + 1);
          const text = `<p>${inline(item.props.text, ctx)}</p>`;
          return type === "todo"
            ? `<li data-type="taskItem" data-checked="${item.props.checked === true}">${text}${children}</li>`
            : `<li>${text}${children}</li>`;
        })
        .join("");
      const start = typeof items[0].props.order === "number" && items[0].props.order > 1 ? ` start="${Math.floor(items[0].props.order)}"` : "";
      html += type === "todo" ? `<ul data-type="taskList">${body}</ul>` : type === "numbered" ? `<ol${start}>${body}</ol>` : `<ul>${body}</ul>`;
      continue;
    }
    html += renderBlock(block, ctx, depth);
  }
  return html;
}

function renderBlock(block: ABlock, ctx: Ctx, depth: number): string {
  const p = block.props;
  const children = () => renderBlocks(block.children, ctx, depth + 1);
  switch (block.flavour) {
    case "affine:paragraph": {
      const text = inline(p.text, ctx);
      const type = String(p.type || "text");
      if (/^h[1-6]$/.test(type)) return `<${type}>${text}</${type}>${children()}`;
      if (type === "quote") return `<blockquote><p>${text}</p>${children()}</blockquote>`;
      return `<p>${text}</p>${children()}`;
    }
    case "affine:list": {
      // Toggles (the rest is grouped into lists by renderBlocks).
      const inner = children();
      return `<details><summary>${esc(plainOf(p.text, ctx).slice(0, 500) || "…")}</summary><div>${inner || "<p></p>"}</div></details>`;
    }
    case "affine:code": {
      const language = typeof p.language === "string" && /^[\w+#.-]{1,30}$/.test(p.language) ? ` class="language-${esc(p.language.toLowerCase())}"` : "";
      return `<pre><code${language}>${esc(plainOf(p.text, ctx))}</code></pre>`;
    }
    case "affine:divider":
      return "<hr>";
    case "affine:callout": {
      const icon = p.icon as { type?: unknown; unicode?: unknown } | undefined;
      // An emoji Flowplan takes as a symbol becomes the callout's own one.
      const symbol = calloutIcon(icon?.unicode);
      const emoji = !symbol && icon && typeof icon.unicode === "string" ? `${esc(icon.unicode.slice(0, 16))} ` : "";
      const own = inline(p.text, ctx);
      const color = String(p.backgroundColorName || "");
      const type = CALLOUT_COLORS[color] || "note";
      // The icon stays in front of the callout's own text.
      const body = (own ? `<p>${emoji}${own}</p>` : "") + children();
      return `<aside data-callout="${type}"${symbol ? ` data-callout-icon="${esc(symbol)}"` : ""}>${body || "<p></p>"}</aside>`;
    }
    case "affine:latex": {
      const latex = typeof p.latex === "string" ? p.latex.trim().slice(0, 20000) : "";
      return latex ? `<div data-math="${esc(latex)}"></div>` : "";
    }
    case "affine:table":
      return renderTable(block, ctx);
    case "affine:image": {
      const src = ctx.blob(p.sourceId, undefined, "image");
      const caption = typeof p.caption === "string" ? p.caption.slice(0, 500) : "";
      if (!src) return caption ? `<p>${esc(caption)}</p>` : "";
      return `<img src="${src}" alt="${esc(caption)}">${caption ? `<p><em>${esc(caption)}</em></p>` : ""}`;
    }
    case "affine:attachment": {
      const name = typeof p.name === "string" && p.name.trim() ? p.name.slice(0, 200) : ct("Anhang", "Attachment");
      const href = ctx.blob(p.sourceId, name, typeof p.type === "string" ? p.type : undefined);
      return href ? `<p><a href="${href}">${esc(name)}</a></p>` : `<p>${esc(name)}</p>`;
    }
    case "affine:embed-linked-doc":
    case "affine:embed-synced-doc": {
      if (typeof p.pageId !== "string") return "";
      if (block.flavour === "affine:embed-synced-doc") ctx.warn("Synchronisierte Dokumente werden als Link übernommen.");
      const href = ctx.docLink(p.pageId);
      const shown = typeof p.title === "string" && p.title.trim() ? p.title : ctx.title(p.pageId);
      return href ? `<p><a href="${esc(href)}">${esc(shown)}</a></p>` : `<p>${esc(shown)}</p>`;
    }
    case "affine:surface-ref":
      // A frame or group of the canvas shown in the text: the whiteboard.
      return ctx.board ? `<div data-whiteboard="${esc(ctx.board)}" data-whiteboard-height="360"></div>` : "";
    case "affine:database":
      return ctx.database(block);
    case "affine:note":
    case "affine:transcription":
      return children();
    case "affine:embed-html":
      ctx.warn("HTML-Einbettungen werden nicht übernommen.");
      return "";
    case "affine:data-view":
      ctx.warn("Datenansichten (Data View) werden nicht übernommen.");
      return "";
    default: {
      // Bookmarks and embeds (YouTube, Figma, GitHub, Loom, iframes …) as links.
      const href = safeHref(p.url, ctx.docLink);
      const shown = typeof p.title === "string" && p.title.trim() ? p.title.slice(0, 500) : typeof p.url === "string" ? p.url.slice(0, 500) : "";
      if (href) return `<p><a href="${esc(href)}">${esc(shown)}</a></p>${children()}`;
      // A link with another scheme stays as text.
      if (typeof p.url === "string" && shown) return `<p>${esc(shown)}</p>${children()}`;
      if (block.children.length) return children();
      ctx.warn(`Block „${block.flavour.slice(0, 60)}“ wird nicht übernommen.`);
      return "";
    }
  }
}

function renderTable(block: ABlock, ctx: Ctx) {
  const sortByOrder = (record: unknown, idKey: string) =>
    Object.values((record as Record<string, Record<string, unknown>>) || {})
      .filter((r) => r && typeof r[idKey] === "string")
      .sort((a, b) => (String(a.order) < String(b.order) ? -1 : String(a.order) > String(b.order) ? 1 : 0))
      .map((r) => r[idKey] as string);
  const rows = sortByOrder(block.props.rows, "rowId").slice(0, 500);
  const columns = sortByOrder(block.props.columns, "columnId").slice(0, 50);
  if (!rows.length || !columns.length) return "";
  const cells = (block.props.cells as Record<string, { text?: unknown }>) || {};
  return `<table><tbody>${rows
    .map((r) => `<tr>${columns.map((c) => `<td><p>${inline(cells[`${r}:${c}`]?.text, ctx)}</p></td>`).join("")}</tr>`)
    .join("")}</tbody></table>`;
}

/* ---------- databases ---------- */

type Column = { id: string; type: string; name: string; data: Record<string, unknown> };
function convertDatabase(block: ABlock, ctx: Ctx) {
  const columns: Column[] = (Array.isArray(block.props.columns) ? block.props.columns : [])
    .filter((c): c is Column => !!c && typeof c === "object" && typeof c.id === "string" && typeof c.type === "string")
    .slice(0, 80);
  const cells = (block.props.cells as Record<string, Record<string, { value?: unknown }>>) || {};
  const options = (column: Column) =>
    new Map(
      (Array.isArray(column.data?.options) ? column.data.options : [])
        .filter((o): o is { id: string; value: string } => !!o && typeof o.id === "string" && typeof o.value === "string")
        .map((o) => [o.id, o.value.slice(0, 200)]),
    );
  const fields: Field[] = [];
  const convert = new Map<string, (value: unknown) => unknown>();
  const fieldOf = new Map<string, string>();
  const titleColumn = columns.find((c) => c.type === "title");
  fields.push({ id: "title", name: (titleColumn?.name || ct("Titel", "Title")).slice(0, 200), type: "text" });
  let n = 0;
  for (const column of columns) {
    if (column.type === "title") continue;
    const fid = `f${++n}`;
    const name = (typeof column.name === "string" && column.name.trim() ? column.name : column.type).slice(0, 200);
    switch (column.type) {
      case "number":
        fields.push({ id: fid, name, type: "number" });
        convert.set(column.id, (v) => (typeof v === "number" && Number.isFinite(v) ? v : null));
        break;
      case "progress":
        fields.push({ id: fid, name, type: "number", format: "percent" });
        convert.set(column.id, (v) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(100, v)) / 100 : null));
        break;
      case "checkbox":
        fields.push({ id: fid, name, type: "checkbox" });
        convert.set(column.id, (v) => v === true);
        break;
      case "date":
        fields.push({ id: fid, name, type: "date" });
        convert.set(column.id, (v) => (typeof v === "number" && Number.isFinite(v) ? dayOf(v) : null));
        break;
      case "select":
      case "multi-select": {
        const names = options(column);
        const multi = column.type === "multi-select";
        fields.push({ id: fid, name, type: multi ? "multiselect" : "select", options: [...new Set(names.values())].slice(0, 300) });
        convert.set(column.id, (v) =>
          multi
            ? (Array.isArray(v) ? v : []).map((id) => names.get(id)).filter(Boolean)
            : typeof v === "string" ? names.get(v) ?? null : null,
        );
        break;
      }
      case "link":
        fields.push({ id: fid, name, type: "url" });
        convert.set(column.id, (v) => safeHref(v) ?? null);
        break;
      case "created-time":
        fields.push({ id: fid, name, type: "created_at" });
        break;
      case "image":
        ctx.warn("Bild-Spalten von Datenbanken werden nicht übernommen.");
        break;
      default:
        if (column.type !== "rich-text") ctx.warn(`Datenbank-Spalte vom Typ „${column.type.slice(0, 40)}“ als Text übernommen.`);
        fields.push({ id: fid, name, type: "text" });
        convert.set(column.id, (v) => {
          const text = v instanceof AText || typeof v === "string" ? plainOf(v, ctx) : typeof v === "number" || typeof v === "boolean" ? String(v) : "";
          return text ? text.slice(0, 10000) : null;
        });
    }
    if (convert.has(column.id)) fieldOf.set(column.id, fid);
  }
  const rowBlocks = block.children.slice(0, MAX_IMPORT_ROWS);
  if (block.children.length > MAX_IMPORT_ROWS) ctx.warn(`Maximal ${MAX_IMPORT_ROWS} Einträge je Tabelle.`);
  const rows = rowBlocks.map((row) => {
    const out: Record<string, unknown> = { title: plainOf(row.props.text, ctx).slice(0, 1000) };
    const own = cells[row.id] || {};
    for (const column of columns) {
      const fn = convert.get(column.id);
      if (!fn) continue;
      const value = fn(own[column.id]?.value);
      if (value !== null && value !== undefined && !(Array.isArray(value) && !value.length)) out[fieldOf.get(column.id)!] = value;
    }
    const created = typeof row.props["meta:createdAt"] === "number" ? iso(row.props["meta:createdAt"] as number) : undefined;
    return { cells: out, html: renderBlocks(row.children, ctx), ...(created ? { created } : {}) };
  });
  // Table views stay tables; kanban views become boards by their column.
  const views: View[] = [];
  for (const raw of (Array.isArray(block.props.views) ? block.props.views : []).slice(0, 10)) {
    const view = raw as { name?: unknown; mode?: unknown; groupBy?: { columnId?: unknown } };
    const name = (typeof view?.name === "string" && view.name.trim() ? view.name : ct("Tabelle", "Table")).slice(0, 100);
    const group = typeof view?.groupBy?.columnId === "string" ? fieldOf.get(view.groupBy.columnId) : undefined;
    const groupField = fields.find((f) => f.id === group && (f.type === "select" || f.type === "checkbox"));
    if (view?.mode === "kanban" && groupField) views.push({ id: randomUUID(), name, type: "board", groupBy: groupField.id, filters: [], sorts: [] });
    else views.push({ id: randomUUID(), name, type: "table", filters: [], sorts: [] });
  }
  if (!views.length) views.push({ id: randomUUID(), name: ct("Tabelle", "Table"), type: "table", filters: [], sorts: [] });
  return { fields, views, rows, title: plainOf(block.props.title, ctx).trim().slice(0, 200) || dbTitle() };
}

/* ---------- collections ---------- */

const METHODS: Record<string, () => string> = {
  "include-any-of": () => ct("enthält eines von", "contains any of"),
  "include-all": () => ct("enthält alle", "contains all of"),
  "not-include-any-of": () => ct("enthält keines von", "contains none of"),
  "not-include-all": () => ct("enthält nicht alle", "does not contain all of"),
  "is-empty": () => ct("ist leer", "is empty"),
  "is-not-empty": () => ct("ist nicht leer", "is not empty"),
  after: () => ct("nach", "after"),
  before: () => ct("vor", "before"),
  last: () => ct("in den letzten", "in the last"),
  is: () => ct("ist", "is"),
  "is-not": () => ct("ist nicht", "is not"),
  contains: () => ct("enthält", "contains"),
  "not-contains": () => ct("enthält nicht", "does not contain"),
  "starts-with": () => ct("beginnt mit", "starts with"),
  "ends-with": () => ct("endet mit", "ends with"),
};
const KEYS: Record<string, () => string> = {
  tags: () => ct("Tags", "Tags"),
  createdAt: () => ct("Erstellt", "Created"),
  updatedAt: () => ct("Geändert", "Updated"),
  title: () => ct("Titel", "Title"),
  favorite: () => ct("Favorit", "Favourite"),
  shared: () => ct("Öffentlich geteilt", "Shared publicly"),
  journal: () => ct("Journal", "Journal"),
  docPrimaryMode: () => ct("Modus", "Mode"),
  createdBy: () => ct("Erstellt von", "Created by"),
  updatedBy: () => ct("Geändert von", "Updated by"),
};
function describeFilter(filter: AFilter, ws: AWorkspace) {
  const key = KEYS[filter.key]?.() ?? filter.key;
  const method = METHODS[filter.method]?.() ?? filter.method;
  let value = filter.value ?? "";
  if (filter.key === "tags" && value)
    value = value
      .split(",")
      .map((id) => ws.tags.get(id.trim())?.name ?? id.trim())
      .join(", ");
  return [key, method, value].filter(Boolean).join(" ");
}
// Whether a document matches a rule, or undefined when that cannot be told
// at import time (rules on properties, people, sharing …).
function matches(doc: ADoc, filter: AFilter, ws: AWorkspace, now: number): boolean | undefined {
  if (filter.type !== "system") return undefined;
  const list = (filter.value || "").split(",").map((v) => v.trim()).filter(Boolean);
  switch (filter.key) {
    case "tags": {
      const has = (id: string) => doc.tags.includes(id);
      if (filter.method === "include-any-of") return list.some(has);
      if (filter.method === "include-all") return list.every(has);
      if (filter.method === "not-include-any-of") return !list.some(has);
      if (filter.method === "not-include-all") return !list.every(has);
      if (filter.method === "is-empty") return !doc.tags.some((t) => ws.tags.has(t));
      if (filter.method === "is-not-empty") return doc.tags.some((t) => ws.tags.has(t));
      return undefined;
    }
    case "createdAt":
    case "updatedAt": {
      const at = filter.key === "createdAt" ? doc.created : doc.updated ?? doc.created;
      if (!at) return false;
      const day = new Date(at).toISOString().slice(0, 10);
      const value = filter.value || "";
      const since = /^\d+$/.test(value) ? new Date(now - Number(value) * 86400e3).toISOString().slice(0, 10) : validDate(value);
      if (!since) return undefined;
      if (filter.method === "after" || filter.method === "last") return day >= since;
      if (filter.method === "before") return day < since;
      return undefined;
    }
    case "title": {
      const title = doc.title.toLowerCase(),
        value = (filter.value || "").toLowerCase();
      if (filter.method === "contains") return title.includes(value);
      if (filter.method === "not-contains") return !title.includes(value);
      if (filter.method === "is") return title === value;
      if (filter.method === "is-not") return title !== value;
      return undefined;
    }
    case "favorite":
      if (filter.method === "is") return ws.favorites.has(doc.id) === (filter.value === "true");
      return undefined;
    case "journal":
      if (filter.method === "is") return !!validDate(ws.docProps.get(doc.id)?.journal) === (filter.value === "true");
      return undefined;
    default:
      return undefined;
  }
}

/* ---------- the tree ---------- */

const sniff = (data: Buffer): string | null => {
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return "image/png";
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (data.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  return null;
};
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "application/pdf": "pdf" };

export function parseAffine(ws: AWorkspace, fallbackTitle: string): ImportTree {
  const warnings = warningList();
  for (const w of ws.warnings) warnings.add(w);
  const live = ws.docs.filter((d) => !d.trash);
  const trashed = ws.docs.length - live.length;
  if (trashed) warnings.add(`${trashed} Dokumente im Papierkorb werden nicht übernommen.`);
  if (ws.format === "snapshot") warnings.add("Ordner, Sammlungen und Journale enthält nur die Arbeitsbereichsdatei (.affine).");
  const byId = new Map(live.map((d) => [d.id, d]));
  const untitled = ct("Ohne Titel", "Untitled");
  const titleOf = (id: string) => {
    const doc = byId.get(id) ?? ws.docs.find((d) => d.id === id);
    if (!doc) return untitled;
    const own = doc.title.trim() || (doc.root ? plainOf(doc.root.props.title, { title: () => "" }).trim() : "");
    return own.slice(0, 200) || untitled;
  };
  const journalOf = (id: string) => validDate(ws.docProps.get(id)?.journal);
  const docLink = (id: string) => (byId.has(id) ? pageRef(docKey(id)) : null);
  const files = new Map<string, ImportFile>();
  let missingFiles = 0;
  const blob = (key: unknown, name?: string, mime?: string) => {
    if (typeof key !== "string" || !key) return null;
    const found = ws.blobs.get(key) ?? ws.blobs.get(key.replace(/^\//, ""));
    if (!found) {
      missingFiles++;
      return null;
    }
    if (!files.has(key)) {
      const type = sniff(found.head) || (mime && mime !== "image" ? mime : "") || found.mime || (name ? mimeOf(name) : "application/octet-stream");
      const fileName = name || `${ct("Bild", "Image")}-${files.size + 1}.${EXT[type] || mimeOf("x").split("/")[1] || "bin"}`;
      // Read when written: large workspaces never hold all files at once.
      files.set(key, { key, name: fileName, mime: type, size: found.size, read: found.read });
    }
    return fileRef(key);
  };

  // Folders: the first folder of a document is its place.
  const pages: ImportPage[] = [];
  const root: ImportPage = { key: ROOT, parent: null, title: (ws.name || fallbackTitle).slice(0, 200) || "AFFiNE", html: "", folder: true };
  pages.push(root);
  const placeOf = new Map<string, string>(); // doc or collection key → parent key
  const extraLinks = new Map<string, string[]>(); // folder key → html list items
  const byParent = new Map<string | null, typeof ws.folders>();
  for (const node of ws.folders) byParent.set(node.parentId, [...(byParent.get(node.parentId) || []), node]);
  for (const list of byParent.values()) list.sort((a, b) => (a.index < b.index ? -1 : a.index > b.index ? 1 : 0));
  const seenFolders = new Set<string>();
  const walk = (parentId: string | null, parentKey: string, depth: number) => {
    for (const node of byParent.get(parentId) || []) {
      if (node.type === "folder") {
        if (seenFolders.has(node.id) || depth > 20 || seenFolders.size > 2000) continue;
        seenFolders.add(node.id);
        const key = `folder:${node.id}`;
        pages.push({ key, parent: parentKey, title: node.data.trim().slice(0, 200) || untitled, html: "", folder: true });
        walk(node.id, key, depth + 1);
        continue;
      }
      if (parentId === null) continue;
      const add = (target: string, href: string | null, shown: string) => {
        if (!placeOf.has(target) && href) placeOf.set(target, parentKey);
        else extraLinks.set(parentKey, [...(extraLinks.get(parentKey) || []), `<li>${href ? `<a href="${esc(href)}">${esc(shown)}</a>` : esc(shown)}</li>`]);
      };
      if (node.type === "doc" && byId.has(node.data)) add(docKey(node.data), docLink(node.data), titleOf(node.data));
      else if (node.type === "collection") {
        const collection = ws.collections.find((c) => c.id === node.data);
        if (collection) add(`collection:${collection.id}`, pageRef(`collection:${collection.id}`), ct(`Sammlung: ${collection.name}`, `Collection: ${collection.name}`));
      } else if (node.type === "tag" && ws.tags.has(node.data))
        extraLinks.set(parentKey, [...(extraLinks.get(parentKey) || []), `<li>#${esc(ws.tags.get(node.data)!.name)}</li>`]);
    }
  };
  walk(null, ROOT, 0);

  // Documents, with their databases and whiteboards.
  let dropped = 0;
  const boardFor = new Set<string>();
  for (const doc of live) {
    if (doc.root && (edgelessExtras(doc.root) > 0 || ws.docProps.get(doc.id)?.primaryMode === "edgeless")) boardFor.add(doc.id);
  }
  for (const doc of live) {
    const key = docKey(doc.id);
    const title = titleOf(doc.id);
    const journalDate = journalOf(doc.id);
    const parent = journalDate ? null : placeOf.get(key) || ROOT;
    const subpages: ImportPage[] = [];
    const ctx: Ctx = {
      ws,
      warn: (m) => warnings.add(m),
      docLink,
      title: titleOf,
      blob,
      board: boardFor.has(doc.id) ? pageRef(boardKey(doc.id)) : null,
      database: (block) => {
        const db = convertDatabase(block, ctx);
        const dbKey = `db:${doc.id}:${block.id}`;
        // Below its document; for a journal day (which may live in another
        // space) below the workspace page.
        subpages.push({ key: dbKey, parent: journalDate ? ROOT : key, title: db.title, html: "", kind: "database", database: { fields: db.fields, views: db.views, rows: db.rows } });
        // Shown where it was, as an embedded view of the new database.
        const views = JSON.stringify(db.views.slice(0, 1).map((v) => ({ ...v, id: randomUUID() })));
        return `<div data-linked-database="${randomUUID()}" data-linked-source="${esc(pageRef(dbKey))}" data-linked-views="${esc(views)}" data-linked-version="1"></div>`;
      },
    };
    let html = "";
    if (doc.root) {
      const notes = doc.root.children.filter((b) => b.flavour === "affine:note" && noteDisplay(b) !== "edgeless");
      html = notes.map((note) => renderBlocks(note.children, ctx)).join("");
    } else warnings.add("Ein Dokument ohne Inhalt wurde nur mit seinem Titel übernommen.");
    if (boardFor.has(doc.id) && doc.root) {
      const board = affineBoard(doc.id, doc.root, {
        blobs: ws.blobs,
        pageRef: docLink,
        docTitle: titleOf,
        plainText: (blocks) => blocksPlain(blocks, { title: titleOf }),
      });
      dropped += board.replaced;
      const name = `${title} – Whiteboard`.slice(0, 200);
      html = `<p>${esc(ct("Whiteboard", "Whiteboard"))}: <a href="${esc(pageRef(boardKey(doc.id)))}">${esc(name)}</a></p>${html}`;
      subpages.unshift({ key: boardKey(doc.id), parent: parent ?? ROOT, title: name, html: "", kind: "whiteboard", board });
    }
    pages.push({
      key,
      parent,
      title,
      html,
      ...(iso(doc.created) ? { created: iso(doc.created) } : {}),
      ...(iso(doc.updated) ? { updated: iso(doc.updated) } : {}),
      tags: [...new Set(doc.tags.map((t) => ws.tags.get(t)?.name).filter((t): t is string => !!t))],
      ...(journalDate ? { journalDate } : {}),
    });
    pages.push(...subpages);
  }
  if (dropped) warnings.add(`${dropped} Elemente auf Whiteboards konnten nicht übernommen werden.`);
  if (missingFiles) warnings.add(`${missingFiles} Bilder oder Anhänge fehlen in der Datei.`);

  // Collections: their documents as of the import, and the rules as text.
  const now = Date.now();
  for (const collection of ws.collections) {
    const key = `collection:${collection.id}`;
    const ids = new Set(collection.allowList.filter((id) => byId.has(id)));
    let resolved = true;
    if (collection.filters.length) {
      const results = live.map((doc) => ({ doc, hits: collection.filters.map((f) => matches(doc, f, ws, now)) }));
      resolved = results.every((r) => r.hits.every((h) => h !== undefined));
      if (resolved) {
        for (const r of results) if (r.hits.every(Boolean)) ids.add(r.doc.id);
      } else
        warnings.add("Regeln einer Sammlung konnten nicht vollständig ausgewertet werden; übernommen sind die fest hinzugefügten Dokumente.");
    }
    const list = live.filter((d) => ids.has(d.id)).map((d) => `<li><a href="${esc(docLink(d.id)!)}">${esc(titleOf(d.id))}</a></li>`);
    let html = `<p>${esc(ct("Sammlung aus AFFiNE, Stand des Imports.", "Collection from AFFiNE, as of the import."))}</p>`;
    if (collection.filters.length) {
      html += `<h2>${esc(ct("Regeln", "Rules"))}</h2><ul>${collection.filters.map((f) => `<li>${esc(describeFilter(f, ws))}</li>`).join("")}</ul>`;
      if (!resolved) html += `<p><em>${esc(ct("Nicht alle Regeln konnten beim Import ausgewertet werden; aufgeführt sind die fest hinzugefügten Dokumente.", "Not every rule could be evaluated during the import; listed are the documents added by hand."))}</em></p>`;
    }
    html += `<h2>${esc(ct("Dokumente", "Documents"))}</h2>${list.length ? `<ul>${list.join("")}</ul>` : `<p>${esc(ct("Keine Dokumente.", "No documents."))}</p>`}`;
    pages.push({ key, parent: placeOf.get(key) || ROOT, title: ct(`Sammlung: ${collection.name}`, `Collection: ${collection.name}`).slice(0, 200), html });
  }
  // Folders that list more than the documents they hold.
  for (const page of pages) if (extraLinks.has(page.key)) page.html = `<ul>${extraLinks.get(page.key)!.join("")}</ul>`;
  if (!live.length) warnings.add("Keine Dokumente gefunden.");
  // The workspace page only when it carries structure (#77); otherwise its
  // children go straight into the target.
  const wrap = keepWorkspacePage(ws.format, pages);
  if (!wrap) {
    pages.splice(pages.indexOf(root), 1);
    for (const page of pages) if (page.parent === ROOT) page.parent = null;
  }
  return {
    source: "affine",
    title: root.title,
    pages,
    files,
    warnings: warnings.list(),
    collections: ws.collections.length,
    ...(wrap ? { wrapper: ROOT } : {}),
    ...(ws.close ? { close: ws.close } : {}),
    tagColors: Object.fromEntries([...ws.tags.values()].flatMap((t) => (t.color ? [[t.name, t.color]] : []))),
  };
}

// Whether the import keeps the page named after the workspace: only for the
// workspace file (.affine), and only when more than one item would sit at
// the top – folders, documents outside folders, collections, databases of
// journal days. A whiteboard belongs to its document and does not count;
// journal days go into the journal.
export function keepWorkspacePage(format: AWorkspace["format"], pages: Pick<ImportPage, "parent" | "kind">[]) {
  if (format === "snapshot") return false;
  return pages.filter((p) => p.parent === ROOT && p.kind !== "whiteboard").length > 1;
}
