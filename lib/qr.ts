// A small QR code encoder for the setup of authenticator apps: byte mode,
// error correction level M, versions 1–10 (up to 213 bytes – an otpauth://
// link needs about 120). Follows ISO/IEC 18004; no dependency.
// qrModules() returns the dark modules row by row, qrPath() an SVG path.

// Error correction codewords per block and number of blocks, level M.
const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const MAX_VERSION = 10;
const FORMAT_M = 0; // Level M in the format information.

function rawDataModules(version: number) {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    result -= (25 * align - 10) * align - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}
const dataCodewords = (version: number) => Math.floor(rawDataModules(version) / 8) - ECC_PER_BLOCK[version] * BLOCKS[version];

// Arithmetic in GF(2^8) with the polynomial 0x11D.
function multiply(x: number, y: number) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 255;
}
function divisor(degree: number) {
  const result: number[] = new Array(degree - 1).fill(0);
  result.push(1);
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = multiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = multiply(root, 2);
  }
  return result;
}
function remainder(data: number[], div: number[]) {
  const result = div.map(() => 0);
  for (const byte of data) {
    const factor = byte ^ (result.shift() as number);
    result.push(0);
    div.forEach((coef, i) => (result[i] ^= multiply(coef, factor)));
  }
  return result;
}

function alignmentPositions(version: number, size: number) {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < count; pos -= step) result.splice(1, 0, pos);
  return result;
}

export function qrModules(text: string): boolean[][] {
  const bytes = [...Buffer.from(text, "utf8")];
  let version = 1;
  const countBits = (v: number) => (v < 10 ? 8 : 16);
  while (version <= MAX_VERSION && 4 + countBits(version) + bytes.length * 8 > dataCodewords(version) * 8) version++;
  if (version > MAX_VERSION) throw new Error("Zu viel Text für den QR-Code.");
  const size = version * 4 + 17;

  // Data bits: mode (byte), length, bytes, terminator, padding.
  const bits: number[] = [];
  const append = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  append(4, 4);
  append(bytes.length, countBits(version));
  for (const b of bytes) append(b, 8);
  const capacity = dataCodewords(version) * 8;
  append(0, Math.min(4, capacity - bits.length));
  append(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) append(pad, 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));

  // Error correction per block, then interleaved.
  const blocks = BLOCKS[version],
    eccLength = ECC_PER_BLOCK[version],
    raw = Math.floor(rawDataModules(version) / 8),
    shortBlocks = blocks - (raw % blocks),
    shortLength = Math.floor(raw / blocks),
    div = divisor(eccLength);
  const parts: number[][] = [];
  for (let i = 0, k = 0; i < blocks; i++) {
    const chunk = data.slice(k, k + shortLength - eccLength + (i < shortBlocks ? 0 : 1));
    k += chunk.length;
    const ecc = remainder(chunk, div);
    if (i < shortBlocks) chunk.push(0);
    parts.push(chunk.concat(ecc));
  }
  const codewords: number[] = [];
  for (let i = 0; i < parts[0].length; i++)
    for (let j = 0; j < parts.length; j++) if (i !== shortLength - eccLength || j >= shortBlocks) codewords.push(parts[j][i]);

  // Function patterns.
  const modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const fixed = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (x: number, y: number, dark: boolean) => {
    modules[y][x] = dark;
    fixed[y][x] = true;
  };
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy)),
          x = cx + dx,
          y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
      }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  const align = alignmentPositions(version, size);
  for (let i = 0; i < align.length; i++)
    for (let j = 0; j < align.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) set(align[i] + dx, align[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  const format = (mask: number) => {
    const value = (FORMAT_M << 3) | mask;
    let rem = value;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const word = ((value << 10) | rem) ^ 0x5412;
    const bit = (i: number) => ((word >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6));
    set(8, 8, bit(7));
    set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  format(0); // Reserves the area; written again with the chosen mask.
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const word = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((word >>> i) & 1) !== 0,
        a = size - 11 + (i % 3),
        b = Math.floor(i / 3);
      set(a, b, dark);
      set(b, a, dark);
    }
  }

  // Codewords in the zigzag, two columns at a time from the right.
  let index = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++)
      for (let j = 0; j < 2; j++) {
        const x = right - j,
          upward = ((right + 1) & 2) === 0,
          y = upward ? size - 1 - vert : vert;
        if (!fixed[y][x] && index < codewords.length * 8) {
          modules[y][x] = ((codewords[index >>> 3] >>> (7 - (index & 7))) & 1) !== 0;
          index++;
        }
      }
  }

  const masked = (mask: number, x: number, y: number) => {
    switch (mask) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
      case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
      case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
      default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    }
  };
  const applyMask = (mask: number) => {
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) if (!fixed[y][x] && masked(mask, x, y)) modules[y][x] = !modules[y][x];
  };
  // The mask with the fewest patterns that confuse scanners.
  let best = 0,
    lowest = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(mask);
    format(mask);
    const score = penalty(modules);
    if (score < lowest) {
      lowest = score;
      best = mask;
    }
    applyMask(mask);
  }
  applyMask(best);
  format(best);
  return modules;
}

// Penalty rules of the standard: runs, 2×2 blocks, finder-like patterns
// and the balance of dark and light.
function penalty(m: boolean[][]) {
  const size = m.length;
  let score = 0,
    dark = 0;
  const line = (get: (i: number) => boolean) => {
    let s = 0,
      run = 1;
    for (let i = 1; i <= size; i++) {
      if (i < size && get(i) === get(i - 1)) run++;
      else {
        if (run >= 5) s += run - 2;
        run = 1;
      }
    }
    // 1:1:3:1:1 with four light modules on one side.
    for (let i = 0; i + 6 < size; i++) {
      const pattern = [true, false, true, true, true, false, true];
      let match = pattern.every((p, k) => get(i + k) === p);
      if (match) {
        const before = i >= 4 && [1, 2, 3, 4].every((k) => !get(i - k));
        const after = i + 10 < size && [7, 8, 9, 10].every((k) => !get(i + k));
        match = before || after;
      }
      if (match) s += 40;
    }
    return s;
  };
  for (let y = 0; y < size; y++) score += line((x) => m[y][x]);
  for (let x = 0; x < size; x++) score += line((y) => m[y][x]);
  for (let y = 0; y < size - 1; y++)
    for (let x = 0; x < size - 1; x++) {
      const c = m[y][x];
      if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += 3;
    }
  for (const row of m) for (const cell of row) if (cell) dark++;
  const total = size * size;
  score += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10;
  return score;
}

// An SVG path of the dark modules (one unit per module, no quiet zone).
export function qrPath(modules: boolean[][]) {
  let d = "";
  modules.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) d += `M${x} ${y}h1v1h-1z`;
    }),
  );
  return d;
}
