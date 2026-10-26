// ThumbHash (Evan Wallace's format, https://evanw.github.io/thumbhash/): a
// picture in about 25 bytes – the average colour, a few cosine terms of
// brightness, colour and transparency, and the aspect ratio. The server
// computes it once per uploaded image (lib/image-placeholders.ts); the
// browser turns it back into a tiny blurred picture shown while the image
// loads (components/file-image.tsx). Pure, no DOM: runs on both sides.

const { PI, round, max, min, cos, abs } = Math;

/** Hash of an image of at most 100 × 100 pixels (RGBA, not premultiplied). */
export function rgbaToThumbHash(w: number, h: number, rgba: ArrayLike<number>): Uint8Array {
  if (w > 100 || h > 100 || w < 1 || h < 1) throw new Error(`${w}x${h} does not fit in 100x100`);
  // The average colour, weighted by opacity.
  let avgR = 0,
    avgG = 0,
    avgB = 0,
    avgA = 0;
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    const alpha = rgba[j + 3] / 255;
    avgR += (alpha / 255) * rgba[j];
    avgG += (alpha / 255) * rgba[j + 1];
    avgB += (alpha / 255) * rgba[j + 2];
    avgA += alpha;
  }
  if (avgA) {
    avgR /= avgA;
    avgG /= avgA;
    avgB /= avgA;
  }
  const hasAlpha = avgA < w * h;
  // Fewer brightness terms when transparency needs room.
  const lLimit = hasAlpha ? 5 : 7;
  const lx = max(1, round((lLimit * w) / max(w, h)));
  const ly = max(1, round((lLimit * h) / max(w, h)));
  const l: number[] = [],
    p: number[] = [],
    q: number[] = [],
    a: number[] = [];
  // RGBA to brightness, yellow–blue, red–green and opacity, composited
  // onto the average colour.
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    const alpha = rgba[j + 3] / 255;
    const r = avgR * (1 - alpha) + (alpha / 255) * rgba[j];
    const g = avgG * (1 - alpha) + (alpha / 255) * rgba[j + 1];
    const b = avgB * (1 - alpha) + (alpha / 255) * rgba[j + 2];
    l[i] = (r + g + b) / 3;
    p[i] = (r + g) / 2 - b;
    q[i] = r - g;
    a[i] = alpha;
  }
  // A cosine transform: the constant term and the normalised others.
  const encodeChannel = (channel: number[], nx: number, ny: number): [number, number[], number] => {
    let dc = 0,
      scale = 0;
    const ac: number[] = [],
      fx: number[] = [];
    for (let cy = 0; cy < ny; cy++) {
      for (let cx = 0; cx * ny < nx * (ny - cy); cx++) {
        let f = 0;
        for (let x = 0; x < w; x++) fx[x] = cos((PI / w) * cx * (x + 0.5));
        for (let y = 0; y < h; y++) {
          const fy = cos((PI / h) * cy * (y + 0.5));
          for (let x = 0; x < w; x++) f += channel[x + y * w] * fx[x] * fy;
        }
        f /= w * h;
        if (cx || cy) {
          ac.push(f);
          scale = max(scale, abs(f));
        } else dc = f;
      }
    }
    if (scale) for (let i = 0; i < ac.length; i++) ac[i] = 0.5 + (0.5 / scale) * ac[i];
    return [dc, ac, scale];
  };
  const [lDc, lAc, lScale] = encodeChannel(l, max(3, lx), max(3, ly));
  const [pDc, pAc, pScale] = encodeChannel(p, 3, 3);
  const [qDc, qAc, qScale] = encodeChannel(q, 3, 3);
  const [aDc, aAc, aScale] = hasAlpha ? encodeChannel(a, 5, 5) : [0, [], 0];
  const isLandscape = w > h;
  const header24 =
    round(63 * lDc) |
    (round(31.5 + 31.5 * pDc) << 6) |
    (round(31.5 + 31.5 * qDc) << 12) |
    (round(31 * lScale) << 18) |
    ((hasAlpha ? 1 : 0) << 23);
  const header16 =
    (isLandscape ? ly : lx) | (round(63 * pScale) << 3) | (round(63 * qScale) << 9) | ((isLandscape ? 1 : 0) << 15);
  const hash = [header24 & 255, (header24 >> 8) & 255, header24 >> 16, header16 & 255, header16 >> 8];
  const acStart = hasAlpha ? 6 : 5;
  let acIndex = 0;
  if (hasAlpha) hash.push(round(15 * aDc) | (round(15 * aScale) << 4));
  for (const ac of hasAlpha ? [lAc, pAc, qAc, aAc] : [lAc, pAc, qAc])
    for (const f of ac) {
      const at = acStart + (acIndex >> 1);
      hash[at] = (hash[at] || 0) | (round(15 * f) << ((acIndex++ & 1) << 2));
    }
  return new Uint8Array(hash);
}

