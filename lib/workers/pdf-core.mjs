// pdf.js work for the file texts (lib/file-text.ts): the text layer of a
// PDF and, for scans, the page images as PNG for the OCR. Plain JavaScript
// that Node.js runs as it is, in a worker thread (pdf-worker.mjs, started
// by lib/pdf-text.ts) – parsing a long PDF, decoding its images and
// compressing PNGs held the server's event loop for seconds – or, should
// no worker start, in the server itself.
import { deflateSync } from "node:zlib";

export const MAX_PDF_TEXT = 100000;
const MAX_PAGES = 200;
const options = { disableFontFace: true, useSystemFonts: false, stopAtErrors: false, enableXfa: false, verbosity: 0 };
const loadPdfjs = () => import("pdfjs-dist/legacy/build/pdf.mjs");

// The visible text layer (no OCR), capped for the index.
export async function pdfText(data) {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ data: new Uint8Array(data), ...options });
  try {
    const doc = await task.promise;
    const parts = [];
    let length = 0;
    for (let n = 1; n <= Math.min(doc.numPages, MAX_PAGES); n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : " ") : ""))
        .join("")
        .replace(/[ \t]+/g, " ")
        .trim();
      page.cleanup();
      if (text) {
        parts.push(text);
        length += text.length;
      }
      if (length >= MAX_PDF_TEXT) break;
    }
    return parts.join("\n").slice(0, MAX_PDF_TEXT);
  } finally {
    await task.destroy();
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
// An 8-bit PNG of grey, RGB or RGBA pixels (decoded PDF images for the OCR).
export function encodePng(width, height, pixels) {
  const channels = pixels.length / (width * height);
  if (![1, 3, 4].includes(channels)) throw new Error("Unbekanntes Bildformat.");
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(pixels.buffer, pixels.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = channels === 1 ? 0 : channels === 3 ? 2 : 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Images of pages without a text layer (scans), as PNG.
export async function pdfScanImages(data, maxPages = 20) {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ data: new Uint8Array(data), ...options, isOffscreenCanvasSupported: false });
  const images = [];
  try {
    const doc = await task.promise;
    for (let n = 1; n <= Math.min(doc.numPages, maxPages); n++) {
      const page = await doc.getPage(n);
      const text = await page.getTextContent();
      if (text.items.some((item) => "str" in item && item.str.trim())) continue;
      const ops = await page.getOperatorList();
      for (let i = 0; i < ops.fnArray.length; i++) {
        if (ops.fnArray[i] !== pdfjs.OPS.paintImageXObject) continue;
        const id = ops.argsArray[i][0];
        const image = await new Promise((done) => {
          try {
            page.objs.get(id, done);
          } catch {
            done(null);
          }
        });
        if (!image?.data || image.width < 50 || image.height < 20) continue;
        let pixels = image.data;
        // 1 bit per pixel greyscale, rows padded to whole bytes.
        if (image.kind === 1) {
          const grey = new Uint8Array(image.width * image.height);
          const row = Math.ceil(image.width / 8);
          for (let y = 0; y < image.height; y++)
            for (let x = 0; x < image.width; x++) grey[y * image.width + x] = image.data[y * row + (x >> 3)] & (128 >> (x & 7)) ? 255 : 0;
          pixels = grey;
        }
        try {
          images.push(encodePng(image.width, image.height, pixels));
        } catch {}
      }
      page.cleanup();
    }
    return images;
  } finally {
    await task.destroy();
  }
}
