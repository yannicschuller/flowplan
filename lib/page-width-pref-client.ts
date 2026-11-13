import { useSyncExternalStore } from "react";
import { DEFAULT_FULL_WIDTH_PAGES, fullWidthPagesOf } from "./page-width-pref";

// "Seiten in voller Breite anzeigen" (#257, lib/page-width-pref.ts) in the
// browser: set from the bootstrap (components/workspace-app.tsx) and by the
// settings; the page view reads it.
const listeners = new Set<() => void>();
let current = DEFAULT_FULL_WIDTH_PAGES;
let known = false;
export function fullWidthPages(): boolean {
  return current;
}
export function setFullWidthPagesLocal(value: unknown) {
  const next = fullWidthPagesOf(value);
  const changed = next !== current || !known;
  known = true;
  current = next;
  if (changed) listeners.forEach((listener) => listener());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
/** The choice; `fallback` (the bootstrap's) until the browser's copy is
 *  set, so the server's render, hydration and the first paint agree. */
export function useFullWidthPages(fallback: boolean = DEFAULT_FULL_WIDTH_PAGES): boolean {
  return useSyncExternalStore(
    subscribe,
    () => (known ? current : fallback),
    () => fallback,
  );
}
