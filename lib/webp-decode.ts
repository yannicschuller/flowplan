// WebP for placeholders (lib/image-decode.ts): lossy (VP8 key frames),
// lossless (VP8L), transparency (ALPH) and the first frame of animations,
// written after libwebp and the format descriptions (RFC 6386, RFC 9649).
// The picture is reduced while it is produced (lib/image-small.ts). The
// lossy part skips the loop filter: it only smooths block edges, which a
// placeholder of a few dozen pixels never shows.
import { Downsampler, MAX_DECODE_PIXELS, type SmallImage, type Steps } from "./image-small";
import { AC_TABLE, BMODES_PROBA, CODE_TO_PLANE, COEFFS_PROBA0, COEFFS_UPDATE_PROBA, DC_TABLE } from "./webp-tables";

const ascii = (d: Uint8Array, i: number, n: number) => String.fromCharCode(...d.subarray(i, i + n));
const u24le = (d: Uint8Array, i: number) => d[i] | (d[i + 1] << 8) | (d[i + 2] << 16);
const u32le = (d: Uint8Array, i: number) => (d[i] | (d[i + 1] << 8) | (d[i + 2] << 16) | (d[i + 3] << 24)) >>> 0;

/** Rows of RGBA pixels of a frame. */
type Emit = (y: number, rgba: Uint8Array) => void;

export function* decodeWebp(data: Uint8Array): Steps<SmallImage | null> {
  if (ascii(data, 0, 4) !== "RIFF" || ascii(data, 8, 4) !== "WEBP") return null;
  const end = Math.min(data.length, 8 + u32le(data, 4));
  const chunks: { type: string; body: Uint8Array }[] = [];
  for (let at = 12; at + 8 <= end; ) {
    const size = u32le(data, at + 4);
    chunks.push({ type: ascii(data, at, 4), body: data.subarray(at + 8, Math.min(end, at + 8 + size)) });
    at += 8 + size + (size & 1);
  }
  const vp8x = chunks.find((c) => c.type === "VP8X");
  let canvasW: number, canvasH: number;
  let frame = chunks,
    ox = 0,
    oy = 0;
  if (vp8x) {
    canvasW = u24le(vp8x.body, 4) + 1;
    canvasH = u24le(vp8x.body, 7) + 1;
    // Animations: the first frame, where it sits on the canvas.
    const first = chunks.find((c) => c.type === "ANMF");
    if (first) {
      ox = u24le(first.body, 0) * 2;
      oy = u24le(first.body, 3) * 2;
      frame = [];
      for (let at = 16; at + 8 <= first.body.length; ) {
        const size = u32le(first.body, at + 4);
        frame.push({ type: ascii(first.body, at, 4), body: first.body.subarray(at + 8, at + 8 + size) });
        at += 8 + size + (size & 1);
      }
    }
  } else {
    const info = chunks[0];
    if (!info) return null;
    const size = info.type === "VP8 " ? vp8Size(info.body) : info.type === "VP8L" ? vp8lSize(info.body) : null;
    if (!size) return null;
    [canvasW, canvasH] = size;
  }
  if (!canvasW || !canvasH || canvasW * canvasH > MAX_DECODE_PIXELS) return null;
  const out = new Downsampler(canvasW, canvasH);
  const emitTo = (fw: number): Emit =>
    ox === 0 && oy === 0 && fw === canvasW
      ? (y, rgba) => out.row(y, rgba)
      : (y, rgba) => {
          for (let x = 0; x < fw; x++) out.pixel(ox + x, oy + y, rgba[x * 4], rgba[x * 4 + 1], rgba[x * 4 + 2], rgba[x * 4 + 3]);
        };
  const lossless = frame.find((c) => c.type === "VP8L");
  const lossy = frame.find((c) => c.type === "VP8 ");
  if (lossless) {
    const size = vp8lSize(lossless.body);
    if (!size) return null;
    const pixels = yield* decodeVp8l(lossless.body);
    if (!pixels) return null;
    const emit = emitTo(size[0]);
    const row = new Uint8Array(size[0] * 4);
    for (let y = 0; y < size[1]; y++) {
      for (let x = 0; x < size[0]; x++) {
        const argb = pixels[y * size[0] + x];
        row[x * 4] = (argb >>> 16) & 255;
        row[x * 4 + 1] = (argb >>> 8) & 255;
        row[x * 4 + 2] = argb & 255;
        row[x * 4 + 3] = argb >>> 24;
      }
      emit(y, row);
      if ((y & 127) === 127) yield;
    }
  } else if (lossy) {
    const size = vp8Size(lossy.body);
    if (!size) return null;
    const alphaChunk = frame.find((c) => c.type === "ALPH");
    const alpha = alphaChunk ? yield* decodeAlpha(alphaChunk.body, size[0], size[1]) : null;
    const planes = yield* decodeVp8(lossy.body);
    if (!planes) return null;
    // Opaque pictures are reduced in YUV and converted once per box.
    if (!alpha && ox === 0 && oy === 0 && planes.width === canvasW && planes.height === canvasH) return yuvSmall(planes);
    yuvRows(planes, alpha, emitTo(planes.width));
  } else return null;
  return out.result();
}

// ---------------------------------------------------------------------------
// VP8 (lossy)

function vp8Size(d: Uint8Array): [number, number] | null {
  if (d.length < 10 || d[3] !== 0x9d || d[4] !== 0x01 || d[5] !== 0x2a) return null;
  return [(d[6] | (d[7] << 8)) & 0x3fff, (d[8] | (d[9] << 8)) & 0x3fff];
}

class BoolDecoder {
  private value: number;
  private range = 255;
  private bitCount = 0;
  private at: number;
  constructor(
    private data: Uint8Array,
    start: number,
    private end: number,
  ) {
    this.value = ((data[start] ?? 0) << 8) | (start + 1 < end ? data[start + 1] : 0);
    this.at = start + 2;
  }
  bit(prob: number) {
    const split = 1 + (((this.range - 1) * prob) >> 8);
    const bigSplit = split << 8;
    let result: number;
    if (this.value >= bigSplit) {
      result = 1;
      this.range -= split;
      this.value -= bigSplit;
    } else {
      result = 0;
      this.range = split;
    }
    // Renormalise in one step (at most one new byte comes in).
    if (this.range < 128) {
      const shift = Math.clz32(this.range) - 24;
      this.range <<= shift;
      this.value <<= shift;
      this.bitCount += shift;
      if (this.bitCount >= 8) {
        this.bitCount -= 8;
        if (this.at < this.end) this.value |= this.data[this.at++] << this.bitCount;
      }
    }
    return result;
  }
  literal(n: number) {
    let v = 0;
    while (n--) v = (v << 1) | this.bit(128);
    return v;
  }
  signed(n: number) {
    const v = this.literal(n);
    return this.bit(128) ? -v : v;
  }
}

