import { useSyncExternalStore } from "react";
import { DEFAULT_FORMATTING_TOOLBAR, formattingToolbarOf, type FormattingToolbarPref } from "./toolbar-pref";

// "Formatierungsleiste" (#235, lib/toolbar-pref.ts) in the browser: the
// current choice, set from the bootstrap (components/workspace-app.tsx) and
// by the settings; the editors read it.
const listeners = new Set<() => void>();
let current: FormattingToolbarPref = DEFAULT_FORMATTING_TOOLBAR;
export function formattingToolbar(): FormattingToolbarPref {
  return current;
}
export function setFormattingToolbarLocal(value: unknown) {
  const next = formattingToolbarOf(value);
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
export function useFormattingToolbar(): FormattingToolbarPref {
  return useSyncExternalStore(subscribe, formattingToolbar, () => DEFAULT_FORMATTING_TOOLBAR);
}
