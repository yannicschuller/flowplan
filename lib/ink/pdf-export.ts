// Writes ink into a copy of a PDF as vector graphics on top of each page
// ("Download with annotations"). The original bytes are not changed; the
// result is a new PDF with the same pages. Pen strokes with pressure become
// filled outlines, other strokes lines with round ends, the highlighter a
// translucent multiply layer under the ink, text in the nearest standard
// PDF font of its face (lib/ink/fonts.ts: Helvetica, Times, Courier).
import {
  LineCapStyle,
  LineJoinStyle,
  PDFDocument,
  PDFName,
  StandardFonts,
  beginText,
  clip,
  closePath,
  concatTransformationMatrix,
  drawObject,
  drawSvgPath,
  endPath,
  endText,
  fill,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  rgb,
  setFillingColor,
  setFontAndSize,
  setGraphicsState,
  setLineCap,
  setLineJoin,
  setLineWidth,
  setStrokingColor,
  setTextMatrix,
  showText,
  stroke,
  type PDFFont,
  type PDFImage,
  type PDFOperator,
  type PDFPage,
  type PDFRef,
} from "pdf-lib";
import { viewToPdfMatrix, type Matrix } from "./coords";
import { lineWidth, strokeOutline, strokePoints, variesInWidth } from "./geometry";
import type { InkDoc, InkImage, InkItem, InkStroke, InkText } from "./model";
import { fullBox, imageCentre } from "./image";
import { builtinSticker, shapePaint } from "./stickers";
import { splitHighlights } from "./svg";
import { HIGHLIGHTER_OPACITY } from "./presets";
import { inkPdfFont, type InkPdfFont } from "./fonts";

const color = (hex: string) => rgb(parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255);
const n = (v: number) => Math.round(v * 100) / 100;

type ColorMap = Record<string, string>;
const mapped = (hex: string, map?: ColorMap) => color(map?.[hex] || hex);

function strokeOps(item: InkStroke, map?: ColorMap): PDFOperator[] {
  const points = strokePoints(item);
  if (!points.length) return [];
  if (variesInWidth(item)) {
    const poly = strokeOutline(points, item.width);
    return [setFillingColor(mapped(item.color, map)), moveTo(n(poly[0][0]), n(poly[0][1])), ...poly.slice(1).map(([x, y]) => lineTo(n(x), n(y))), closePath(), fill()];
  }
  const path = points.length === 1 ? [points[0], { ...points[0], x: points[0].x + 0.01 }] : points;
  return [
    setStrokingColor(mapped(item.color, map)),
    setLineWidth(n(lineWidth(item))),
    setLineCap(LineCapStyle.Round),
    setLineJoin(LineJoinStyle.Round),
    moveTo(n(path[0].x), n(path[0].y)),
    ...path.slice(1).map((p) => lineTo(n(p.x), n(p.y))),
    stroke(),
  ];
}

// Characters the standard fonts (WinAnsi) cannot show become "?".
function encodable(font: PDFFont, text: string) {
  let out = "";
  for (const ch of text) {
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      out += "?";
    }
  }
  return out;
}
function textOps(item: InkText, font: PDFFont, fontName: PDFName, map?: ColorMap): PDFOperator[] {
  const ops: PDFOperator[] = [setFillingColor(mapped(item.color, map))];
  item.text.split("\n").forEach((line, i) => {
    if (!line) return;
    // The page system has y downwards: the text matrix turns the glyphs upright.
    // Turned text (rotation, clockwise on the page) turns around its top left.
    const a = ((item.rotation || 0) * Math.PI) / 180;
    const cos = Math.cos(a),
      sin = Math.sin(a);
    const down = item.size * 0.8 + i * item.size * 1.25;
    const x = item.x - down * sin,
      y = item.y + down * cos;
    ops.push(beginText(), setFontAndSize(fontName, item.size), setTextMatrix(cos, sin, sin, -cos, n(x), n(y)), showText(font.encodeText(encodable(font, line))), endText());
  });
  return ops;
}

export class InkExportError extends Error {}

