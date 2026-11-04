import { readFileSync } from "node:fs";
const font = JSON.parse(readFileSync(new URL("./hershey-script.json", import.meta.url), "utf8"));
const glyph = (c) => typeof font[c] === "object" ? font[c] : null;
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = a + 1831565813 >>> 0;
    let t = a;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function smooth(points, rounds = 2) {
  let list = points;
  for (let r = 0; r < rounds && list.length > 2; r++) {
    const next = [list[0]];
    for (let i = 0; i < list.length - 1; i++) {
      const [a, b] = [list[i], list[i + 1]];
      next.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    next.push(list[list.length - 1]);
    list = next;
  }
  return list;
}
function resample(points, step) {
  if (points.length < 2) return points;
  const out = [points[0]];
  let carry = 0;
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1], points[i]];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let d = step - carry;
    while (d <= len) {
      out.push([a[0] + (b[0] - a[0]) * d / len, a[1] + (b[1] - a[1]) * d / len]);
      d += step;
    }
    carry = len - (d - step);
  }
  out.push(points[points.length - 1]);
  return out;
}
function handwriting(text, options) {
  const size = options.size ?? 28;
  const scale = size / 1e3;
  const rnd = random(options.seed ?? text.length * 7919);
  text = text.replace(/ß/g, "ss");
  const slant = options.slant ?? 0.18;
  const lineHeight = options.lineHeight ?? size * 1.25;
  const maxWidth = options.maxWidth ?? Infinity;
  const strokes = [];
  let id = 0;
  const wordWidth = (word) => [...word].reduce((w, c) => w + (glyph(c)?.[0] ?? 400), 0) * scale;
  const space = (glyph(" ")?.[0] ?? 320) * scale * 0.9;
  const lines = [];
  for (const paragraph of text.split("\n")) {
    let line = [];
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
    const drift = (rnd() - 0.5) * 0.012;
    for (const word of line) {
      const wordScale = scale * (0.96 + rnd() * 0.08);
      const wordLift = (rnd() - 0.5) * size * 0.04;
      const placed = [];
      let cursor = 0;
      for (const c of word) {
        const g = glyph(c) ?? glyph("?");
        const [advance, ...parts] = g;
        for (const part of parts) {
          const pts = [];
          for (let i = 0; i + 1 < part.length; i += 2) pts.push([part[i] + cursor, part[i + 1]]);
          if (!pts.length) continue;
          const last = placed[placed.length - 1];
          const tail = last?.[last.length - 1];
          if (tail && Math.hypot(tail[0] - pts[0][0], tail[1] - pts[0][1]) < 70) last.push(...pts.slice(1));
          else placed.push(pts);
        }
        cursor += advance * (0.97 + rnd() * 0.06);
      }
      for (const part of placed) {
        const wobble = [rnd() * 6, rnd() * 6];
        const page = part.map(([fx, fy]) => {
          const px = x + fx * wordScale + fy * wordScale * slant;
          const py = baseline + wordLift + (x - options.x) * drift - fy * wordScale;
          return [px, py];
        });
        const curve = resample(smooth(page), Math.max(0.8, size * 0.045));
        const points = [];
        curve.forEach(([px, py], i) => {
          const t = i / Math.max(1, curve.length - 1);
          const wx = Math.sin(t * 5 + wobble[0]) * size * 6e-3;
          const wy = Math.cos(t * 4 + wobble[1]) * size * 6e-3;
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
function penPath(points, options) {
  const rnd = random(options.seed ?? 1);
  const curve = resample(options.corners ? points : smooth(points, 3), 1.5);
  const flat = [];
  curve.forEach(([x, y], i) => {
    const taper = Math.min(1, i / 4, (curve.length - 1 - i) / 4);
    flat.push(Math.round((x + (rnd() - 0.5) * 0.4) * 100) / 100, Math.round((y + (rnd() - 0.5) * 0.4) * 100) / 100, options.type === "highlighter" ? 0.5 : Math.round((0.35 + 0.2 * taper) * 100) / 100);
  });
  return { id: options.id, type: options.type ?? "pen", color: options.color ?? "#1f2a44", width: options.width ?? 1.6, points: flat };
}
function loop(cx, cy, rx, ry, seed = 3) {
  const rnd = random(seed);
  const pts = [];
  const start = -0.4 + rnd() * 0.3;
  for (let a = 0; a <= Math.PI * 2.15; a += 0.18) {
    const r = 1 + (rnd() - 0.5) * 0.05;
    pts.push([cx + Math.cos(a + start) * rx * r, cy + Math.sin(a + start) * ry * r]);
  }
  return pts;
}
export {
  handwriting,
  loop,
  penPath,
  random
};
