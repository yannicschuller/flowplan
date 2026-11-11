import { useSyncExternalStore } from "react";
import { DEFAULT_PAGE_ICON_PREF, pageIconPrefOf, type PageIconPref } from "./page-icon-pref";

// "Seitensymbol" (#214, lib/page-icon-pref.ts) in the browser: the current
// choice, set from the bootstrap (components/workspace-app.tsx) and by the
// settings; the page header reads it.
const listeners = new Set<() => void>();
let current: PageIconPref = DEFAULT_PAGE_ICON_PREF;
export function pageIconPref(): PageIconPref {
  return current;
}
export function setPageIconPrefLocal(value: unknown) {
  const next = pageIconPrefOf(value);
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
export function usePageIconPref(): PageIconPref {
  return useSyncExternalStore(subscribe, pageIconPref, () => DEFAULT_PAGE_ICON_PREF);
}
