// Organising a notebook (lib/notebook-organize.ts on the server,
// components/notebook/notebook-overview.tsx in the browser): a sheet's own
// title and bookmark, links on a sheet to another sheet or page, the table
// of contents, and the helpers of the page overview – search, selection,
// moving several sheets at once and the window of a virtualised grid.
// Plain data and pure functions: used on both sides and in tests.
import { z } from "zod";

export const SHEET_TITLE_MAX = 120;
export const OUTLINE_TITLE_MAX = 200;
export const MAX_LINKS = 100;
export const MAX_OUTLINE = 1000;
// Levels of the table of contents: chapter, sub-chapter, section.
export const OUTLINE_LEVELS = 3;
// Deleted sheets stay restorable this long.
export const TRASH_DAYS = 30;

// A link on a sheet: an area (x, y, w, h in the sheet's points, top left)
// that jumps to another sheet of the notebook or to any page. With a label
// it shows as a chip with that text; without, as a marked area.
export type NotebookLinkTarget = { sheet: string } | { page: string };
export type NotebookLink = { id: string; x: number; y: number; w: number; h: number; label?: string; target: NotebookLinkTarget };
// An entry of the table of contents: a heading on a sheet (y: where on the
// sheet, points from the top), nested by level (0 = chapter).
export type OutlineEntry = { id: string; sheet: string; title: string; level: number; y?: number };

const ID = /^[\w-]{1,40}$/;
const coordinate = z.number().finite().min(-100).max(20000);
const linkSchema = z.object({
  id: z.string().regex(ID),
  x: coordinate,
  y: coordinate,
  w: z.number().finite().min(4).max(20000),
  h: z.number().finite().min(4).max(20000),
  label: z.string().optional(),
  target: z.union([z.object({ sheet: z.string().regex(ID) }).strict(), z.object({ page: z.uuid() }).strict()]),
});
const entrySchema = z.object({
  id: z.string().regex(ID),
  sheet: z.string().regex(ID),
  title: z.string(),
  level: z.number().int().optional(),
  y: z.number().finite().min(0).max(20000).optional(),
});

// Text a person typed as a title: one line, no control or direction
// characters, at most `max` characters.
export function cleanTitle(value: unknown, max = SHEET_TITLE_MAX): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
}
const round = (n: number) => Math.round(n * 100) / 100;

// The valid links of a sheet; `sheets` (when given): the sheets a link may
// point to – links to others are dropped.
export function cleanLinks(value: unknown, sheets?: Set<string>): NotebookLink[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: NotebookLink[] = [];
  for (const raw of value) {
    const parsed = linkSchema.safeParse(raw);
    if (!parsed.success || seen.has(parsed.data.id)) continue;
    const { id, x, y, w, h, label, target } = parsed.data;
    if ("sheet" in target && sheets && !sheets.has(target.sheet)) continue;
    seen.add(id);
    const text = cleanTitle(label, OUTLINE_TITLE_MAX);
    out.push({ id, x: round(x), y: round(y), w: round(w), h: round(h), ...(text ? { label: text } : {}), target: "sheet" in target ? { sheet: target.sheet } : { page: target.page } });
    if (out.length >= MAX_LINKS) break;
  }
  return out;
}
export function parseLinks(stored: string | null | undefined, sheets?: Set<string>): NotebookLink[] {
  try {
    return cleanLinks(JSON.parse(stored || "[]"), sheets);
  } catch {
    return [];
  }
}

// The valid entries of a table of contents, in order: titles cleaned,
// levels between 0 and OUTLINE_LEVELS - 1 and never deeper than one below
// the entry before (the first is a chapter), entries of unknown sheets
// dropped (when `sheets` is given).
export function cleanOutline(value: unknown, sheets?: Set<string>): OutlineEntry[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: OutlineEntry[] = [];
  for (const raw of value) {
    const parsed = entrySchema.safeParse(raw);
    if (!parsed.success || seen.has(parsed.data.id)) continue;
    const { id, sheet, y } = parsed.data;
    if (sheets && !sheets.has(sheet)) continue;
    const title = cleanTitle(parsed.data.title, OUTLINE_TITLE_MAX);
    if (!title) continue;
    const previous = out.length ? out[out.length - 1].level : -1;
    const level = Math.max(0, Math.min(OUTLINE_LEVELS - 1, previous + 1, Math.round(parsed.data.level ?? 0)));
    seen.add(id);
    out.push({ id, sheet, title, level, ...(y !== undefined ? { y: round(y) } : {}) });
    if (out.length >= MAX_OUTLINE) break;
  }
  return out;
}
export function parseOutline(stored: string | null | undefined, sheets?: Set<string>): OutlineEntry[] {
  try {
    return cleanOutline(JSON.parse(stored || "[]"), sheets);
  } catch {
    return [];
  }
}

