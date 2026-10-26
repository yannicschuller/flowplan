// Enough of an uploaded image to make its placeholder (lib/image-placeholders.ts):
// the size it is shown in and a small copy of at most 100 × 100 pixels.
// PNG, GIF (first frame), JPEG (lib/jpeg-decode.ts) and WebP
// (lib/webp-decode.ts) are read here without any native library; AVIF and
// HEIC give only their size. Everything is defensive – a broken or hostile
// file yields null, never an exception or an endless loop – and large
// images are reduced while they are read, so memory stays small.
import { inflateSync } from "node:zlib";
import { decodeJpeg } from "./jpeg-decode";
import { decodeWebp } from "./webp-decode";
import { Downsampler, finish, finishInSlices, MAX_DECODE_PIXELS, orient, type SmallImage, type Steps } from "./image-small";

export type DecodedImage = {
  /** The size the browser shows (EXIF orientation applied). */
  width: number;
  height: number;
  /** The reduced copy, or null when only the size could be read. */
  small: SmallImage | null;
};


// ---- sizes from the headers ----

const ascii = (data: Uint8Array, at: number, length: number) =>
  String.fromCharCode(...data.subarray(at, at + length));
const u16be = (d: Uint8Array, i: number) => (d[i] << 8) | d[i + 1];
const u32be = (d: Uint8Array, i: number) => ((d[i] << 24) | (d[i + 1] << 16) | (d[i + 2] << 8) | d[i + 3]) >>> 0;
const u16le = (d: Uint8Array, i: number) => d[i] | (d[i + 1] << 8);
const u24le = (d: Uint8Array, i: number) => d[i] | (d[i + 1] << 8) | (d[i + 2] << 16);
const u32le = (d: Uint8Array, i: number) => (d[i] | (d[i + 1] << 8) | (d[i + 2] << 16) | (d[i + 3] << 24)) >>> 0;

/** AVIF/HEIC: the size of the primary item ("ispe" in the item properties). */
function isoBmffSize(data: Uint8Array) {
  // A bounded scan of the boxes in meta/iprp/ipco for the first ispe.
  const find = (start: number, end: number, depth: number): { width: number; height: number } | null => {
    let at = start;
    while (at + 8 <= end && depth < 6) {
      let size = u32be(data, at);
      const type = ascii(data, at + 4, 4);
      let header = 8;
      if (size === 1 && at + 16 <= end) {
        size = u32be(data, at + 12) + u32be(data, at + 8) * 2 ** 32;
        header = 16;
      } else if (size === 0) size = end - at;
      if (size < header || at + size > end) return null;
      if (type === "ispe" && size >= 20) return { width: u32be(data, at + 12), height: u32be(data, at + 16) };
      // meta is a full box (4 bytes of version and flags).
      if (type === "meta" || type === "iprp" || type === "ipco") {
        const found = find(at + header + (type === "meta" ? 4 : 0), at + size, depth + 1);
        if (found) return found;
      }
      at += size;
    }
    return null;
  };
  return find(0, Math.min(data.length, 1 << 20), 0);
}

