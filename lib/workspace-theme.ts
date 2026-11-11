// A workspace's look (#196): one accent colour, a background tint and three
// typefaces (interface, headings, code), set by its owners in Settings →
// Workspace → Appearance and seen by every member – unless they chose
// Flowplan's own look for themselves (users.plain_look). Light or dark stays
// each person's choice (lib/theme.ts): the accent's palette is derived for
// both, in OKLCH, and its lightness moved until text on the accent and the
// accent as text on the page backgrounds reach WCAG AA (4.5:1).
// No custom CSS: CSS can read out content (attribute selectors with
// background URLs) and would break with every update of the app.
// Pure: no React, no DOM, no database (the server part is
// lib/workspace-fonts.ts and the commands in lib/api.ts).
import { z } from "zod";
import { BUNDLED_FONT_IDS, CUSTOM_PREFIX, DEFAULT_FONTS, FONT_SLOTS, bundledFontFaces, customFamily, customFontId, fontStack, type FontCategory, type FontSlot } from "./theme-fonts";

// ---- Colour ----

type Rgb = [number, number, number];
export type Oklch = { l: number; c: number; h: number };

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const fromLinear = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

export function parseHex(hex: string): Rgb {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`not a colour: ${hex}`);
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
const channel = (v: number) =>
  Math.round(Math.min(1, Math.max(0, v)) * 255)
    .toString(16)
    .padStart(2, "0");
export const toHex = ([r, g, b]: Rgb) => `#${channel(r)}${channel(g)}${channel(b)}`;

export function hexToOklch(hex: string): Oklch {
  const [r, g, b] = parseHex(hex).map(toLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const c = Math.hypot(A, B);
  return { l: L, c, h: c < 1e-4 ? 0 : ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360 };
}
function oklchToLinear({ l: L, c, h }: Oklch): Rgb {
  const A = c * Math.cos((h * Math.PI) / 180);
  const B = c * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}
const inGamut = (rgb: Rgb) => rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4);
// Into sRGB at the same lightness and hue: as much chroma as fits.
export function oklchToHex(color: Oklch) {
  const l = Math.min(1, Math.max(0, color.l));
  let target = { ...color, l };
  if (!inGamut(oklchToLinear(target))) {
    let lo = 0,
      hi = color.c;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklchToLinear({ ...target, c: mid }))) lo = mid;
      else hi = mid;
    }
    target = { ...target, c: lo };
  }
  return toHex(oklchToLinear(target).map(fromLinear) as Rgb);
}

