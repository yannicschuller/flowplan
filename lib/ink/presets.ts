// Ink tools, colours, widths and the per-device choices: three favourite
// pens, the text style, own colours used lately and what the Apple
// Pencil's double-tap or squeeze does.
import type { PencilAction } from "../stylus";
import { isInkFont, type InkFont } from "./fonts";

export type InkTool = "pen" | "highlighter" | "eraser" | "lasso" | "text" | "laser";
export type EraserMode = "stroke" | "partial";
export type InkPreset = { type: "pen" | "highlighter"; color: string; width: number };

export const PEN_COLORS = ["#1f1f1f", "#1c5fd6", "#e03131", "#2f9e44", "#f08c00", "#7048e8"];
export const HIGHLIGHTER_COLORS = ["#ffd43b", "#8ce99a", "#74c0fc", "#faa2c1", "#ffc078"];
// Page units (points): fine, medium, bold.
export const PEN_WIDTHS = [0.8, 1.6, 3.2];
export const HIGHLIGHTER_WIDTHS = [8, 14, 22];
export const TEXT_SIZES = [10, 14, 20];
export const HIGHLIGHTER_OPACITY = 0.4;
// The free width slider besides the presets (page units): min, max, step.
export const WIDTH_RANGES = {
  pen: { min: 0.3, max: 12, step: 0.1 },
  highlighter: { min: 4, max: 40, step: 1 },
  text: { min: 8, max: 96, step: 1 },
} as const;
export const clampWidth = (tool: keyof typeof WIDTH_RANGES, value: number) => {
  const { min, max, step } = WIDTH_RANGES[tool];
  if (!Number.isFinite(value)) return min;
  const stepped = Math.round(Math.min(max, Math.max(min, value)) / step) * step;
  return Math.round(Math.min(max, Math.max(min, stepped)) * 100) / 100;
};

export const DEFAULT_PRESETS: InkPreset[] = [
  { type: "pen", color: "#1f1f1f", width: 1.6 },
  { type: "pen", color: "#1c5fd6", width: 1.6 },
  { type: "highlighter", color: "#ffd43b", width: 14 },
];

const PRESETS_KEY = "flowplan-ink-presets";
const PENCIL_KEY = "flowplan-ink-pencil";
const SNAP_KEY = "flowplan-ink-snap";
const COLORS_KEY = "flowplan-ink-colors";
const TEXT_KEY = "flowplan-ink-text";

function read(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}
const COLOR = /^#[0-9a-f]{6}$/i;
export function loadPresets(): InkPreset[] {
  try {
    const list = JSON.parse(read(PRESETS_KEY) || "null");
    if (Array.isArray(list) && list.length === 3)
      return list.map((p, i) =>
        p && (p.type === "pen" || p.type === "highlighter") && COLOR.test(p.color) && Number.isFinite(p.width) && p.width > 0 && p.width < 100
          ? { type: p.type, color: p.color, width: p.width }
          : DEFAULT_PRESETS[i],
      );
  } catch {}
  return DEFAULT_PRESETS.map((p) => ({ ...p }));
}
export const savePresets = (presets: InkPreset[]) => write(PRESETS_KEY, JSON.stringify(presets));

// Own colours (the colour picker), most recent first, on this device.
export const RECENT_COLORS = 8;
export function loadRecentColors(): string[] {
  try {
    const list = JSON.parse(read(COLORS_KEY) || "[]");
    if (Array.isArray(list)) return [...new Set(list.filter((c) => typeof c === "string" && COLOR.test(c)).map((c: string) => c.toLowerCase()))].slice(0, RECENT_COLORS);
  } catch {}
  return [];
}
// Remembers a colour that is not one of the standard ones; the new list.
export function rememberColor(color: string, list = loadRecentColors()): string[] {
  const c = color.toLowerCase();
  if (!COLOR.test(c) || PEN_COLORS.includes(c) || HIGHLIGHTER_COLORS.includes(c)) return list;
  const next = [c, ...list.filter((x) => x !== c)].slice(0, RECENT_COLORS);
  write(COLORS_KEY, JSON.stringify(next));
  return next;
}

// The text tool's colour, size and face, on this device.
export type TextStyle = { color: string; width: number; font?: InkFont };
export function loadTextStyle(): TextStyle | null {
  try {
    const s = JSON.parse(read(TEXT_KEY) || "null");
    if (s && COLOR.test(s.color) && Number.isFinite(s.width))
      return { color: s.color, width: clampWidth("text", s.width), ...(isInkFont(s.font) ? { font: s.font } : {}) };
  } catch {}
  return null;
}
export const saveTextStyle = (style: TextStyle) => write(TEXT_KEY, JSON.stringify(style));

// Apple Pencil double-tap / squeeze: as set on the iPad ("system"), always
// the eraser, always the previous tool, or nothing.
export type PencilSetting = "system" | "eraser" | "previous" | "off";
export function pencilSetting(): PencilSetting {
  const value = read(PENCIL_KEY);
  return value === "eraser" || value === "previous" || value === "off" ? value : "system";
}
export const setPencilSetting = (value: PencilSetting) => write(PENCIL_KEY, value);
// What a Pencil gesture does under the setting.
export function pencilResult(setting: PencilSetting, action: Pick<PencilAction, "preferred">): "eraser" | "previous" | "pen" | null {
  if (setting === "off") return null;
  if (setting === "eraser") return "eraser";
  if (setting === "previous") return "previous";
  if (action.preferred === "switchEraser") return "eraser";
  if (action.preferred === "switchPrevious") return "previous";
  if (action.preferred === "ignore") return null;
  return "pen";
}

// Hold the pen at the end of a stroke to straighten it into a shape.
export const snapSetting = () => read(SNAP_KEY) !== "0";
export const setSnapSetting = (on: boolean) => write(SNAP_KEY, on ? "1" : "0");
