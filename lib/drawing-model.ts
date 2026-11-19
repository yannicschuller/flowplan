// The drawing viewer's own model of a 2D CAD drawing (#384): what a DXF
// (lib/drawing-dxf.ts) and a DWG file (lib/drawing-dwg.ts) are read into,
// before lib/drawing-scene.ts turns it into what the canvas draws. Also the
// AutoCAD colour index, the drawing units ($INSUNITS), the DWG versions
// and the text codes of TEXT and MTEXT. Pure, no DOM.
import type { Pt } from "./drawing-geometry";

// The colour of an entity: an AutoCAD colour index (ACI) – 0 is BYBLOCK,
// 256 BYLAYER, 1–255 the palette – or a true colour (24-bit RGB).
export type ColorRef = { aci: number; rgb?: number };
export const BYBLOCK = 0;
export const BYLAYER = 256;

type Base = {
  layer: string;
  color: ColorRef;
  // Linetype name, "BYLAYER" (or empty) or "BYBLOCK".
  lineType?: string;
  lineTypeScale?: number;
};
export type Vertex = Pt & { bulge?: number };
export type TextAnchor = { h: 0 | 1 | 2; v: "baseline" | "bottom" | "middle" | "top" };
export type DrawingEntity = Base &
  (
    | { type: "line"; a: Pt; b: Pt }
    | { type: "polyline"; vertices: Vertex[]; closed: boolean }
    | { type: "circle"; c: Pt; r: number }
    // Radians, counter-clockwise from start to end.
    | { type: "arc"; c: Pt; r: number; start: number; end: number }
    // The major axis relative to the centre; parameters in radians.
    | { type: "ellipse"; c: Pt; major: Pt; ratio: number; start: number; end: number }
    | { type: "spline"; degree: number; controls: Pt[]; knots: number[]; weights?: number[]; fit: Pt[]; closed: boolean }
    // Height: the height of capital letters, in drawing units; rotation
    // in radians; lines already without formatting codes.
    | { type: "text"; at: Pt; height: number; rotation: number; lines: string[]; anchor: TextAnchor; lineSpacing?: number }
    | { type: "insert"; block: string; at: Pt; sx: number; sy: number; rotation: number; columns: number; rows: number; columnSpacing: number; rowSpacing: number }
    // Hatches and solids: closed rings (already as points); `solid` fills
    // them, a pattern hatch is shown as a light tint.
    | { type: "fill"; rings: Pt[][]; solid: boolean }
    | { type: "point"; at: Pt }
  );
export type DrawingLayer = { name: string; color: ColorRef; on: boolean; frozen: boolean; lineType?: string };
export type DrawingBlock = { base: Pt; entities: DrawingEntity[] };
export type Drawing = {
  // $INSUNITS (0: none).
  units: number;
  // $LTSCALE.
  lineTypeScale: number;
  layers: DrawingLayer[];
  // Dash lengths of each linetype (positive: dash, negative: gap, 0: dot).
  lineTypes: Record<string, number[]>;
  blocks: Record<string, DrawingBlock>;
  entities: DrawingEntity[];
  // Entities the viewer does not draw (3D solids, images, …), by type.
  skipped: Record<string, number>;
};
export const emptyDrawing = (): Drawing => ({ units: 0, lineTypeScale: 1, layers: [], lineTypes: {}, blocks: {}, entities: [], skipped: {} });

// ---- AutoCAD colour index ----

