import { useSyncExternalStore } from "react";
import { DRAWIO_THEMES, DRAWIO_UIS, type DrawioConfig, type DrawioTheme, type DrawioUi } from "./drawio";

// The draw.io editor in the browser (#110): which draw.io the instance uses
// (from the start data, components/workspace-app.tsx) and how this person
// wants it on this device (Settings → Appearance → Editor, like the code
// blocks' line numbers): its theme – automatic follows Flowplan's light or
// dark mode – and its interface. Kept in the browser; other tabs follow.

let instance: DrawioConfig | null = null;
export const setDrawioEditor = (config: DrawioConfig | null | undefined) => {
  instance = config ?? null;
};
export const drawioEditor = () => instance;

const KEYS = { theme: "flowplan.drawio-theme", ui: "flowplan.drawio-ui" } as const;
type Prefs = { theme: DrawioTheme; ui: DrawioUi };
const DEFAULTS: Prefs = { theme: "auto", ui: "kennedy" };
const listeners = new Set<() => void>();
let cached: Prefs | null = null;

function read(key: string) {
  try {
    return typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}
export function drawioPrefs(): Prefs {
  if (cached) return cached;
  const theme = read(KEYS.theme),
    ui = read(KEYS.ui);
  cached = {
    theme: DRAWIO_THEMES.includes(theme as DrawioTheme) ? (theme as DrawioTheme) : DEFAULTS.theme,
    ui: DRAWIO_UIS.includes(ui as DrawioUi) ? (ui as DrawioUi) : DEFAULTS.ui,
  };
  return cached;
}
export function setDrawioPref<K extends keyof Prefs>(key: K, value: Prefs[K]) {
  cached = { ...drawioPrefs(), [key]: value };
  try {
    if (value === DEFAULTS[key]) localStorage.removeItem(KEYS[key]);
    else localStorage.setItem(KEYS[key], value);
  } catch {}
  listeners.forEach((listener) => listener());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  const storage = (event: StorageEvent) => {
    if (event.key !== KEYS.theme && event.key !== KEYS.ui) return;
    cached = null;
    listener();
  };
  if (typeof window !== "undefined") window.addEventListener("storage", storage);
  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined") window.removeEventListener("storage", storage);
  };
}
export function useDrawioPrefs(): Prefs {
  return useSyncExternalStore(subscribe, drawioPrefs, () => DEFAULTS);
}

// The editor's dialog maximized to the whole window (#110), remembered on
// this device: the next diagram opens the way the last one was left.
const MAXIMIZED = "flowplan.drawio-maximized";
export const drawioMaximized = () => read(MAXIMIZED) === "1";
export function setDrawioMaximized(value: boolean) {
  try {
    if (value) localStorage.setItem(MAXIMIZED, "1");
    else localStorage.removeItem(MAXIMIZED);
  } catch {}
}

// A page just created from a template that opens its diagram right away
// (lib/template-catalog.ts, openDiagram): the editor opens draw.io for the
// page's empty diagram once the page shows (components/editor.tsx).
const openOnCreate = new Set<string>();
export const queueDrawioOpen = (pageId: string) => void openOnCreate.add(pageId);
export const drawioOpenQueued = (pageId: string) => openOnCreate.has(pageId);
export const takeDrawioOpen = (pageId: string) => openOnCreate.delete(pageId);