// The bytes of a picture's file as PNG or JPEG (other types are converted
// by the caller, e.g. through a canvas in the browser); `orientation` is the
// EXIF orientation of a JPEG still to apply (1: none). null: not available.
export type InkImageBytes = { bytes: Uint8Array | ArrayBuffer; type: "png" | "jpg"; orientation?: number };
export type InkImageLoader = (file: string) => Promise<InkImageBytes | null>;
// Resources shared by the pages of one PDF (fonts, highlighter state,
// pictures – each file embedded once).
export type InkPdfContext = {
  pdf: PDFDocument;
  fonts: Partial<Record<InkPdfFont, PDFFont>>;
  highlighter: PDFRef | null;
  loadImage?: InkImageLoader;
  images: Map<string, Promise<{ image: PDFImage; orientation: number } | null>>;
  alphas: Map<number, PDFRef>;
};
export const inkPdfContext = (pdf: PDFDocument, { loadImage }: { loadImage?: InkImageLoader } = {}): InkPdfContext => ({
  pdf,
  fonts: {},
  highlighter: null,
  loadImage,
  images: new Map(),
  alphas: new Map(),
});

// (o11, o12, o13, o21, o22, o23): where a point (a, b) of the stored JPEG
// (0–1, b down) is shown, per EXIF orientation.
const ORIENT: Record<number, number[]> = {
  1: [1, 0, 0, 0, 1, 0],
  2: [-1, 0, 1, 0, 1, 0],
  3: [-1, 0, 1, 0, -1, 1],
  4: [1, 0, 0, 0, -1, 1],
  5: [0, 1, 0, 1, 0, 0],
  6: [0, -1, 1, 1, 0, 0],
  7: [0, -1, 1, -1, 0, 1],
  8: [0, 1, 0, -1, 0, 1],
};
// The matrix that puts an image XObject (unit square, y up) into the box
// (page units, y down), turned by the EXIF orientation.
export function imageMatrix(box: { x: number; y: number; w: number; h: number }, orientation = 1): Matrix {
  const [o11, o12, o13, o21, o22, o23] = ORIENT[orientation] || ORIENT[1];
  const m = [box.w * o11, box.h * o21, -box.w * o12, -box.h * o22, box.x + box.w * (o12 + o13), box.y + box.h * (o22 + o23)];
  return m.map((v) => n(v) || 0) as Matrix;
}
// Turning around the centre (degrees clockwise, page units y down).
function rotation(item: InkImage): Matrix | null {
  if (!item.rotation) return null;
  const a = (item.rotation * Math.PI) / 180,
    c = Math.cos(a),
    s = Math.sin(a);
  const { x: cx, y: cy } = imageCentre(item);
  return [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy];
}
function alphaState(context: InkPdfContext, page: PDFPage, opacity: number) {
  const key = Math.round(opacity * 100);
  let ref = context.alphas.get(key);
  if (!ref) {
    ref = context.pdf.context.register(context.pdf.context.obj({ Type: "ExtGState", CA: key / 100, ca: key / 100 }));
    context.alphas.set(key, ref);
  }
  return page.node.newExtGState(`FlowplanInkAlpha${key}`, ref);
}
async function embedded(context: InkPdfContext, file: string) {
  if (!context.loadImage) return null;
  if (!context.images.has(file))
    context.images.set(
      file,
      context
        .loadImage(file)
        .then(async (loaded) => {
          if (!loaded) return null;
          const image = loaded.type === "png" ? await context.pdf.embedPng(loaded.bytes) : await context.pdf.embedJpg(loaded.bytes);
          return { image, orientation: loaded.orientation || 1 };
        })
        .catch(() => null),
    );
  return context.images.get(file)!;
}
async function imageOps(context: InkPdfContext, page: PDFPage, item: InkImage): Promise<PDFOperator[]> {
  const ops: PDFOperator[] = [pushGraphicsState()];
  const turn = rotation(item);
  if (turn) ops.push(concatTransformationMatrix(...turn));
  if (item.opacity !== undefined && item.opacity < 1) ops.push(setGraphicsState(alphaState(context, page, item.opacity)));
  const sticker = builtinSticker(item.sticker);
  if (sticker) {
    ops.push(concatTransformationMatrix(n(item.w / 100), 0, 0, n(-item.h / 100), n(item.x), n(item.y)), setLineJoin(LineJoinStyle.Round));
    for (const shape of sticker.shapes) {
      const fill = shapePaint(sticker, shape.fill, item.color);
      const line = shapePaint(sticker, shape.stroke, item.color);
      ops.push(
        ...drawSvgPath(shape.d, {
          x: 0,
          y: 0,
          scale: 1,
          color: fill ? color(fill) : undefined,
          borderColor: line ? color(line) : undefined,
          borderWidth: line ? shape.width || 1 : 0,
          borderLineCap: LineCapStyle.Round,
          graphicsState: shape.opacity !== undefined ? alphaState(context, page, shape.opacity) : undefined,
        }),
      );
    }
  } else {
    const found = item.file ? await embedded(context, item.file) : null;
    // The shown part only.
    ops.push(rectangle(n(item.x), n(item.y), n(item.w), n(item.h)), clip(), endPath());
    if (found) {
      const name = page.node.newXObject("FlowplanInkImage", found.image.ref);
      ops.push(concatTransformationMatrix(...imageMatrix(fullBox(item), found.orientation)), drawObject(name));
    } else
      ops.push(
        setFillingColor(rgb(0.91, 0.93, 0.94)),
        rectangle(n(item.x), n(item.y), n(item.w), n(item.h)),
        fill(),
      );
  }
  ops.push(popGraphicsState());
  return ops;
}
const STANDARD: Record<InkPdfFont, StandardFonts> = { Helvetica: StandardFonts.Helvetica, "Times-Roman": StandardFonts.TimesRoman, Courier: StandardFonts.Courier };
const FONT_KEYS: Record<InkPdfFont, string> = { Helvetica: "FlowplanInkFont", "Times-Roman": "FlowplanInkSerif", Courier: "FlowplanInkMono" };