// Sub-block modes in libwebp's order.
const B_DC = 0,
  B_TM = 1,
  B_VE = 2,
  B_HE = 3,
  B_RD = 4,
  B_VR = 5,
  B_LD = 6,
  B_VL = 7,
  B_HD = 8,
  B_HU = 9;
const YMODES_TREE = new Int8Array([0, 1, -1, 2, -2, 3, 4, 6, -3, 5, -4, -5, -6, 7, -7, 8, -8, -9]);
const ZIGZAG = [0, 1, 4, 8, 5, 2, 3, 6, 9, 12, 13, 10, 7, 11, 14, 15];
const BANDS = [0, 1, 2, 3, 6, 4, 5, 6, 6, 6, 6, 6, 6, 6, 6, 7, 0];
const TOP_RIGHT_ROWS = [3, 7, 11];
const CAT3456 = [
  [173, 148, 140],
  [176, 155, 140, 135],
  [180, 157, 141, 134, 130],
  [254, 254, 243, 230, 196, 177, 153, 140, 133, 130, 129],
];

const clip = (v: number, max: number) => (v < 0 ? 0 : v > max ? max : v);
const clip8 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

type Planes = { Y: Uint8Array; U: Uint8Array; V: Uint8Array; yStride: number; uvStride: number; width: number; height: number };

// Token probabilities [type][band][context][11]: where a band starts, per
// type and coefficient position.
const BAND_START = new Int32Array(4 * 17);
for (let type = 0; type < 4; type++) for (let n = 0; n < 17; n++) BAND_START[type * 17 + n] = (type * 8 + BANDS[n]) * 33;

/** The coefficients of one 4×4 block; returns the position after the last. */
function getCoeffs(tokens: BoolDecoder, proba: Uint8Array, coeffs: Int16Array, type: number, ctx: number, dc: number, ac: number, n: number, out: number) {
  const bands = type * 17;
  let p = BAND_START[bands + n] + ctx * 11;
  for (; n < 16; n++) {
    if (!tokens.bit(proba[p])) return n; // end of block
    while (!tokens.bit(proba[p + 1])) {
      // zero
      if (++n === 16) return 16;
      p = BAND_START[bands + n];
    }
    let v: number;
    const next = BAND_START[bands + n + 1];
    if (!tokens.bit(proba[p + 2])) {
      v = 1;
      p = next + 11;
    } else {
      if (!tokens.bit(proba[p + 3])) {
        v = !tokens.bit(proba[p + 4]) ? 2 : 3 + tokens.bit(proba[p + 5]);
      } else if (!tokens.bit(proba[p + 6])) {
        v = !tokens.bit(proba[p + 7]) ? 5 + tokens.bit(159) : 7 + 2 * tokens.bit(165) + tokens.bit(145);
      } else {
        const bit1 = tokens.bit(proba[p + 8]);
        const bit0 = tokens.bit(proba[p + 9 + bit1]);
        const cat = 2 * bit1 + bit0;
        v = 0;
        for (const prob of CAT3456[cat]) v = v + v + tokens.bit(prob);
        v += 3 + (8 << cat);
      }
      p = next + 22;
    }
    coeffs[out + ZIGZAG[n]] = (tokens.bit(128) ? -v : v) * (n > 0 ? ac : dc);
  }
  return 16;
}

// Inverse DCT of a 4×4 block, added to the prediction.
const idctTmp = new Int32Array(16);
const mul1 = (a: number) => ((a * 20091) >> 16) + a,
  mul2 = (a: number) => (a * 35468) >> 16;
function idct(coeffs: Int16Array, c: number, plane: Uint8Array, at: number, stride: number) {
  let zero = true;
  for (let i = 0; i < 16; i++)
    if (coeffs[c + i]) {
      zero = false;
      break;
    }
  if (zero) return;
  const tmp = idctTmp;
  for (let i = 0; i < 4; i++) {
    const a = coeffs[c + i] + coeffs[c + 8 + i],
      b = coeffs[c + i] - coeffs[c + 8 + i],
      cc = mul2(coeffs[c + 4 + i]) - mul1(coeffs[c + 12 + i]),
      dd = mul1(coeffs[c + 4 + i]) + mul2(coeffs[c + 12 + i]);
    tmp[i * 4] = a + dd;
    tmp[i * 4 + 1] = b + cc;
    tmp[i * 4 + 2] = b - cc;
    tmp[i * 4 + 3] = a - dd;
  }
  for (let i = 0; i < 4; i++) {
    const dc = tmp[i] + 4;
    const a = dc + tmp[8 + i],
      b = dc - tmp[8 + i],
      cc = mul2(tmp[4 + i]) - mul1(tmp[12 + i]),
      dd = mul1(tmp[4 + i]) + mul2(tmp[12 + i]);
    const row = at + i * stride;
    plane[row] = clip8(plane[row] + ((a + dd) >> 3));
    plane[row + 1] = clip8(plane[row + 1] + ((b + cc) >> 3));
    plane[row + 2] = clip8(plane[row + 2] + ((b - cc) >> 3));
    plane[row + 3] = clip8(plane[row + 3] + ((a - dd) >> 3));
  }
}

// The inverse Walsh–Hadamard transform: the DCs of the 16 luma blocks.
function wht(input: Int16Array, coeffs: Int16Array) {
  const t = idctTmp;
  for (let i = 0; i < 4; i++) {
    const a0 = input[i] + input[12 + i],
      a1 = input[4 + i] + input[8 + i],
      a2 = input[4 + i] - input[8 + i],
      a3 = input[i] - input[12 + i];
    t[i] = a0 + a1;
    t[8 + i] = a0 - a1;
    t[4 + i] = a3 + a2;
    t[12 + i] = a3 - a2;
  }
  for (let i = 0; i < 4; i++) {
    const dc = t[i * 4] + 3;
    const a0 = dc + t[3 + i * 4],
      a1 = t[1 + i * 4] + t[2 + i * 4],
      a2 = t[1 + i * 4] - t[2 + i * 4],
      a3 = dc - t[3 + i * 4];
    coeffs[(i * 4 + 0) * 16] = (a0 + a1) >> 3;
    coeffs[(i * 4 + 1) * 16] = (a3 + a2) >> 3;
    coeffs[(i * 4 + 2) * 16] = (a0 - a1) >> 3;
    coeffs[(i * 4 + 3) * 16] = (a3 - a2) >> 3;
  }
}

