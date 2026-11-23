// "Draw your own cover" (design review): a drawing on the cover's
// proportions becomes a PNG that is uploaded like any cover image
// (POST /api/upload, purpose "cover" – same limits and rights). The ink
// travels inside the PNG as an iTXt chunk (keyword "flowplan-ink"), so the
// drawing can be opened and changed again later; the upload keeps such
// chunks (lib/upload-safety.ts drops only eXIf). Pure functions: no DOM.
import type { InkDoc, InkItem } from "./ink/model";
import { parseInk } from "./ink/model";
import { inkSvgElements } from "./ink/svg";

// Page units of the canvas, drawn at twice the size into the PNG. 3 : 1
// lies between the cover's shape on a phone (about 2 : 1) and on a wide
// page (about 6 : 1); the cover shows it cropped like any picture, with
// the dialog's "Bildausschnitt".
export const COVER_DRAWING = { width: 1200, height: 400, scale: 2 } as const;
export const COVER_DRAWING_PAGE = "cover";
export const COVER_DRAWING_NAME = "cover-drawing.png";
export const COVER_DRAWING_BACKGROUND = "#ffffff";
const KEYWORD = "flowplan-ink";

/** Whether an image of the page is a drawn cover (by its file name). */
export const isCoverDrawing = (name: string | undefined) => !!name && /^cover-drawing.*\.png$/i.test(name);

/** The whole canvas as an SVG document of `scale` pixels per unit. */
export function coverSvg(items: InkItem[], { background = COVER_DRAWING_BACKGROUND, scale: s = COVER_DRAWING.scale } = {}) {
  const { width, height } = COVER_DRAWING;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width * s}" height="${height * s}">` +
    `<rect x="0" y="0" width="${width}" height="${height}" fill="${/^#[0-9a-f]{6}$/i.test(background) ? background : COVER_DRAWING_BACKGROUND}"/>` +
    inkSvgElements(items) +
    `</svg>`
  );
}

// CRC-32 of PNG chunks (ISO 3309).
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
export function crc32(bytes: Uint8Array) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const isPng = (png: Uint8Array) => png.length > 8 && SIGNATURE.every((b, i) => png[i] === b);
const view = (png: Uint8Array) => new DataView(png.buffer, png.byteOffset, png.byteLength);

/** The PNG with the ink as an iTXt chunk before IEND (one such chunk: an
 *  older one is replaced). Not a PNG: returned unchanged. */
export function pngWithInk(png: Uint8Array, ink: InkDoc): Uint8Array {
  if (!isPng(png)) return png;
  const text = new TextEncoder().encode(JSON.stringify(ink));
  const keyword = new TextEncoder().encode(KEYWORD);
  // keyword \0, compression flag and method 0, empty language and
  // translated keyword (each \0-terminated), then the UTF-8 text.
  const data = new Uint8Array(keyword.length + 5 + text.length);
  data.set(keyword, 0);
  data.set(text, keyword.length + 5);
  const type = new TextEncoder().encode("iTXt");
  const chunk = new Uint8Array(12 + data.length);
  const out = view(chunk);
  out.setUint32(0, data.length);
  chunk.set(type, 4);
  chunk.set(data, 8);
  const crcInput = new Uint8Array(4 + data.length);
  crcInput.set(type, 0);
  crcInput.set(data, 4);
  out.setUint32(8 + data.length, crc32(crcInput));
  const parts: Uint8Array[] = [png.subarray(0, 8)];
  const dv = view(png);
  for (let pos = 8; pos + 12 <= png.length; ) {
    const length = dv.getUint32(pos);
    const kind = String.fromCharCode(...png.subarray(pos + 4, pos + 8));
    const end = pos + 12 + length;
    if (kind === "IEND") parts.push(chunk);
    if (!(kind === "iTXt" && inkKeywordAt(png, pos + 8, length))) parts.push(png.subarray(pos, end));
    if (kind === "IEND") break;
    pos = end;
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const result = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    result.set(part, at);
    at += part.length;
  }
  return result;
}

function inkKeywordAt(png: Uint8Array, start: number, length: number) {
  const keyword = new TextEncoder().encode(KEYWORD);
  return length > keyword.length && png[start + keyword.length] === 0 && keyword.every((b, i) => png[start + i] === b);
}

/** The ink kept in a drawn cover's PNG, or null. Checks the chunk's CRC
 *  and reads it through parseInk (anything unexpected is dropped). */
export function inkFromPng(png: Uint8Array): InkDoc | null {
  if (!isPng(png)) return null;
  const dv = view(png);
  for (let pos = 8; pos + 12 <= png.length; ) {
    const length = dv.getUint32(pos);
    const kind = String.fromCharCode(...png.subarray(pos + 4, pos + 8));
    const end = pos + 12 + length;
    if (end > png.length) return null;
    if (kind === "iTXt" && inkKeywordAt(png, pos + 8, length)) {
      if (crc32(png.subarray(pos + 4, pos + 8 + length)) !== dv.getUint32(pos + 8 + length)) return null;
      const data = png.subarray(pos + 8, pos + 8 + length);
      // keyword \0 flag method language \0 translated \0 text
      let at = KEYWORD.length + 1;
      if (data[at] !== 0) return null; // compressed: not written by us
      at += 2;
      at = data.indexOf(0, at) + 1;
      at = data.indexOf(0, at) + 1;
      if (at <= 0) return null;
      try {
        return parseInk(new TextDecoder().decode(data.subarray(at)));
      } catch {
        return null;
      }
    }
    if (kind === "IEND") break;
    pos = end;
  }
  return null;
}