/** Type and size from the first bytes, without decoding anything. */
export function imageInfo(data: Uint8Array): { mime: string; width: number; height: number } | null {
  try {
    if (data.length < 12) return null;
    if (data[0] === 0x89 && ascii(data, 1, 3) === "PNG" && ascii(data, 12, 4) === "IHDR")
      return { mime: "image/png", width: u32be(data, 16), height: u32be(data, 20) };
    if (ascii(data, 0, 4) === "GIF8") return { mime: "image/gif", width: u16le(data, 6), height: u16le(data, 8) };
    if (ascii(data, 0, 4) === "RIFF" && ascii(data, 8, 4) === "WEBP") {
      const chunk = ascii(data, 12, 4);
      if (chunk === "VP8 " && data.length >= 30)
        return { mime: "image/webp", width: u16le(data, 26) & 0x3fff, height: u16le(data, 28) & 0x3fff };
      if (chunk === "VP8L" && data.length >= 25) {
        const bits = u32le(data, 21);
        return { mime: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
      if (chunk === "VP8X" && data.length >= 30)
        return { mime: "image/webp", width: u24le(data, 24) + 1, height: u24le(data, 27) + 1 };
      return null;
    }
    if (data[0] === 0xff && data[1] === 0xd8) {
      const jpeg = jpegInfo(data);
      return jpeg && { mime: "image/jpeg", width: jpeg.width, height: jpeg.height };
    }
    if (ascii(data, 4, 4) === "ftyp" && /avi[fs]|heic|heix|mif1/.test(ascii(data, 8, 4))) {
      const size = isoBmffSize(data);
      return size && { mime: /avi/.test(ascii(data, 8, 4)) ? "image/avif" : "image/heic", ...size };
    }
  } catch {
    return null;
  }
  return null;
}

/** JPEG: the frame size and the EXIF orientation, the shown size swapped
 *  for orientations that turn the picture. */
export function jpegInfo(data: Uint8Array) {
  let at = 2,
    orientation = 1;
  while (at + 4 <= data.length) {
    if (data[at] !== 0xff) return null;
    const marker = data[at + 1];
    if (marker === 0xff) {
      at++;
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      at += 2;
      continue;
    }
    const length = u16be(data, at + 2);
    if (length < 2) return null;
    if (marker === 0xe1 && ascii(data, at + 4, 6) === "Exif\0\0") orientation = exifOrientation(data, at + 10, at + 2 + length) || orientation;
    // Start of frame (baseline, extended, progressive, lossless …).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = u16be(data, at + 5),
        width = u16be(data, at + 7);
      const turned = orientation >= 5 && orientation <= 8;
      return { width: turned ? height : width, height: turned ? width : height, orientation };
    }
    if (marker === 0xda) return null;
    at += 2 + length;
  }
  return null;
}

function exifOrientation(data: Uint8Array, tiff: number, end: number) {
  if (tiff + 8 > end) return 0;
  const little = data[tiff] === 0x49;
  const u16 = (i: number) => (little ? u16le(data, i) : u16be(data, i));
  const u32 = (i: number) => (little ? u32le(data, i) : u32be(data, i));
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > end) return 0;
  const count = u16(ifd);
  for (let i = 0; i < count && ifd + 2 + i * 12 + 12 <= end; i++) {
    const entry = ifd + 2 + i * 12;
    if (u16(entry) === 0x0112) return u16(entry + 8);
  }
  return 0;
}

// ---- PNG ----

const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
] as const;