/** Width divided by height, as far as the hash knows it. */
export function thumbHashAspectRatio(hash: ArrayLike<number>) {
  const header = hash[3];
  const hasAlpha = hash[2] & 0x80;
  const isLandscape = hash[4] & 0x80;
  const lx = isLandscape ? (hasAlpha ? 5 : 7) : header & 7;
  const ly = isLandscape ? header & 7 : hasAlpha ? 5 : 7;
  return lx / ly;
}

/** The blurred picture of a hash: at most 32 × 32 pixels, RGBA. */
export function thumbHashToRGBA(hash: ArrayLike<number>) {
  const header24 = hash[0] | (hash[1] << 8) | (hash[2] << 16);
  const header16 = hash[3] | (hash[4] << 8);
  const lDc = (header24 & 63) / 63;
  const pDc = ((header24 >> 6) & 63) / 31.5 - 1;
  const qDc = ((header24 >> 12) & 63) / 31.5 - 1;
  const lScale = ((header24 >> 18) & 31) / 31;
  const hasAlpha = header24 >> 23;
  const pScale = ((header16 >> 3) & 63) / 63;
  const qScale = ((header16 >> 9) & 63) / 63;
  const isLandscape = header16 >> 15;
  const lx = max(3, isLandscape ? (hasAlpha ? 5 : 7) : header16 & 7);
  const ly = max(3, isLandscape ? header16 & 7 : hasAlpha ? 5 : 7);
  const aDc = hasAlpha ? (hash[5] & 15) / 15 : 1;
  const aScale = (hash[5] >> 4) / 15;
  const acStart = hasAlpha ? 6 : 5;
  let acIndex = 0;
  // Saturation is boosted a little to make up for the quantisation.
  const decodeChannel = (nx: number, ny: number, scale: number) => {
    const ac: number[] = [];
    for (let cy = 0; cy < ny; cy++)
      for (let cx = cy ? 0 : 1; cx * ny < nx * (ny - cy); cx++)
        ac.push((((hash[acStart + (acIndex >> 1)] >> ((acIndex++ & 1) << 2)) & 15) / 7.5 - 1) * scale);
    return ac;
  };
  const lAc = decodeChannel(lx, ly, lScale);
  const pAc = decodeChannel(3, 3, pScale * 1.25);
  const qAc = decodeChannel(3, 3, qScale * 1.25);
  const aAc = hasAlpha ? decodeChannel(5, 5, aScale) : [];
  const ratio = thumbHashAspectRatio(hash);
  const w = round(ratio > 1 ? 32 : 32 * ratio);
  const h = round(ratio > 1 ? 32 / ratio : 32);
  const rgba = new Uint8Array(w * h * 4),
    fx: number[] = [],
    fy: number[] = [];
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i += 4) {
      let l = lDc,
        p = pDc,
        q = qDc,
        a = aDc;
      for (let cx = 0, n = max(lx, hasAlpha ? 5 : 3); cx < n; cx++) fx[cx] = cos((PI / w) * (x + 0.5) * cx);
      for (let cy = 0, n = max(ly, hasAlpha ? 5 : 3); cy < n; cy++) fy[cy] = cos((PI / h) * (y + 0.5) * cy);
      for (let cy = 0, j = 0; cy < ly; cy++)
        for (let cx = cy ? 0 : 1, fy2 = fy[cy] * 2; cx * ly < lx * (ly - cy); cx++, j++) l += lAc[j] * fx[cx] * fy2;
      for (let cy = 0, j = 0; cy < 3; cy++)
        for (let cx = cy ? 0 : 1, fy2 = fy[cy] * 2; cx < 3 - cy; cx++, j++) {
          const f = fx[cx] * fy2;
          p += pAc[j] * f;
          q += qAc[j] * f;
        }
      if (hasAlpha)
        for (let cy = 0, j = 0; cy < 5; cy++)
          for (let cx = cy ? 0 : 1, fy2 = fy[cy] * 2; cx < 5 - cy; cx++, j++) a += aAc[j] * fx[cx] * fy2;
      const b = l - (2 / 3) * p;
      const r = (3 * l - b + q) / 2;
      const g = r - q;
      rgba[i] = max(0, 255 * min(1, r));
      rgba[i + 1] = max(0, 255 * min(1, g));
      rgba[i + 2] = max(0, 255 * min(1, b));
      rgba[i + 3] = max(0, 255 * min(1, a));
    }
  }
  return { w, h, rgba };
}

