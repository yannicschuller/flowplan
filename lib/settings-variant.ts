// PROTOTYPE (settings and administration in one place): which of the four
// design variants the settings show. `?settingsVariant=a|b|c|d` in the
// address chooses one and keeps it in this browser; `?settingsVariant=off`
// goes back to today's two screens. Not for release.
//
//   a – one screen, one sidebar, the instance groups under "Instanz"
//   b – one screen, a scope switcher "Für mich | Arbeitsbereich | Instanz"
//   c – one screen that opens on an overview of cards
//   d – two screens as today, Settings gets a bridge into Administration
import { useSyncExternalStore } from "react";

export type SettingsVariant = "a" | "b" | "c" | "d";
const KEY = "flowplan.settingsVariant";
const VARIANTS: readonly SettingsVariant[] = ["a", "b", "c", "d"];

let current: SettingsVariant | null | undefined;

function read(): SettingsVariant | null {
  if (current !== undefined) return current;
  current = null;
  if (typeof window === "undefined") return current;
  try {
    const asked = new URLSearchParams(location.search).get("settingsVariant")?.toLowerCase();
    if (asked === "off") localStorage.removeItem(KEY);
    else if (asked && (VARIANTS as readonly string[]).includes(asked)) localStorage.setItem(KEY, asked);
    const kept = localStorage.getItem(KEY);
    current = kept && (VARIANTS as readonly string[]).includes(kept) ? (kept as SettingsVariant) : null;
  } catch {
    current = null;
  }
  return current;
}

export const settingsVariant = read;
// Variants a–c show the administration inside the settings.
export const combinedSettings = (v: SettingsVariant | null = read()) => v === "a" || v === "b" || v === "c";
export function useSettingsVariant(): SettingsVariant | null {
  return useSyncExternalStore(
    () => () => {},
    read,
    () => null,
  );
}
