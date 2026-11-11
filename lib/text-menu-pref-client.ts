import { useSyncExternalStore } from "react";
import { DEFAULT_TEXT_MENU_PREF, textMenuPrefOf, type TextMenuPref } from "./text-menu-pref";

// "Menü bei Textauswahl" (#200, lib/text-menu-pref.ts) in the browser: the
// current choice, set from the bootstrap (components/workspace-app.tsx) and
// by the settings; the text menus read it.
const listeners = new Set<() => void>();
let current: TextMenuPref = DEFAULT_TEXT_MENU_PREF;
export function textMenuPref(): TextMenuPref {
  return current;
}
export function setTextMenuPrefLocal(value: unknown) {
  const next = textMenuPrefOf(value);
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
export function useTextMenuPref(): TextMenuPref {
  return useSyncExternalStore(subscribe, textMenuPref, () => DEFAULT_TEXT_MENU_PREF);
}