/** The average colour of a hash as CSS, for a plain background. */
export function thumbHashAverage(hash: ArrayLike<number>) {
  const header = hash[0] | (hash[1] << 8) | (hash[2] << 16);
  const l = (header & 63) / 63;
  const p = ((header >> 6) & 63) / 31.5 - 1;
  const q = ((header >> 12) & 63) / 31.5 - 1;
  const hasAlpha = header >> 23;
  const a = hasAlpha ? (hash[5] & 15) / 15 : 1;
  const b = l - (2 / 3) * p;
  const r = (3 * l - b + q) / 2;
  const g = r - q;
  const c = (v: number) => round(255 * max(0, min(1, v)));
  return `rgba(${c(r)},${c(g)},${c(b)},${round(a * 100) / 100})`;
}

// ---- a tiny PNG for the picture (stored deflate blocks, no compression) ----

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** A PNG data URL of RGBA pixels (small images only). */
export function rgbaToDataURL(w: number, h: number, rgba: ArrayLike<number>) {
  const row = w * 4 + 1;
  const idat = 6 + h * (5 + row);
  const bytes = [
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, w >> 8, w & 255, 0, 0, h >> 8, h & 255, 8, 6, 0,
    0, 0, 0, 0, 0, 0, idat >>> 24, (idat >> 16) & 255, (idat >> 8) & 255, idat & 255, 73, 68, 65, 84, 120, 1,
  ];
  const table = crcTable;
  let a = 1,
    b = 0;
  for (let y = 0, i = 0, end = row - 1; y < h; y++, end += row - 1) {
    bytes.push(y + 1 < h ? 0 : 1, row & 255, row >> 8, ~row & 255, (row >> 8) ^ 255, 0);
    for (b = (b + a) % 65521; i < end; i++) {
      const u = rgba[i] & 255;
      bytes.push(u);
      a = (a + u) % 65521;
      b = (b + a) % 65521;
    }
  }
  bytes.push(b >> 8, b & 255, a >> 8, a & 255, 0, 0, 0, 0, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130);
  for (const [start, end] of [
    [12, 29],
    [37, 41 + idat],
  ]) {
    let c = ~0;
    for (let i = start; i < end; i++) c = table[(c ^ bytes[i]) & 255] ^ (c >>> 8);
    c = ~c;
    bytes[end] = c >>> 24;
    bytes[end + 1] = (c >> 16) & 255;
    bytes[end + 2] = (c >> 8) & 255;
    bytes[end + 3] = c & 255;
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:image/png;base64,${btoa(binary)}`;
}

/** The placeholder picture of a hash (base64) as a data URL. */
export function thumbHashToDataURL(hash: ArrayLike<number>) {
  const image = thumbHashToRGBA(hash);
  return rgbaToDataURL(image.w, image.h, image.rgba);
}

export function thumbHashFromBase64(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]{7,64}={0,2}$/.test(text)) return null;
  try {
    const binary = atob(text);
    if (binary.length < 5) return null;
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export function thumbHashToBase64(hash: Uint8Array) {
  let binary = "";
  for (const byte of hash) binary += String.fromCharCode(byte);
  return btoa(binary);
}