// Where a new heading goes: after the last entry on an earlier sheet (or
// higher up on the same sheet), so the contents follow the sheets.
export function outlineInsert(outline: OutlineEntry[], entry: OutlineEntry, order: string[]): OutlineEntry[] {
  const index = new Map(order.map((sid, i) => [sid, i]));
  const at = index.get(entry.sheet) ?? order.length;
  const before = (e: OutlineEntry) => {
    const i = index.get(e.sheet) ?? -1;
    return i < at || (i === at && (e.y ?? 0) <= (entry.y ?? 0));
  };
  let position = 0;
  outline.forEach((e, i) => {
    if (before(e)) position = i + 1;
  });
  return [...outline.slice(0, position), entry, ...outline.slice(position)];
}
// An entry with the entries nested below it: [start, end).
function branch(outline: OutlineEntry[], index: number): [number, number] {
  let end = index + 1;
  while (end < outline.length && outline[end].level > outline[index].level) end++;
  return [index, end];
}
// Moves an entry (with what is nested below it) before the previous or
// after the next entry of the same level.
export function outlineMove(outline: OutlineEntry[], id: string, direction: -1 | 1): OutlineEntry[] {
  const index = outline.findIndex((e) => e.id === id);
  if (index < 0) return outline;
  const [start, end] = branch(outline, index);
  const level = outline[index].level;
  const part = outline.slice(start, end);
  const rest = [...outline.slice(0, start), ...outline.slice(end)];
  if (direction < 0) {
    let target = start - 1;
    while (target >= 0 && rest[target].level > level) target--;
    if (target < 0 || rest[target].level < level) return outline;
    return cleanOutline([...rest.slice(0, target), ...part, ...rest.slice(target)]);
  }
  if (start >= rest.length || rest[start].level < level) return outline;
  const [, nextEnd] = branch(rest, start);
  return cleanOutline([...rest.slice(0, nextEnd), ...part, ...rest.slice(nextEnd)]);
}
// One level deeper (indent) or higher (outdent), with what is nested below.
export function outlineIndent(outline: OutlineEntry[], id: string, delta: -1 | 1): OutlineEntry[] {
  const index = outline.findIndex((e) => e.id === id);
  if (index < 0) return outline;
  const [start, end] = branch(outline, index);
  const level = outline[index].level + delta;
  const previous = index ? outline[index - 1].level : -1;
  if (level < 0 || level > previous + 1 || level > OUTLINE_LEVELS - 1) return outline;
  if (outline.slice(start, end).some((e) => e.level + delta > OUTLINE_LEVELS - 1)) return outline;
  return outline.map((e, i) => (i >= start && i < end ? { ...e, level: e.level + delta } : e));
}
// The entries without the ones of these sheets (deleted, moved away).
export const outlineWithout = (outline: OutlineEntry[], sheets: Set<string>) => cleanOutline(outline.filter((e) => !sheets.has(e.sheet)));

// ---- Search ----

// Lower case, without accents: "Übung" finds "ubung" and "uebung" does not.
export const searchKey = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
// The sheets whose text (title, typed text, recognised handwriting)
// contains every word of the query.
export function searchSheets(sheets: { id: string; text: string }[], query: string): string[] {
  const words = searchKey(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return sheets.filter((s) => {
    const text = searchKey(s.text);
    return words.every((w) => text.includes(w));
  }).map((s) => s.id);
}

// ---- Selection and order ----

// Shift-click: everything from the anchor to the target is added.
export function rangeSelect(order: string[], anchor: string | null, target: string, current: Set<string>): Set<string> {
  const a = anchor ? order.indexOf(anchor) : -1;
  const b = order.indexOf(target);
  if (b < 0) return current;
  if (a < 0) return new Set([...current, target]);
  const next = new Set(current);
  for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(order[i]);
  return next;
}
// The sheets `ids` moved together (in their order) to before the sheet that
// was at `to` in `order` (to = order.length: the end).
export function moveMany(order: string[], ids: Set<string> | string[], to: number): string[] {
  const moving = new Set(ids);
  const picked = order.filter((x) => moving.has(x));
  if (!picked.length) return order;
  const before = order.slice(0, Math.max(0, Math.min(order.length, to))).filter((x) => !moving.has(x)).length;
  const rest = order.filter((x) => !moving.has(x));
  return [...rest.slice(0, before), ...picked, ...rest.slice(before)];
}

// ---- Virtualised grid ----

// The rows of a grid of `count` cells to draw for a scroll position.
export function gridWindow({ count, columns, rowHeight, scrollTop, height, overscan = 2 }: { count: number; columns: number; rowHeight: number; scrollTop: number; height: number; overscan?: number }) {
  const cols = Math.max(1, Math.floor(columns));
  const rows = Math.ceil(count / cols);
  const firstRow = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const lastRow = Math.min(rows - 1, Math.ceil((scrollTop + height) / rowHeight) + overscan);
  return {
    columns: cols,
    rows,
    first: firstRow * cols,
    last: Math.min(count - 1, (lastRow + 1) * cols - 1),
    top: firstRow * rowHeight,
    total: rows * rowHeight,
  };
}
// How many cells of at least `min` pixels fit into `width`.
export const gridColumns = (width: number, min: number, gap: number) => Math.max(1, Math.floor((width + gap) / (min + gap)));
