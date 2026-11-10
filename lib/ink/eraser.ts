// The eraser's kinds and size (the eraser panel, components/ink/ink-panel.tsx):
// whole strokes, only the part under the eraser (strokes are split, see
// erasePartial in geometry.ts), or whole highlighter strokes only – the pen
// ink under them stays. The size is the partial eraser's radius in screen
// pixels (the same on the screen at every zoom). Remembered on this device.
import { eraseItems, erasePartial, hitItem } from "./geometry";
import type { InkItem } from "./model";

export type EraserMode = "stroke" | "partial" | "highlighter";
export const ERASER_MODES: EraserMode[] = ["stroke", "partial", "highlighter"];
export const ERASER_SIZE = { min: 4, max: 40, step: 1, default: 10 } as const;
// The radius of the whole-stroke kinds (screen pixels), as before.
export const STROKE_ERASER_RADIUS = 6;

type XY = { x: number; y: number };

// Highlighter strokes touched by the eraser path go as a whole.
export function eraseHighlighter(items: InkItem[], path: XY[], radius: number) {
  const kept = items.filter((item) => item.type !== "highlighter" || !path.some((p) => hitItem(item, p, radius)));
  return kept.length === items.length ? items : kept;
}

// The items after erasing along `path` (page units); the same array when
// nothing was hit (no undo step, no save).
export function eraseWith(items: InkItem[], path: XY[], mode: EraserMode, radius: number) {
  if (mode === "partial") return erasePartial(items, path, radius);
  if (mode === "highlighter") return eraseHighlighter(items, path, radius);
  return eraseItems(items, path, radius);
}

export const clampEraserSize = (value: number) =>
  Number.isFinite(value) ? Math.round(Math.min(ERASER_SIZE.max, Math.max(ERASER_SIZE.min, value))) : ERASER_SIZE.default;

const KEY = "flowplan-ink-eraser";
export type EraserSetting = { mode: EraserMode; size: number };
export function cleanEraserSetting(raw: unknown): EraserSetting {
  const value = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    mode: ERASER_MODES.includes(value.mode as EraserMode) ? (value.mode as EraserMode) : "stroke",
    size: typeof value.size === "number" ? clampEraserSize(value.size) : ERASER_SIZE.default,
  };
}
export function loadEraserSetting(): EraserSetting {
  try {
    return cleanEraserSetting(JSON.parse(localStorage.getItem(KEY) || "null"));
  } catch {
    return cleanEraserSetting(null);
  }
}
export function saveEraserSetting(setting: EraserSetting) {
  try {
    localStorage.setItem(KEY, JSON.stringify(setting));
  } catch {}
}