function* decodeVp8(d: Uint8Array): Steps<Planes | null> {
  const tag = d[0] | (d[1] << 8) | (d[2] << 16);
  if (tag & 1) return null; // not a key frame
  const firstSize = tag >> 5;
  const size = vp8Size(d);
  if (!size) return null;
  const [width, height] = size;
  if (!width || !height || 10 + firstSize > d.length) return null;
  const br = new BoolDecoder(d, 10, 10 + firstSize);
  br.bit(128); // colour space
  br.bit(128); // clamping
  // Segments.
  const useSegment = br.bit(128);
  let updateMap = 0,
    absoluteDelta = 0;
  const quantizer = [0, 0, 0, 0],
    segmentProbs = [255, 255, 255];
  if (useSegment) {
    updateMap = br.bit(128);
    if (br.bit(128)) {
      absoluteDelta = br.bit(128);
      for (let s = 0; s < 4; s++) quantizer[s] = br.bit(128) ? br.signed(7) : 0;
      for (let s = 0; s < 4; s++) if (br.bit(128)) br.signed(6);
    }
    if (updateMap) for (let s = 0; s < 3; s++) segmentProbs[s] = br.bit(128) ? br.literal(8) : 255;
  }
  // Loop filter (read, not applied).
  br.bit(128);
  br.literal(6);
  br.literal(3);
  if (br.bit(128) && br.bit(128)) for (let i = 0; i < 8; i++) if (br.bit(128)) br.signed(6);
  // Token partitions.
  const partitionCount = 1 << br.literal(2);
  let at = 10 + firstSize + 3 * (partitionCount - 1);
  if (at > d.length) return null;
  const partitions: BoolDecoder[] = [];
  for (let p = 0; p < partitionCount; p++) {
    const sizeAt = 10 + firstSize + 3 * p;
    const length = p < partitionCount - 1 ? u24le(d, sizeAt) : d.length - at;
    const end = Math.min(d.length, at + length);
    partitions.push(new BoolDecoder(d, at, end));
    at = end;
  }
  // Quantizers per segment: [y1 dc, y1 ac, y2 dc, y2 ac, uv dc, uv ac].
  const base = br.literal(7);
  const delta = () => (br.bit(128) ? br.signed(4) : 0);
  const dqY1dc = delta(),
    dqY2dc = delta(),
    dqY2ac = delta(),
    dqUVdc = delta(),
    dqUVac = delta();
  const dqm: number[][] = [];
  for (let s = 0; s < 4; s++) {
    let q = base;
    if (useSegment) q = quantizer[s] + (absoluteDelta ? 0 : base);
    else if (s > 0) {
      dqm[s] = dqm[0];
      continue;
    }
    const y2ac = (AC_TABLE[clip(q + dqY2ac, 127)] * 101581) >> 16;
    dqm[s] = [
      DC_TABLE[clip(q + dqY1dc, 127)],
      AC_TABLE[clip(q, 127)],
      DC_TABLE[clip(q + dqY2dc, 127)] * 2,
      y2ac < 8 ? 8 : y2ac,
      DC_TABLE[clip(q + dqUVdc, 117)],
      AC_TABLE[clip(q + dqUVac, 127)],
    ];
  }
  br.bit(128); // refresh entropy probabilities (key frames only)
  const proba = new Uint8Array(COEFFS_PROBA0.length);
  for (let i = 0; i < proba.length; i++) proba[i] = br.bit(COEFFS_UPDATE_PROBA[i]) ? br.literal(8) : COEFFS_PROBA0[i];
  const useSkip = br.bit(128);
  const skipProb = useSkip ? br.literal(8) : 0;

  const mbW = (width + 15) >> 4,
    mbH = (height + 15) >> 4;
  // Planes with a border: one row above, one column left, 4 extra on the right
  // (above-right samples of the last 4×4 blocks).
  const yStride = mbW * 16 + 5,
    uvStride = mbW * 8 + 1;
  const Y = new Uint8Array(yStride * (mbH * 16 + 1)),
    U = new Uint8Array(uvStride * (mbH * 8 + 1)),
    V = new Uint8Array(uvStride * (mbH * 8 + 1));
  const yAt = (x: number, y: number) => (y + 1) * yStride + x + 1,
    uvAt = (x: number, y: number) => (y + 1) * uvStride + x + 1;
  // The row above the picture is 127 (its corner too), the column left of
  // it 129.
  Y.fill(127, 0, yStride);
  U.fill(127, 0, uvStride);
  V.fill(127, 0, uvStride);
  for (let y = 0; y < mbH * 16; y++) Y[yAt(-1, y)] = 129;
  for (let y = 0; y < mbH * 8; y++) {
    U[uvAt(-1, y)] = 129;
    V[uvAt(-1, y)] = 129;
  }

  // Contexts: modes of the 4×4 blocks above, whether blocks had coefficients.
  const intraTop = new Uint8Array(mbW * 4);
  const intraLeft = new Uint8Array(4);
  const nzTop = new Uint8Array(mbW * 9), // 4 Y, 2 U, 2 V, 1 Y2 per macroblock
    nzLeft = new Uint8Array(9);
  const coeffs = new Int16Array(400);
  const modes = new Uint8Array(16);
  for (let mbY = 0; mbY < mbH; mbY++) {
    intraLeft.fill(B_DC);
    nzLeft.fill(0);
    const tokens = partitions[mbY & (partitionCount - 1)];
    for (let mbX = 0; mbX < mbW; mbX++) {
      // Modes (first partition).
      const segment = updateMap ? (!br.bit(segmentProbs[0]) ? br.bit(segmentProbs[1]) : 2 + br.bit(segmentProbs[2])) : 0;
      const skip = useSkip ? br.bit(skipProb) : 0;
      const isI4 = !br.bit(145);
      let yMode = B_DC;
      if (!isI4) {
        yMode = br.bit(156) ? (br.bit(128) ? B_TM : B_HE) : br.bit(163) ? B_VE : B_DC;
        intraTop.fill(yMode, mbX * 4, mbX * 4 + 4);
        intraLeft.fill(yMode);
      } else {
        for (let y = 0; y < 4; y++) {
          let mode = intraLeft[y];
          for (let x = 0; x < 4; x++) {
            const prob = (intraTop[mbX * 4 + x] * 10 + mode) * 9;
            let i: number = YMODES_TREE[br.bit(BMODES_PROBA[prob])];
            while (i > 0) i = YMODES_TREE[2 * i + br.bit(BMODES_PROBA[prob + i])];
            mode = -i;
            intraTop[mbX * 4 + x] = mode;
            modes[y * 4 + x] = mode;
          }
          intraLeft[y] = mode;
        }
      }
      const uvMode = !br.bit(142) ? B_DC : !br.bit(114) ? B_VE : br.bit(183) ? B_TM : B_HE;

      // Coefficients (token partition).
      coeffs.fill(0);
      const q = dqm[segment];
      const top = mbX * 9;
      if (!skip) {
        let first = 0,
          acType = 3;
        if (!isI4) {
          // The second-order block (the DCs of the 16 luma blocks) after them.
          const nz = getCoeffs(tokens, proba, coeffs, 1, nzTop[top + 8] + nzLeft[8], q[2], q[3], 0, 384);
          const dcIn = coeffs.subarray(384, 400);
          nzTop[top + 8] = nzLeft[8] = nz > 0 ? 1 : 0;
          if (nz > 1) wht(dcIn, coeffs);
          else {
            const dc0 = (dcIn[0] + 3) >> 3;
            for (let i = 0; i < 256; i += 16) coeffs[i] = dc0;
          }
          first = 1;
          acType = 0;
        }
        for (let y = 0; y < 4; y++)
          for (let x = 0; x < 4; x++) {
            const ctx = nzTop[top + x] + nzLeft[y];
            const nz = getCoeffs(tokens, proba, coeffs, acType, ctx, q[0], q[1], first, (y * 4 + x) * 16);
            nzTop[top + x] = nzLeft[y] = nz > first ? 1 : 0;
          }
        for (let ch = 0; ch < 2; ch++)
          for (let y = 0; y < 2; y++)
            for (let x = 0; x < 2; x++) {
              const t = top + 4 + ch * 2 + x,
                l = 4 + ch * 2 + y;
              const nz = getCoeffs(tokens, proba, coeffs, 2, nzTop[t] + nzLeft[l], q[4], q[5], 0, 256 + ch * 64 + (y * 2 + x) * 16);
              nzTop[t] = nzLeft[l] = nz > 0 ? 1 : 0;
            }
      } else {
        nzTop.fill(0, top, top + 8);
        nzLeft.fill(0, 0, 8);
        if (!isI4) nzTop[top + 8] = nzLeft[8] = 0;
      }

      // Prediction and reconstruction.
      const px = mbX * 16,
        py = mbY * 16;
      if (isI4) {
        // Above-right of the last column: from the macroblock above-right
        // (the last one repeats its own corner), copied down for each row.
        const tr = yAt(px + 16, py - 1);
        if (mbY > 0) {
          if (mbX === mbW - 1) Y.fill(Y[yAt(px + 15, py - 1)], tr, tr + 4);
        } else Y.fill(127, tr, tr + 4);
        // (Those places belong to the next macroblock, predicted afresh.)
        for (const row of TOP_RIGHT_ROWS) Y.copyWithin(yAt(px + 16, py + row), tr, tr + 4);
        for (let n = 0; n < 16; n++) {
          const at = yAt(px + (n & 3) * 4, py + (n >> 2) * 4);
          predict4(Y, at, yStride, modes[n]);
          idct(coeffs, n * 16, Y, at, yStride);
        }
      } else {
        predictBlock(Y, yAt(px, py), yStride, 16, yMode, mbX, mbY);
        for (let n = 0; n < 16; n++) idct(coeffs, n * 16, Y, yAt(px + (n & 3) * 4, py + (n >> 2) * 4), yStride);
      }
      predictBlock(U, uvAt(px / 2, py / 2), uvStride, 8, uvMode, mbX, mbY);
      predictBlock(V, uvAt(px / 2, py / 2), uvStride, 8, uvMode, mbX, mbY);
      for (let n = 0; n < 4; n++) {
        idct(coeffs, 256 + n * 16, U, uvAt(px / 2 + (n & 1) * 4, py / 2 + (n >> 1) * 4), uvStride);
        idct(coeffs, 320 + n * 16, V, uvAt(px / 2 + (n & 1) * 4, py / 2 + (n >> 1) * 4), uvStride);
      }
    }
    yield;
  }
  return { Y, U, V, yStride, uvStride, width, height };
}

