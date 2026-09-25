import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";

// Text recognition for scanned PDFs and images (German and English). The
// language data ships with the app and is never downloaded at runtime.
const LANGS = ["deu", "eng"] as const;
type Worker = Awaited<ReturnType<typeof import("tesseract.js").createWorker>>;
const runtime = globalThis as typeof globalThis & {
  flowplanOcr?: Promise<Worker>;
};
function languageDir() {
  const dir = resolve(process.env.FLOWPLAN_DATA_DIR || "./data", "ocr");
  mkdirSync(dir, { recursive: true });
  // Bundlers rewrite require.resolve, so the packages are found through the
  // app's node_modules (the same layout in development and standalone).
  for (const lang of LANGS) {
    const target = join(dir, `${lang}.traineddata.gz`);
    if (existsSync(target)) continue;
    copyFileSync(
      join(
        process.cwd(),
        "node_modules",
        "@tesseract.js-data",
        lang,
        "4.0.0",
        `${lang}.traineddata.gz`,
      ),
      target,
    );
  }
  return dir;
}
async function worker() {
  runtime.flowplanOcr ??= (async () => {
    const { createWorker } = await import("tesseract.js");
    const dir = languageDir();
    return createWorker([...LANGS], 1, {
      langPath: dir,
      cachePath: dir,
      gzip: true,
      logger: () => undefined,
      errorHandler: () => undefined,
    });
  })();
  try {
    return await runtime.flowplanOcr;
  } catch (error) {
    runtime.flowplanOcr = undefined;
    throw error;
  }
}
export async function ocrImage(image: Buffer) {
  const { data } = await (await worker()).recognize(image);
  return data.text
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
export async function stopOcr() {
  const current = runtime.flowplanOcr;
  runtime.flowplanOcr = undefined;
  if (current) await (await current).terminate();
}

// Minimal PNG encoder for decoded PDF images (grey, RGB or RGBA pixels).
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(data: Buffer) {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}
export function encodePng(
  width: number,
  height: number,
  pixels: Uint8Array | Uint8ClampedArray,
) {
  const channels = pixels.length / (width * height);
  if (![1, 3, 4].includes(channels)) throw new Error("Unbekanntes Bildformat.");
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++)
    Buffer.from(pixels.buffer, pixels.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1,
    );
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
