// JPEG at an eighth of its size, for placeholders (lib/image-decode.ts):
// every 8 × 8 block becomes one pixel, its average – the block's DC
// coefficient. No inverse DCT is needed, and progressive files are read
// only as far as their DC scans. Huffman-coded files (baseline, extended,
// progressive) with any sampling, restart intervals, grey, YCbCr, RGB and
// (Adobe) CMYK/YCCK; arithmetic coding gives null.
import { Downsampler, MAX_DECODE_PIXELS, type SmallImage, type Steps } from "./image-small";

type Huffman = { lookup: Uint16Array; maxcode: Int32Array; valptr: Int32Array; mincode: Int32Array; values: Uint8Array };
type Component = {
  id: number;
  h: number;
  v: number;
  tq: number;
  blocksPerLine: number;
  blocksPerColumn: number;
  /** DC coefficient per block (quantised), MCU-padded grid. */
  dc: Int32Array;
  pred: number;
  dcTable?: Huffman;
  acTable?: Huffman;
};

function buildHuffman(counts: Uint8Array, values: Uint8Array): Huffman {
  const maxcode = new Int32Array(18).fill(-1),
    valptr = new Int32Array(17),
    mincode = new Int32Array(17);
  // An 8-bit lookahead: (length << 8) | value, 0 for longer codes.
  const lookup = new Uint16Array(256);
  let code = 0,
    k = 0;
  for (let length = 1; length <= 16; length++) {
    valptr[length] = k;
    mincode[length] = code;
    for (let i = 0; i < counts[length - 1]; i++, k++, code++) {
      if (length <= 8) {
        const shift = 8 - length;
        for (let fill = 0; fill < 1 << shift; fill++) lookup[(code << shift) | fill] = (length << 8) | values[k];
      }
    }
    maxcode[length] = counts[length - 1] ? code - 1 : -1;
    code <<= 1;
  }
  maxcode[17] = 0x7fffffff;
  return { lookup, maxcode, valptr, mincode, values };
}

class Bits {
  private bits = 0;
  private count = 0;
  /** A marker was reached: the entropy data of the segment ended. */
  marker = false;
  constructor(
    private data: Uint8Array,
    public at: number,
  ) {}
  private fill() {
    while (this.count <= 24) {
      let byte = 0;
      if (!this.marker && this.at < this.data.length) {
        byte = this.data[this.at];
        if (byte === 0xff) {
          const next = this.data[this.at + 1];
          if (next === 0) this.at += 2;
          else {
            // A marker: zeros from here on, the position stays at it.
            this.marker = true;
            byte = 0;
          }
        } else this.at++;
      }
      this.bits = (this.bits << 8) | byte;
      this.count += 8;
    }
  }
  peek(n: number) {
    if (this.count < n) this.fill();
    return (this.bits >>> (this.count - n)) & ((1 << n) - 1);
  }
  skip(n: number) {
    if (this.count < n) this.fill();
    this.count -= n;
    this.bits &= (1 << this.count) - 1;
  }
  read(n: number) {
    if (!n) return 0;
    const value = this.peek(n);
    this.skip(n);
    return value;
  }
  decode(table: Huffman) {
    const fast = table.lookup[this.peek(8)];
    if (fast) {
      this.skip(fast >> 8);
      return fast & 255;
    }
    let code = this.read(8);
    for (let length = 9; length <= 16; length++) {
      code = (code << 1) | this.read(1);
      if (code <= table.maxcode[length]) return table.values[table.valptr[length] + code - table.mincode[length]];
    }
    throw new Error("bad huffman code");
  }
  extend(n: number) {
    if (!n) return 0;
    const value = this.read(n);
    return value < 1 << (n - 1) ? value - (1 << n) + 1 : value;
  }
  /** Drops what is left of the interval and steps over its restart marker. */
  restart() {
    this.bits = 0;
    this.count = 0;
    let at = this.at;
    while (at + 1 < this.data.length && !(this.data[at] === 0xff && this.data[at + 1] !== 0)) at++;
    if (this.data[at] === 0xff && this.data[at + 1] >= 0xd0 && this.data[at + 1] <= 0xd7) {
      this.at = at + 2;
      this.marker = false;
    }
  }
}

const u16 = (d: Uint8Array, i: number) => (d[i] << 8) | d[i + 1];
type Frame = {
  width: number;
  height: number;
  precision: number;
  progressive: boolean;
  components: Component[];
  mcusPerLine: number;
  mcusPerColumn: number;
  hmax: number;
  vmax: number;
};