const yuvR = (c: number, v: number) => clip8(Math.round(c + 1.596 * v)),
  yuvG = (c: number, u: number, v: number) => clip8(Math.round(c - 0.392 * u - 0.813 * v)),
  yuvB = (c: number, u: number) => clip8(Math.round(c + 2.017 * u));

/** Rows of RGBA pixels (transparency or a frame on a larger canvas). */
function yuvRows(p: Planes, alpha: Uint8Array | null, emit: Emit) {
  const row = new Uint8Array(p.width * 4);
  for (let y = 0; y < p.height; y++) {
    const yRow = (y + 1) * p.yStride + 1,
      uvRow = ((y >> 1) + 1) * p.uvStride + 1;
    for (let x = 0; x < p.width; x++) {
      const c = 1.164 * (p.Y[yRow + x] - 16),
        u = p.U[uvRow + (x >> 1)] - 128,
        v = p.V[uvRow + (x >> 1)] - 128;
      row[x * 4] = yuvR(c, v);
      row[x * 4 + 1] = yuvG(c, u, v);
      row[x * 4 + 2] = yuvB(c, u);
      row[x * 4 + 3] = alpha ? alpha[y * p.width + x] : 255;
    }
    emit(y, row);
  }
}

/** The small picture straight from the planes: averages of Y, U and V per
 *  box (the same boxes as lib/image-small.ts), converted once per box. */