function* decodePng(data: Uint8Array): Steps<SmallImage | null> {
  let at = 8,
    width = 0,
    height = 0,
    depth = 0,
    type = 0,
    interlace = 0;
  let palette: Uint8Array | null = null,
    transparency: Uint8Array | null = null;
  const parts: Uint8Array[] = [];
  while (at + 8 <= data.length) {
    const length = u32be(data, at),
      kind = ascii(data, at + 4, 4),
      body = data.subarray(at + 8, at + 8 + length);
    if (body.length < length) break;
    if (kind === "IHDR") {
      width = u32be(body, 0);
      height = u32be(body, 4);
      depth = body[8];
      type = body[9];
      interlace = body[12];
    } else if (kind === "PLTE") palette = body;
    else if (kind === "tRNS") transparency = body;
    else if (kind === "IDAT") parts.push(body);
    else if (kind === "IEND") break;
    at += 12 + length;
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  if (!channels || ![1, 2, 4, 8, 16].includes(depth) || !width || !height || width * height > MAX_DECODE_PIXELS) return null;
  if (type === 3 && !palette) return null;
  const raw = inflateSync(Buffer.concat(parts), { maxOutputLength: 512 * 1024 * 1024 });
  const bitsPerPixel = channels * depth,
    bpp = Math.max(1, bitsPerPixel >> 3);
  const out = new Downsampler(width, height);
  const max = (1 << depth) - 1;
  // The colour key of grey and RGB images (tRNS).
  const key =
    transparency && type === 0 && transparency.length >= 2
      ? [u16be(transparency, 0)]
      : transparency && type === 2 && transparency.length >= 6
        ? [u16be(transparency, 0), u16be(transparency, 2), u16be(transparency, 4)]
        : null;
  const sample = (line: Uint8Array, i: number) => {
    if (depth === 16) return u16be(line, i * 2);
    if (depth === 8) return line[i];
    const bit = i * depth;
    return (line[bit >> 3] >> (8 - depth - (bit & 7))) & max;
  };
  const to8 = (v: number) => (depth === 16 ? v >> 8 : depth === 8 ? v : Math.round((v * 255) / max));
  let offset = 0;
  const pass = function* (x0: number, y0: number, dx: number, dy: number): Steps<boolean> {
    const pw = Math.ceil((width - x0) / dx),
      ph = Math.ceil((height - y0) / dy);
    if (pw <= 0 || ph <= 0) return true;
    const stride = Math.ceil((pw * bitsPerPixel) / 8);
    let previous = new Uint8Array(stride),
      line = new Uint8Array(stride);
    const rgba = new Uint8Array(pw * 4);
    for (let y = 0; y < ph; y++) {
      if ((y & 63) === 63) yield;
      if (offset + 1 + stride > raw.length) return false;
      const filter = raw[offset];
      line.set(raw.subarray(offset + 1, offset + 1 + stride));
      offset += 1 + stride;
      for (let i = 0; i < stride; i++) {
        const left = i >= bpp ? line[i - bpp] : 0,
          up = previous[i],
          corner = i >= bpp ? previous[i - bpp] : 0;
        let add = 0;
        if (filter === 1) add = left;
        else if (filter === 2) add = up;
        else if (filter === 3) add = (left + up) >> 1;
        else if (filter === 4) {
          const p = left + up - corner,
            pa = Math.abs(p - left),
            pb = Math.abs(p - up),
            pc = Math.abs(p - corner);
          add = pa <= pb && pa <= pc ? left : pb <= pc ? up : corner;
        } else if (filter !== 0) return false;
        line[i] = (line[i] + add) & 255;
      }
      for (let x = 0, j = 0; x < pw; x++, j += 4) {
        let r: number, g: number, b: number, a = 255;
        if (type === 3) {
          const index = sample(line, x);
          r = palette![index * 3] ?? 0;
          g = palette![index * 3 + 1] ?? 0;
          b = palette![index * 3 + 2] ?? 0;
          if (transparency && index < transparency.length) a = transparency[index];
        } else if (type === 0 || type === 4) {
          const v = sample(line, x * (type === 4 ? 2 : 1));
          r = g = b = to8(v);
          if (type === 4) a = to8(sample(line, x * 2 + 1));
          else if (key && v === key[0]) a = 0;
        } else {
          const c = type === 6 ? 4 : 3;
          const vr = sample(line, x * c),
            vg = sample(line, x * c + 1),
            vb = sample(line, x * c + 2);
          r = to8(vr);
          g = to8(vg);
          b = to8(vb);
          if (type === 6) a = to8(sample(line, x * 4 + 3));
          else if (key && vr === key[0] && vg === key[1] && vb === key[2]) a = 0;
        }
        rgba[j] = r;
        rgba[j + 1] = g;
        rgba[j + 2] = b;
        rgba[j + 3] = a;
      }
      if (dx === 1 && dy === 1) out.row(y, rgba);
      else
        for (let x = 0; x < pw; x++)
          out.pixel(x0 + x * dx, y0 + y * dy, rgba[x * 4], rgba[x * 4 + 1], rgba[x * 4 + 2], rgba[x * 4 + 3]);
      [previous, line] = [line, previous];
    }
    return true;
  };
  if (interlace) {
    for (const [x0, y0, dx, dy] of ADAM7) if (!(yield* pass(x0, y0, dx, dy))) break;
  } else yield* pass(0, 0, 1, 1);
  return out.result();
}

// ---- GIF (the first frame) ----

function decodeGif(data: Uint8Array): SmallImage | null {
  const width = u16le(data, 6),
    height = u16le(data, 8),
    flags = data[10];
  if (!width || !height || width * height > MAX_DECODE_PIXELS) return null;
  let at = 13;
  let global: Uint8Array | null = null;
  if (flags & 0x80) {
    const size = 3 << ((flags & 7) + 1);
    global = data.subarray(at, at + size);
    at += size;
  }
  let transparent = -1;
  while (at < data.length) {
    const block = data[at++];
    if (block === 0x21) {
      const label = data[at++];
      if (label === 0xf9 && data[at] >= 4 && data[at + 1] & 1) transparent = data[at + 4];
      // Skip the sub-blocks of the extension.
      while (at < data.length && data[at]) at += data[at] + 1;
      at++;
    } else if (block === 0x2c) {
      const left = u16le(data, at),
        top = u16le(data, at + 2),
        fw = u16le(data, at + 4),
        fh = u16le(data, at + 6),
        local = data[at + 8];
      at += 9;
      let colors = global;
      if (local & 0x80) {
        const size = 3 << ((local & 7) + 1);
        colors = data.subarray(at, at + size);
        at += size;
      }
      if (!colors || !fw || !fh) return null;
      const minCode = data[at++];
      if (minCode < 2 || minCode > 11) return null;
      // The image data of the frame, from its sub-blocks.
      const chunks: Uint8Array[] = [];
      while (at < data.length && data[at]) {
        chunks.push(data.subarray(at + 1, at + 1 + data[at]));
        at += data[at] + 1;
      }
      const indices = lzw(Buffer.concat(chunks), minCode, fw * fh);
      const out = new Downsampler(width, height);
      // Rows of interlaced frames come in four passes.
      const rowOrder: number[] = [];
      if (local & 0x40) for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) for (let y = start; y < fh; y += step) rowOrder.push(y);
      else for (let y = 0; y < fh; y++) rowOrder.push(y);
      // Outside the frame the canvas is transparent.
      for (let i = 0; i < fh; i++) {
        const y = rowOrder[i];
        for (let x = 0; x < fw; x++) {
          const index = indices[i * fw + x];
          if (index === transparent || index * 3 + 2 >= colors.length) out.pixel(left + x, top + y, 0, 0, 0, 0);
          else out.pixel(left + x, top + y, colors[index * 3], colors[index * 3 + 1], colors[index * 3 + 2], 255);
        }
      }
      return out.result();
    } else return null;
  }
  return null;
}

