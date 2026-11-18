// A small picture for image occlusion tests and the UI gallery: a PNG drawn
// in memory (zlib + CRC, no image library) – a light background with a few
// coloured regions to put masks on, like a labelled diagram.
import { crc32, deflateSync } from "node:zlib";

type Rgb = [number, number, number];
export type Region = { shape: "rect" | "ellipse"; x: number; y: number; w: number; h: number; color: Rgb };

// The regions of the sample picture, in proportions (0–1).
export const DIAGRAM_REGIONS: Region[] = [
  { shape: "ellipse", x: 0.08, y: 0.18, w: 0.26, h: 0.42, color: [214, 92, 74] },
  { shape: "rect", x: 0.4, y: 0.12, w: 0.22, h: 0.3, color: [72, 132, 196] },
  { shape: "rect", x: 0.7, y: 0.2, w: 0.22, h: 0.22, color: [88, 168, 104] },
  { shape: "ellipse", x: 0.42, y: 0.56, w: 0.3, h: 0.32, color: [226, 168, 60] },
  { shape: "rect", x: 0.08, y: 0.7, w: 0.24, h: 0.18, color: [138, 104, 186] },
];

function chunk(type: string, data: Buffer) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}

export function diagramPng(width = 640, height = 400, regions: Region[] = DIAGRAM_REGIONS): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const fx = x / width,
        fy = y / height;
      // A faint grid on a warm white, the regions on top (with a border).
      let color: Rgb = x % 40 === 0 || y % 40 === 0 ? [232, 228, 218] : [250, 248, 243];
      for (const r of regions) {
        const inside =
          r.shape === "rect"
            ? fx >= r.x && fx <= r.x + r.w && fy >= r.y && fy <= r.y + r.h
            : ((fx - (r.x + r.w / 2)) / (r.w / 2)) ** 2 + ((fy - (r.y + r.h / 2)) / (r.h / 2)) ** 2 <= 1;
        if (inside) color = r.color;
      }
      raw.set(color, row + 1 + x * 3);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
