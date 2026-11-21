import { test } from "node:test";
import assert from "node:assert/strict";
import { QR_QUIET_ZONE, qrModules, qrPath, qrSvg } from "../lib/qr";

// The QR encoder (lib/qr.ts) for authenticator apps, CalDAV profiles,
// contacts and form links (#415), read back by a small decoder written from
// ISO/IEC 18004 alone – its own tables, not the encoder's: format
// information, function patterns, masks, the zigzag, block interleaving,
// Reed–Solomon syndromes and the byte-mode segment.

// Level M per version: [error correction codewords per block, data codewords of each block].
const LEVEL_M: Record<number, [number, number[]]> = {
  1: [10, [16]],
  2: [16, [28]],
  3: [26, [44]],
  4: [18, [32, 32]],
  5: [24, [43, 43]],
  6: [16, [27, 27, 27, 27]],
  7: [18, [31, 31, 31, 31]],
  8: [22, [38, 38, 39, 39]],
  9: [22, [36, 36, 36, 37, 37]],
  10: [26, [43, 43, 43, 43, 44]],
};
const ALIGNMENT: Record<number, number[]> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
};

// GF(256) with the polynomial 0x11D.
const EXP: number[] = [],
  LOG: number[] = [];
for (let i = 0, x = 1; i < 255; i++, x = x & 0x80 ? ((x << 1) ^ 0x11d) & 255 : x << 1) {
  EXP[i] = x;
  LOG[x] = i;
}
const mul = (a: number, b: number) => (a && b ? EXP[(LOG[a] + LOG[b]) % 255] : 0);

function decode(m: boolean[][]) {
  const n = m.length,
    version = (n - 17) / 4;
  assert.ok(Number.isInteger(version) && LEVEL_M[version], `size ${n}`);
  const dark = (x: number, y: number) => m[y][x];

  // Format information next to the top-left finder, with its BCH check.
  const formatCells: [number, number][] = [
    ...[0, 1, 2, 3, 4, 5].map((y): [number, number] => [8, y]),
    [8, 7],
    [8, 8],
    [7, 8],
    ...[5, 4, 3, 2, 1, 0].map((x): [number, number] => [x, 8]),
  ];
  const word = formatCells.reduce((acc, [x, y], i) => acc | (+dark(x, y) << i), 0) ^ 0x5412;
  const value = word >>> 10;
  let bch = value << 10;
  for (let bit = 14; bit >= 10; bit--) if (bch & (1 << bit)) bch ^= 0x537 << (bit - 10);
  assert.equal(word & 0x3ff, bch, "format information checks out");
  assert.equal(value >>> 3, 0b00, "error correction level M");
  const mask = value & 7;
  // The copy of the format information at the other two finders.
  const second = [
    ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => dark(n - 1 - i, 8)),
    ...[8, 9, 10, 11, 12, 13, 14].map((i) => dark(8, n - 15 + i)),
  ].reduce((acc, bit, i) => acc | (+bit << i), 0);
  assert.equal(second ^ 0x5412, word, "both copies of the format information agree");
  assert.equal(dark(8, n - 8), true, "the dark module");

  // Finders with separators and format areas, timing, alignment, version information.
  const centers = ALIGNMENT[version];
  const reserved = (x: number, y: number) => {
    if ((x < 9 && y < 9) || (x >= n - 8 && y < 9) || (x < 9 && y >= n - 8)) return true;
    if (x === 6 || y === 6) return true;
    if (version >= 7 && ((x >= n - 11 && x < n - 8 && y < 6) || (y >= n - 11 && y < n - 8 && x < 6))) return true;
    return centers.some((cx, i) =>
      centers.some((cy, j) => {
        const last = centers.length - 1;
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return false;
        return Math.abs(x - cx) <= 2 && Math.abs(y - cy) <= 2;
      }),
    );
  };
  // Timing patterns alternate.
  for (let i = 8; i < n - 8; i++) {
    assert.equal(dark(i, 6), i % 2 === 0);
    assert.equal(dark(6, i), i % 2 === 0);
  }
  const masks = [
    (x: number, y: number) => (x + y) % 2 === 0,
    (_x: number, y: number) => y % 2 === 0,
    (x: number) => x % 3 === 0,
    (x: number, y: number) => (x + y) % 3 === 0,
    (x: number, y: number) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
    (x: number, y: number) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x: number, y: number) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x: number, y: number) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];

  // The zigzag, two columns at a time from the right, unmasked.
  const bits: boolean[] = [];
  let upward = true;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let i = 0; i < n; i++) {
      const y = upward ? n - 1 - i : i;
      for (const x of [right, right - 1]) if (!reserved(x, y)) bits.push(dark(x, y) !== masks[mask](x, y));
    }
    upward = !upward;
  }
  const codewords: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) codewords.push(bits.slice(i, i + 8).reduce((acc, b) => (acc << 1) | +b, 0));

  // Blocks: data codewords interleaved, then the error correction codewords.
  const [ecc, dataLengths] = LEVEL_M[version];
  const blocks = dataLengths.map(() => [] as number[]);
  let k = 0;
  for (let i = 0; i < Math.max(...dataLengths); i++) blocks.forEach((b, j) => i < dataLengths[j] && b.push(codewords[k++]));
  for (let i = 0; i < ecc; i++) blocks.forEach((b) => b.push(codewords[k++]));
  // Reed–Solomon: a correct block has zero syndromes at α^0 … α^(ecc-1).
  for (const block of blocks)
    for (let s = 0; s < ecc; s++) {
      const syndrome = block.reduce((acc, c) => mul(acc, EXP[s]) ^ c, 0);
      assert.equal(syndrome, 0, "error correction codewords match the data");
    }
  const data = blocks.flatMap((b, j) => b.slice(0, dataLengths[j]));

  // One byte-mode segment.
  const stream = data.flatMap((byte) => [7, 6, 5, 4, 3, 2, 1, 0].map((i) => (byte >>> i) & 1));
  let at = 0;
  const read = (length: number) => {
    let v = 0;
    for (let i = 0; i < length; i++) v = (v << 1) | stream[at++];
    return v;
  };
  assert.equal(read(4), 0b0100, "byte mode");
  const length = read(version < 10 ? 8 : 16);
  const bytes = Uint8Array.from({ length }, () => read(8));
  return { version, mask, text: new TextDecoder().decode(bytes) };
}

