// The ink model: handwriting, highlighter and text on a page surface (a PDF
// page, paper of a notebook, an image). Free of React and the DOM, shared by
// the browser and the server. The format is described in lib/ink/README.md.
//
// Coordinates are page units (PDF points for PDFs: 1/72 inch), origin at the
// top left of the page as it is shown, y downwards – independent of zoom and
// device pixel ratio. A stroke keeps its points as a flat list of
// x, y, pressure triples, rounded to two decimals.

import { isInkFont, type InkFont } from "./fonts";
import { cleanShape, type InkShape } from "./shapes";

export const INK_FORMAT = "flowplan-ink";
export const INK_VERSION = 1;
export const INK_LIMITS = {
  pages: 5000,
  itemsPerPage: 4000,
  pointsPerStroke: 6000,
  textLength: 1000,
  // Pictures and stickers on one page (each is one item).
  imagesPerPage: 200,
  // The stored JSON of a whole ink document.
  bytes: 6_000_000,
};

export type InkStrokeType = "pen" | "highlighter";
// When the item was written during an audio recording of a notebook
// (lib/notebook-audio.ts): the recording's id and the time into it in
// milliseconds. Optional, so older versions read such ink (and drop the
// field when they save that surface: the item then plays as always shown).
export type InkRec = { id: string; t: number };
export const INK_REC_MAX_MS = 3 * 60 * 60 * 1000 + 60_000;
export type InkStroke = {
  id: string;
  type: InkStrokeType;
  color: string;
  // Line width in page units at pressure 0.5 (pen) or the full width (highlighter).
  width: number;
  // x, y, pressure (0–1), x, y, pressure, …
  points: number[];
  // Pen only: an editable shape (lib/ink/shapes.ts); `points` is then its
  // outline, which is what versions without shapes draw (and keep).
  shape?: InkShape;
  rec?: InkRec;
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
  // Typeface (lib/ink/fonts.ts); none: Helvetica as before. Optional, so
  // older versions read such text (and drop the face when they save).
  font?: InkFont;
  // Turned clockwise by this many degrees around (x, y) (the lasso's
  // rotation handle); none: upright. Optional like `font`: older versions
  // show such text upright and drop the turn when they save that surface.
  rotation?: number;
  rec?: InkRec;
};
// A picture on the page: a file attached to the page (`file`) or one of the
// built-in stickers (`sticker`, lib/ink/stickers.ts). (x, y, w, h) is the
// box it is shown in, before `rotation` (degrees, clockwise, around the
// box's centre); `crop` is the part of the picture shown, in fractions of
// its full size (0–1); `opacity` 0.05–1. Optional fields, so a picture
// without them is the whole file, upright and opaque. Versions before
// pictures drop the item (the server keeps it for them, see README).
export type InkImage = {
  id: string;
  type: "image";
  x: number;
  y: number;
  w: number;
  h: number;
  file?: string;
  sticker?: string;
  // Tint of a one-colour built-in sticker.
  color?: string;
  rotation?: number;
  crop?: { x: number; y: number; w: number; h: number };
  opacity?: number;
  rec?: InkRec;
};
export type InkItem = InkStroke | InkText | InkImage;
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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STICKER = /^[a-z][a-z0-9-]{0,39}$/;
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