// The 256 colours of the AutoCAD colour index (the same table as
// dxf-parser's, MIT): six hex digits per colour, index 0 unused.
const ACI_HEX =
  "000000ff0000ffff0000ff0000ffff0000ffff00ffffffff808080c0c0c0ff0000ff7f7fcc0000cc6666990000994c4c" +
  "7f00007f3f3f4c00004c2626ff3f00ff9f7fcc3300cc7f66992600995f4c7f1f007f4f3f4c13004c2f26ff7f00ffbf7f" +
  "cc6600cc9966994c0099724c7f3f007f5f3f4c26004c3926ffbf00ffdf7fcc9900ccb26699720099854c7f5f007f6f3f" +
  "4c39004c4226ffff00ffff7fcccc00cccc6698980098984c7f7f007f7f3f4c4c004c4c26bfff00dfff7f99cc00b2cc66" +
  "72980085984c5f7f006f7f3f394c00424c267fff00bfff7f66cc0099cc664c980072984c3f7f005f7f3f264c00394c26" +
  "3fff009fff7f33cc007fcc662698005f984c1f7f004f7f3f134c002f4c2600ff007fff7f00cc0066cc660098004c984c" +
  "007f003f7f3f004c00264c2600ff3f7fff9f00cc3366cc7f0098264c985f007f1f3f7f4f004c13264c2f00ff7f7fffbf" +
  "00cc6666cc9900984c4c9872007f3f3f7f5f004c26264c3900ffbf7fffdf00cc9966ccb20098724c9885007f5f3f7f6f" +
  "004c39264c4200ffff7fffff00cccc66cccc0098984c9898007f7f3f7f7f004c4c264c4c00bfff7fdfff0099cc66b2cc" +
  "0072984c8598005f7f3f6f7f00394c26424c007fff7fbfff0066cc6699cc004c984c7298003f7f3f5f7f00264c26394c" +
  "003fff7f9fff0033cc667fcc0026984c5f98001f7f3f4f7f00134c262f4c0000ff7f7fff0000cc6666cc0000984c4c98" +
  "00007f3f3f7f00004c26264c3f00ff9f7fff3300cc7f66cc2600985f4c981f007f4f3f7f13004c2f264c7f00ffbf7fff" +
  "6600cc9966cc4c0098724c983f007f5f3f7f26004c39264cbf00ffdf7fff9900ccb266cc720098854c985f007f6f3f7f" +
  "39004c42264cff00ffff7fffcc00cccc66cc980098984c987f007f7f3f7f4c004c4c264cff00bfff7fdfcc0099cc66b2" +
  "980072984c857f005f7f3f6f4c00394c2642ff007fff7fbfcc0066cc669998004c984c727f003f7f3f5f4c00264c2639" +
  "ff003fff7f9fcc0033cc667f980026984c5f7f001f7f3f4f4c00134c262f3333335b5b5b848484adadadd6d6d6ffffff";
// The RGB value of an index 1–255 (other values: null).
export function aciColor(index: number): number | null {
  if (!Number.isInteger(index) || index < 1 || index > 255) return null;
  return parseInt(ACI_HEX.slice(index * 6, index * 6 + 6), 16);
}
// "Ink": colour 7, shown black on white paper and white on dark paper.
export const INK = -1;

// What colour an entity is drawn in: its own, its layer's (BYLAYER) or the
// colour of the block reference it is part of (BYBLOCK; at the top level
// colour 7). Index 7 becomes INK. A negative index (a layer that is off)
// counts as its absolute value.
export function resolveColor(color: ColorRef, layerColor: ColorRef, blockColor: number = INK): number {
  if (color.rgb !== undefined && color.aci !== BYLAYER && color.aci !== BYBLOCK) return color.rgb;
  const aci = Math.abs(color.aci);
  if (aci === BYBLOCK) return blockColor;
  if (aci === BYLAYER) {
    if (layerColor.rgb !== undefined) return layerColor.rgb;
    const index = Math.abs(layerColor.aci);
    return index === 7 || !aciColor(index) ? INK : (aciColor(index) as number);
  }
  return aci === 7 ? INK : (aciColor(aci) ?? INK);
}
export const hexColor = (rgb: number) => `#${(rgb & 0xffffff).toString(16).padStart(6, "0")}`;

// ---- Units ----

// $INSUNITS: the unit's symbol and its length in millimetres.
const UNITS: Record<number, [string, number]> = {
  1: ["in", 25.4],
  2: ["ft", 304.8],
  3: ["mi", 1609344],
  4: ["mm", 1],
  5: ["cm", 10],
  6: ["m", 1000],
  7: ["km", 1e6],
  8: ["µin", 25.4e-6],
  9: ["mil", 0.0254],
  10: ["yd", 914.4],
  11: ["Å", 1e-7],
  12: ["nm", 1e-6],
  13: ["µm", 0.001],
  14: ["dm", 100],
  15: ["dam", 10000],
  16: ["hm", 100000],
  17: ["Gm", 1e12],
  18: ["AU", 1.495978707e14],
  19: ["ly", 9.4607304725808e18],
  20: ["pc", 3.0856775814913673e19],
  21: ["ft (US)", 1200000 / 3937],
  22: ["in (US)", 100000 / 3937],
  23: ["yd (US)", 3600000 / 3937],
  24: ["mi (US)", 6336000000 / 3937],
};
// The unit of a drawing: its symbol and millimetres per drawing unit, or
// none (unitless, 0, or an unknown value) – then lengths are given as
// plain numbers in drawing units.
export function drawingUnit(insunits: number | null | undefined): { symbol: string; mm: number } | null {
  const unit = UNITS[Number(insunits)];
  return unit ? { symbol: unit[0], mm: unit[1] } : null;
}

// ---- DWG versions ----