// WCAG 2 relative luminance and contrast ratio.
export function luminance(hex: string) {
  const [r, g, b] = parseHex(hex).map(toLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a: string, b: string) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
export const MIN_CONTRAST = 4.5;

// ---- Backgrounds ----

export type Surfaces = { bg: string; surface: string; sidebar: string; hover: string; border: string };
export type BackgroundPreset = { id: string; light: Surfaces; dark: Surfaces };
// Curated tints only (no free background colours): the text colours of
// app/globals.css keep their contrast on each (tests/workspace-theme.test.ts).
export const BACKGROUND_PRESETS = [
  {
    id: "standard",
    light: { bg: "#fcfbf8", surface: "#f6f4ef", sidebar: "#f3f1eb", hover: "#ebe8e0", border: "#e4e0d6" },
    dark: { bg: "#16151b", surface: "#1d1c23", sidebar: "#121117", hover: "#29272f", border: "#2e2c35" },
  },
  {
    id: "neutral",
    light: { bg: "#fbfbfb", surface: "#f5f5f5", sidebar: "#f2f2f2", hover: "#e9e9e9", border: "#e2e2e2" },
    dark: { bg: "#161616", surface: "#1d1d1d", sidebar: "#121212", hover: "#292929", border: "#2f2f2f" },
  },
  {
    id: "cool",
    light: { bg: "#f9fbfd", surface: "#f2f5f9", sidebar: "#eef2f7", hover: "#e4e9f0", border: "#dbe2eb" },
    dark: { bg: "#13161c", surface: "#1a1e25", sidebar: "#0f1217", hover: "#252a33", border: "#2b313b" },
  },
  {
    id: "sepia",
    light: { bg: "#fcf9f2", surface: "#f7f2e8", sidebar: "#f5efe3", hover: "#ede5d5", border: "#e5dbc7" },
    dark: { bg: "#1a1713", surface: "#221e19", sidebar: "#15130f", hover: "#2e2921", border: "#352f26" },
  },
] as const satisfies readonly BackgroundPreset[];
export type BackgroundId = (typeof BACKGROUND_PRESETS)[number]["id"];
export const BACKGROUND_IDS = BACKGROUND_PRESETS.map((p) => p.id) as [BackgroundId, ...BackgroundId[]];
export const backgroundPreset = (id?: string | null): BackgroundPreset => BACKGROUND_PRESETS.find((p) => p.id === id) ?? BACKGROUND_PRESETS[0];

// ---- The accent's palette ----

export type Mode = "light" | "dark";
export type AccentPalette = {
  blue: string;
  blueLight: string;
  accentStrong: string;
  onAccent: string;
  focusBorder: string;
  focusRing: string;
  cellSelection: string;
  // The lightness had to move for the contrast (shown in the settings).
  adjusted: boolean;
};

// Moves the lightness from `start` in `step`s until `ok`; the chroma is kept
// (as far as sRGB allows) and the hue stays.
function fitLightness(start: Oklch, step: number, ok: (hex: string) => boolean) {
  let l = start.l;
  for (let i = 0; i < 400; i++) {
    const hex = oklchToHex({ ...start, l });
    if (ok(hex) || l <= 0 || l >= 1) return { hex, l };
    l = Math.min(1, Math.max(0, l + step));
  }
  return { hex: oklchToHex({ ...start, l }), l };
}

// The accent's colours for one mode on one background tint. Light: the
// chosen colour itself if it is readable, otherwise darker. Dark: a light
// version of it (at least the lightness of Flowplan's own dark accent),
// lighter still if needed. Text on the accent is white in light mode and
// the darkest background in dark mode (as in app/globals.css).
export function derivePalette(accent: string, mode: Mode, background: BackgroundId | string = "standard"): AccentPalette {
  const surfaces = backgroundPreset(background)[mode];
  const base = hexToOklch(accent);
  const chroma = base.c;
  const blueLight = oklchToHex(mode === "light" ? { l: 0.945, c: Math.min(chroma, 0.12) * 0.25, h: base.h } : { l: 0.3, c: Math.min(chroma, 0.2) * 0.4, h: base.h });
  const onAccent = mode === "light" ? "#ffffff" : surfaces.sidebar;
  const backgrounds = [surfaces.bg, surfaces.surface, surfaces.sidebar, blueLight];
  const ok = (hex: string) => contrast(hex, onAccent) >= MIN_CONTRAST && backgrounds.every((b) => contrast(hex, b) >= MIN_CONTRAST);
  let blue: string, l: number, adjusted: boolean;
  if (mode === "light") {
    const picked = toHex(parseHex(accent));
    if (ok(picked)) [blue, l, adjusted] = [picked, base.l, false];
    else {
      const fitted = fitLightness(base, -0.005, ok);
      [blue, l, adjusted] = [fitted.hex, fitted.l, true];
    }
  } else {
    const start = { ...base, l: Math.max(base.l, 0.72) };
    const fitted = fitLightness(start, 0.005, ok);
    [blue, l, adjusted] = [fitted.hex, fitted.l, fitted.l - start.l > 0.004];
  }
  const accentStrong = oklchToHex({ ...base, l: mode === "light" ? (l >= 0.25 ? l - 0.08 : l + 0.2) : Math.min(0.97, l + 0.08) });
  return {
    blue,
    blueLight,
    accentStrong,
    onAccent,
    focusBorder: oklchToHex({ l: 0.78, c: Math.min(chroma * 0.6, 0.12), h: base.h }),
    focusRing: `${blue}${mode === "light" ? "1a" : "33"}`,
    cellSelection: `${blue}${mode === "light" ? "1f" : "33"}`,
    adjusted,
  };
}

// ---- The stored look ----

const hex = z
  .string()
  .regex(/^#[0-9a-f]{6}$/i, "Farbe als #rrggbb angeben.")
  .transform((v) => v.toLowerCase());
const fontRef = z
  .string()
  .max(60)
  .refine((v) => BUNDLED_FONT_IDS.includes(v) || new RegExp(`^${CUSTOM_PREFIX}[0-9a-f-]{36}$`, "i").test(v), "Unbekannte Schrift.");
export const workspaceThemeSchema = z
  .object({
    accent: hex.nullable().optional(),
    background: z.enum(BACKGROUND_IDS).optional(),
    fonts: z
      .object({ ui: fontRef.optional(), display: fontRef.optional(), mono: fontRef.optional() })
      .strict()
      .optional(),
  })
  .strict();
export type WorkspaceTheme = z.infer<typeof workspaceThemeSchema>;

// Without what equals the default; null when nothing is left.
export function normalizeTheme(theme: WorkspaceTheme): WorkspaceTheme | null {
  const out: WorkspaceTheme = {};
  if (theme.accent) out.accent = theme.accent.toLowerCase();
  if (theme.background && theme.background !== "standard") out.background = theme.background;
  const fonts: Partial<Record<FontSlot, string>> = {};
  for (const slot of FONT_SLOTS) {
    const value = theme.fonts?.[slot];
    if (value && value !== DEFAULT_FONTS[slot]) fonts[slot] = customFontId(value) ? `${CUSTOM_PREFIX}${customFontId(value)!.toLowerCase()}` : value;
  }
  if (Object.keys(fonts).length) out.fonts = fonts;
  return Object.keys(out).length ? out : null;
}
// A stored value (workspaces.theme): whatever does not parse is the default.
export function parseTheme(raw: unknown): WorkspaceTheme | null {
  if (raw === null || raw === undefined || raw === "") return null;
  try {
    const parsed = workspaceThemeSchema.safeParse(typeof raw === "string" ? JSON.parse(raw) : raw);
    return parsed.success ? normalizeTheme(parsed.data) : null;
  } catch {
    return null;
  }
}
// The uploaded faces a look refers to.
export const themeCustomFonts = (theme: WorkspaceTheme | null) =>
  [...new Set(FONT_SLOTS.map((s) => customFontId(theme?.fonts?.[s])).filter((id): id is string => !!id))];

// An uploaded face as the look needs it (lib/workspace-fonts.ts).
export type ThemeFont = { id: string; name: string; format: "woff2" | "woff" | "truetype" | "opentype"; variable: boolean; category?: FontCategory };
// What the app, published pages and forms get: the look and the faces it
// may use (in the settings: all the workspace has).
export type WorkspaceLook = { theme: WorkspaceTheme | null; fonts: ThemeFont[] };

// Only characters that are safe inside a declaration, a CSS string or
// url(): the values are validated already, this keeps the style element
// inert regardless.
const cssSafe = (value: string) => value.replace(/[^\w\s#"(),.:%/+-]/g, "");
function declarations(vars: Record<string, string | undefined>) {
  return Object.entries(vars)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${cssSafe(k)}:${cssSafe(v!)}`)
    .join(";");
}

// The variables of one mode, for :root or for a preview element.
export function themeVariables(theme: WorkspaceTheme | null, mode: Mode, fonts: ThemeFont[] = []) {
  const vars: Record<string, string | undefined> = {};
  if (!theme) return vars;
  if (theme.background && theme.background !== "standard") {
    const s = backgroundPreset(theme.background)[mode];
    Object.assign(vars, { "--bg": s.bg, "--surface": s.surface, "--sidebar": s.sidebar, "--hover": s.hover, "--border": s.border });
  }
  if (theme.accent) {
    const p = derivePalette(theme.accent, mode, theme.background);
    Object.assign(vars, {
      "--blue": p.blue,
      "--blue-light": p.blueLight,
      "--accent-strong": p.accentStrong,
      "--on-accent": p.onAccent,
      "--focus-border": p.focusBorder,
      "--focus-ring": p.focusRing,
      "--cell-selection": p.cellSelection,
      "--primary-hover": p.accentStrong,
    });
  }
  for (const slot of FONT_SLOTS) {
    const ref = theme.fonts?.[slot];
    if (!ref || ref === DEFAULT_FONTS[slot]) continue;
    const custom = customFontId(ref);
    const font = custom ? fonts.find((f) => f.id === custom) : undefined;
    if (custom && !font) continue;
    const stack = fontStack(slot, ref, font);
    if (stack) vars[slot === "ui" ? "--font-ui" : slot === "display" ? "--font-display" : "--font-mono"] = stack;
  }
  // Pages set in "Serif" use the heading face; Instrument Sans' stylistic
  // sets mean other letters in other faces.
  if (vars["--font-display"]) vars["--font-page-serif"] = "var(--font-display)";
  if (vars["--font-ui"]) vars["font-feature-settings"] = "normal";
  return vars;
}

// The @font-face rules a look needs: bundled faces it uses, and its
// uploaded ones (served at `fontUrl(id)`: the app, a publication, a form).
export function themeFontFaces(theme: WorkspaceTheme | null, fonts: ThemeFont[], fontUrl: (id: string) => string) {
  const rules: string[] = [];
  const seen = new Set<string>();
  for (const slot of FONT_SLOTS) {
    const ref = theme?.fonts?.[slot];
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    const custom = customFontId(ref);
    if (!custom) {
      const faces = bundledFontFaces(ref);
      if (faces) rules.push(faces);
      continue;
    }
    const font = fonts.find((f) => f.id === custom);
    if (!font) continue;
    rules.push(fontFaceRule(font, fontUrl(font.id)));
  }
  return rules.join("\n");
}
// An uploaded face: a variable one covers every weight, a static one is
// its regular cut (the browser makes bold and italic from it).
export const fontFaceRule = (font: ThemeFont, url: string) =>
  `@font-face{font-family:"${customFamily(font.id)}";font-style:normal;font-display:swap;font-weight:${font.variable ? "100 1000" : "400"};src:url("${cssSafe(url)}") format("${font.format}")}`;

// The whole style sheet of a look: variables for light and dark (more
// specific than app/globals.css, so they win; without data-theme as light)
// and the faces it uses. Empty for the default look.
export function themeCss(look: WorkspaceLook | null | undefined, fontUrl: (id: string) => string) {
  const theme = look?.theme ?? null;
  if (!theme) return "";
  const light = declarations(themeVariables(theme, "light", look?.fonts));
  const dark = declarations(themeVariables(theme, "dark", look?.fonts));
  const parts: string[] = [];
  if (light) parts.push(`html:root{${light}}`);
  if (dark) parts.push(`html:root[data-theme="dark"]{${dark}}`);
  const faces = themeFontFaces(theme, look?.fonts ?? [], fontUrl);
  if (faces) parts.push(faces);
  return parts.join("\n");
}
export const appFontUrl = (id: string) => `/api/workspace-fonts/${id}`;
