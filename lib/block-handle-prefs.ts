import { useSyncExternalStore } from "react";

// "Always show block handles" (Settings → Appearance › Editor, #138): by
// default the ⠿ handle shows only at the block under the pointer, the block
// with the caret and a handle with keyboard focus (on touch screens only at
// the block with the caret). Turned on, every block shows its handle again,
// as before. For this person on this device (like the line numbers of code
// blocks); other tabs follow.
const KEY = "flowplan.block-handles-always";
const listeners = new Set<() => void>();
let cached: boolean | null = null;

export function blockHandlesAlways(): boolean {
  if (cached !== null) return cached;
  try {
    cached = typeof localStorage !== "undefined" && localStorage.getItem(KEY) === "true";
  } catch {
    cached = false;
  }
  return cached;
}
export function setBlockHandlesAlways(value: boolean) {
  cached = value;
  try {
    if (value) localStorage.setItem(KEY, "true");
    else localStorage.removeItem(KEY);
  } catch {}
  listeners.forEach((listener) => listener());
}
export function onBlockHandlesAlways(listener: () => void) {
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
export function useBlockHandlesAlways(): boolean {
  return useSyncExternalStore(onBlockHandlesAlways, blockHandlesAlways, () => false);
}