// The release of a DWG file by its first six bytes ("AC1032").
const RELEASES: Record<string, string> = {
  "MC0.0": "R1.0",
  "AC1.2": "R1.2",
  "AC1.40": "R1.4",
  "AC1.50": "R2.0",
  "AC2.10": "R2.10",
  AC1001: "R2.5",
  AC1002: "R2.6",
  AC1003: "R9",
  AC1004: "R10",
  AC1006: "R10",
  AC1009: "R11/R12",
  AC1012: "R13",
  AC1014: "R14",
  AC1015: "2000",
  AC1018: "2004",
  AC1021: "2007",
  AC1024: "2010",
  AC1027: "2013",
  AC1032: "2018",
};
export function dwgVersion(head: Uint8Array): { code: string; release: string | null } | null {
  const text = String.fromCharCode(...head.subarray(0, 6));
  const code = /^(AC\d{4}|AC[12]\.\d{1,2}|MC0\.0)/.exec(text)?.[1];
  if (!code) return null;
  return { code, release: RELEASES[code] ?? null };
}
// The releases LibreDWG reads: R11/R12 up to 2018 (AutoCAD 2018 to today
// still write that format). Older and unknown newer ones are tried, but
// the viewer suggests exporting a DXF when they fail.
export const DWG_READABLE = new Set(["AC1009", "AC1012", "AC1014", "AC1015", "AC1018", "AC1021", "AC1024", "AC1027", "AC1032"]);

// ---- Text ----

// Control codes of TEXT: %%c ⌀, %%d °, %%p ±, %%% %, %%u/%%o underline and
// overline (dropped), %%nnn a character code; \U+XXXX and \M+nXXXX escapes.
export function plainText(text: string): string {
  return (text || "")
    .replace(/\\U\+([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\M\+\d[0-9a-fA-F]{4}/g, "")
    .replace(/%%(\d{3})/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/%%([cCdDpPuUoOkK%])/g, (_, code: string) => ({ c: "⌀", d: "°", p: "±", "%": "%" })[code.toLowerCase()] ?? "");
}
// MTEXT: paragraphs (\P) as lines, without the formatting codes (fonts,
// heights, colours, alignment, stacking a^b → a/b).
export function plainMText(text: string): string[] {
  let s = plainText(text || "");
  s = s
    .replace(/\\\\/g, "\u0000")
    .replace(/\\[Pp]/g, "\n")
    .replace(/\\[Xx]/g, "\n")
    .replace(/\\~/g, " ")
    .replace(/\\S([^;]*?)[#^/]([^;]*?);/g, "$1/$2")
    .replace(/\\[ACFfHQTWcpa][^;\\]*;/g, "")
    .replace(/\\[LlOoKkNn]/g, "")
    .replace(/\\\{/g, "\u0001")
    .replace(/\\\}/g, "\u0002")
    .replace(/[{}]/g, "")
    .replace(/\u0001/g, "{")
    .replace(/\u0002/g, "}")
    .replace(/\u0000/g, "\\");
  return s.split("\n").map((line) => line.replace(/\s+$/, ""));
}
// TEXT: horizontal (72: 0 left, 1 centre, 2 right, 3 aligned, 4 middle,
// 5 fit) and vertical alignment (73: 0 baseline, 1 bottom, 2 middle, 3 top).
export function textAnchor(h: number | undefined, v: number | undefined): TextAnchor {
  const hh = Number(h) || 0,
    vv = Number(v) || 0;
  if (hh === 4) return { h: 1, v: "middle" };
  const horizontal: 0 | 1 | 2 = hh === 1 ? 1 : hh === 2 ? 2 : 0;
  const vertical = vv === 1 ? "bottom" : vv === 2 ? "middle" : vv === 3 ? "top" : "baseline";
  return { h: horizontal, v: vertical };
}
// MTEXT's attachment point 1–9 (top left … bottom right).
export function mtextAnchor(point: number | undefined): TextAnchor {
  const p = Math.min(9, Math.max(1, Number(point) || 1)) - 1;
  return { h: (p % 3) as 0 | 1 | 2, v: p < 3 ? "top" : p < 6 ? "middle" : "bottom" };
}
// TEXT is placed by its first point unless it is aligned otherwise.
export const textUsesAlignmentPoint = (h: number | undefined, v: number | undefined) => (Number(h) || 0) !== 0 || (Number(v) || 0) !== 0;

// Entities in an object coordinate system with the extrusion (0, 0, −1)
// – mirrored, as CAD programs write them – have their x axis reversed.
export const mirroredOcs = (extrusion: { z?: number } | null | undefined) => !!extrusion && typeof extrusion.z === "number" && extrusion.z < -0.5;
