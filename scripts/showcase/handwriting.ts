// Natural-looking handwriting for the showcase workspace: text set in a
// single-stroke script font (Hershey Script, public domain), then smoothed,
// slanted, slightly wobbly and with pen pressure, as if written with a
// stylus. Produces ink items (lib/ink/model.ts) in page units (points).
import { readFileSync } from "node:fs";
import type { InkStroke } from "../../lib/ink/model";

type Glyph = [number, ...number[][]];
const font = JSON.parse(readFileSync(new URL("./hershey-script.json", import.meta.url), "utf8")) as Record<string, Glyph | string>;
const glyph = (c: string) => (typeof font[c] === "object" ? (font[c] as Glyph) : null);

// A small deterministic random generator, so every build writes the same.
export function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Pt = [number, number];
// Chaikin corner cutting: the font's polylines become smooth curves.
function smooth(points: Pt[], rounds = 2): Pt[] {
  let list = points;
  for (let r = 0; r < rounds && list.length > 2; r++) {
    const next: Pt[] = [list[0]];
    for (let i = 0; i < list.length - 1; i++) {
      const [a, b] = [list[i], list[i + 1]];
      next.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    next.push(list[list.length - 1]);
    list = next;
  }
  return list;
}
// Evenly spaced points (a stylus reports at a steady rate).
function resample(points: Pt[], step: number): Pt[] {
  if (points.length < 2) return points;
  const out: Pt[] = [points[0]];
  let carry = 0;
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1], points[i]];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let d = step - carry;
    while (d <= len) {
      out.push([a[0] + ((b[0] - a[0]) * d) / len, a[1] + ((b[1] - a[1]) * d) / len]);
      d += step;
    }
    carry = len - (d - step);
  }
  out.push(points[points.length - 1]);
  return out;
}

export type HandOptions = {
  x: number;
  // Baseline of the first line.
  y: number;
  // Em size in points (capitals are about 0.6 of it).
  size?: number;
  color?: string;
  width?: number;
  // Lines wrap at this width; "\n" starts a new line.
  maxWidth?: number;
  lineHeight?: number;
  seed?: number;
  slant?: number;
};

