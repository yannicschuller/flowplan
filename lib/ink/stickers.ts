// The built-in stickers of notebooks: simple shapes drawn for Flowplan
// (public domain, CC0), each a few SVG paths in a 100 × 100 box. One source
// for every renderer: the ink layer and the SVG export draw the paths, the
// PDF export draws them as vectors (pdf-lib), and public/stickers/<id>.svg
// (the pictures of the sticker panel) are written from here
// (tests/ink-stickers.test.ts checks they match). A sticker on a sheet is
// an image item with `sticker: <id>` (lib/ink/model.ts); "tint" paths take
// the item's colour (one-colour stickers follow the colour of a selection).
import { inkId, type InkItem } from "./model";

export type StickerShape = {
  d: string;
  // A colour, or "tint": the item's colour (the sticker's default otherwise).
  fill?: string;
  stroke?: string;
  width?: number;
  opacity?: number;
};
// Names for people are in the sticker panel (translated there).
export type Sticker = { id: string; tint?: string; shapes: StickerShape[] };

const circle = (cx: number, cy: number, r: number) => `M${cx - r} ${cy} A${r} ${r} 0 1 0 ${cx + r} ${cy} A${r} ${r} 0 1 0 ${cx - r} ${cy} Z`;
const note = (fill: string, fold: string): StickerShape[] => [
  { d: "M6 6 H94 V72 L72 94 H6 Z", fill },
  { d: "M94 72 H76 C73.8 72 72 73.8 72 76 V94 Z", fill: fold },
];

export const STICKERS: Sticker[] = [
  { id: "arrow", tint: "#1971c2", shapes: [{ d: "M8 40 H58 V22 L94 50 L58 78 V60 H8 Z", fill: "tint" }] },
  {
    id: "arrow-curved",
    tint: "#1971c2",
    shapes: [
      { d: "M14 80 C18 42 48 22 78 29.5", stroke: "tint", width: 9 },
      { d: "M91.6 33.1 L79.5 16.4 L72.8 41.6 Z", fill: "tint" },
    ],
  },
  { id: "check", tint: "#2f9e44", shapes: [{ d: "M16 52 L40 76 L86 24", stroke: "tint", width: 13 }] },
  { id: "cross", tint: "#e03131", shapes: [{ d: "M24 24 L76 76 M76 24 L24 76", stroke: "tint", width: 13 }] },
  {
    id: "star",
    shapes: [{ d: "M50 9 L61.2 38.6 L92.8 40.1 L68.1 59.9 L76.5 90.4 L50 73 L23.5 90.4 L31.9 59.9 L7.2 40.1 L38.8 38.6 Z", fill: "#fcc419", stroke: "#f08c00", width: 3 }],
  },
  {
    id: "heart",
    tint: "#e03131",
    shapes: [{ d: "M50 88 C18 66 6 46 8 32 C10 16 24 8 36 10 C44 11 49 17 50 22 C51 17 56 11 64 10 C76 8 90 16 92 32 C94 46 82 66 50 88 Z", fill: "tint" }],
  },
  {
    id: "warning",
    shapes: [
      { d: "M50 10 L94 88 H6 Z", fill: "#fcc419", stroke: "#e67700", width: 4 },
      { d: "M46 36 H54 L52.5 66 H47.5 Z", fill: "#212529" },
      { d: circle(50, 76, 5), fill: "#212529" },
    ],
  },
  {
    id: "info",
    shapes: [
      { d: circle(50, 50, 44), fill: "#1971c2" },
      { d: circle(50, 29, 6), fill: "#ffffff" },
      { d: "M44 42 H56 V77 H44 Z", fill: "#ffffff" },
    ],
  },
  {
    id: "question",
    shapes: [
      { d: circle(50, 50, 44), fill: "#7048e8" },
      { d: "M36 38 C36 21 64 21 64 38 C64 51 50 50 50 62", stroke: "#ffffff", width: 9 },
      { d: circle(50, 76, 5.5), fill: "#ffffff" },
    ],
  },
  {
    id: "idea",
    shapes: [
      { d: "M50 8 C28 8 16 26 20 44 C23 56 34 62 36 72 H64 C66 62 77 56 80 44 C84 26 72 8 50 8 Z", fill: "#ffe066", stroke: "#f08c00", width: 3 },
      { d: "M37 76 H63 V84 C63 91 37 91 37 84 Z", fill: "#868e96" },
    ],
  },
  {
    id: "pin",
    tint: "#e03131",
    shapes: [
      { d: "M48 56 H52 L50 95 Z", fill: "#495057" },
      { d: circle(50, 34, 24), fill: "tint" },
      { d: circle(43, 27, 6), fill: "#ffffff", opacity: 0.5 },
    ],
  },
  {
    id: "flag",
    tint: "#e03131",
    shapes: [
      { d: "M20 8 H26 V94 H20 Z", fill: "#495057" },
      { d: "M26 12 C46 4 60 22 86 14 V54 C60 62 46 44 26 52 Z", fill: "tint" },
    ],
  },
  {
    id: "smiley",
    shapes: [
      { d: circle(50, 50, 44), fill: "#ffd43b", stroke: "#f08c00", width: 3 },
      { d: circle(36, 40, 5.5), fill: "#212529" },
      { d: circle(64, 40, 5.5), fill: "#212529" },
      { d: "M30 60 C38 75 62 75 70 60", stroke: "#212529", width: 5 },
    ],
  },
  { id: "note-yellow", shapes: note("#fff3bf", "#ffe066") },
  { id: "note-pink", shapes: note("#ffdeeb", "#faa2c1") },
  { id: "note-blue", shapes: note("#d0ebff", "#74c0fc") },
  { id: "note-green", shapes: note("#d3f9d8", "#8ce99a") },
  {
    id: "tape",
    tint: "#f783ac",
    shapes: [{ d: "M4 34 L10 30 L6 26 L94 18 L90 23 L96 27 L98 62 L92 66 L97 70 L8 78 L12 73 L6 69 Z", fill: "tint", opacity: 0.6 }],
  },
];

