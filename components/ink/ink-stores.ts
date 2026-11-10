"use client";
// Small per-device stores of the ink tools that are not part of the ink:
// the ruler on the page (lib/ink/ruler.ts) and the shape tool's choices.
// Outside React state on purpose: the ink layers of all pages and the
// toolbar read them without passing them through the editor.
import { useSyncExternalStore } from "react";
import type { RulerMode, RulerState, RulerUnit } from "@/lib/ink/ruler";
import { SHAPE_TOOL_KINDS, type ShapeToolKind } from "@/lib/ink/shape-recognize";

// `load` gives the first value in the browser (read once, on first use).
function store<T>(initial: T, load?: () => T) {
  let value = initial;
  let pending = !!load;
  const listeners = new Set<() => void>();
  return {
    get: () => {
      if (pending && typeof window !== "undefined") {
        pending = false;
        value = load!();
      }
      return value;
    },
    set(next: T) {
      pending = false;
      if (next === value) return;
      value = next;
      listeners.forEach((l) => l());
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
function read(key: string) {
  try {
    return JSON.parse(localStorage.getItem(key) || "null");
  } catch {
    return null;
  }
}
function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

// ---- Ruler ----

// The ruler shown (null: off). `x` NaN: not placed yet (the page's ink
// layer puts it in the middle of what is in view).
const ruler = store<RulerState | null>(null);
const RULER_KEY = "flowplan-ink-ruler";
type RulerPrefs = { mode: RulerMode; unit: RulerUnit | null; radius: number };
const rulerPrefs = (): RulerPrefs => {
  const p = read(RULER_KEY);
  return {
    mode: p?.mode === "protractor" || p?.mode === "compass" ? p.mode : "ruler",
    unit: p?.unit === "in" || p?.unit === "cm" ? p.unit : null,
    radius: Number.isFinite(p?.radius) && p.radius > 5 && p.radius < 2000 ? p.radius : 85,
  };
};
export const useRuler = () => useSyncExternalStore(ruler.subscribe, ruler.get, () => null);
export const getRuler = ruler.get;
export function setRuler(next: RulerState | null) {
  ruler.set(next);
  if (next) write(RULER_KEY, { mode: next.mode, unit: next.unit, radius: next.radius });
}
// Shows the tool on `page` (or changes its mode), or hides it.
export function showRuler(page: string | null, mode?: RulerMode, unit?: RulerUnit) {
  if (!page) return setRuler(null);
  const prefs = rulerPrefs();
  const now = ruler.get();
  if (now && now.page === page) return setRuler({ ...now, mode: mode || now.mode, unit: unit || now.unit });
  setRuler({ page, x: NaN, y: NaN, angle: 0, mode: mode || prefs.mode, radius: prefs.radius, unit: unit || prefs.unit || "cm" });
}
// Whether a unit was chosen on this device (otherwise the paper decides).
export const chosenUnit = () => rulerPrefs().unit;

// ---- Shape tool ----

// `fillColor`: the fill of new closed shapes while `fill` is on; null: the
// line's colour.
export type ShapeToolSettings = { kind: ShapeToolKind; fill: boolean; fillColor: string | null; dash: "solid" | "dash" | "dot" };
const SHAPE_KEY = "flowplan-ink-shape";
const shapeDefaults: ShapeToolSettings = { kind: "auto", fill: false, fillColor: null, dash: "solid" };
const shapeSettings = store<ShapeToolSettings>(shapeDefaults, () => {
  const s = read(SHAPE_KEY);
  if (!s) return shapeDefaults;
  return {
    kind: SHAPE_TOOL_KINDS.includes(s.kind) ? s.kind : "auto",
    fill: s.fill === true,
    fillColor: typeof s.fillColor === "string" && /^#[0-9a-f]{6}$/i.test(s.fillColor) ? s.fillColor.toLowerCase() : null,
    dash: s.dash === "dash" || s.dash === "dot" ? s.dash : "solid",
  };
});
export const useShapeSettings = () => useSyncExternalStore(shapeSettings.subscribe, shapeSettings.get, () => shapeDefaults);
export const getShapeSettings = shapeSettings.get;
export function setShapeSettings(patch: Partial<ShapeToolSettings>) {
  const next = { ...shapeSettings.get(), ...patch };
  shapeSettings.set(next);
  write(SHAPE_KEY, next);
}
