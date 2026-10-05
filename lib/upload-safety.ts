// Checks for everything that is uploaded (members, guests, forms): sizes the
// server can rely on, file names without path or control characters, a
// type that matches the content, and photos without their location.
import { HttpError } from "./auth";

// Uploads must say how large they are; a body without Content-Length
// (chunked) would be read into memory before any limit applies.
export function requireBodySize(req: Request, max: number, message: string) {
  const header = req.headers.get("content-length");
  if (!header || !/^\d+$/.test(header))
    throw new HttpError(411, "Die Größe der Anfrage fehlt.");
  if (Number(header) > max) throw new HttpError(413, message);
}

export function sanitizeFileName(name: string, fallback = "datei") {
  const clean = name
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f/\\]/g, "")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 200);
  return clean || fallback;
}

const signatures: [RegExp, (b: Buffer) => boolean][] = [
  [/^image\/png$/, (b) => b.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))],
  [/^image\/jpeg$/, (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  [/^image\/gif$/, (b) => b.subarray(0, 4).toString("latin1") === "GIF8"],
  [/^image\/webp$/, (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP"],
  [/^image\/avif$/, (b) => b.subarray(4, 8).toString("latin1") === "ftyp" && /avi[fs]/.test(b.subarray(8, 12).toString("latin1"))],
  [/^application\/pdf$/, (b) => b.subarray(0, 5).toString("latin1") === "%PDF-"],
  [/^video\/mp4$|^audio\/mp4$/, (b) => b.subarray(4, 8).toString("latin1") === "ftyp"],
  [/^video\/webm$|^audio\/webm$/, (b) => b.subarray(0, 4).equals(Buffer.from("1a45dfa3", "hex"))],
  [/^audio\/mpeg$/, (b) => b.subarray(0, 3).toString("latin1") === "ID3" || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)],
  [/^audio\/ogg$/, (b) => b.subarray(0, 4).toString("latin1") === "OggS"],
  [/^audio\/wav$/, (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WAVE"],
];
// The type to store: the claimed one when the content matches it (for the
// types shown in the browser), otherwise a plain download.
export function verifiedMime(claimed: string, data: Buffer) {
  const type = (claimed || "").toLowerCase().slice(0, 200);
  const check = signatures.find(([pattern]) => pattern.test(type));
  if (check) return check[1](data) ? type : "application/octet-stream";
  // Anything a browser could run or render as a page is never kept as such.
  if (/html|svg|xml|javascript|ecmascript/.test(type) || !type) return "application/octet-stream";
  return type;
}

/* ---------- Location in photos ---------- */

// Removes the GPS position from JPEG (EXIF GPS data and XMP) and PNG
// (eXIf chunk), without re-encoding: orientation and colours stay.
export function stripLocation(data: Buffer, mime: string): Buffer {
  try {
    if (mime === "image/jpeg") return stripJpeg(data);
    if (mime === "image/png") return stripPng(data);
  } catch {
    // An unusual file stays as it is rather than failing the upload.
  }
  return data;
}

function stripJpeg(input: Buffer): Buffer {
  if (input[0] !== 0xff || input[1] !== 0xd8) return input;
  const data = Buffer.from(input);
  const keep: Buffer[] = [data.subarray(0, 2)];
  let pos = 2;
  while (pos + 4 <= data.length && data[pos] === 0xff) {
    const marker = data[pos + 1];
    // Start of scan: the image data follows, copy the rest unchanged.
    if (marker === 0xda) break;
    const length = data.readUInt16BE(pos + 2);
    const segment = data.subarray(pos, pos + 2 + length);
    if (marker === 0xe1) {
      const header = segment.subarray(4, 33).toString("latin1");
      // XMP can repeat the position: dropped as a whole.
      if (header.startsWith("http://ns.adobe.com/xap/1.0/")) {
        pos += 2 + length;
        continue;
      }
      if (header.startsWith("Exif\0\0")) clearGps(segment, 10);
    }
    keep.push(segment);
    pos += 2 + length;
  }
  keep.push(data.subarray(pos));
  return Buffer.concat(keep);
}
// Zeroes the GPS directory of an EXIF block (TIFF header at `tiff`).
function clearGps(segment: Buffer, tiff: number) {
  const little = segment.subarray(tiff, tiff + 2).toString("latin1") === "II";
  const u16 = (at: number) => (little ? segment.readUInt16LE(at) : segment.readUInt16BE(at));
  const u32 = (at: number) => (little ? segment.readUInt32LE(at) : segment.readUInt32BE(at));
  const ifd0 = tiff + u32(tiff + 4);
  const entries = u16(ifd0);
  for (let i = 0; i < entries; i++) {
    const entry = ifd0 + 2 + i * 12;
    if (u16(entry) !== 0x8825) continue;
    const gps = tiff + u32(entry + 8);
    if (gps + 2 > segment.length) return;
    const count = u16(gps);
    const sizes: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
    for (let k = 0; k < count; k++) {
      const field = gps + 2 + k * 12;
      if (field + 12 > segment.length) break;
      const bytes = (sizes[u16(field + 2)] || 1) * u32(field + 4);
      // Values longer than four bytes live elsewhere: zero them too.
      if (bytes > 4) {
        const at = tiff + u32(field + 8);
        if (at + bytes <= segment.length) segment.fill(0, at, at + bytes);
      }
      segment.fill(0, field, field + 12);
    }
    segment.fill(0, gps, gps + 2);
  }
}
function stripPng(data: Buffer): Buffer {
  if (!data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return data;
  const keep: Buffer[] = [data.subarray(0, 8)];
  let pos = 8;
  while (pos + 12 <= data.length) {
    const length = data.readUInt32BE(pos);
    const type = data.subarray(pos + 4, pos + 8).toString("latin1");
    const chunk = data.subarray(pos, pos + 12 + length);
    if (type !== "eXIf") keep.push(chunk);
    pos += 12 + length;
    if (type === "IEND") break;
  }
  return Buffer.concat(keep);
}
