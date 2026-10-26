// Reducing images while they are decoded (lib/image-decode.ts and the
// JPEG and WebP decoders): pixels go into at most 100 × 100 boxes, so a
// large photo never needs a full-size buffer.

/** Pixels beyond this are not decoded (only the size is kept). */
export const MAX_DECODE_PIXELS = 50_000_000;
export const SMALL_EDGE = 100;

export type SmallImage = { width: number; height: number; rgba: Uint8Array };

/** Decoding in steps: the decoders pause (yield) now and then, so a large
 *  picture can be decoded without holding up the server for long. */
export type Steps<T> = Generator<void, T, void>;

/** Runs the steps at once (tests, small files). */
export function finish<T>(steps: Steps<T>): T {
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

/** Runs the steps in slices of `sliceMs`, letting other work in between. */
export async function finishInSlices<T>(steps: Steps<T>, sliceMs = 8): Promise<T> {
  let start = performance.now();
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
    if (performance.now() - start > sliceMs) {
      await new Promise((resolve) => setImmediate(resolve));
      start = performance.now();
    }
  }
}

// ---- reducing while reading ----

/** Collects pixels of a source image into at most `edge` × `edge` boxes
 *  (averages, weighted by opacity so transparent pixels add no colour). */
export class Downsampler {
  readonly w: number;
  readonly h: number;
  private sums: Float64Array;
  private xMap: Uint16Array;
  private yMap: Uint16Array;
  constructor(
    readonly srcW: number,
    readonly srcH: number,
    edge = SMALL_EDGE,
  ) {
    const scale = Math.min(1, edge / Math.max(srcW, srcH));
    this.w = Math.max(1, Math.round(srcW * scale));
    this.h = Math.max(1, Math.round(srcH * scale));
    this.sums = new Float64Array(this.w * this.h * 5);
    this.xMap = new Uint16Array(srcW);
    this.yMap = new Uint16Array(srcH);
    for (let x = 0; x < srcW; x++) this.xMap[x] = Math.min(this.w - 1, Math.floor((x * this.w) / srcW));
    for (let y = 0; y < srcH; y++) this.yMap[y] = Math.min(this.h - 1, Math.floor((y * this.h) / srcH));
  }
  pixel(x: number, y: number, r: number, g: number, b: number, a: number) {
    if (x < 0 || y < 0 || x >= this.srcW || y >= this.srcH) return;
    const i = (this.yMap[y] * this.w + this.xMap[x]) * 5,
      s = this.sums;
    s[i] += r * a;
    s[i + 1] += g * a;
    s[i + 2] += b * a;
    s[i + 3] += a;
    s[i + 4] += 1;
  }
  /** A row of RGBA pixels (width srcW). */
  row(y: number, rgba: Uint8Array) {
    if (y < 0 || y >= this.srcH) return;
    const base = this.yMap[y] * this.w,
      s = this.sums,
      xMap = this.xMap;
    for (let x = 0, j = 0; x < this.srcW; x++, j += 4) {
      const a = rgba[j + 3],
        i = (base + xMap[x]) * 5;
      s[i] += rgba[j] * a;
      s[i + 1] += rgba[j + 1] * a;
      s[i + 2] += rgba[j + 2] * a;
      s[i + 3] += a;
      s[i + 4] += 1;
    }
  }
  result(): SmallImage {
    const rgba = new Uint8Array(this.w * this.h * 4),
      s = this.sums;
    for (let i = 0, j = 0; j < rgba.length; i += 5, j += 4) {
      const alpha = s[i + 3];
      if (alpha > 0) {
        rgba[j] = Math.round(s[i] / alpha);
        rgba[j + 1] = Math.round(s[i + 1] / alpha);
        rgba[j + 2] = Math.round(s[i + 2] / alpha);
      }
      rgba[j + 3] = s[i + 4] ? Math.round(alpha / s[i + 4]) : 0;
    }
    return { width: this.w, height: this.h, rgba };
  }
}

/** Applies an EXIF orientation (2–8) to a small image. */
export function orient(image: SmallImage, orientation: number): SmallImage {
  if (orientation < 2 || orientation > 8) return image;
  const { width: w, height: h, rgba } = image;
  const swap = orientation >= 5;
  const ow = swap ? h : w,
    oh = swap ? w : h;
  const out = new Uint8Array(rgba.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let nx = x,
        ny = y;
      switch (orientation) {
        case 2: nx = w - 1 - x; break;
        case 3: nx = w - 1 - x; ny = h - 1 - y; break;
        case 4: ny = h - 1 - y; break;
        case 5: nx = y; ny = x; break;
        case 6: nx = h - 1 - y; ny = x; break;
        case 7: nx = h - 1 - y; ny = w - 1 - x; break;
        case 8: nx = y; ny = w - 1 - x; break;
      }
      out.set(rgba.subarray((y * w + x) * 4, (y * w + x) * 4 + 4), (ny * ow + nx) * 4);
    }
  return { width: ow, height: oh, rgba: out };
}