const byId = new Map(STICKERS.map((s) => [s.id, s]));
export const builtinSticker = (id: string | undefined) => (id ? byId.get(id) : undefined);
// One-colour stickers take the colour of a selection.
export const stickerTintable = (id: string | undefined) => !!builtinSticker(id)?.tint;
// The paint of a shape: its own colour, or the item's (default the sticker's).
export function shapePaint(sticker: Sticker, value: string | undefined, color?: string) {
  if (value !== "tint") return value;
  return color || sticker.tint || "#212529";
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
// The shapes as SVG elements in the 100 × 100 box.
export function stickerSvgElements(sticker: Sticker, color?: string) {
  return sticker.shapes
    .map((s) => {
      const fill = shapePaint(sticker, s.fill, color);
      const stroke = shapePaint(sticker, s.stroke, color);
      return `<path d="${xml(s.d)}" fill="${fill ? xml(fill) : "none"}"${stroke ? ` stroke="${xml(stroke)}" stroke-width="${s.width || 1}" stroke-linecap="round" stroke-linejoin="round"` : ""}${s.opacity !== undefined ? ` opacity="${s.opacity}"` : ""}/>`;
    })
    .join("");
}
// A sticker as a file of its own (public/stickers/<id>.svg).
export const stickerSvg = (sticker: Sticker) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">${stickerSvgElements(sticker)}</svg>\n`;

// ---- Stamps: today's date or the time as ink (text in a frame) ----

// A frame and the text, in the given colour, the text's top left at `at`:
// ordinary ink items (searchable, editable as text, in every export).
export function stampItems(text: string, at: { x: number; y: number }, color = "#e03131", size = 16): InkItem[] {
  const width = Math.max(1, text.length) * size * 0.58 + size * 0.9;
  const height = size * 1.6;
  const x = at.x - size * 0.45,
    y = at.y - size * 0.3;
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const frame = [x, y, x + width, y, x + width, y + height, x, y + height, x, y].map(r2);
  const points: number[] = [];
  for (let i = 0; i < frame.length; i += 2) points.push(frame[i], frame[i + 1], 0.5);
  return [
    { id: inkId(), type: "pen", color, width: 1.4, points },
    { id: inkId(), type: "text", color, size, x: r2(at.x), y: r2(at.y), text, font: "mono" },
  ];
}
