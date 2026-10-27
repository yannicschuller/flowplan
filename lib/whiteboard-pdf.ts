// PDF export of a whiteboard: the whole board on one page, or one page per
// frame in presentation order. The browser draws each page (the board's own
// rendering, components/whiteboard/board-export.ts) and pdf-lib – the
// library the app already uses for PDFs – puts the pictures into pages of
// the same proportions. Nothing runs on the server.
import { contentBounds } from "./whiteboard-geometry";
import { presentationSlides } from "./whiteboard-frames";
import type { WhiteboardItem } from "./whiteboard-model";

export type Box = { x: number; y: number; w: number; h: number };
export type ExportPage = { box: Box; title: string };
export const EXPORT_PAD = 40;
// A frame with its title strip above it.
export const frameBox = (frame: Box): Box => ({ x: frame.x - 12, y: frame.y - 36, w: frame.w + 24, h: frame.h + 48 });

// The boxes to draw: "board" – everything (one page), "frames" – one page
// per frame of the presentation (hidden frames left out).
export function exportPages(items: WhiteboardItem[], mode: "board" | "frames", title = ""): ExportPage[] {
  if (mode === "frames")
    return presentationSlides(items).map((frame) => ({ box: frameBox(frame), title: frame.text || "" }));
  const shown = items.filter((i) => i.type !== "comment");
  const box = contentBounds(shown, new Map(items.map((i) => [i.id, i])));
  return box
    ? [{ box: { x: box.x - EXPORT_PAD, y: box.y - EXPORT_PAD, w: box.w + EXPORT_PAD * 2, h: box.h + EXPORT_PAD * 2 }, title }]
    : [];
}

// PDF pages may be at most 14 400 pt on a side; pixels are 0.75 pt.
const MAX_POINTS = 14400;
export function pageSize(width: number, height: number) {
  let w = Math.max(1, width) * 0.75,
    h = Math.max(1, height) * 0.75;
  const scale = Math.min(1, MAX_POINTS / Math.max(w, h));
  w *= scale;
  h *= scale;
  // Tiny selections still give a readable page.
  const grow = Math.max(1, 144 / Math.min(w, h));
  return { width: Math.min(MAX_POINTS, w * grow), height: Math.min(MAX_POINTS, h * grow) };
}

export type PdfPicture = { png: Uint8Array; width: number; height: number; title?: string };
export async function boardPdf(pictures: PdfPicture[], title: string) {
  // Loaded on first use: the board itself does not need it.
  const { PDFDocument } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  pdf.setTitle(title || "Whiteboard");
  pdf.setCreator("Flowplan");
  pdf.setProducer("Flowplan");
  for (const picture of pictures) {
    const image = await pdf.embedPng(picture.png);
    const size = pageSize(picture.width, picture.height);
    const page = pdf.addPage([size.width, size.height]);
    page.drawImage(image, { x: 0, y: 0, width: size.width, height: size.height });
  }
  return pdf.save();
}
