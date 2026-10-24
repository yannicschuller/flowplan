// Coordinate transforms of the ink layer.
//
//   page units  – where ink is stored (PDF points, top left, y down)
//   CSS pixels  – the page as laid out (zoom included)
//   device px   – a canvas drawn at the device pixel ratio
//   PDF user space – the PDF's own system (bottom left, y up, page rotation
//                    and crop box applied), used when ink is written into
//                    the PDF (lib/ink/pdf-export.ts)

export type PageSize = { width: number; height: number };
export type Rect = { left: number; top: number; width: number; height: number };

// CSS pixels per page unit for a page laid out `cssWidth` wide.
export const pageScale = (page: PageSize, cssWidth: number) => (page.width > 0 ? cssWidth / page.width : 1);

// A pointer position on the screen → page units on the page drawn in `rect`.
export function clientToPage(clientX: number, clientY: number, rect: Rect, page: PageSize) {
  return {
    x: ((clientX - rect.left) * page.width) / (rect.width || 1),
    y: ((clientY - rect.top) * page.height) / (rect.height || 1),
  };
}
export function pageToClient(x: number, y: number, rect: Rect, page: PageSize) {
  return { x: rect.left + (x * rect.width) / (page.width || 1), y: rect.top + (y * rect.height) / (page.height || 1) };
}

// The size of a canvas showing the page `cssWidth` wide: device pixels, at
// most `maxRatio` per CSS pixel (as the PDF pages are drawn).
export function canvasSize(page: PageSize, cssWidth: number, dpr: number, maxRatio = 2) {
  const ratio = Math.min(dpr || 1, maxRatio);
  const scale = pageScale(page, cssWidth) * ratio;
  return { width: Math.floor(page.width * scale), height: Math.floor(page.height * scale), scale, ratio };
}
// Page units ↔ device pixels of such a canvas (zoom and pixel ratio).
export function pageToDevice(x: number, y: number, page: PageSize, cssWidth: number, dpr: number, maxRatio = 2) {
  const { scale } = canvasSize(page, cssWidth, dpr, maxRatio);
  return { x: x * scale, y: y * scale };
}
export function deviceToPage(x: number, y: number, page: PageSize, cssWidth: number, dpr: number, maxRatio = 2) {
  const { scale } = canvasSize(page, cssWidth, dpr, maxRatio);
  return { x: x / scale, y: y / scale };
}

// ---- PDF user space ----

export type Matrix = [number, number, number, number, number, number];
export type PdfBox = { x: number; y: number; width: number; height: number };
export const normalRotation = (angle: number) => ((((Math.round(angle / 90) * 90) % 360) + 360) % 360) as 0 | 90 | 180 | 270;

// The page as shown (pdf.js at scale 1: rotated, crop box) → PDF user space,
// as a PDF matrix [a b c d e f]: ux = a·x + c·y + e, uy = b·x + d·y + f.
export function viewToPdfMatrix(rotation: number, box: PdfBox): Matrix {
  const { x, y, width: w, height: h } = box;
  switch (normalRotation(rotation)) {
    case 90:
      return [0, 1, 1, 0, x, y];
    case 180:
      return [-1, 0, 0, 1, x + w, y];
    case 270:
      return [0, -1, -1, 0, x + w, y + h];
    default:
      return [1, 0, 0, -1, x, y + h];
  }
}
export const applyMatrix = (m: Matrix, x: number, y: number) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });
// The size of the page as shown: width and height swap at 90° and 270°.
export function viewSize(rotation: number, box: PdfBox): PageSize {
  const turned = normalRotation(rotation) % 180 !== 0;
  return turned ? { width: box.height, height: box.width } : { width: box.width, height: box.height };
}
