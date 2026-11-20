// The dark whiteboard canvas (#399): how a board's stored colours are shown
// on it. Display only – the stored colours never change, other people see
// their own setting (lib/whiteboard-canvas-pref.ts) and the exports stay
// light. Pure functions, used by the board (components/whiteboard/
// board-colors.tsx) and tested in tests/whiteboard-display-colors.test.ts.
//
// - Ink (strokes, pen, outlines, connectors, text on the canvas): very dark
//   colours turn light – their lightness is mirrored, the hue kept – so
//   black on the dark canvas reads as near-white. Mid and light colours stay.
// - Fills (notes, shapes, frames, cards): light fills are toned down –
//   darker and less saturated, their hue kept – so the board does not glare.
//   Mid and dark fills stay.
// - Text on a fill: the ink mapping, then nudged lighter or darker until it
//   has a contrast of at least 4.5:1 (WCAG AA) against the shown fill.
// Both maps are idempotent: a shown colour maps to itself.

export type Rgba = { r: number; g: number; b: number; a: number };

// The dark canvas (the dark theme's --bg in app/globals.css) and the
// surfaces drawn on it, as plain colours for the contrast calculations.
export const DARK_CANVAS = "#16151b";
// Light colours below this relative luminance count as "very dark" ink:
// against the dark canvas they would have a contrast below about 2.5:1.
export const DARK_INK_LUMINANCE = 0.1;
// Fills above this relative luminance count as light and are toned down.
export const LIGHT_FILL_LUMINANCE = 0.4;
// The lightest that very dark ink is shown in (HSL lightness).
export const INK_MAX_LIGHTNESS = 0.84;
export const AA_CONTRAST = 4.5;

const NAMED: Record<string, string> = {
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
  green: "#008000",
  lime: "#00ff00",
  blue: "#0000ff",
  yellow: "#ffff00",
  orange: "#ffa500",
  purple: "#800080",
  fuchsia: "#ff00ff",
  magenta: "#ff00ff",
  aqua: "#00ffff",
  cyan: "#00ffff",
  teal: "#008080",
  navy: "#000080",
  maroon: "#800000",
  olive: "#808000",
  gray: "#808080",
  grey: "#808080",
  silver: "#c0c0c0",
  pink: "#ffc0cb",
  brown: "#a52a2a",
  gold: "#ffd700",
  indigo: "#4b0082",
  violet: "#ee82ee",
  darkgray: "#a9a9a9",
  darkgrey: "#a9a9a9",
  dimgray: "#696969",
  dimgrey: "#696969",
  lightgray: "#d3d3d3",
  lightgrey: "#d3d3d3",
  darkblue: "#00008b",
  darkred: "#8b0000",
  darkgreen: "#006400",
  darkslategray: "#2f4f4f",
  darkslategrey: "#2f4f4f",
  midnightblue: "#191970",
  whitesmoke: "#f5f5f5",
  ivory: "#fffff0",
  beige: "#f5f5dc",
  lavender: "#e6e6fa",
  lightyellow: "#ffffe0",
  lightblue: "#add8e6",
  lightgreen: "#90ee90",
  lightpink: "#ffb6c1",
};

const clamp = (n: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, n));

// A CSS colour as RGBA (0–255, alpha 0–1): #rgb, #rgba, #rrggbb,
// #rrggbbaa, rgb()/rgba() and the common named colours. Anything else
// (gradients, url(), var(), "none", "currentColor", typos) is null.
export function parseColor(input: unknown): Rgba | null {
  if (typeof input !== "string") return null;
  const value = input.trim().toLowerCase();
  if (value === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  const named = NAMED[value];
  if (named) return parseColor(named);
  let m = /^#([0-9a-f]{3,8})$/.exec(value);
  if (m) {
    const hex = m[1];
    if (hex.length === 3 || hex.length === 4) {
      const [r, g, b, a = "f"] = hex.split("");
      return { r: parseInt(r + r, 16), g: parseInt(g + g, 16), b: parseInt(b + b, 16), a: parseInt(a + a, 16) / 255 };
    }
    if (hex.length === 6 || hex.length === 8)
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
        a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
      };
    return null;
  }
  m = /^rgba?\(\s*([\d.]+%?)\s*[,\s]\s*([\d.]+%?)\s*[,\s]\s*([\d.]+%?)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/.exec(value);
  if (m) {
    const channel = (s: string) => (s.endsWith("%") ? (parseFloat(s) / 100) * 255 : parseFloat(s));
    const alpha = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    const [r, g, b] = [m[1], m[2], m[3]].map(channel);
    if (![r, g, b, alpha].every(Number.isFinite)) return null;
    return { r: clamp(r, 0, 255), g: clamp(g, 0, 255), b: clamp(b, 0, 255), a: clamp(alpha) };
  }
  return null;
}

const hex2 = (n: number) => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, "0");
// #rrggbb, or #rrggbbaa when not opaque.
export function formatColor({ r, g, b, a }: Rgba) {
  return `#${hex2(r)}${hex2(g)}${hex2(b)}${a < 1 ? hex2(a * 255) : ""}`;
}