function yuvSmall(p: Planes): SmallImage {
  const box = new Downsampler(p.width, p.height);
  const w = box.w,
    h = box.h;
  const sums = new Float64Array(w * h * 4);
  for (let y = 0; y < p.height; y++) {
    const by = Math.min(h - 1, Math.floor((y * h) / p.height)) * w;
    const yRow = (y + 1) * p.yStride + 1,
      uvRow = ((y >> 1) + 1) * p.uvStride + 1;
    for (let x = 0, bx = 0, nextX = 0; x < p.width; x++) {
      if (x >= nextX) {
        bx = Math.min(w - 1, Math.floor((x * w) / p.width));
        nextX = Math.ceil(((bx + 1) * p.width) / w);
      }
      const i = (by + bx) * 4;
      sums[i] += p.Y[yRow + x];
      sums[i + 1] += p.U[uvRow + (x >> 1)];
      sums[i + 2] += p.V[uvRow + (x >> 1)];
      sums[i + 3]++;
    }
  }
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const n = sums[i * 4 + 3] || 1;
    const c = 1.164 * (sums[i * 4] / n - 16),
      u = sums[i * 4 + 1] / n - 128,
      v = sums[i * 4 + 2] / n - 128;
    rgba[i * 4] = yuvR(c, v);
    rgba[i * 4 + 1] = yuvG(c, u, v);
    rgba[i * 4 + 2] = yuvB(c, u);
    rgba[i * 4 + 3] = 255;
  }
  return { width: w, height: h, rgba };
}

// 16×16 luma and 8×8 chroma prediction.
function predictBlock(p: Uint8Array, at: number, stride: number, size: number, mode: number, mbX: number, mbY: number) {
  const top = at - stride;
  if (mode === B_DC) {
    let sum = 0,
      count = 0;
    if (mbY > 0) {
      for (let i = 0; i < size; i++) sum += p[top + i];
      count += size;
    }
    if (mbX > 0) {
      for (let i = 0; i < size; i++) sum += p[at + i * stride - 1];
      count += size;
    }
    const dc = count ? (sum + (count >> 1)) / count | 0 : 128;
    for (let y = 0; y < size; y++) p.fill(dc, at + y * stride, at + y * stride + size);
  } else if (mode === B_VE) {
    for (let y = 0; y < size; y++) p.copyWithin(at + y * stride, top, top + size);
  } else if (mode === B_HE) {
    for (let y = 0; y < size; y++) p.fill(p[at + y * stride - 1], at + y * stride, at + y * stride + size);
  } else {
    const corner = p[top - 1];
    for (let y = 0; y < size; y++) {
      const left = p[at + y * stride - 1] - corner;
      for (let x = 0; x < size; x++) p[at + y * stride + x] = clip8(left + p[top + x]);
    }
  }
}

const avg3 = (a: number, b: number, c: number) => (a + 2 * b + c + 2) >> 2;
const avg2 = (a: number, b: number) => (a + b + 1) >> 1;
let putPlane: Uint8Array = new Uint8Array(0),
  putAt = 0,
  putStride = 0;
const put = (x: number, y: number, v: number) => (putPlane[putAt + y * putStride + x] = v);

// 4×4 luma prediction (ten modes).
function predict4(p: Uint8Array, at: number, s: number, mode: number) {
  putPlane = p;
  putAt = at;
  putStride = s;
  const t = at - s;
  const A = p[t],
    B = p[t + 1],
    C = p[t + 2],
    D = p[t + 3],
    E = p[t + 4],
    F = p[t + 5],
    G = p[t + 6],
    H = p[t + 7];
  const X = p[t - 1],
    I = p[at - 1],
    J = p[at + s - 1],
    K = p[at + 2 * s - 1],
    L = p[at + 3 * s - 1];
  const set = put;
  switch (mode) {
    case B_DC: {
      const dc = (A + B + C + D + I + J + K + L + 4) >> 3;
      for (let y = 0; y < 4; y++) p.fill(dc, at + y * s, at + y * s + 4);
      break;
    }
    case B_TM:
      for (let y = 0; y < 4; y++) {
        const left = p[at + y * s - 1] - X;
        for (let x = 0; x < 4; x++) set(x, y, clip8(left + p[t + x]));
      }
      break;
    case B_VE: {
      const v = [avg3(X, A, B), avg3(A, B, C), avg3(B, C, D), avg3(C, D, E)];
      for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) set(x, y, v[x]);
      break;
    }
    case B_HE: {
      const v = [avg3(X, I, J), avg3(I, J, K), avg3(J, K, L), avg3(K, L, L)];
      for (let y = 0; y < 4; y++) p.fill(v[y], at + y * s, at + y * s + 4);
      break;
    }
    case B_RD:
      set(0, 3, avg3(J, K, L));
      set(1, 3, avg3(I, J, K)); set(0, 2, avg3(I, J, K));
      set(2, 3, avg3(X, I, J)); set(1, 2, avg3(X, I, J)); set(0, 1, avg3(X, I, J));
      set(3, 3, avg3(A, X, I)); set(2, 2, avg3(A, X, I)); set(1, 1, avg3(A, X, I)); set(0, 0, avg3(A, X, I));
      set(3, 2, avg3(B, A, X)); set(2, 1, avg3(B, A, X)); set(1, 0, avg3(B, A, X));
      set(3, 1, avg3(C, B, A)); set(2, 0, avg3(C, B, A));
      set(3, 0, avg3(D, C, B));
      break;
    case B_VR:
      set(0, 0, avg2(X, A)); set(1, 2, avg2(X, A));
      set(1, 0, avg2(A, B)); set(2, 2, avg2(A, B));
      set(2, 0, avg2(B, C)); set(3, 2, avg2(B, C));
      set(3, 0, avg2(C, D));
      set(0, 3, avg3(K, J, I));
      set(0, 2, avg3(J, I, X));
      set(0, 1, avg3(I, X, A)); set(1, 3, avg3(I, X, A));
      set(1, 1, avg3(X, A, B)); set(2, 3, avg3(X, A, B));
      set(2, 1, avg3(A, B, C)); set(3, 3, avg3(A, B, C));
      set(3, 1, avg3(B, C, D));
      break;
    case B_LD:
      set(0, 0, avg3(A, B, C));
      set(1, 0, avg3(B, C, D)); set(0, 1, avg3(B, C, D));
      set(2, 0, avg3(C, D, E)); set(1, 1, avg3(C, D, E)); set(0, 2, avg3(C, D, E));
      set(3, 0, avg3(D, E, F)); set(2, 1, avg3(D, E, F)); set(1, 2, avg3(D, E, F)); set(0, 3, avg3(D, E, F));
      set(3, 1, avg3(E, F, G)); set(2, 2, avg3(E, F, G)); set(1, 3, avg3(E, F, G));
      set(3, 2, avg3(F, G, H)); set(2, 3, avg3(F, G, H));
      set(3, 3, avg3(G, H, H));
      break;
    case B_VL:
      set(0, 0, avg2(A, B));
      set(1, 0, avg2(B, C)); set(0, 2, avg2(B, C));
      set(2, 0, avg2(C, D)); set(1, 2, avg2(C, D));
      set(3, 0, avg2(D, E)); set(2, 2, avg2(D, E));
      set(0, 1, avg3(A, B, C));
      set(1, 1, avg3(B, C, D)); set(0, 3, avg3(B, C, D));
      set(2, 1, avg3(C, D, E)); set(1, 3, avg3(C, D, E));
      set(3, 1, avg3(D, E, F)); set(2, 3, avg3(D, E, F));
      set(3, 2, avg3(E, F, G));
      set(3, 3, avg3(F, G, H));
      break;
    case B_HD:
      set(0, 0, avg2(I, X)); set(2, 1, avg2(I, X));
      set(0, 1, avg2(J, I)); set(2, 2, avg2(J, I));
      set(0, 2, avg2(K, J)); set(2, 3, avg2(K, J));
      set(0, 3, avg2(L, K));
      set(3, 0, avg3(A, B, C));
      set(2, 0, avg3(X, A, B));
      set(1, 0, avg3(I, X, A)); set(3, 1, avg3(I, X, A));
      set(1, 1, avg3(J, I, X)); set(3, 2, avg3(J, I, X));
      set(1, 2, avg3(K, J, I)); set(3, 3, avg3(K, J, I));
      set(1, 3, avg3(L, K, J));
      break;
    case B_HU:
      set(0, 0, avg2(I, J));
      set(2, 0, avg2(J, K)); set(0, 1, avg2(J, K));
      set(2, 1, avg2(K, L)); set(0, 2, avg2(K, L));
      set(1, 0, avg3(I, J, K));
      set(3, 0, avg3(J, K, L)); set(1, 1, avg3(J, K, L));
      set(3, 1, avg3(K, L, L)); set(1, 2, avg3(K, L, L));
      set(3, 2, L); set(2, 2, L); set(0, 3, L); set(1, 3, L); set(2, 3, L); set(3, 3, L);
      break;
  }
}