// Draws ink onto a page; `matrix` takes page units (top left, y down) to
// the page's PDF user space. `colors` swaps ink colours (dark paper).
export async function drawInk(context: InkPdfContext, page: PDFPage, items: InkItem[], matrix: Matrix, colors?: ColorMap) {
  if (!items.length) return;
  const ops: PDFOperator[] = [pushGraphicsState(), concatTransformationMatrix(...matrix)];
  // Highlighter under the ink – those above a picture in order, multiplied over it.
  const under = splitHighlights(items);
  const highlights = items.filter((i, index): i is InkStroke => i.type === "highlighter" && index < under);
  let highlightName: PDFName | null = null;
  const highlightState = () => {
    context.highlighter ??= context.pdf.context.register(
      context.pdf.context.obj({ Type: "ExtGState", CA: HIGHLIGHTER_OPACITY, ca: HIGHLIGHTER_OPACITY, BM: "Multiply" }),
    );
    return (highlightName ??= page.node.newExtGState("FlowplanInkHighlight", context.highlighter));
  };
  if (highlights.length) ops.push(pushGraphicsState(), setGraphicsState(highlightState()), ...highlights.flatMap((h) => strokeOps(h, colors)), popGraphicsState());
  const fontNames: Partial<Record<InkPdfFont, PDFName>> = {};
  for (const [index, item] of items.entries()) {
    if (item.type === "highlighter" && index >= under) ops.push(pushGraphicsState(), setGraphicsState(highlightState()), ...strokeOps(item, colors), popGraphicsState());
    else if (item.type === "image") ops.push(...(await imageOps(context, page, item)));
    else if (item.type === "pen") ops.push(...strokeOps(item, colors));
    else if (item.type === "text") {
      const face = inkPdfFont(item.font);
      const font = (context.fonts[face] ??= await context.pdf.embedFont(STANDARD[face]));
      const fontName = (fontNames[face] ??= page.node.newFontDictionary(FONT_KEYS[face], font.ref));
      ops.push(...textOps(item, font, fontName, colors));
    }
  }
  ops.push(popGraphicsState());
  page.pushOperators(...ops);
}

// The matrix of a page as shown (rotation, crop box): what pdf.js shows at
// scale 1 is where the ink was drawn.
export const shownPageMatrix = (page: PDFPage) => viewToPdfMatrix(page.getRotation().angle, page.getCropBox());

// The PDF with the ink of `doc` (page keys "1", "2", … = page numbers).
export async function flattenInk(original: Uint8Array | ArrayBuffer, doc: InkDoc): Promise<Uint8Array> {
  let pdf: PDFDocument;
  try {
    pdf = await PDFDocument.load(original, { updateMetadata: false });
  } catch (error) {
    // Encrypted (password-protected) PDFs cannot be written again.
    throw new InkExportError(/encrypt/i.test(String((error as Error)?.message)) ? "encrypted" : "unreadable");
  }
  const pages = pdf.getPages();
  const context = inkPdfContext(pdf);
  for (const [key, items] of Object.entries(doc.pages)) {
    const index = Number(key) - 1;
    const page = pages[index];
    if (!page || !Number.isInteger(index) || !items.length) continue;
    await drawInk(context, page, items, shownPageMatrix(page));
  }
  return pdf.save();
}