// Text as pen strokes; returns the strokes and where the text ended.
export function handwriting(text: string, options: HandOptions) {
  const size = options.size ?? 28;
  const scale = size / 1000;
  const rnd = random(options.seed ?? text.length * 7919);
  // The script font's ß reads like a 3: written as "ss", as many people do.
  text = text.replace(/ß/g, "ss");
  const slant = options.slant ?? 0.18;
  const lineHeight = options.lineHeight ?? size * 1.25;
  const maxWidth = options.maxWidth ?? Infinity;
  const strokes: InkStroke[] = [];
  let id = 0;
  // Layout: words, wrapped at maxWidth (font units → points).
  const wordWidth = (word: string) => [...word].reduce((w, c) => w + (glyph(c)?.[0] ?? 400), 0) * scale;
  const space = (glyph(" ")?.[0] ?? 320) * scale * 0.9;
  const lines: string[][] = [];
  for (const paragraph of text.split("\n")) {
    let line: string[] = [];
    let width = 0;
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const w = wordWidth(word);
      if (line.length && width + space + w > maxWidth) {
        lines.push(line);
        line = [];
        width = 0;
      }
      width += (line.length ? space : 0) + w;
      line.push(word);
    }
    lines.push(line);
  }
  let baseline = options.y;
  let endX = options.x;
  for (const line of lines) {
    let x = options.x + (rnd() - 0.5) * size * 0.1;
    // The line drifts a little up or down, as on unruled paper.
    const drift = (rnd() - 0.5) * 0.012;
    for (const word of line) {
      const wordScale = scale * (0.96 + rnd() * 0.08);
      const wordLift = (rnd() - 0.5) * size * 0.04;
      // Strokes of one word, in font units already placed.
      const placed: Pt[][] = [];
      let cursor = 0;
      for (const c of word) {
        const g = glyph(c) ?? glyph("?")!;
        const [advance, ...parts] = g;
        for (const part of parts) {
          const pts: Pt[] = [];
          for (let i = 0; i + 1 < part.length; i += 2) pts.push([part[i] + cursor, part[i + 1]]);
          if (!pts.length) continue;
          // Cursive: a letter starting where the previous one ended joins it.
          const last = placed[placed.length - 1];
          const tail = last?.[last.length - 1];
          if (tail && Math.hypot(tail[0] - pts[0][0], tail[1] - pts[0][1]) < 70) last.push(...pts.slice(1));
          else placed.push(pts);
        }
        cursor += advance * (0.97 + rnd() * 0.06);
      }
      for (const part of placed) {
        const wobble = [rnd() * 6, rnd() * 6];
        const page = part.map(([fx, fy]): Pt => {
          const px = x + fx * wordScale + fy * wordScale * slant;
          const py = baseline + wordLift + (x - options.x) * drift - fy * wordScale;
          return [px, py];
        });
        const curve = resample(smooth(page), Math.max(0.8, size * 0.045));
        const points: number[] = [];
        curve.forEach(([px, py], i) => {
          // Slow wobble of the hand.
          const t = i / Math.max(1, curve.length - 1);
          const wx = Math.sin(t * 5 + wobble[0]) * size * 0.006;
          const wy = Math.cos(t * 4 + wobble[1]) * size * 0.006;
          // More pressure on down strokes, lighter at start and end.
          const prev = curve[Math.max(0, i - 1)];
          const down = py - prev[1] > 0 ? 0.12 : -0.05;
          const taper = Math.min(1, i / 3, (curve.length - 1 - i) / 3);
          const pressure = Math.max(0.15, Math.min(0.95, (0.42 + down + (rnd() - 0.5) * 0.04) * (0.55 + 0.45 * taper)));
          points.push(Math.round((px + wx) * 100) / 100, Math.round((py + wy) * 100) / 100, Math.round(pressure * 100) / 100);
        });
        if (points.length >= 6)
          strokes.push({ id: `hw${(options.seed ?? 0).toString(36)}-${(id++).toString(36)}`, type: "pen", color: options.color ?? "#1f2a44", width: options.width ?? Math.max(1, size * 0.055), points });
      }
      x += cursor * wordScale + space * (0.9 + rnd() * 0.25);
      endX = Math.max(endX, x);
    }
    baseline += lineHeight;
  }
  return { strokes, bottom: baseline - lineHeight, right: endX };
}

// A freehand line or shape through the given points (underlines, arrows,
// circles around a word).
// `corners`: keep the corners (boxes) instead of rounding the path.
export function penPath(points: Pt[], options: { color?: string; width?: number; seed?: number; id: string; type?: "pen" | "highlighter"; corners?: boolean }): InkStroke {
  const rnd = random(options.seed ?? 1);
  const curve = resample(options.corners ? points : smooth(points, 3), 1.5);
  const flat: number[] = [];
  curve.forEach(([x, y], i) => {
    const taper = Math.min(1, i / 4, (curve.length - 1 - i) / 4);
    flat.push(Math.round((x + (rnd() - 0.5) * 0.4) * 100) / 100, Math.round((y + (rnd() - 0.5) * 0.4) * 100) / 100, options.type === "highlighter" ? 0.5 : Math.round((0.35 + 0.2 * taper) * 100) / 100);
  });
  return { id: options.id, type: options.type ?? "pen", color: options.color ?? "#1f2a44", width: options.width ?? 1.6, points: flat };
}
// An ellipse-ish loop for circling something, not quite closed.
export function loop(cx: number, cy: number, rx: number, ry: number, seed = 3): Pt[] {
  const rnd = random(seed);
  const pts: Pt[] = [];
  const start = -0.4 + rnd() * 0.3;
  for (let a = 0; a <= Math.PI * 2.15; a += 0.18) {
    const r = 1 + (rnd() - 0.5) * 0.05;
    pts.push([cx + Math.cos(a + start) * rx * r, cy + Math.sin(a + start) * ry * r]);
  }
  return pts;
}
