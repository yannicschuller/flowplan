// Ink tools, colours, widths and the per-device choices: three favourite
// pens and what the Apple Pencil's double-tap or squeeze does.
import type { PencilAction } from "../stylus";

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

export const DEFAULT_PRESETS: InkPreset[] = [
  { type: "pen", color: "#1f1f1f", width: 1.6 },
  { type: "pen", color: "#1c5fd6", width: 1.6 },
  { type: "highlighter", color: "#ffd43b", width: 14 },
];

const PRESETS_KEY = "flowplan-ink-presets";
const PENCIL_KEY = "flowplan-ink-pencil";
const SNAP_KEY = "flowplan-ink-snap";

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
