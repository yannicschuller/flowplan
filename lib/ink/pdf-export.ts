// Writes ink into a copy of a PDF as vector graphics on top of each page
// ("Download with annotations"). The original bytes are not changed; the
// result is a new PDF with the same pages. Pen strokes with pressure become
// filled outlines, other strokes lines with round ends, the highlighter a
// translucent multiply layer under the ink, text Helvetica.
import {
  LineCapStyle,
  LineJoinStyle,
  PDFDocument,
  PDFName,
  StandardFonts,
  beginText,
  closePath,
  concatTransformationMatrix,
  endText,
  fill,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
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
  type PDFOperator,
} from "pdf-lib";
import { viewToPdfMatrix } from "./coords";
import { lineWidth, strokeOutline, strokePoints, variesInWidth } from "./geometry";
import type { InkDoc, InkItem, InkStroke, InkText } from "./model";
import { HIGHLIGHTER_OPACITY } from "./presets";

const color = (hex: string) => rgb(parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255);
const n = (v: number) => Math.round(v * 100) / 100;

function strokeOps(item: InkStroke): PDFOperator[] {
  const points = strokePoints(item);
  if (!points.length) return [];
  if (variesInWidth(item)) {
    const poly = strokeOutline(points, item.width);
    return [setFillingColor(color(item.color)), moveTo(n(poly[0][0]), n(poly[0][1])), ...poly.slice(1).map(([x, y]) => lineTo(n(x), n(y))), closePath(), fill()];
  }
  const path = points.length === 1 ? [points[0], { ...points[0], x: points[0].x + 0.01 }] : points;
  return [
    setStrokingColor(color(item.color)),
    setLineWidth(n(lineWidth(item))),
    setLineCap(LineCapStyle.Round),
    setLineJoin(LineJoinStyle.Round),
    moveTo(n(path[0].x), n(path[0].y)),
    ...path.slice(1).map((p) => lineTo(n(p.x), n(p.y))),
    stroke(),
  ];
}

// Characters Helvetica (WinAnsi) cannot show become "?".
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
function textOps(item: InkText, font: PDFFont, fontName: PDFName): PDFOperator[] {
  const ops: PDFOperator[] = [setFillingColor(color(item.color))];
  item.text.split("\n").forEach((line, i) => {
    if (!line) return;
    // The page system has y downwards: the text matrix turns the glyphs upright.
    const baseline = item.y + item.size * 0.8 + i * item.size * 1.25;
    ops.push(beginText(), setFontAndSize(fontName, item.size), setTextMatrix(1, 0, 0, -1, n(item.x), n(baseline)), showText(font.encodeText(encodable(font, line))), endText());
  });
  return ops;
}

export class InkExportError extends Error {}

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
  let font: PDFFont | null = null;
  let highlighterState: ReturnType<typeof pdf.context.register> | null = null;
  for (const [key, items] of Object.entries(doc.pages)) {
    const index = Number(key) - 1;
    const page = pages[index];
    if (!page || !Number.isInteger(index) || !items.length) continue;
    const box = page.getCropBox();
    const rotation = page.getRotation().angle;
    const ops: PDFOperator[] = [pushGraphicsState(), concatTransformationMatrix(...viewToPdfMatrix(rotation, box))];
    const highlights = items.filter((i): i is InkStroke => i.type === "highlighter");
    if (highlights.length) {
      highlighterState ??= pdf.context.register(
        pdf.context.obj({ Type: "ExtGState", CA: HIGHLIGHTER_OPACITY, ca: HIGHLIGHTER_OPACITY, BM: "Multiply" }),
      );
      const name = page.node.newExtGState("FlowplanInkHighlight", highlighterState);
      ops.push(pushGraphicsState(), setGraphicsState(name), ...highlights.flatMap(strokeOps), popGraphicsState());
    }
    let fontName: PDFName | null = null;
    for (const item of items as InkItem[]) {
      if (item.type === "pen") ops.push(...strokeOps(item));
      else if (item.type === "text") {
        font ??= await pdf.embedFont(StandardFonts.Helvetica);
        fontName ??= page.node.newFontDictionary("FlowplanInkFont", font.ref);
        ops.push(...textOps(item, font, fontName));
      }
    }
    ops.push(popGraphicsState());
    page.pushOperators(...ops);
  }
  return pdf.save();
}
