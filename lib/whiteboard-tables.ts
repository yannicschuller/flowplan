// Tables on whiteboards (#455): background colours of whole rows and
// columns, the header row and column, and links in cells. Colours are
// stored per row (`rowFills`) and per column (`colFills`) as "#rrggbb" or ""
// for none; a row's colour goes before a column's, and a cell without
// either keeps the header's grey when it is a header cell. A cell whose text
// is one web address shows a preview: players of the embed allowlist from
// the address alone, other pages from what GET /api/embed found, kept on
// the table (`links`, by address) so every viewer and the exports see it
// without loading anything.
import { safeHref } from "./whiteboard-links";
import { embedFromUrl } from "./embed-providers";
import type { WhiteboardItem } from "./whiteboard-model";

export const TABLE_FILL = /^#[0-9a-f]{6}$/i;
export const MAX_TABLE_ROWS = 50;
export const MAX_TABLE_COLS = 20;
// The previews a table keeps at most.
export const MAX_TABLE_LINKS = 60;

// A web page's preview (link cards on the board and in table cells).
export type LinkPreview = {
  title: string;
  site: string;
  description?: string;
  image?: string;
  icon?: string;
};

type TableLike = Pick<WhiteboardItem, "cells" | "header" | "headerCol" | "rowFills" | "colFills">;

export function tableShape(item: Pick<WhiteboardItem, "cells">) {
  const cells = item.cells?.length ? item.cells : [[""]];
  return { cells, cols: Math.max(1, ...cells.map((r) => r.length)) };
}
export const isHeadCell = (item: TableLike, r: number, c: number) =>
  (r === 0 && item.header !== false) || (c === 0 && !!item.headerCol);
const fillAt = (list: unknown, i: number) => {
  const value = Array.isArray(list) ? list[i] : undefined;
  return typeof value === "string" && TABLE_FILL.test(value) ? value.toLowerCase() : null;
};
// The background of a cell: its row's colour, else its column's, else none.
export const cellFill = (item: TableLike, r: number, c: number) => fillAt(item.rowFills, r) ?? fillAt(item.colFills, c);

// The list with one entry set ("" or "transparent" clears it), trailing
// empty entries cut off; undefined when nothing is left.
export function setFill(list: unknown, index: number, color: string, length: number): string[] | undefined {
  const next = Array.from({ length: Math.max(0, length) }, (_, i) => fillAt(list, i) ?? "");
  if (index >= 0 && index < next.length) next[index] = TABLE_FILL.test(color) ? color.toLowerCase() : "";
  return trimFills(next, length);
}
// After rows or columns were added or removed.
export function trimFills(list: unknown, length: number): string[] | undefined {
  const next = Array.from({ length: Math.max(0, length) }, (_, i) => fillAt(list, i) ?? "");
  while (next.length && !next[next.length - 1]) next.pop();
  return next.length ? next : undefined;
}

// ---- links in cells ----
export type CellPart = { text: string; href?: string };
const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"'`]+/gi;
// Punctuation after an address belongs to the sentence ("see https://a.b.").
function trimUrl(raw: string) {
  let url = raw.replace(/[.,;:!?'"]+$/, "");
  // A closing bracket stays only when the address opened one.
  while (/[)\]}]$/.test(url)) {
    const close = url.slice(-1),
      open = close === ")" ? "(" : close === "]" ? "[" : "{";
    if (url.split(open).length >= url.split(close).length) break;
    url = url.slice(0, -1).replace(/[.,;:!?'"]+$/, "");
  }
  return url;
}
// The cell text as plain parts and web links (http and https only).
export function cellParts(text: string): CellPart[] {
  const parts: CellPart[] = [];
  let at = 0;
  for (const match of text.matchAll(URL_IN_TEXT)) {
    const url = trimUrl(match[0]);
    const href = safeHref(url);
    if (!href || !/^https?:/i.test(href)) continue;
    const start = match.index!;
    if (start > at) parts.push({ text: text.slice(at, start) });
    parts.push({ text: url, href });
    at = start + url.length;
  }
  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts;
}
// The address when the cell holds exactly one web address and nothing else.
export function soleUrl(text: string): string | null {
  const parts = cellParts(text.trim());
  return parts.length === 1 && parts[0].href ? parts[0].href : null;
}
// What a cell with a lone address shows: a player of the allowlist (with a
// thumbnail where the address gives one) or a page's preview.
export type CellLink =
  | { kind: "player"; url: string; provider: string; thumbnail?: string }
  | { kind: "page"; url: string; preview?: LinkPreview };
export function cellLink(text: string, links?: Record<string, LinkPreview>): CellLink | null {
  const url = soleUrl(text);
  if (!url) return null;
  const player = embedFromUrl(url);
  if (player) return { kind: "player", url, provider: player.provider, thumbnail: videoThumbnail(player.src) };
  return { kind: "page", url, preview: links?.[url] };
}
// YouTube's still picture of a video (the only provider whose address
// alone gives one).
export function videoThumbnail(player: string) {
  const id = /^https:\/\/www\.youtube-nocookie\.com\/embed\/([-\w]{6,20})$/.exec(player)?.[1];
  return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : undefined;
}
// The page addresses of a table whose preview is wanted (lone addresses
// that are not players).
export function tablePageLinks(item: Pick<WhiteboardItem, "cells">): string[] {
  const out = new Set<string>();
  for (const row of item.cells || [])
    for (const text of row || []) {
      const link = typeof text === "string" ? cellLink(text) : null;
      if (link?.kind === "page") out.add(link.url);
    }
  return [...out].slice(0, MAX_TABLE_LINKS);
}
// The kept previews without those of addresses no cell holds any more.
export function keptLinks(item: Pick<WhiteboardItem, "cells" | "links">): Record<string, LinkPreview> | undefined {
  const wanted = new Set(tablePageLinks(item));
  const entries = Object.entries(item.links || {}).filter(([url]) => wanted.has(url));
  return entries.length ? Object.fromEntries(entries) : undefined;
}
