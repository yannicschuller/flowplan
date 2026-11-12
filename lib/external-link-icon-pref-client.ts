import { useSyncExternalStore } from "react";
import { DEFAULT_EXTERNAL_LINK_ICON, externalLinkIconOf } from "./external-link-icon-pref";

// "Symbol bei externen Links" (#217, lib/external-link-icon-pref.ts) in the
// browser: the current choice, set from the bootstrap
// (components/workspace-app.tsx, which also puts the class on <html>) and by
// the settings.
const listeners = new Set<() => void>();
let current = DEFAULT_EXTERNAL_LINK_ICON;
export function externalLinkIcon(): boolean {
  return current;
}
export function setExternalLinkIconLocal(value: unknown) {
  const next = externalLinkIconOf(value);
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
export function useExternalLinkIcon(): boolean {
  return useSyncExternalStore(subscribe, externalLinkIcon, () => DEFAULT_EXTERNAL_LINK_ICON);
}
