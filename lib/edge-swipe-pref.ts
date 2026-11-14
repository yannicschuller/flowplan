import { useSyncExternalStore } from "react";
import { DEFAULT_EDGE_SWIPE, parseEdgeSwipePref, type EdgeSwipePref } from "./edge-swipe";
import { nativeApp } from "./native-app";

// "Wischen vom linken Rand" (Settings → Darstellung & Sprache, #285): in the
// app for iPhone and iPad, whether the swipe from the left edge opens the
// sidebar (the default) or goes back. For this device (like the block
// handles); other tabs follow. lib/edge-swipe.ts decides who owns the edge.
const KEY = "flowplan.edge-swipe";
const listeners = new Set<() => void>();
let cached: EdgeSwipePref | null = null;

export function edgeSwipePref(): EdgeSwipePref {
  if (cached !== null) return cached;
  try {
    cached = typeof localStorage !== "undefined" ? parseEdgeSwipePref(localStorage.getItem(KEY)) : DEFAULT_EDGE_SWIPE;
  } catch {
    cached = DEFAULT_EDGE_SWIPE;
  }
  return cached;
}

export function setEdgeSwipePref(value: EdgeSwipePref) {
  cached = parseEdgeSwipePref(value);
  try {
    if (cached === DEFAULT_EDGE_SWIPE) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, cached);
  } catch {}
  listeners.forEach((listener) => listener());
}

export function onEdgeSwipePref(listener: () => void) {
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

export function useEdgeSwipePref(): EdgeSwipePref {
  return useSyncExternalStore(onEdgeSwipePref, edgeSwipePref, () => DEFAULT_EDGE_SWIPE);
}

// The choice only does something in the app on iPhone and iPad that takes
// it (FlowplanApp.edgeSwipe, apps newer than 1.0.12): elsewhere Safari or
// the system owns its back gesture, or nothing claims the edge.
export function edgeSwipeChoosable(): boolean {
  const app = nativeApp();
  return app?.platform === "ios" && typeof app.edgeSwipe === "function";
}

const noop = () => () => {};
export function useEdgeSwipeChoosable(): boolean {
  return useSyncExternalStore(noop, edgeSwipeChoosable, () => false);
}

// Tells the app which way the edge goes (now and on every change).
export function reportEdgeSwipe(pref: EdgeSwipePref = edgeSwipePref()) {
  try {
    nativeApp()?.edgeSwipe?.(pref);
  } catch {}
}
