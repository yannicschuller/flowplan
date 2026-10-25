// A notebook as PDF: one page per sheet – the imported PDF page (copied with
// its vectors and text) or the paper drawn as vectors – with the ink on top
// as vectors (lib/ink/pdf-export.ts). Runs in the browser ("Export as PDF")
// and on the server (Markdown export), with pdf-lib.
import {
  LineCapStyle,
  PDFDocument,
  closePath,
  concatTransformationMatrix,
  fill,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  setFillingColor,
  setLineCap,
  setLineWidth,
  setStrokingColor,
  stroke,
  type PDFOperator,
} from "pdf-lib";
import type { Matrix, PageSize } from "./coords";
import type { InkDoc, InkItem } from "./model";
import { effectivePaper, paperLayout, paperSize, type Paper, type PaperLayout, type PaperOverride } from "../notebook-paper";
import { drawInk, inkPdfContext, shownPageMatrix } from "./pdf-export";
import { DARK_INK } from "./svg";

export type NotebookPdfSheet = {
  size: PageSize;
  // Paper drawn under the ink (null: none, e.g. a PDF background).
  paper: PaperLayout | null;
  dark?: boolean;
  // Page `page` (from 1) of the PDF `file` as background.
  background?: { file: string; page: number } | null;
  items: InkItem[];
};

// The pages of a notebook as stored (lib/notebook.ts NotebookSheetData).
export function notebookPdfSheets(
  defaults: Paper,
  sheets: { id: string; paper: PaperOverride; background: { file: string; page: number; width: number; height: number } | null; ink: InkDoc }[],
): NotebookPdfSheet[] {
  return sheets.map((sheet) => {
    const paper = effectivePaper(defaults, sheet.paper);
    const size = sheet.background ? { width: sheet.background.width, height: sheet.background.height } : paperSize(paper);
    return {
      size,
      paper: sheet.background ? { ...paperLayout({ ...paper, template: "blank", color: "light" }, size) } : paperLayout(paper, size),
      dark: !sheet.background && paper.color === "dark",
      background: sheet.background ? { file: sheet.background.file, page: sheet.background.page } : null,
      items: sheet.ink.pages[sheet.id] || [],
    };
  });
}

const n = (v: number) => Math.round(v * 100) / 100;
const hex = (value: string) =>
  /^#[0-9a-f]{6}$/i.test(value)
    ? rgb(parseInt(value.slice(1, 3), 16) / 255, parseInt(value.slice(3, 5), 16) / 255, parseInt(value.slice(5, 7), 16) / 255)
    : rgb(1, 1, 1);

function paperOps(layout: PaperLayout, matrix: Matrix): PDFOperator[] {
  const ops: PDFOperator[] = [pushGraphicsState(), concatTransformationMatrix(...matrix)];
  if (layout.background !== "transparent")
    ops.push(
      setFillingColor(hex(layout.background)),
      moveTo(0, 0),
      lineTo(n(layout.width), 0),
      lineTo(n(layout.width), n(layout.height)),
      lineTo(0, n(layout.height)),
      closePath(),
      fill(),
    );
  for (const shape of layout.shapes) {
    if (shape.type === "line")
      ops.push(setStrokingColor(hex(shape.color)), setLineWidth(shape.width), moveTo(shape.x1, shape.y1), lineTo(shape.x2, shape.y2), stroke());
    // A dot: a line of no length with round ends.
    else
      ops.push(
        setStrokingColor(hex(shape.color)),
        setLineWidth(n(shape.r * 2)),
        setLineCap(LineCapStyle.Round),
        moveTo(shape.x, shape.y),
        lineTo(n(shape.x + 0.01), shape.y),
        stroke(),
      );
  }
  ops.push(popGraphicsState());
  return ops;
}

// `load` gives the bytes of a background PDF (null when it is gone).
export async function notebookPdf(
  sheets: NotebookPdfSheet[],
  load: (file: string) => Promise<Uint8Array | ArrayBuffer | null>,
  { title = "" }: { title?: string } = {},
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  if (title) pdf.setTitle(title);
  pdf.setCreator("Flowplan");
  const context = inkPdfContext(pdf);
  const sources = new Map<string, Promise<PDFDocument | null>>();
  const source = (file: string) => {
    if (!sources.has(file))
      sources.set(
        file,
        load(file)
          .then((bytes) => (bytes ? PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true }) : null))
          .catch(() => null),
      );
    return sources.get(file)!;
  };
  for (const sheet of sheets) {
    const doc = sheet.background ? await source(sheet.background.file) : null;
    let copied = null;
    if (doc && sheet.background && sheet.background.page <= doc.getPageCount()) {
      try {
        [copied] = await pdf.copyPages(doc, [sheet.background.page - 1]);
      } catch {
        copied = null;
      }
    }
    if (copied) {
      const page = pdf.addPage(copied);
      await drawInk(context, page, sheet.items, shownPageMatrix(page));
      continue;
    }
    // Paper (or a background that is gone: an empty page of its size).
    const page = pdf.addPage([n(sheet.size.width), n(sheet.size.height)]);
    const matrix: Matrix = [1, 0, 0, -1, 0, n(sheet.size.height)];
    if (sheet.paper) page.pushOperators(...paperOps(sheet.paper, matrix));
    await drawInk(context, page, sheet.items, matrix, sheet.dark ? DARK_INK : undefined);
  }
  return pdf.save();
}
