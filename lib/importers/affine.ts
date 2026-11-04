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
//   the imported pages. Tags become the page's tags, the document's
//   properties its page properties (#70), an emoji as icon of a document,
//   folder or collection the page's icon. Attachments become the block an
//   upload in the editor creates: PDFs with preview, audio and video with a
//   player (#82).
// - Databases (affine:database) become a database page below the document,
//   shown in it as an embedded (linked) database; rows keep their content,
//   columns the order, width and visibility of AFFiNE's views (#82). A row
//   turned into a document of its own brings that document as the record's
//   content, with its icon, tags and properties; the document gets no page
//   of its own and links to it lead to the record (attachRowDocs, #82). Its
//   own databases (a document that is only a database) go below the
//   record's database page, embedded in the record; documents linked only
//   from such documents below that database too (placeLinkedDocs, #117).
// - Templates (isTemplate in the document's properties): saved templates of
//   the workspace (lib/importers/write.ts), not pages; links to them are
//   text (#116).
// - The edgeless canvas: when it holds more than the document's note (or
//   the document opens as edgeless), a whiteboard "<Name> – Whiteboard"
//   next to it, linked both ways (link in the document, card on the board).
// - Collections: a page "Sammlung: <Name>" listing its documents as of the
//   import (fixed ones and those the rules match) with the rules as text.
// - Journals: into the matching day of the workspace's journal.
// All text is escaped; links keep http, https and mailto only. Documents
// are read one at a time (ADoc.load); a workspace with more pages than one
// import may bring is only counted (#82).
import { randomUUID } from "node:crypto";
import { ct } from "../content-locale";
import { calloutIcon } from "../callout-types";
import { codeBlockHtml, esc, fileRef, mimeOf, pageRef, withBlockId } from "./html";
import { AText, propertyValue, type ABlock, type ADoc, type AFilter, type AWorkspace, type DeltaOp } from "./affine-read";
import { affineBoard, edgelessExtras, noteDisplay } from "./affine-board";
import { warningList, MAX_IMPORT_DEPTH, MAX_IMPORT_ROWS, maxImportPages, type ImportDatabase, type ImportFile, type ImportPage, type ImportTemplate, type ImportTree } from "./types";
import type { FrontmatterValue } from "../frontmatter";
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