// ---------------------------------------------------------------------------
// Transparency of lossy images (ALPH)

function* decodeAlpha(body: Uint8Array, width: number, height: number): Steps<Uint8Array | null> {
  if (!body.length) return null;
  const method = body[0] & 3,
    filter = (body[0] >> 2) & 3;
  let alpha: Uint8Array;
  if (method === 0) {
    if (body.length - 1 < width * height) return null;
    alpha = body.slice(1, 1 + width * height);
  } else if (method === 1) {
    const pixels = yield* decodeVp8lStream(new BitReader(body, 1), width, height);
    if (!pixels) return null;
    alpha = new Uint8Array(width * height);
    for (let i = 0; i < alpha.length; i++) alpha[i] = (pixels[i] >> 8) & 255;
  } else return null;
  // Unfiltering: horizontal, vertical or gradient prediction.
  if (filter)
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        let pred = 0;
        if (y === 0) pred = x > 0 ? alpha[i - 1] : 0;
        else if (x === 0) pred = alpha[i - width];
        else if (filter === 1) pred = alpha[i - 1];
        else if (filter === 2) pred = alpha[i - width];
        else pred = clip8(alpha[i - 1] + alpha[i - width] - alpha[i - width - 1]);
        alpha[i] = (alpha[i] + pred) & 255;
      }
  return alpha;
}

// ---------------------------------------------------------------------------
// VP8L (lossless)

function vp8lSize(d: Uint8Array): [number, number] | null {
  if (d.length < 5 || d[0] !== 0x2f) return null;
  const bits = u32le(d, 1);
  return [(bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1];
}

class BitReader {
  private bit = 0;
  constructor(
    private data: Uint8Array,
    private at: number,
  ) {}
  read(n: number) {
    if (n === 8 && this.bit === 0) {
      if (this.at > this.data.length + 8) throw new Error("truncated");
      return this.data[this.at++] ?? 0;
    }
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.data[this.at] ?? 0;
      v |= ((byte >> this.bit) & 1) << i;
      if (++this.bit === 8) {
        this.bit = 0;
        this.at++;
      }
    }
    if (this.at > this.data.length + 8) throw new Error("truncated");
    return v >>> 0;
  }
}

// A prefix code as a tree walked bit by bit, with a table for the first bits.
type Code = { single: number; table: Int32Array; left: Int32Array; right: Int32Array; symbol: Int32Array };
const TABLE_BITS = 8;

function buildCode(lengths: Uint8Array): Code | null {
  const symbols: number[] = [];
  for (let s = 0; s < lengths.length; s++) if (lengths[s]) symbols.push(s);
  if (!symbols.length) return null;
  if (symbols.length === 1) return { single: symbols[0], table: new Int32Array(0), left: new Int32Array(0), right: new Int32Array(0), symbol: new Int32Array(0) };
  // Canonical codes.
  const counts = new Int32Array(16);
  for (const s of symbols) counts[lengths[s]]++;
  const next = new Int32Array(16);
  let code = 0;
  for (let len = 1; len < 16; len++) {
    code = (code + counts[len - 1]) << 1;
    next[len] = code;
  }
  const capacity = symbols.length * 2 + 1;
  const left = new Int32Array(capacity).fill(-1),
    right = new Int32Array(capacity).fill(-1),
    symbol = new Int32Array(capacity).fill(-1);
  let nodes = 1;
  for (const s of symbols) {
    const len = lengths[s],
      c = next[len]++;
    let node = 0;
    for (let i = len - 1; i >= 0; i--) {
      const branch = (c >> i) & 1 ? right : left;
      if (branch[node] < 0) {
        if (nodes >= capacity) return null;
        branch[node] = nodes++;
      }
      node = branch[node];
    }
    symbol[node] = s;
  }
  // Table: for each value of the next TABLE_BITS bits (first bit lowest),
  // the symbol and length, or the node to continue from.
  const table = new Int32Array(1 << TABLE_BITS);
  for (let bits = 0; bits < 1 << TABLE_BITS; bits++) {
    let node = 0,
      used = 0;
    while (symbol[node] < 0 && used < TABLE_BITS) {
      node = (bits >> used) & 1 ? right[node] : left[node];
      used++;
      if (node < 0) break;
    }
    table[bits] = node < 0 ? -1 : symbol[node] >= 0 ? (symbol[node] << 4) | used : -(node + 2);
  }
  return { single: -1, table, left, right, symbol };
}

