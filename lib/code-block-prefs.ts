import { useSyncExternalStore } from "react";

// "Show line numbers by default" (Settings → Appearance, #93): what a code
// block without a setting of its own shows, for this person on this device
// (like light or dark mode). Kept in the browser; other tabs follow.
const KEY = "flowplan.code-line-numbers";
const listeners = new Set<() => void>();
let cached: boolean | null = null;

export function lineNumbersByDefault(): boolean {
  if (cached !== null) return cached;
  try {
    cached = typeof localStorage !== "undefined" && localStorage.getItem(KEY) === "true";
  } catch {
    cached = false;
  }
  return cached;
}
export function setLineNumbersByDefault(value: boolean) {
  cached = value;
  try {
    if (value) localStorage.setItem(KEY, "true");
    else localStorage.removeItem(KEY);
  } catch {}
  listeners.forEach((listener) => listener());
}
export function onLineNumbersDefault(listener: () => void) {
  listeners.add(listener);
  const storage = (event: StorageEvent) => {
    if (event.key !== KEY) return;
    cached = null;
    listener();
  };
  if (typeof window !== "undefined") window.addEventListener("storage", storage);
  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined") window.removeEventListener("storage", storage);
  };
}
export function useLineNumbersByDefault(): boolean {
  return useSyncExternalStore(onLineNumbersDefault, lineNumbersByDefault, () => false);
}