export function* decodeJpeg(data: Uint8Array): Steps<SmallImage | null> {
  const quant: Int32Array[] = [];
  const dcTables: Huffman[] = [],
    acTables: Huffman[] = [];
  let frame: Frame | null = null;
  let restartInterval = 0,
    adobe = -1,
    at = 2,
    scans = 0;
  while (at + 4 <= data.length) {
    if (data[at] !== 0xff) {
      at++;
      continue;
    }
    const marker = data[at + 1];
    if (marker === 0xff || marker === 0x00 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += marker === 0xff ? 1 : 2;
      continue;
    }
    if (marker === 0xd9) break;
    const length = u16(data, at + 2),
      start = at + 4,
      end = at + 2 + length;
    if (length < 2 || end > data.length) break;
    if (marker === 0xdb) {
      for (let p = start; p < end; ) {
        const pq = data[p] >> 4,
          tq = data[p] & 15;
        const table = new Int32Array(64);
        for (let i = 0; i < 64; i++) table[i] = pq ? u16(data, p + 1 + i * 2) : data[p + 1 + i];
        quant[tq] = table;
        p += 1 + 64 * (pq ? 2 : 1);
      }
    } else if (marker === 0xc4) {
      for (let p = start; p < end; ) {
        const tc = data[p] >> 4,
          th = data[p] & 15;
        const counts = data.subarray(p + 1, p + 17);
        let total = 0;
        for (const c of counts) total += c;
        const table = buildHuffman(counts, data.subarray(p + 17, p + 17 + total));
        (tc ? acTables : dcTables)[th] = table;
        p += 17 + total;
      }
    } else if (marker === 0xdd) restartInterval = u16(data, start);
    else if (marker === 0xee && String.fromCharCode(...data.subarray(start, start + 5)) === "Adobe") adobe = data[start + 11];
    else if (marker >= 0xc0 && marker <= 0xc2) {
      const precision = data[start],
        height = u16(data, start + 1),
        width = u16(data, start + 3),
        count = data[start + 5];
      if (!width || !height || width * height > MAX_DECODE_PIXELS || count < 1 || count > 4) return null;
      const components: Component[] = [];
      for (let i = 0; i < count; i++) {
        const p = start + 6 + i * 3;
        components.push({ id: data[p], h: data[p + 1] >> 4 || 1, v: data[p + 1] & 15 || 1, tq: data[p + 2], blocksPerLine: 0, blocksPerColumn: 0, dc: new Int32Array(0), pred: 0 });
      }
      const hmax = Math.max(...components.map((c) => c.h)),
        vmax = Math.max(...components.map((c) => c.v));
      const mcusPerLine = Math.ceil(width / 8 / hmax),
        mcusPerColumn = Math.ceil(height / 8 / vmax);
      for (const c of components) {
        c.blocksPerLine = Math.ceil(Math.ceil((width * c.h) / hmax) / 8);
        c.blocksPerColumn = Math.ceil(Math.ceil((height * c.v) / vmax) / 8);
        c.dc = new Int32Array(mcusPerLine * c.h * mcusPerColumn * c.v);
      }
      frame = { width, height, precision, progressive: marker === 0xc2, components, mcusPerLine, mcusPerColumn, hmax, vmax };
    } else if (marker >= 0xc3 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return null;
    else if (marker === 0xda) {
      if (!frame) return null;
      const count = data[start];
      const scan: Component[] = [];
      for (let i = 0; i < count; i++) {
        const id = data[start + 1 + i * 2],
          tables = data[start + 2 + i * 2];
        const c = frame.components.find((x) => x.id === id);
        if (!c) return null;
        c.dcTable = dcTables[tables >> 4];
        c.acTable = acTables[tables & 15];
        scan.push(c);
      }
      const p = start + 1 + count * 2;
      const ss = data[p],
        se = data[p + 1],
        ah = data[p + 2] >> 4,
        al = data[p + 2] & 15;
      const bits = new Bits(data, end);
      // Progressive AC scans hold nothing an eighth of the picture needs.
      if (!frame.progressive || ss === 0) {
        yield* decodeScan(frame, scan, bits, restartInterval, frame.progressive ? { ah, al } : null, se);
        scans++;
      }
      // On to the next marker after the entropy-coded data.
      let q = frame.progressive && ss !== 0 ? end : bits.at;
      while (q + 1 < data.length && !(data[q] === 0xff && data[q + 1] !== 0 && !(data[q + 1] >= 0xd0 && data[q + 1] <= 0xd7))) q++;
      at = q;
      continue;
    }
    at = end;
  }
  if (!frame || !scans) return null;
  return toPixels(frame, quant, adobe);
}

function* decodeScan(
  frame: Frame,
  scan: Component[],
  bits: Bits,
  restartInterval: number,
  progressive: { ah: number; al: number } | null,
  se: number,
): Steps<void> {
  for (const c of scan) {
    c.pred = 0;
    if (!c.dcTable && !(progressive && progressive.ah)) throw new Error("missing table");
    if (!progressive && se > 0 && !c.acTable) throw new Error("missing table");
  }
  const block = (c: Component, row: number, col: number) => {
    const index = row * frame.mcusPerLine * c.h + col;
    if (progressive) {
      if (progressive.ah === 0) {
        const t = bits.decode(c.dcTable!);
        c.pred += bits.extend(t);
        if (index < c.dc.length) c.dc[index] = c.pred * (1 << progressive.al);
      } else if (bits.read(1) && index < c.dc.length) c.dc[index] |= 1 << progressive.al;
      return;
    }
    const t = bits.decode(c.dcTable!);
    c.pred += bits.extend(t);
    if (index < c.dc.length) c.dc[index] = c.pred;
    // The AC coefficients are read only to get past them.
    for (let k = 1; k <= se; ) {
      const rs = bits.decode(c.acTable!);
      const s = rs & 15,
        r = rs >> 4;
      if (!s) {
        if (r < 15) break;
        k += 16;
        continue;
      }
      k += r;
      bits.skip(s);
      k++;
    }
  };
  const single = scan.length === 1;
  const total = single
    ? scan[0].blocksPerLine * scan[0].blocksPerColumn
    : frame.mcusPerLine * frame.mcusPerColumn;
  for (let n = 0; n < total; n++) {
    if ((n & 1023) === 1023) yield;
    if (restartInterval && n && n % restartInterval === 0) {
      bits.restart();
      for (const c of scan) c.pred = 0;
    }
    if (single) {
      const c = scan[0];
      block(c, Math.floor(n / c.blocksPerLine), n % c.blocksPerLine);
    } else {
      const mcuRow = Math.floor(n / frame.mcusPerLine),
        mcuCol = n % frame.mcusPerLine;
      for (const c of scan)
        for (let v = 0; v < c.v; v++) for (let h = 0; h < c.h; h++) block(c, mcuRow * c.v + v, mcuCol * c.h + h);
    }
  }
}

function toPixels(frame: Frame, quant: Int32Array[], adobe: number): SmallImage | null {
  const w = Math.ceil(frame.width / 8),
    h = Math.ceil(frame.height / 8);
  const out = new Downsampler(w, h);
  const shift = frame.precision > 8 ? frame.precision - 8 : 0;
  const center = 128 << shift;
  // The block average: DC × q / 8 + 128, per component.
  const value = (c: Component, x: number, y: number) => {
    const bx = Math.min(c.blocksPerLine - 1, Math.floor((x * c.h) / frame.hmax)),
      by = Math.min(c.blocksPerColumn - 1, Math.floor((y * c.v) / frame.vmax));
    const q = quant[c.tq]?.[0] ?? 1;
    const v = (c.dc[by * frame.mcusPerLine * c.h + bx] * q) / 8 + center;
    return Math.max(0, Math.min(255, v / (1 << shift)));
  };
  const [c0, c1, c2, c3] = frame.components;
  const count = frame.components.length;
  const rgb = count === 3 && (adobe === 0 || (adobe < 0 && c0.id === 82 && c1.id === 71 && c2.id === 66));
  const row = new Uint8Array(w * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0, j = 0; x < w; x++, j += 4) {
      let r: number, g: number, b: number;
      if (count < 3) r = g = b = value(c0, x, y);
      else if (count === 3) {
        const Y = value(c0, x, y),
          cb = value(c1, x, y),
          cr = value(c2, x, y);
        if (rgb) [r, g, b] = [Y, cb, cr];
        else [r, g, b] = ycc(Y, cb, cr);
      } else {
        let [c, m, ye] = [value(c0, x, y), value(c1, x, y), value(c2, x, y)];
        const k = value(c3, x, y);
        if (adobe === 2) [c, m, ye] = ycc(c, m, ye);
        // Adobe stores CMYK inverted: 255 means no ink.
        r = (c * k) / 255;
        g = (m * k) / 255;
        b = (ye * k) / 255;
      }
      row[j] = r;
      row[j + 1] = g;
      row[j + 2] = b;
      row[j + 3] = 255;
    }
    out.row(y, row);
  }
  return out.result();
}

function ycc(y: number, cb: number, cr: number): [number, number, number] {
  const clamp = (v: number) => Math.max(0, Math.min(255, v));
  return [clamp(y + 1.402 * (cr - 128)), clamp(y - 0.344136 * (cb - 128) - 0.714136 * (cr - 128)), clamp(y + 1.772 * (cb - 128))];
}