class Lossless {
  private value = 0;
  private count = 0;
  constructor(private r: BitReader) {}
  // A small bit buffer on top of the reader for symbol decoding.
  private ensure(n: number) {
    while (this.count < n) {
      this.value |= this.r.read(8) << this.count;
      this.count += 8;
    }
  }
  bits(n: number) {
    if (!n) return 0;
    let v = 0,
      shift = 0;
    while (n > 0) {
      const take = Math.min(n, 16);
      this.ensure(take);
      v += (this.value & ((1 << take) - 1)) * 2 ** shift;
      this.value >>>= take;
      this.count -= take;
      n -= take;
      shift += take;
    }
    return v;
  }
  symbol(code: Code) {
    if (code.single >= 0) return code.single;
    this.ensure(TABLE_BITS);
    const entry = code.table[this.value & ((1 << TABLE_BITS) - 1)];
    if (entry >= 0) {
      const used = entry & 15;
      this.value >>>= used;
      this.count -= used;
      return entry >> 4;
    }
    if (entry === -1) throw new Error("bad code");
    let node = -entry - 2;
    this.value >>>= TABLE_BITS;
    this.count -= TABLE_BITS;
    while (code.symbol[node] < 0) {
      node = this.bits(1) ? code.right[node] : code.left[node];
      if (node < 0) throw new Error("bad code");
    }
    return code.symbol[node];
  }
}