test("a form link encodes and decodes back (level M, version 5, 37 modules)", () => {
  const link = "https://flowplan.example.org/forms/3f2b8c1e-9a4d-4f6b-8e21-7c5d0a9b1e44";
  const modules = qrModules(link);
  assert.equal(modules.length, 37);
  const decoded = decode(modules);
  assert.equal(decoded.version, 5);
  assert.equal(decoded.text, link);
});

test("short and long texts, UTF-8 and several masks read back", () => {
  const masks = new Set<number>();
  for (const text of [
    "https://a.example/forms/x",
    "https://flowplan.example/forms/äöü-ß-表单",
    "otpauth://totp/Flowplan:ada%40example.org?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Flowplan&algorithm=SHA1&digits=6&period=30",
    "x".repeat(150),
    "y".repeat(213),
    ...Array.from({ length: 24 }, (_, i) => `https://flowplan.example/forms/${i.toString(36).repeat(i + 1)}`),
  ]) {
    const decoded = decode(qrModules(text));
    assert.equal(decoded.text, text);
    masks.add(decoded.mask);
  }
  assert.equal(decode(qrModules("y".repeat(213))).version, 10, "the largest version");
  assert.throws(() => qrModules("y".repeat(214)));
  assert.ok(masks.size >= 4, `several masks chosen (${[...masks]})`);
});

test("the SVG file: white tile with a quiet zone, the modules as one path", () => {
  const modules = qrModules("https://flowplan.example/forms/abc");
  const total = modules.length + 2 * QR_QUIET_ZONE;
  const svg = qrSvg(modules);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" /);
  assert.ok(svg.includes(`viewBox="0 0 ${total} ${total}"`));
  assert.ok(svg.includes(`<rect width="${total}" height="${total}" fill="#fff"/>`));
  assert.ok(svg.includes(`translate(${QR_QUIET_ZONE} ${QR_QUIET_ZONE})`));
  assert.ok(svg.includes(`d="${qrPath(modules)}" fill="#000"`));
  assert.ok(!/style=|<script/i.test(svg));
});