// The document an AFFiNE app link ("https://…/workspace/<ws>/<doc>") names.
const APP_LINK = /^https?:\/\/[^/]+\/workspace\/[^/?#]+\/([A-Za-z0-9_-]{3,100})(?:[/?#]|$)/i;
export const affineAppDocId = (url: unknown) => (typeof url === "string" && url.length <= 4000 ? (APP_LINK.exec(url.trim())?.[1] ?? null) : null);

// Only links a browser opens safely; AFFiNE app links to documents of the
// import become links to their pages.
export function safeHref(url: unknown, docLink?: (docId: string) => string | null): string | null {
  if (typeof url !== "string" || url.length > 4000) return null;
  const trimmed = url.trim();
  const app = affineAppDocId(trimmed);
  if (app && docLink) {
    const page = docLink(app);
    if (page) return withAffineAnchor(page, affineUrlAnchor(trimmed));
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

/* ---------- block links (#88) ---------- */
// AFFiNE names a block of a document by its id: references and linked-doc
// cards carry params {mode, blockIds, elementIds}, app links
// "?blockIds=…". The blocks keep their AFFiNE id as data-block-id; the
// writer (lib/importers/write.ts, lib/import-anchors.ts) gives them
// Flowplan ids and turns such links into block links. Element ids name
// shapes of the canvas: those lead to the document.
const AFFINE_ID = /^[A-Za-z0-9_-]{1,64}$/;
export function affineParamsAnchor(params: unknown): string | null {
  const ids = (params as { blockIds?: unknown } | null | undefined)?.blockIds;
  const first = Array.isArray(ids) ? ids.find((id) => typeof id === "string" && AFFINE_ID.test(id)) : null;
  return typeof first === "string" ? first : null;
}
export function affineUrlAnchor(url: string): string | null {
  try {
    const ids = new URL(url).searchParams.get("blockIds")?.split(",") || [];
    return ids.find((id) => AFFINE_ID.test(id)) || null;
  } catch {
    return null;
  }
}
const withAffineAnchor = (href: string | null, anchor: string | null) => (href && anchor ? `${href}#${encodeURIComponent(anchor)}` : href);

type Ctx = {
  ws: AWorkspace;
  warn: (message: string) => void;
  docLink: (docId: string) => string | null;
  // A document of the import that is a page (not a template, #116), and
  // one that is a template (links to it stay text).
  isDoc: (docId: string) => boolean;
  isTemplate: (docId: string) => boolean;
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
  const reference = a.reference as { pageId?: unknown; title?: unknown; params?: unknown } | undefined;
  if (reference && typeof reference.pageId === "string") {
    const shown = typeof reference.title === "string" && reference.title.trim() ? reference.title : ctx.title(reference.pageId);
    const href = withAffineAnchor(ctx.docLink(reference.pageId), affineParamsAnchor(reference.params));
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
    // An app link to a template (#116) stays text, as references to it.
    const target = affineAppDocId(a.link);
    if (target && ctx.isTemplate(target)) ctx.docLink(target);
    else {
      const href = safeHref(a.link, ctx.docLink);
      if (href) html = `<a href="${esc(href)}">${html}</a>`;
    }
  }
  return html;
}
// Plain text of a text with references shown by their own title (an alias
// set in AFFiNE) or their target's.
function plainOf(text: unknown, ctx: Pick<Ctx, "title">): string {
  if (typeof text === "string") return text;
  if (!(text instanceof AText)) return "";
  return text.delta
    .map((op) => {
      const ref = op.attributes?.reference as { pageId?: unknown; title?: unknown } | undefined;
      if (ref && typeof ref.pageId === "string") return typeof ref.title === "string" && ref.title.trim() ? ref.title : ctx.title(ref.pageId);
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
          return withBlockId(
            type === "todo"
              ? `<li data-type="taskItem" data-checked="${item.props.checked === true}">${text}${children}</li>`
              : `<li>${text}${children}</li>`,
            item.id,
          );
        })
        .join("");
      const start = typeof items[0].props.order === "number" && items[0].props.order > 1 ? ` start="${Math.floor(items[0].props.order)}"` : "";
      html += type === "todo" ? `<ul data-type="taskList">${body}</ul>` : type === "numbered" ? `<ol${start}>${body}</ol>` : `<ul>${body}</ul>`;
      continue;
    }
    // The block keeps its AFFiNE id (#88).
    html += withBlockId(renderBlock(block, ctx, depth), block.id);
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
      // Mermaid shows its diagram, the code one click away (#95).
      const language = typeof p.language === "string" && /^[\w+#.-]{1,30}$/.test(p.language) ? p.language : null;
      const code = codeBlockHtml(plainOf(p.text, ctx), language);
      const caption = typeof p.caption === "string" ? p.caption.trim().slice(0, 500) : "";
      return caption ? `<figure class="block-figure">${code}<figcaption>${esc(caption)}</figcaption></figure>` : code;
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
      // The caption becomes the image's caption (lib/block-captions.ts).
      return caption ? `<figure class="block-figure"><img src="${src}"><figcaption>${esc(caption)}</figcaption></figure>` : `<img src="${src}">`;
    }
    case "affine:attachment": {
      // Written as the block an upload creates (lib/importers/write.ts
      // attachmentHtml): PDF preview, audio and video player, else a link.
      const name = typeof p.name === "string" && p.name.trim() ? p.name.slice(0, 200) : ct("Anhang", "Attachment");
      const href = ctx.blob(p.sourceId, name, typeof p.type === "string" ? p.type : undefined);
      return href ? `<div data-import-file="${href}" data-title="${esc(name)}"></div>` : `<p>${esc(name)}</p>`;
    }
    case "affine:embed-linked-doc":
    case "affine:embed-synced-doc": {
      if (typeof p.pageId !== "string") return "";
      if (block.flavour === "affine:embed-synced-doc") ctx.warn("Synchronisierte Dokumente werden als Link übernommen.");
      const href = withAffineAnchor(ctx.docLink(p.pageId), affineParamsAnchor(p.params));
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

// The document a database row was turned into (#82). AFFiNE's "convert to
// linked doc" of a row (blocksuite affine/blocks/database, title cell)
// moves the row's content into a new document and leaves a reference to it
// as the row's title: one delta op " " with attributes.reference {type:
// "LinkedPage", pageId}. Also taken: a title with exactly one reference
// beside other text, a row block that is itself a linked or synced doc
// card, and a row whose only content is such a card ("card": that block,
// not rendered again). Since #117 also: an AFFiNE app link to the document
// as the title's one reference (a pasted link), the same in the title
// column's own cell (titleCell, older databases kept the title there), and
// (convertDatabase) a row whose id is that of a document.
export type RowDocRef = { pageId: string; card?: ABlock };
const isDocCard = (b: ABlock) => (b.flavour === "affine:embed-linked-doc" || b.flavour === "affine:embed-synced-doc") && typeof b.props.pageId === "string";
const isEmpty = (b: ABlock) => b.flavour === "affine:paragraph" && !b.children.length && !(b.props.text instanceof AText ? b.props.text.plain.trim() : String(b.props.text ?? "").trim());
const opDoc = (op: DeltaOp) => {
  const pageId = (op.attributes?.reference as { pageId?: unknown } | undefined)?.pageId;
  return typeof pageId === "string" ? pageId : affineAppDocId(op.attributes?.link);
};
export function rowDocRef(row: ABlock, titleCell?: unknown): RowDocRef | null {
  if (isDocCard(row)) return { pageId: row.props.pageId as string };
  for (const text of [row.props.text, titleCell]) {
    const refs = (text instanceof AText ? text.delta : []).map(opDoc).filter((id): id is string => !!id);
    if (refs.length === 1) return { pageId: refs[0] };
    if (refs.length > 1) return null;
  }
  const content = row.children.filter((b) => !isEmpty(b));
  return content.length === 1 && isDocCard(content[0]) ? { pageId: content[0].props.pageId as string, card: content[0] } : null;
}

type Column = { id: string; type: string; name: string; data: Record<string, unknown> };
type ViewColumn = { id: string; width?: number; hide?: boolean };
type RawView = { name?: unknown; mode?: unknown; groupBy?: { columnId?: unknown }; columns?: unknown };
const viewColumns = (view: RawView | undefined): ViewColumn[] =>
  (Array.isArray(view?.columns) ? view.columns : [])
    .filter((c): c is ViewColumn => !!c && typeof c === "object" && typeof (c as { id?: unknown }).id === "string")
    .slice(0, 200);
// The columns as a view of AFFiNE shows them: those the view lists in its
// order, then the others in the order of the database
// (data-view/src/view-presets/table/table-view-manager.ts propertiesRaw$).
export function columnOrder(ids: string[], view: RawView | undefined) {
  const known = new Set(ids);
  const ordered = viewColumns(view)
    .map((c) => c.id)
    .filter((id) => known.delete(id));
  return [...ordered, ...ids.filter((id) => known.has(id))];
}
function convertDatabase(block: ABlock, ctx: Ctx) {
  const rawViews = (Array.isArray(block.props.views) ? block.props.views : []).slice(0, 10) as RawView[];
  const declared: Column[] = (Array.isArray(block.props.columns) ? block.props.columns : [])
    .filter((c): c is Column => !!c && typeof c === "object" && typeof c.id === "string" && typeof c.type === "string")
    .slice(0, 80);
  // Fields in the order of the first view (#82), not of creation.
  const byColumn = new Map(declared.map((c) => [c.id, c]));
  const columns = columnOrder(declared.map((c) => c.id), rawViews[0]).map((id) => byColumn.get(id)!);
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
  // Every column that became a field (also the title and computed ones).
  const fieldIdOf = new Map<string, string>();
  const titleColumn = columns.find((c) => c.type === "title");
  fields.push({ id: "title", name: (titleColumn?.name || ct("Titel", "Title")).slice(0, 200), type: "text" });
  if (titleColumn) fieldIdOf.set(titleColumn.id, "title");
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
    if (fields.some((f) => f.id === fid)) fieldIdOf.set(column.id, fid);
  }
  const rowBlocks = block.children.slice(0, MAX_IMPORT_ROWS);
  if (block.children.length > MAX_IMPORT_ROWS) ctx.warn(`Maximal ${MAX_IMPORT_ROWS} Einträge je Tabelle.`);
  const refs = rowBlocks.map(
    (row): RowDocRef | null =>
      rowDocRef(row, titleColumn ? cells[row.id]?.[titleColumn.id]?.value : undefined) ?? (ctx.isDoc(row.id) ? { pageId: row.id } : null),
  );
  const rows: ImportDatabase["rows"] = rowBlocks.map((row, i) => {
    const ref = refs[i];
    // A reference in the title reads as its document's title; a row whose
    // card names its document and that has no title of its own takes it.
    const shown = plainOf(row.props.text, ctx).trim();
    const title = shown || (ref ? ctx.title(ref.pageId) : "");
    const out: Record<string, unknown> = { title: title.slice(0, 1000) };
    const own = cells[row.id] || {};
    for (const column of columns) {
      const fn = convert.get(column.id);
      if (!fn) continue;
      const value = fn(own[column.id]?.value);
      if (value !== null && value !== undefined && !(Array.isArray(value) && !value.length)) out[fieldOf.get(column.id)!] = value;
    }
    const created = typeof row.props["meta:createdAt"] === "number" ? iso(row.props["meta:createdAt"] as number) : undefined;
    // The card that names the row's document is not shown again.
    const content = ref?.card ? row.children.filter((b) => b !== ref.card) : row.children;
    return { cells: out, html: renderBlocks(content, ctx), ...(created ? { created } : {}) };
  });
  // Table views stay tables; kanban views become boards by their column.
  // Each keeps its column order, hidden columns and (tables) widths.
  const views: View[] = [];
  for (const view of rawViews) {
    const name = (typeof view?.name === "string" && view.name.trim() ? view.name : ct("Tabelle", "Table")).slice(0, 100);
    const group = typeof view?.groupBy?.columnId === "string" ? fieldOf.get(view.groupBy.columnId) : undefined;
    const groupField = fields.find((f) => f.id === group && (f.type === "select" || f.type === "checkbox"));
    const board = view?.mode === "kanban" && !!groupField;
    const layout = viewColumns(view);
    const fieldOrder = columnOrder(declared.map((c) => c.id), view)
      .map((id) => fieldIdOf.get(id))
      .filter((id): id is string => !!id);
    const hiddenFields = layout.filter((c) => c.hide === true && fieldIdOf.has(c.id) && fieldIdOf.get(c.id) !== "title").map((c) => fieldIdOf.get(c.id)!);
    const columnWidths = Object.fromEntries(
      layout
        .filter((c) => fieldIdOf.has(c.id) && typeof c.width === "number" && Number.isFinite(c.width))
        .map((c) => [fieldIdOf.get(c.id)!, Math.max(80, Math.min(800, Math.round(c.width!)))]),
    );
    views.push({
      id: randomUUID(),
      name,
      type: board ? "board" : "table",
      ...(board ? { groupBy: groupField!.id } : {}),
      filters: [],
      sorts: [],
      ...(fieldOrder.length > 1 ? { fieldOrder } : {}),
      ...(hiddenFields.length ? { hiddenFields } : {}),
      ...(!board && Object.keys(columnWidths).length ? { columnWidths } : {}),
    });
  }
  if (!views.length) views.push({ id: randomUUID(), name: ct("Tabelle", "Table"), type: "table", filters: [], sorts: [] });
  return { fields, views, rows, refs, title: plainOf(block.props.title, ctx).trim().slice(0, 200) || dbTitle() };
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

// AFFiNE's template flag: a boolean in db$docProperties; as text where a
// value went through the legacy properties.
const isTemplateFlag = (value: unknown) => value === true || value === "true";
// The database blocks among blocks (also nested in lists, toggles …).
function databasesIn(blocks: ABlock[], depth = 0): ABlock[] {
  if (depth > 40) return [];
  return blocks.flatMap((b) => (b.flavour === "affine:database" ? [b] : databasesIn(b.children, depth + 1)));
}
// The database a document consists of: its notes hold that one block and
// nothing else but empty paragraphs.
function onlyDatabase(root: ABlock): ABlock | null {
  const content = root.children
    .filter((b) => b.flavour === "affine:note" && noteDisplay(b) !== "edgeless")
    .flatMap((n) => n.children)
    .filter((b) => !isEmpty(b));
  return content.length === 1 && content[0].flavour === "affine:database" ? content[0] : null;
}

// The properties of a document (AFFiNE's custom doc properties) by name.
function docProperties(ws: AWorkspace, docId: string): Record<string, FrontmatterValue> | undefined {
  const values = ws.docProps.get(docId);
  if (!values) return undefined;
  const out: Record<string, FrontmatterValue> = {};
  for (const [id, def] of ws.properties) {
    const value = propertyValue(def.type, values[`custom:${id}`]);
    if (value === undefined) continue;
    const fallback: Record<string, () => string> = {
      text: () => ct("Text", "Text"),
      number: () => ct("Zahl", "Number"),
      checkbox: () => ct("Kontrollkästchen", "Checkbox"),
      date: () => ct("Datum", "Date"),
      progress: () => ct("Fortschritt", "Progress"),
    };
    const name = (def.name.trim() || fallback[def.type]?.() || def.type).slice(0, 100);
    if (!(name in out)) out[name] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

export function parseAffine(ws: AWorkspace, fallbackTitle: string): ImportTree {
  const warnings = warningList();
  const live = ws.docs.filter((d) => !d.trash);
  const trashed = ws.docs.length - live.length;
  if (trashed) warnings.add(`${trashed} Dokumente im Papierkorb werden nicht übernommen.`);
  // More documents than one import may bring (#82): counted, not converted.
  if (live.length > maxImportPages()) {
    for (const w of ws.warnings) warnings.add(w);
    return {
      source: "affine",
      title: (ws.name || fallbackTitle).slice(0, 200) || "AFFiNE",
      pages: live.map((d) => ({ key: docKey(d.id), parent: null, title: d.title.trim().slice(0, 200) || ct("Ohne Titel", "Untitled"), html: "" })),
      files: new Map(),
      warnings: warnings.list(),
      tooMany: true,
      ...(ws.close ? { close: ws.close } : {}),
    };
  }
  const byId = new Map(live.map((d) => [d.id, d]));
  const untitled = ct("Ohne Titel", "Untitled");
  // A document without a title in the list shows the one in its text; that
  // document is read once for it.
  const ownTitles = new Map<string, string>();
  const titleOf = (id: string) => {
    const doc = byId.get(id) ?? ws.docs.find((d) => d.id === id);
    if (!doc) return untitled;
    let own = doc.title.trim();
    if (!own) {
      if (!ownTitles.has(id)) {
        const root = doc.load();
        ownTitles.set(id, root ? plainOf(root.props.title, { title: () => "" }).trim() : "");
      }
      own = ownTitles.get(id)!;
    }
    return own.slice(0, 200) || untitled;
  };
  // Emoji icons of documents, folders and collections; AFFiNE's own symbols
  // have no counterpart.
  let affineIcons = 0;
  const iconOf = (key: string) => {
    const icon = ws.icons.get(key);
    if (icon === "affine-icon") affineIcons++;
    return icon && icon !== "affine-icon" ? { icon } : {};
  };
  const journalOf = (id: string) => validDate(ws.docProps.get(id)?.journal);
  // Templates (#116): AFFiNE marks them in the document's properties
  // (db$docProperties isTemplate, packages/frontend/core/src/modules/db/
  // schema/schema.ts; DocRecord.isTemplate$). They become saved templates of
  // the workspace, not pages; links to them stay text.
  const templateIds = new Set(live.filter((d) => isTemplateFlag(ws.docProps.get(d.id)?.isTemplate)).map((d) => d.id));
  const docLink = (id: string) => (byId.has(id) && !templateIds.has(id) ? pageRef(docKey(id)) : null);
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
  // Folders nested deeper than MAX_IMPORT_DEPTH hold their content at the
  // deepest level.
  let tooDeep = false;
  const walk = (parentId: string | null, parentKey: string, depth: number) => {
    for (const node of byParent.get(parentId) || []) {
      if (node.type === "folder") {
        if (seenFolders.has(node.id) || seenFolders.size > 20000) continue;
        seenFolders.add(node.id);
        if (depth >= MAX_IMPORT_DEPTH) {
          tooDeep = true;
          walk(node.id, parentKey, depth);
          continue;
        }
        const key = `folder:${node.id}`;
        pages.push({ key, parent: parentKey, title: node.data.trim().slice(0, 200) || untitled, html: "", folder: true, ...iconOf(`folder:${node.id}`) });
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
  if (tooDeep) warnings.add(`Ordner tiefer als ${MAX_IMPORT_DEPTH} Ebenen werden zusammengefasst.`);

  // Documents, with their databases and whiteboards.
  let dropped = 0;
  const boardFor = new Set<string>();
  // Database rows that name a document of their own (#82), in the order of
  // the import; settled once every document is converted.
  const claims: Claim[] = [];
  // The documents each document links to (#117: AFFiNE's sidebar shows them
  // below it), links to templates (text) and the templates themselves.
  const linksFrom = new Map<string, Set<string>>();
  let templateLinks = 0,
    canvasDatabases = 0;
  const templates: ImportTemplate[] = [];
  for (const doc of live) {
    // Read now, let go after the document is converted.
    const docRoot = doc.load();
    const template = templateIds.has(doc.id);
    if (docRoot && (edgelessExtras(docRoot) > 0 || ws.docProps.get(doc.id)?.primaryMode === "edgeless")) boardFor.add(doc.id);
    if (template && boardFor.delete(doc.id)) warnings.add("Whiteboards von Vorlagen werden nicht übernommen.");
    const key = docKey(doc.id);
    const title = titleOf(doc.id);
    const journalDate = template ? undefined : journalOf(doc.id);
    const properties = docProperties(ws, doc.id);
    const parent = journalDate ? null : placeOf.get(key) || ROOT;
    const subpages: ImportPage[] = [];
    const links = new Set<string>();
    if (!template) linksFrom.set(doc.id, links);
    const ownLink = (id: string) => {
      if (templateIds.has(id)) {
        templateLinks++;
        return null;
      }
      const href = docLink(id);
      if (href && id !== doc.id) links.add(id);
      return href;
    };
    // A template that is only a database becomes a database template; other
    // databases in templates are left out (a template has no pages below it).
    const databaseTemplate = template && docRoot ? onlyDatabase(docRoot) : null;
    let templateDb: ReturnType<typeof convertDatabase> | null = null;
    const ctx: Ctx = {
      ws,
      warn: (m) => warnings.add(m),
      docLink: ownLink,
      isDoc: (id) => byId.has(id) && !templateIds.has(id),
      isTemplate: (id) => templateIds.has(id),
      title: titleOf,
      blob,
      board: boardFor.has(doc.id) ? pageRef(boardKey(doc.id)) : null,
      database: (block) => {
        if (template) {
          if (block === databaseTemplate) templateDb = convertDatabase(block, ctx);
          else warnings.add("Datenbanken in Vorlagen werden nicht übernommen.");
          return "";
        }
        const db = convertDatabase(block, ctx);
        const dbKey = `db:${doc.id}:${block.id}`;
        db.refs.forEach((ref, i) => ref && claims.push({ ref, row: db.rows[i], fields: db.fields, owner: doc.id, db: dbKey }));
        // Below its document; for a journal day (which may live in another
        // space) below the workspace page.
        subpages.push({ key: dbKey, parent: journalDate ? ROOT : key, title: db.title, html: "", kind: "database", database: { fields: db.fields, views: db.views, rows: db.rows } });
        // Shown where it was, as an embedded view of the new database.
        const views = JSON.stringify(db.views.slice(0, 1).map((v) => ({ ...v, id: randomUUID() })));
        return `<div data-linked-database="${randomUUID()}" data-linked-source="${esc(pageRef(dbKey))}" data-linked-views="${esc(views)}" data-linked-version="1"></div>`;
      },
    };
    let html = "";
    if (docRoot) {
      const notes = docRoot.children.filter((b) => b.flavour === "affine:note" && noteDisplay(b) !== "edgeless");
      html = notes.map((note) => renderBlocks(note.children, ctx)).join("");
      // Databases in notes only on the canvas (#117): the whiteboard shows
      // their text; the database (and its rows' documents) becomes a page
      // below the document as any other.
      if (!template)
        for (const note of docRoot.children)
          if (note.flavour === "affine:note" && noteDisplay(note) === "edgeless")
            for (const block of databasesIn(note.children)) {
              ctx.database(block);
              canvasDatabases++;
            }
    } else warnings.add("Ein Dokument ohne Inhalt wurde nur mit seinem Titel übernommen.");
    if (template) {
      const db = templateDb as ReturnType<typeof convertDatabase> | null;
      templates.push({
        key,
        name: title,
        kind: db ? "database" : "document",
        html: db ? "" : html,
        ...(db ? { database: { fields: db.fields, views: db.views, rows: db.rows } } : {}),
        tags: [...new Set(doc.tags.map((t) => ws.tags.get(t)?.name).filter((t): t is string => !!t))],
        ...iconOf(`doc:${doc.id}`),
      });
      continue;
    }
    if (boardFor.has(doc.id) && docRoot) {
      const board = affineBoard(doc.id, docRoot, {
        blobs: ws.blobs,
        pageRef: ownLink,
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
      ...(properties ? { properties } : {}),
      ...iconOf(`doc:${doc.id}`),
    });
    pages.push(...subpages);
  }
  const homes = attachRowDocs(pages, claims, { byId, extraLinks, placeOf, titleOf, warn: (m) => warnings.add(m) });
  const below = placeLinkedDocs(pages, homes, linksFrom);
  if (below)
    warnings.add(`${below} Dokumente, die nur aus Dokumenten in Datenbankeinträgen verlinkt sind, liegen unter der Datenbank (Einträge haben keine Unterseiten).`);
  if (canvasDatabases) warnings.add(`${canvasDatabases} Datenbanken stehen in AFFiNE nur auf dem Whiteboard; sie werden Datenbankseiten unter ihrem Dokument.`);
  if (templateLinks) warnings.add(`${templateLinks} Links auf Vorlagen werden als Text übernommen.`);
  if (affineIcons) warnings.add(`${affineIcons} Symbole aus AFFiNEs Symbolbibliothek werden nicht übernommen (nur Emojis).`);
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
    const list = live
      .filter((d) => ids.has(d.id))
      .map((d) => (templateIds.has(d.id) ? `<li>${esc(titleOf(d.id))}</li>` : `<li><a href="${esc(docLink(d.id)!)}">${esc(titleOf(d.id))}</a></li>`));
    let html = `<p>${esc(ct("Sammlung aus AFFiNE, Stand des Imports.", "Collection from AFFiNE, as of the import."))}</p>`;
    if (collection.filters.length) {
      html += `<h2>${esc(ct("Regeln", "Rules"))}</h2><ul>${collection.filters.map((f) => `<li>${esc(describeFilter(f, ws))}</li>`).join("")}</ul>`;
      if (!resolved) html += `<p><em>${esc(ct("Nicht alle Regeln konnten beim Import ausgewertet werden; aufgeführt sind die fest hinzugefügten Dokumente.", "Not every rule could be evaluated during the import; listed are the documents added by hand."))}</em></p>`;
    }
    html += `<h2>${esc(ct("Dokumente", "Documents"))}</h2>${list.length ? `<ul>${list.join("")}</ul>` : `<p>${esc(ct("Keine Dokumente.", "No documents."))}</p>`}`;
    pages.push({ key, parent: placeOf.get(key) || ROOT, title: ct(`Sammlung: ${collection.name}`, `Collection: ${collection.name}`).slice(0, 200), html, ...iconOf(key) });
  }
  // Folders that list more than the documents they hold.
  for (const page of pages) if (extraLinks.has(page.key)) page.html = `<ul>${extraLinks.get(page.key)!.join("")}</ul>`;
  if (!live.length) warnings.add("Keine Dokumente gefunden.");
  // The reader's warnings, also those of documents read meanwhile.
  for (const w of ws.warnings) warnings.add(w);
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
    ...(templates.length ? { templates } : {}),
    ...(wrap ? { wrapper: ROOT } : {}),
    ...(ws.close ? { close: ws.close } : {}),
    tagColors: Object.fromEntries([...ws.tags.values()].flatMap((t) => (t.color ? [[t.name, t.color]] : []))),
  };
}

// Documents made from database rows (#82) become the content of their
// record instead of pages of their own:
// - the first row (in the order of the import) that names a document gets
//   its content, ahead of the row's own content; the record keeps the row's
//   title and cells, takes the document's icon, its tags into a multi-select
//   column "Tags" (or "Schlagwörter") and its properties into columns of the
//   same name and type that the row leaves empty;
// - every other row naming it links to it, as do rows naming a journal day
//   (which goes into the journal) or the document that holds the database;
// - links to the document lead to the record (write.ts); a folder that held
//   it lists a link to it; its own databases move to where it was.
// The result: per attached document the key of its record's database page.
type Claim = { ref: RowDocRef; row: ImportDatabase["rows"][number]; fields: Field[]; owner: string; db: string };
const TAG_COLUMN = /^(tags?|schlagw(ö|oe)rter)$/i;
function attachRowDocs(
  pages: ImportPage[],
  claims: Claim[],
  ctx: { byId: Map<string, ADoc>; extraLinks: Map<string, string[]>; placeOf: Map<string, string>; titleOf: (id: string) => string; warn: (m: string) => void },
) {
  const byKey = new Map(pages.map((p) => [p.key, p]));
  const attached = new Map<string, ImportPage>();
  const homes = new Map<string, string>();
  let lostTags = 0,
    lostProperties = 0,
    shared = 0,
    linked = 0,
    inFolders = 0;
  for (const { ref, row, fields, owner, db } of claims) {
    const key = docKey(ref.pageId);
    const page = byKey.get(key);
    if (!page || !ctx.byId.has(ref.pageId) || page.kind) continue;
    if (attached.has(key) || page.journalDate || ref.pageId === owner) {
      if (attached.has(key)) shared++;
      else linked++;
      row.html = `<p><a href="${esc(pageRef(key))}">${esc(ctx.titleOf(ref.pageId))}</a></p>${row.html}`;
      continue;
    }
    attached.set(key, page);
    homes.set(key, db);
    page.inRecord = true;
    row.key = key;
    row.html = page.html + row.html;
    if (page.icon) row.icon = page.icon;
    if (page.tags?.length) {
      const column = fields.find((f) => f.type === "multiselect" && TAG_COLUMN.test(f.name.trim()));
      if (column) {
        column.options = [...new Set([...(column.options || []), ...page.tags])].slice(0, 300);
        const own = Array.isArray(row.cells[column.id]) ? (row.cells[column.id] as string[]) : [];
        row.cells[column.id] = [...new Set([...own, ...page.tags])].filter((t) => column.options!.includes(t));
      } else lostTags++;
    }
    for (const [name, value] of Object.entries(page.properties || {})) {
      const type = typeof value === "number" ? "number" : typeof value === "boolean" ? "checkbox" : typeof value === "string" && DATE.test(value) ? "date" : "text";
      const field = fields.find((f) => f.id !== "title" && f.name.trim().toLowerCase() === name.trim().toLowerCase() && f.type === type);
      if (!field) lostProperties++;
      else if (row.cells[field.id] === undefined) row.cells[field.id] = value;
    }
    // A folder that held the document lists it (its record).
    const place = ctx.placeOf.get(key);
    if (place && place !== ROOT) {
      inFolders++;
      ctx.extraLinks.set(place, [...(ctx.extraLinks.get(place) || []), `<li><a href="${esc(pageRef(key))}">${esc(page.title)}</a></li>`]);
    }
  }
  // What hung below an attached document – its databases, its whiteboard –
  // goes below the database page of its record (#117): records have no
  // subpages, and the record's content shows those databases embedded, as
  // the document did. A document that is only a database (AFFiNE has no
  // database without a document) so lands in the database of the row that
  // names it, not at the top. Where that would put a page below itself (rows
  // naming each other's documents), it goes where the document was.
  const ancestors = (key: string) => {
    const seen = new Set<string>();
    for (let at: string | null | undefined = key; at && !seen.has(at) && seen.size < 500; at = byKey.get(at)?.parent) seen.add(at);
    return seen;
  };
  for (const page of pages) {
    const owner = page.parent && attached.has(page.parent) ? page.parent : page.kind === "whiteboard" ? docKey(page.key.slice("board:".length)) : null;
    if (!owner || !attached.has(owner)) continue;
    const home = homes.get(owner)!;
    page.parent = ancestors(home).has(page.key) ? attached.get(owner)!.parent ?? ROOT : home;
  }
  if (lostTags) ctx.warn(`${lostTags} Dokumente in Datenbankeinträgen haben Tags, die Datenbank aber keine Spalte „Tags“; diese Tags werden nicht übernommen.`);
  if (lostProperties) ctx.warn(`${lostProperties} Eigenschaften von Dokumenten in Datenbankeinträgen haben keine passende Spalte und werden nicht übernommen.`);
  // Where the unusual cases went (#117).
  if (shared) ctx.warn(`${shared} Datenbankeinträge nennen ein Dokument, das schon Inhalt eines anderen Eintrags ist; sie verlinken auf diesen Eintrag.`);
  if (linked) ctx.warn(`${linked} Datenbankeinträge nennen einen Journaltag oder das Dokument ihrer Datenbank; sie verlinken darauf.`);
  if (inFolders) ctx.warn(`${inFolders} Dokumente in Datenbankeinträgen liegen in AFFiNE auch in Ordnern; die Ordner verlinken auf den Eintrag.`);
  return homes;
}

// Documents linked from a document that became a record's content (#117):
// AFFiNE's sidebar shows them below it. Records have no subpages, so such a
// document goes below the record's database page – when it would otherwise
// sit at the top (no folder, no journal day) and every document linking to
// it is a record's document or one placed so; the documents those link to
// follow below them the same way. A document also linked from elsewhere
// stays where it was. Returns how many were placed.
function placeLinkedDocs(pages: ImportPage[], homes: Map<string, string>, linksFrom: Map<string, Set<string>>) {
  const byKey = new Map(pages.map((p) => [p.key, p]));
  const linkers = new Map<string, string[]>();
  for (const [from, targets] of linksFrom) for (const target of targets) linkers.set(target, [...(linkers.get(target) || []), from]);
  // Per placed document: the page its linked documents go below.
  const home = new Map(homes);
  const below = (parent: string, key: string) => {
    for (let at: string | null | undefined = parent, n = 0; at && n < 200; at = byKey.get(at)?.parent, n++) if (at === key) return true;
    return false;
  };
  let placed = 0;
  for (let changed = true, rounds = 0; changed && rounds < 100; rounds++) {
    changed = false;
    for (const [target, from] of linkers) {
      const key = docKey(target);
      const page = byKey.get(key);
      if (!page || page.parent !== ROOT || page.inRecord || page.journalDate || page.kind || home.has(key)) continue;
      if (!from.every((f) => home.has(docKey(f)))) continue;
      const parent = home.get(docKey(from[0]))!;
      if (below(parent, key)) continue;
      page.parent = parent;
      home.set(key, key);
      const board = byKey.get(boardKey(target));
      if (board && board.parent === ROOT) board.parent = parent;
      placed++;
      changed = true;
    }
  }
  return placed;
}

// Whether the import keeps the page named after the workspace: only for the
// workspace file (.affine), and only when more than one item would sit at
// the top – folders, documents outside folders, collections, databases of
// journal days. A whiteboard belongs to its document and does not count;
// journal days go into the journal.
export function keepWorkspacePage(format: AWorkspace["format"], pages: Pick<ImportPage, "parent" | "kind" | "inRecord">[]) {
  if (format === "snapshot") return false;
  return pages.filter((p) => p.parent === ROOT && p.kind !== "whiteboard" && !p.inRecord).length > 1;
}
