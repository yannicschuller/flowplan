import { useSyncExternalStore } from "react";
import { DEFAULT_WHITEBOARD_CANVAS, showsDarkCanvas, whiteboardCanvasOf, type WhiteboardCanvasPref } from "./whiteboard-canvas-pref";

// "Whiteboard-Fläche" (#399, lib/whiteboard-canvas-pref.ts) in the browser:
// set from the bootstrap (components/workspace-app.tsx), by the settings and
// by the board's quick toggle; the boards read it together with the page's
// colour scheme (data-theme on <html>, lib/theme.ts).
const listeners = new Set<() => void>();
let current: WhiteboardCanvasPref = DEFAULT_WHITEBOARD_CANVAS;
export function whiteboardCanvas(): WhiteboardCanvasPref {
  return current;
}
export function setWhiteboardCanvasLocal(value: unknown) {
  const next = whiteboardCanvasOf(value);
  if (next === current) return;
  current = next;
  listeners.forEach((listener) => listener());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function useWhiteboardCanvas(): WhiteboardCanvasPref {
  return useSyncExternalStore(subscribe, whiteboardCanvas, () => DEFAULT_WHITEBOARD_CANVAS);
}

// Whether the page shows its dark colours, following changes of the theme.
export const darkTheme = () => typeof document !== "undefined" && document.documentElement.dataset.theme === "dark";
function subscribeTheme(listener: () => void) {
  if (typeof MutationObserver === "undefined" || typeof document === "undefined") return () => {};
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}
export function useDarkTheme(): boolean {
  return useSyncExternalStore(subscribeTheme, darkTheme, () => false);
}

// Whether boards show the dark canvas for this person right now.
export function useDarkCanvas(): boolean {
  return showsDarkCanvas(useWhiteboardCanvas(), useDarkTheme());
}