function lzw(data: Uint8Array, minCode: number, count: number) {
  const out = new Uint8Array(count);
  const clear = 1 << minCode,
    end = clear + 1;
  const prefix = new Int16Array(4096),
    suffix = new Uint8Array(4096);
  for (let i = 0; i < clear; i++) {
    prefix[i] = -1;
    suffix[i] = i;
  }
  let size = minCode + 1,
    next = end + 1,
    previous = -1,
    bits = 0,
    buffer = 0,
    written = 0;
  const stack = new Uint8Array(4096);
  for (let i = 0; i < data.length && written < count; ) {
    while (bits < size && i < data.length) {
      buffer |= data[i++] << bits;
      bits += 8;
    }
    if (bits < size) break;
    const code = buffer & ((1 << size) - 1);
    buffer >>>= size;
    bits -= size;
    if (code === clear) {
      size = minCode + 1;
      next = end + 1;
      previous = -1;
      continue;
    }
    if (code === end) break;
    let current = code;
      if (code >= next) {
      if (previous < 0 || code > next) break;
      current = previous;
    }
    // Unwind the code into the stack (reverse order).
    let depth = 0;
    while (current >= 0 && depth < 4096) {
      stack[depth++] = suffix[current];
      current = current >= clear ? prefix[current] : -1;
    }
    const first = stack[depth - 1];
    for (let k = depth - 1; k >= 0 && written < count; k--) out[written++] = stack[k];
    if (code >= next && written < count) out[written++] = first;
    if (previous >= 0 && next < 4096) {
      prefix[next] = previous;
      suffix[next] = first;
      next++;
      if (next === 1 << size && size < 12) size++;
    }
    previous = code;
  }
  return out;
}

/** Size and small copy of an image, in steps; null when it is not one we
 *  can read. */
export function* decodeImageSteps(data: Uint8Array): Steps<DecodedImage | null> {
  const info = imageInfo(data);
  if (!info || !info.width || !info.height || info.width > 65535 || info.height > 65535) return null;
  let small: SmallImage | null = null;
  try {
    if (info.width * info.height <= MAX_DECODE_PIXELS) {
      if (info.mime === "image/png") small = yield* decodePng(data);
      else if (info.mime === "image/gif") small = decodeGif(data);
      else if (info.mime === "image/webp") small = yield* decodeWebp(data);
      else if (info.mime === "image/jpeg") {
        const decoded = yield* decodeJpeg(data);
        if (decoded) small = orient(decoded, jpegInfo(data)?.orientation || 1);
      }
    }
  } catch {
    small = null;
  }
  return { width: info.width, height: info.height, small: small?.width ? small : null };
}

export const decodeImage = (data: Uint8Array) => finish(decodeImageSteps(data));
/** The same in slices, so the server keeps answering meanwhile. */
export const decodeImageInSlices = (data: Uint8Array, sliceMs?: number) => finishInSlices(decodeImageSteps(data), sliceMs);