// The recording mark of a stored item, or null when it is unusable.
export function cleanRec(raw: unknown): InkRec | null {
  if (!raw || typeof raw !== "object") return null;
  const { id, t } = raw as { id?: unknown; t?: unknown };
  if (typeof id !== "string" || !/^[\w-]{1,40}$/.test(id) || !finite(t)) return null;
  return { id, t: Math.round(clamp(t, 0, INK_REC_MAX_MS)) };
}
const withRec = (raw: Record<string, unknown>) => {
  const rec = cleanRec(raw.rec);
  return rec ? { rec } : {};
};
// Degrees in (-180, 180], two decimals; 0 for (almost) upright.
export function normalRotation(degrees: number) {
  if (!Number.isFinite(degrees)) return 0;
  let d = degrees % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  d = round2(d);
  return Math.abs(d) < 0.01 ? 0 : d;
}

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
    const shape = item.type === "pen" ? cleanShape(item.shape) : undefined;
    return { id, type: item.type, color, width: round2(clamp(item.width, 0.1, 200)), points, ...(shape ? { shape } : {}), ...withRec(item) };
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
      ...(isInkFont(item.font) ? { font: item.font } : {}),
      ...(finite(item.rotation) && normalRotation(item.rotation) ? { rotation: normalRotation(item.rotation) } : {}),
      ...withRec(item),
    };
  }
  if (item.type === "image") return cleanImage(item, id);
  return null;
}

function cleanImage(item: Record<string, unknown>, id: string): InkImage | null {
  const file = typeof item.file === "string" && UUID.test(item.file) ? item.file.toLowerCase() : undefined;
  const sticker = !file && typeof item.sticker === "string" && STICKER.test(item.sticker) ? item.sticker : undefined;
  if ((!file && !sticker) || !finite(item.x) || !finite(item.y) || !finite(item.w) || !finite(item.h)) return null;
  const out: InkImage = {
    id,
    type: "image",
    x: round2(clamp(item.x, -1e5, 1e5)),
    y: round2(clamp(item.y, -1e5, 1e5)),
    w: round2(clamp(item.w, 1, 1e5)),
    h: round2(clamp(item.h, 1, 1e5)),
    ...(file ? { file } : { sticker }),
  };
  if (sticker && typeof item.color === "string" && COLOR.test(item.color)) out.color = item.color.toLowerCase();
  if (finite(item.rotation)) {
    const turn = round2((((item.rotation % 360) + 540) % 360) - 180);
    if (turn) out.rotation = turn;
  }
  const crop = item.crop as Record<string, unknown> | undefined;
  if (crop && typeof crop === "object" && finite(crop.x) && finite(crop.y) && finite(crop.w) && finite(crop.h)) {
    const x = clamp(crop.x, 0, 0.99),
      y = clamp(crop.y, 0, 0.99);
    const w = clamp(crop.w, 0.01, 1 - x),
      h = clamp(crop.h, 0.01, 1 - y);
    const r4 = (n: number) => Math.round(n * 10000) / 10000;
    if (x > 0 || y > 0 || w < 1 || h < 1) out.crop = { x: r4(x), y: r4(y), w: r4(w), h: r4(h) };
  }
  if (finite(item.opacity) && item.opacity < 1) out.opacity = round2(clamp(item.opacity, 0.05, 1));
  const rec = cleanRec(item.rec);
  if (rec) out.rec = rec;
  return out;
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
    let images = 0;
    const items = list
      .slice(0, INK_LIMITS.itemsPerPage)
      .map(cleanItem)
      .filter((i): i is InkItem => !!i && (i.type !== "image" || ++images <= INK_LIMITS.imagesPerPage));
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
// Files the pictures of a document show (attachments of the page).
export function inkFiles(doc: InkDoc): string[] {
  const out = new Set<string>();
  for (const list of Object.values(doc.pages)) for (const item of list) if (item.type === "image" && item.file) out.add(item.file);
  return [...out];
}
// The document with picture files swapped (copies of a page; `map` gives
// the copy's file, or null: the picture goes).
export function mapInkFiles(doc: InkDoc, map: (file: string) => string | null | undefined): InkDoc {
  const pages: Record<string, InkItem[]> = {};
  for (const [key, list] of Object.entries(doc.pages)) {
    const items = list.flatMap((item): InkItem[] => {
      if (item.type !== "image" || !item.file) return [item];
      const file = map(item.file);
      return file ? [{ ...item, file }] : [];
    });
    if (items.length) pages[key] = items;
  }
  return { ...doc, pages };
}
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