const CODE_LENGTH_ORDER = [17, 18, 0, 1, 2, 3, 4, 5, 16, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

function readCode(b: Lossless, alphabet: number): Code | null {
  const lengths = new Uint8Array(alphabet);
  if (b.bits(1)) {
    // Simple: one or two symbols.
    const count = b.bits(1) + 1;
    const first = b.bits(b.bits(1) ? 8 : 1);
    if (first < alphabet) lengths[first] = 1;
    if (count === 2) {
      const second = b.bits(8);
      if (second < alphabet) lengths[second] = 1;
    }
    return buildCode(lengths);
  }
  const lengthLengths = new Uint8Array(19);
  const n = 4 + b.bits(4);
  for (let i = 0; i < n; i++) lengthLengths[CODE_LENGTH_ORDER[i]] = b.bits(3);
  const lengthCode = buildCode(lengthLengths);
  if (!lengthCode) return null;
  let max = alphabet;
  if (b.bits(1)) {
    const width = 2 + 2 * b.bits(3);
    max = 2 + b.bits(width);
    if (max > alphabet) return null;
  }
  let previous = 8;
  for (let s = 0; s < alphabet; ) {
    if (max-- === 0) break;
    const len = b.symbol(lengthCode);
    if (len < 16) {
      lengths[s++] = len;
      if (len) previous = len;
    } else {
      const extra = [2, 3, 7][len - 16],
        offset = [3, 3, 11][len - 16];
      const repeat = b.bits(extra) + offset;
      if (s + repeat > alphabet) return null;
      const value = len === 16 ? previous : 0;
      for (let k = 0; k < repeat; k++) lengths[s++] = value;
    }
  }
  return buildCode(lengths);
}

function* decodeVp8l(d: Uint8Array): Steps<Uint32Array | null> {
  const size = vp8lSize(d);
  if (!size || ((d[4] >> 5) & 7) !== 0 /* version */) return null;
  const r = new BitReader(d, 5);
  return yield* decodeVp8lStream(r, size[0], size[1]);
}

function* decodeVp8lStream(r: BitReader, width: number, height: number): Steps<Uint32Array | null> {
  try {
    const b = new Lossless(r);
    // Transforms, applied backwards at the end.
    type Transform = { type: number; bits: number; data: Uint32Array; width: number };
    const transforms: Transform[] = [];
    let xsize = width;
    while (b.bits(1)) {
      const type = b.bits(2);
      if (transforms.some((t) => t.type === type) || transforms.length >= 4) return null;
      if (type === 0 || type === 1) {
        const bits = b.bits(3) + 2;
        const w = Math.ceil(xsize / (1 << bits)),
          h = Math.ceil(height / (1 << bits));
        const data = yield* imageData(b, w, h, false);
        if (!data) return null;
        transforms.push({ type, bits, data, width: xsize });
      } else if (type === 2) transforms.push({ type, bits: 0, data: new Uint32Array(0), width: xsize });
      else {
        const colors = b.bits(8) + 1;
        const table = yield* imageData(b, colors, 1, false);
        if (!table) return null;
        for (let i = 1; i < colors; i++) table[i] = addPixels(table[i], table[i - 1]);
        const bits = colors > 16 ? 0 : colors > 4 ? 1 : colors > 2 ? 2 : 3;
        transforms.push({ type, bits, data: table, width: xsize });
        xsize = Math.ceil(xsize / (1 << bits));
      }
    }
    let pixels = yield* imageData(b, xsize, height, true);
    if (!pixels) return null;
    for (let i = transforms.length - 1; i >= 0; i--) pixels = yield* inverse(transforms[i], pixels, height);
    return pixels;
  } catch {
    return null;
  }
}

const addPixels = (a: number, b: number) =>
  ((((a >>> 24) + (b >>> 24)) & 255) * 2 ** 24 +
    ((((a >> 16) & 255) + ((b >> 16) & 255)) & 255) * 65536 +
    ((((a >> 8) & 255) + ((b >> 8) & 255)) & 255) * 256 +
    (((a & 255) + (b & 255)) & 255)) >>>
  0;

function* imageData(b: Lossless, w: number, h: number, main: boolean): Steps<Uint32Array | null> {
  if (w * h > MAX_DECODE_PIXELS) return null;
  let cacheBits = 0;
  if (b.bits(1)) {
    cacheBits = b.bits(4);
    if (cacheBits < 1 || cacheBits > 11) return null;
  }
  // Prefix code groups per region (main image only).
  let metaBits = 0,
    meta: Uint32Array | null = null,
    metaWidth = 0,
    groups = 1;
  if (main && b.bits(1)) {
    metaBits = b.bits(3) + 2;
    metaWidth = Math.ceil(w / (1 << metaBits));
    meta = yield* imageData(b, metaWidth, Math.ceil(h / (1 << metaBits)), false);
    if (!meta) return null;
    for (let i = 0; i < meta.length; i++) {
      meta[i] = (meta[i] >> 8) & 0xffff;
      groups = Math.max(groups, meta[i] + 1);
    }
  }
  const cacheSize = cacheBits ? 1 << cacheBits : 0;
  const codes: (Code | null)[][] = [];
  for (let g = 0; g < groups; g++) {
    const group = [256 + 24 + cacheSize, 256, 256, 256, 40].map((alphabet) => readCode(b, alphabet));
    codes.push(group);
  }
  const cache = cacheSize ? new Uint32Array(cacheSize) : null;
  const cacheShift = 32 - cacheBits;
  const out = new Uint32Array(w * h);
  let pos = 0,
    cached = 0,
    pause = 1 << 16;
  const remember = () => {
    if (!cache) return;
    for (; cached < pos; cached++) cache[Math.imul(0x1e35a7bd, out[cached]) >>> cacheShift] = out[cached];
  };
  const copyLength = (symbol: number) => {
    if (symbol < 4) return symbol + 1;
    const extra = (symbol - 2) >> 1;
    return ((2 + (symbol & 1)) << extra) + b.bits(extra) + 1;
  };
  while (pos < out.length) {
    if (pos >= pause) {
      pause = pos + (1 << 16);
      yield;
    }
    const x = pos % w,
      y = (pos / w) | 0;
    const group = codes[meta ? meta[(y >> metaBits) * metaWidth + (x >> metaBits)] : 0];
    const [green, red, blue, alpha, distance] = group;
    if (!green) return null;
    const s = b.symbol(green);
    if (s < 256) {
      const rr = red ? b.symbol(red) : 0,
        bb = blue ? b.symbol(blue) : 0,
        aa = alpha ? b.symbol(alpha) : 0;
      out[pos++] = ((aa << 24) | (rr << 16) | (s << 8) | bb) >>> 0;
    } else if (s < 280) {
      const length = copyLength(s - 256);
      if (!distance) return null;
      const code = copyLength(b.symbol(distance));
      let dist: number;
      if (code > 120) dist = code - 120;
      else {
        const plane = CODE_TO_PLANE[code - 1];
        dist = (plane >> 4) * w + (8 - (plane & 15));
        if (dist < 1) dist = 1;
      }
      if (dist > pos || pos + length > out.length) return null;
      for (let i = 0; i < length; i++, pos++) out[pos] = out[pos - dist];
    } else {
      if (!cache) return null;
      remember();
      out[pos++] = cache[s - 280];
    }
    remember();
  }
  return out;
}

function* inverse(t: { type: number; bits: number; data: Uint32Array; width: number }, input: Uint32Array, height: number): Steps<Uint32Array> {
  const w = t.width;
  if (t.type === 2) {
    // Subtract green: add it back to red and blue.
    for (let i = 0; i < input.length; i++) {
      const p = input[i],
        g = (p >> 8) & 255;
      input[i] = ((p & 0xff00ff00) | ((((p >> 16) + g) & 255) << 16) | (((p & 255) + g) & 255)) >>> 0;
    }
    return input;
  }
  if (t.type === 3) {
    // Colour indexing: indices (several per pixel when the table is small).
    const out = new Uint32Array(w * height);
    const perPixel = 1 << t.bits,
      bitsPer = 8 >> t.bits,
      mask = (1 << bitsPer) - 1,
      packedWidth = Math.ceil(w / perPixel);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < w; x++) {
        const packed = (input[y * packedWidth + (x >> t.bits)] >> 8) & 255;
        const index = (packed >> ((x & (perPixel - 1)) * bitsPer)) & mask;
        out[y * w + x] = index < t.data.length ? t.data[index] : 0;
      }
    return out;
  }
  const blockWidth = Math.ceil(w / (1 << t.bits));
  if (t.type === 1) {
    // Colour transform: red and blue get back what green (and red) took.
    const delta = (m: number, c: number) => (((m << 24) >> 24) * ((c << 24) >> 24)) >> 5;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < w; x++) {
        const m = t.data[(y >> t.bits) * blockWidth + (x >> t.bits)];
        const greenToRed = m & 255,
          greenToBlue = (m >> 8) & 255,
          redToBlue = (m >> 16) & 255;
        const i = y * w + x,
          p = input[i];
        const g = (p >> 8) & 255;
        const red = (((p >> 16) & 255) + delta(greenToRed, g)) & 255;
        const blue = ((p & 255) + delta(greenToBlue, g) + delta(redToBlue, red)) & 255;
        input[i] = ((p & 0xff00ff00) | (red << 16) | blue) >>> 0;
      }
    return input;
  }
  // Predictor transform.
  for (let y = 0; y < height; y++) {
    if ((y & 63) === 63) yield;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let pred: number;
      if (y === 0) pred = x === 0 ? 0xff000000 : input[i - 1];
      else if (x === 0) pred = input[i - w];
      else {
        const mode = (t.data[(y >> t.bits) * blockWidth + (x >> t.bits)] >> 8) & 15;
        const L = input[i - 1],
          T = input[i - w],
          TL = input[i - w - 1],
          TR = input[i - w + 1];
        switch (mode) {
          case 1: pred = L; break;
          case 2: pred = T; break;
          case 3: pred = TR; break;
          case 4: pred = TL; break;
          case 5: pred = average(average(L, TR), T); break;
          case 6: pred = average(L, TL); break;
          case 7: pred = average(L, T); break;
          case 8: pred = average(TL, T); break;
          case 9: pred = average(T, TR); break;
          case 10: pred = average(average(L, TL), average(T, TR)); break;
          case 11: pred = select(L, T, TL); break;
          case 12: pred = clampAddSubtractFull(L, T, TL); break;
          case 13: pred = clampAddSubtractHalf(average(L, T), TL); break;
          default: pred = 0xff000000;
        }
      }
      input[i] = addPixels(input[i], pred);
    }
  }
  return input;
}

// Predictors of the lossless format, per channel of ARGB.
const channel = (p: number, s: number) => (p >>> s) & 255;
const average = (a: number, b: number) => ((((a ^ b) & 0xfefefefe) >>> 1) + (a & b)) >>> 0;
function select(L: number, T: number, TL: number) {
  let pl = 0,
    pt = 0;
  for (let s = 0; s < 32; s += 8) {
    const estimate = channel(L, s) + channel(T, s) - channel(TL, s);
    pl += Math.abs(estimate - channel(L, s));
    pt += Math.abs(estimate - channel(T, s));
  }
  return pl < pt ? L : T;
}
function clampAddSubtractFull(a: number, b: number, c: number) {
  let out = 0;
  for (let s = 0; s < 32; s += 8) out += clip8(channel(a, s) + channel(b, s) - channel(c, s)) * 2 ** s;
  return out >>> 0;
}
function clampAddSubtractHalf(a: number, b: number) {
  let out = 0;
  for (let s = 0; s < 32; s += 8) {
    const ca = channel(a, s);
    out += clip8(ca + Math.trunc((ca - channel(b, s)) / 2)) * 2 ** s;
  }
  return out >>> 0;
}
