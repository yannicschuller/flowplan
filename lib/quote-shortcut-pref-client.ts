import { useSyncExternalStore } from "react";
import { DEFAULT_QUOTE_SHORTCUT, quoteShortcutOf, type QuoteShortcutPref } from "./quote-shortcut-pref";

// "`>` erzeugt" (#230, lib/quote-shortcut-pref.ts) in the browser: the
// current choice, set from the bootstrap (components/workspace-app.tsx) and
// by the settings; the editor's input rule reads it when "> " is typed.
const listeners = new Set<() => void>();
let current: QuoteShortcutPref = DEFAULT_QUOTE_SHORTCUT;
export function quoteShortcut(): QuoteShortcutPref {
  return current;
}
export function setQuoteShortcutLocal(value: unknown) {
  const next = quoteShortcutOf(value);
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
export function useQuoteShortcut(): QuoteShortcutPref {
  return useSyncExternalStore(subscribe, quoteShortcut, () => DEFAULT_QUOTE_SHORTCUT);
}
