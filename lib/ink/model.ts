// The ink model: handwriting, highlighter and text on a page surface (a PDF
// page, paper of a notebook, an image). Free of React and the DOM, shared by
// the browser and the server. The format is described in lib/ink/README.md.
//
// Coordinates are page units (PDF points for PDFs: 1/72 inch), origin at the
// top left of the page as it is shown, y downwards – independent of zoom and
// device pixel ratio. A stroke keeps its points as a flat list of
// x, y, pressure triples, rounded to two decimals.

export const INK_FORMAT = "flowplan-ink";
export const INK_VERSION = 1;
export const INK_LIMITS = {
  pages: 5000,
  itemsPerPage: 4000,
  pointsPerStroke: 6000,
  textLength: 1000,
  // The stored JSON of a whole ink document.
  bytes: 6_000_000,
};

export type InkStrokeType = "pen" | "highlighter";
export type InkStroke = {
  id: string;
  type: InkStrokeType;
  color: string;
  // Line width in page units at pressure 0.5 (pen) or the full width (highlighter).
  width: number;
  // x, y, pressure (0–1), x, y, pressure, …
  points: number[];
};
export type InkText = {
  id: string;
  type: "text";
  color: string;
  // Font size in page units; (x, y) is the top left of the first line.
  size: number;
  x: number;
  y: number;
  text: string;
};
export type InkItem = InkStroke | InkText;
export type InkDoc = {
  format: typeof INK_FORMAT;
  version: number;
  unit: "pt";
  // Page key → items, back to front. PDFs use the page number ("1", "2", …).
  pages: Record<string, InkItem[]>;
};

export const emptyInk = (): InkDoc => ({ format: INK_FORMAT, version: INK_VERSION, unit: "pt", pages: {} });

const round2 = (n: number) => Math.round(n * 100) / 100;
const COLOR = /^#[0-9a-f]{6}$/i;
const KEY = /^[\w.-]{1,64}$/;
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

let counter = 0;
// Short ids are enough: they only tell items of one page apart.
export function inkId() {
  counter = (counter + 1) % 1296;
  return Date.now().toString(36).slice(-5) + counter.toString(36).padStart(2, "0") + Math.random().toString(36).slice(2, 6);
}

// One item as stored, or null when it is unusable.
export function cleanItem(raw: unknown): InkItem | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const id = typeof item.id === "string" && /^[\w-]{1,40}$/.test(item.id) ? item.id : inkId();
  const color = typeof item.color === "string" && COLOR.test(item.color) ? item.color.toLowerCase() : "#1f1f1f";
  if (item.type === "pen" || item.type === "highlighter") {
    if (!Array.isArray(item.points) || !finite(item.width)) return null;
    const points: number[] = [];
    const list = item.points.slice(0, INK_LIMITS.pointsPerStroke * 3);
    for (let i = 0; i + 2 < list.length; i += 3) {
      const [x, y, p] = [list[i], list[i + 1], list[i + 2]];
      if (!finite(x) || !finite(y) || !finite(p)) continue;
      points.push(round2(clamp(x, -1e5, 1e5)), round2(clamp(y, -1e5, 1e5)), round2(clamp(p, 0, 1)));
    }
    if (!points.length) return null;
    return { id, type: item.type, color, width: round2(clamp(item.width, 0.1, 200)), points };
  }
  if (item.type === "text") {
    if (typeof item.text !== "string" || !item.text.trim() || !finite(item.x) || !finite(item.y) || !finite(item.size)) return null;
    return {
      id,
      type: "text",
      color,
      size: round2(clamp(item.size, 2, 400)),
      x: round2(clamp(item.x, -1e5, 1e5)),
      y: round2(clamp(item.y, -1e5, 1e5)),
      text: item.text.slice(0, INK_LIMITS.textLength),
    };
  }
  return null;
}

// Reads stored ink (an object or its JSON); anything unexpected is dropped.
// Newer versions keep the item types this version knows.
export function parseInk(value: unknown): InkDoc {
  let raw = value;
  if (typeof raw === "string") {
    try {
      raw = raw ? JSON.parse(raw) : null;
    } catch {
      raw = null;
    }
  }
  const doc = emptyInk();
  if (!raw || typeof raw !== "object") return doc;
  const pages = (raw as { pages?: unknown }).pages;
  if (!pages || typeof pages !== "object" || Array.isArray(pages)) return doc;
  let count = 0;
  for (const [key, list] of Object.entries(pages as Record<string, unknown>)) {
    if (!KEY.test(key) || !Array.isArray(list) || ++count > INK_LIMITS.pages) continue;
    const items = list.slice(0, INK_LIMITS.itemsPerPage).map(cleanItem).filter((i): i is InkItem => !!i);
    if (items.length) doc.pages[key] = items;
  }
  return doc;
}

// The stored form: pages in order, empty pages left out.
export function serializeInk(doc: InkDoc): string {
  const pages: Record<string, InkItem[]> = {};
  const keys = Object.keys(doc.pages).sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  for (const key of keys) if (doc.pages[key]?.length) pages[key] = doc.pages[key];
  return JSON.stringify({ format: INK_FORMAT, version: INK_VERSION, unit: "pt", pages });
}

export const inkItemCount = (doc: InkDoc) => Object.values(doc.pages).reduce((n, list) => n + list.length, 0);
export const hasInk = (doc: InkDoc | null | undefined) => !!doc && Object.values(doc.pages).some((list) => list.length > 0);

// The typed text of all pages (search index).
export function inkText(doc: InkDoc) {
  return Object.keys(doc.pages)
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
    .flatMap((key) => doc.pages[key].flatMap((item) => (item.type === "text" ? [item.text] : [])))
    .join("\n");
}

// A page of the document with new items (the document is not changed).
export function withPage(doc: InkDoc, key: string, items: InkItem[]): InkDoc {
  const pages = { ...doc.pages };
  if (items.length) pages[key] = items;
  else delete pages[key];
  return { ...doc, pages };
}
