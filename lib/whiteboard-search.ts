// Search on a board (Ctrl/⌘+F): texts of notes, shapes, text, tables,
// frames, comments, connector labels, cards (page and record titles),
// embeds and tags. Case and accents do not matter ("Uber" finds "Über").
// Covered elements stay hidden. Matches come in reading order.
import { itemText, type WhiteboardItem } from "./whiteboard-model";

export type BoardMatch = { id: string; snippet: string; start: number; length: number };
export type SearchContext = {
  page?: (pageId: string) => string | undefined;
  record?: (rowId: string) => { title: string; props?: string[] } | undefined;
};
export const fold = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLocaleLowerCase("de");

export function searchableText(item: WhiteboardItem, ctx: SearchContext = {}) {
  if (item.covered) return "";
  const parts = [itemText(item)];
  if (item.type === "card") {
    if (item.rowId) {
      const record = ctx.record?.(item.rowId);
      if (record) parts.push(record.title, ...(record.props || []));
    } else if (item.pageId) parts.push(ctx.page?.(item.pageId) || "");
  }
  if (item.type === "comment") parts.push(...(item.messages || []).map((m) => m.name));
  if (item.type === "embed") parts.push(item.url || "");
  if (item.type === "image" && item.credit) parts.push(item.credit);
  return parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

export function searchBoard(items: WhiteboardItem[], query: string, ctx: SearchContext = {}): BoardMatch[] {
  const needle = fold(query.trim());
  if (!needle) return [];
  const matches: (BoardMatch & { x: number; y: number })[] = [];
  for (const item of items) {
    const text = searchableText(item, ctx);
    if (!text) continue;
    // Folding keeps the length for nearly every text; where it does not,
    // the snippet starts at the beginning.
    const folded = fold(text);
    const at = folded.indexOf(needle);
    if (at < 0) continue;
    const exact = folded.length === text.length;
    const from = exact ? Math.max(0, at - 30) : 0;
    const snippet = (from ? "…" : "") + text.slice(from, from + 90) + (from + 90 < text.length ? "…" : "");
    const x = item.type === "connector" ? Math.min(item.from?.x ?? 0, item.to?.x ?? 0) : item.x;
    const y = item.type === "connector" ? Math.min(item.from?.y ?? 0, item.to?.y ?? 0) : item.y;
    matches.push({
      id: item.id,
      snippet,
      start: exact ? at - from + (from ? 1 : 0) : 0,
      length: exact ? needle.length : 0,
      x,
      y,
    });
  }
  return matches.sort((a, b) => a.y - b.y || a.x - b.x).map(({ x: _x, y: _y, ...m }) => m);
}