const linear = (c: number) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
// WCAG relative luminance of the opaque colour.
export function luminance({ r, g, b }: Rgba) {
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}
// A colour with alpha laid over an opaque background.
export function over(top: Rgba, bottom: Rgba): Rgba {
  const a = top.a;
  return { r: top.r * a + bottom.r * (1 - a), g: top.g * a + bottom.g * (1 - a), b: top.b * a + bottom.b * (1 - a), a: 1 };
}
// WCAG contrast ratio of two colours (the first laid over the second when
// it is translucent; a translucent second over the dark canvas).
export function contrastRatio(a: string | Rgba, b: string | Rgba) {
  const canvas = parseColor(DARK_CANVAS)!;
  const pb = typeof b === "string" ? parseColor(b) : b,
    pa = typeof a === "string" ? parseColor(a) : a;
  if (!pa || !pb) return 1;
  const back = pb.a < 1 ? over(pb, canvas) : pb;
  const front = pa.a < 1 ? over(pa, back) : pa;
  const [l1, l2] = [luminance(front), luminance(back)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

type Hsl = { h: number; s: number; l: number };
function toHsl({ r, g, b }: Rgba): Hsl {
  const rn = r / 255,
    gn = g / 255,
    bn = b / 255;
  const max = Math.max(rn, gn, bn),
    min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === rn ? (gn - bn) / d + (gn < bn ? 6 : 0) : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4;
  return { h: h * 60, s, l };
}
function fromHsl({ h, s, l }: Hsl, a: number): Rgba {
  const k = (n: number) => (n + h / 30) % 12;
  const q = s * Math.min(l, 1 - l);
  const f = (n: number) => l - q * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return { r: Math.round(f(0) * 255), g: Math.round(f(8) * 255), b: Math.round(f(4) * 255), a };
}

// Ink on the dark canvas: very dark colours mirrored to light (at least
// 72 % lightness, at most 84 %, so black reads as near-white rather than
// glaring white); everything else as stored. Invalid input is returned
// unchanged.
export function darkInk(color: string): string {
  const c = parseColor(color);
  if (!c || c.a === 0 || luminance(c) >= DARK_INK_LUMINANCE) return color;
  const hsl = toHsl(c);
  return formatColor(fromHsl({ h: hsl.h, s: hsl.s, l: clamp(1 - hsl.l, 0.72, INK_MAX_LIGHTNESS) }, c.a));
}

// A fill on the dark canvas: light fills toned down to 18–30 % lightness
// (lighter originals stay a little darker, so white is the darkest – just
// above the canvas) at 45 % of their saturation; mid and dark fills as
// stored.
export function darkFill(color: string): string {
  const c = parseColor(color);
  if (!c || c.a === 0 || luminance(c) <= LIGHT_FILL_LUMINANCE) return color;
  const hsl = toHsl(c);
  return formatColor(fromHsl({ h: hsl.h, s: hsl.s * 0.45, l: 0.18 + (1 - hsl.l) * 0.24 }, c.a));
}

// Lines that only structure (frame and card borders, table rules): light
// greys toned down like fills but a step lighter, so they stay visible –
// never as dark as "very dark" ink, so drawn again as ink they stay.
export function darkLine(color: string): string {
  const c = parseColor(color);
  if (!c || c.a === 0 || luminance(c) <= LIGHT_FILL_LUMINANCE) return color;
  const hsl = toHsl(c);
  let l = 0.34 + (1 - hsl.l) * 0.2,
    shown = fromHsl({ h: hsl.h, s: hsl.s * 0.45, l }, c.a);
  while (luminance(shown) < DARK_INK_LUMINANCE && l < 1) shown = fromHsl({ h: hsl.h, s: hsl.s * 0.45, l: (l += 0.01) }, c.a);
  return formatColor(shown);
}

// The colour with lightness moved (keeping hue and saturation) as little
// as needed for the contrast against the background, or null when no
// lightness in that direction is enough.
function nudge(c: Rgba, background: string, min: number, up: boolean): { color: Rgba; step: number } | null {
  const hsl = toHsl(c);
  const at = (l: number) => fromHsl({ ...hsl, l }, c.a);
  const end = up ? 1 : 0;
  if (contrastRatio(at(end), background) < min) return null;
  let near = hsl.l,
    far = end;
  for (let i = 0; i < 24; i++) {
    const mid = (near + far) / 2;
    if (contrastRatio(at(mid), background) >= min) far = mid;
    else near = mid;
  }
  return { color: at(far), step: Math.abs(far - hsl.l) };
}

// Text on a background: the colour if it reaches the contrast (default
// 4.5:1, WCAG AA), else the closest lighter or darker shade of it that
// does, else black or white – whichever contrasts more.
export function readableOn(color: string, background: string, min = AA_CONTRAST): string {
  const c = parseColor(color);
  if (!c || !parseColor(background)) return color;
  if (contrastRatio(c, background) >= min) return color;
  const options = [nudge(c, background, min, true), nudge(c, background, min, false)].filter((o) => o !== null);
  if (options.length) return formatColor(options.sort((a, b) => a.step - b.step)[0].color);
  return contrastRatio("#ffffff", background) >= contrastRatio("#000000", background) ? "#ffffff" : "#000000";
}

// Text with the given colour on a shown fill (or on the dark canvas): the
// ink mapping when that reads well, the stored colour when that does,
// otherwise the ink nudged until it reaches 4.5:1.
export function darkText(color: string, background: string = DARK_CANVAS): string {
  if (!parseColor(color)) return color;
  const shownBackground = parseColor(background)?.a === 0 ? DARK_CANVAS : background;
  const ink = darkInk(color);
  if (contrastRatio(ink, shownBackground) >= AA_CONTRAST) return ink;
  if (contrastRatio(color, shownBackground) >= AA_CONTRAST) return color;
  return readableOn(ink, shownBackground);
}

// Colours inside SVG markup the board draws as strings (library shapes,
// timelines): fill and stroke attributes and the fill of text, mapped by
// their role – dark strokes as ink, light ones as lines, fills as fills,
// the fill of text as text on `textBackground`. `keep` lists colours the
// caller has mapped already.
export function darkMarkup(markup: string, keep: readonly string[] = [], textBackground: string = DARK_CANVAS): string {
  const kept = new Set(keep.map((k) => k.toLowerCase()));
  return markup.replace(/<(\w+)\b([^>]*)>/g, (whole, tag: string, attrs: string) => {
    const text = tag === "text" || tag === "tspan";
    const next = attrs.replace(/\b(fill|stroke)="([^"]*)"/g, (all, name: string, value: string) => {
      if (kept.has(value.toLowerCase()) || !parseColor(value)) return all;
      // Very light strokes in a drawing are rules and borders (lighter than
      // any ink is shown): toned like lines.
      const shown = name === "stroke" ? (toHsl(parseColor(value)!).l > INK_MAX_LIGHTNESS + 0.01 ? darkLine(value) : darkInk(value)) : text ? darkText(value, textBackground) : darkFill(value);
      return `${name}="${shown}"`;
    });
    return next === attrs ? whole : `<${tag}${next}>`;
  });
}

