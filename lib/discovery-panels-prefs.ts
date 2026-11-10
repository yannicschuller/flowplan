import { useSyncExternalStore } from "react";

// "Show related pages and backlinks" (Settings → Appearance, #191): the
// panels below pages and records – Related pages, Linked from, the record
// backlinks and Unlinked mentions. On by default; turned off they are not
// shown and not loaded. For this person on this device (like "Always show
// block handles"); other tabs follow. Only the choice "off" is stored.
const KEY = "flowplan.discovery-panels-hidden";
const listeners = new Set<() => void>();
let cached: boolean | null = null;

export function discoveryPanelsShown(): boolean {
  if (cached !== null) return cached;
  try {
    cached = !(typeof localStorage !== "undefined" && localStorage.getItem(KEY) === "true");
  } catch {
    cached = true;
  }
  return cached;
}
export function setDiscoveryPanelsShown(value: boolean) {
  cached = value;
  try {
    if (value) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, "true");
  } catch {}
  listeners.forEach((listener) => listener());
}
export function onDiscoveryPanelsShown(listener: () => void) {
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
export function useDiscoveryPanelsShown(): boolean {
  return useSyncExternalStore(onDiscoveryPanelsShown, discoveryPanelsShown, () => true);
}
