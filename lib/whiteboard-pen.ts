// The whiteboard pen (#455): a pen and a highlighter, each with its colour,
// width and opacity, remembered on this device as the last used setting.
// Every stroke stores its own look (`opacity`, `highlight`), so the board,
// its static renderings and the exports (components/whiteboard/
// board-export.ts, lib/whiteboard-svg.ts) draw it alike. Highlighter
// strokes are multiplied over what lies under them, like a marker on paper
// (on the dark canvas they are only translucent: app/whiteboard-draw.css).
import type { WhiteboardItem } from "./whiteboard-model";

export type PenMode = "pen" | "highlighter";
export type PenStyle = { color: string; width: number; opacity: number };
export type PenSettings = { mode: PenMode; pen: PenStyle; highlighter: PenStyle };

// Fine, medium, bold – the same steps as a selected line's width for the
// pen, broad ones for the highlighter.
export const PEN_WIDTHS = [2, 3, 5] as const;
export const HIGHLIGHTER_WIDTHS = [12, 20, 32] as const;
export const HIGHLIGHTER_COLORS = ["#ffd43b", "#ffa94d", "#ff8787", "#faa2c1", "#b197fc", "#74c0fc", "#8ce99a", "#c0eb75"];
export const HIGHLIGHTER_OPACITY = 0.35;
// The opacity slider: 10–100 %, in steps of 5.
export const MIN_OPACITY = 0.1;
export const OPACITY_STEP = 0.05;

export const DEFAULT_PEN: PenSettings = {
  mode: "pen",
  pen: { color: "#1f2937", width: 3, opacity: 1 },
  highlighter: { color: HIGHLIGHTER_COLORS[0], width: HIGHLIGHTER_WIDTHS[1], opacity: HIGHLIGHTER_OPACITY },
};

const HEX = /^#[0-9a-f]{6}$/i;
// An opacity as stored: 0.1–1 in steps of 0.05; anything else is full.
export function cleanOpacity(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  const stepped = Math.round(value / OPACITY_STEP) * OPACITY_STEP;
  return Math.round(Math.min(1, Math.max(MIN_OPACITY, stepped)) * 100) / 100;
}
function cleanStyle(raw: unknown, fallback: PenStyle, widths: readonly number[]): PenStyle {
  const s = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    color: typeof s.color === "string" && HEX.test(s.color) ? s.color.toLowerCase() : fallback.color,
    width: widths.includes(s.width as number) ? (s.width as number) : fallback.width,
    opacity: s.opacity === undefined ? fallback.opacity : cleanOpacity(s.opacity),
  };
}
export function cleanPenSettings(raw: unknown, legacyWidth?: unknown): PenSettings {
  const s = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const pen = cleanStyle(s.pen, DEFAULT_PEN.pen, PEN_WIDTHS);
  // Earlier versions kept only the pen's width.
  if (!s.pen && PEN_WIDTHS.includes(Number(legacyWidth) as 2)) pen.width = Number(legacyWidth);
  return {
    mode: s.mode === "highlighter" ? "highlighter" : "pen",
    pen,
    highlighter: cleanStyle(s.highlighter, DEFAULT_PEN.highlighter, HIGHLIGHTER_WIDTHS),
  };
}

const KEY = "flowplan-board-pen";
const LEGACY_WIDTH_KEY = "flowplan-board-pen-width";
export function loadPenSettings(): PenSettings {
  try {
    return cleanPenSettings(JSON.parse(localStorage.getItem(KEY) || "null"), localStorage.getItem(LEGACY_WIDTH_KEY));
  } catch {
    return cleanPenSettings(null);
  }
}
export function savePenSettings(settings: PenSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {}
}

// The properties of a new stroke drawn with the setting.
export function strokeProps(settings: PenSettings): Pick<WhiteboardItem, "stroke" | "strokeWidth" | "opacity" | "highlight"> {
  const style = settings[settings.mode];
  const opacity = cleanOpacity(style.opacity);
  return {
    stroke: style.color,
    strokeWidth: style.width,
    ...(opacity < 1 ? { opacity } : {}),
    ...(settings.mode === "highlighter" ? { highlight: true } : {}),
  };
}

// How a stored stroke is drawn: its opacity (undefined: opaque) and
// whether it is a highlighter stroke.
export function strokeLook(item: Pick<WhiteboardItem, "opacity" | "highlight">): { opacity?: number; highlight: boolean } {
  const opacity = item.opacity === undefined ? 1 : cleanOpacity(item.opacity);
  return { ...(opacity < 1 ? { opacity } : {}), highlight: item.highlight === true };
}