// What the board uses to show colours: the identity on the light canvas.
export type BoardPalette = {
  dark: boolean;
  canvas: string;
  ink: (color: string) => string;
  fill: (color: string) => string;
  line: (color: string) => string;
  text: (color: string, background?: string) => string;
  markup: (markup: string, keep?: readonly string[], textBackground?: string) => string;
};
const same = (color: string) => color;
export const LIGHT_PALETTE: BoardPalette = {
  dark: false,
  canvas: "#fafbfc",
  ink: same,
  fill: same,
  line: same,
  text: same,
  markup: same,
};
function cached<A extends unknown[]>(fn: (...args: A) => string) {
  const memo = new Map<string, string>();
  return (...args: A) => {
    const key = args.join("\u0000");
    let value = memo.get(key);
    if (value === undefined) {
      if (memo.size > 5000) memo.clear();
      value = fn(...args);
      memo.set(key, value);
    }
    return value;
  };
}
export const DARK_PALETTE: BoardPalette = {
  dark: true,
  canvas: DARK_CANVAS,
  ink: cached(darkInk),
  fill: cached(darkFill),
  line: cached(darkLine),
  text: cached((color: string, background: string = DARK_CANVAS) => darkText(color, background)),
  markup: cached((markup: string, keep: readonly string[] = [], background: string = DARK_CANVAS) => darkMarkup(markup, keep, background)),
};
export const boardPalette = (dark: boolean) => (dark ? DARK_PALETTE : LIGHT_PALETTE);
