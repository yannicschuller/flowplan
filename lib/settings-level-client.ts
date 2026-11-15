import { useSyncExternalStore } from "react";
import { DEFAULT_SETTINGS_LEVEL, settingsLevelOf, type SettingsLevel, type SettingsLevelBoot } from "./settings-level";

// The settings level (#294, lib/settings-level.ts) in the browser: set from
// the bootstrap (components/workspace-app.tsx) and by the level switch at
// the top of Settings; the settings read it.
const listeners = new Set<() => void>();
let current: SettingsLevel = DEFAULT_SETTINGS_LEVEL;
export function settingsLevel(): SettingsLevel {
  return current;
}
export function setSettingsLevelLocal(value: unknown) {
  const next = settingsLevelOf(value);
  if (next === current) return;
  current = next;
  listeners.forEach((listener) => listener());
}
// A save on its way wins over a bootstrap loaded meanwhile.
let pending = 0;
export function setSettingsLevelFromServer(boot: SettingsLevelBoot | undefined) {
  if (!pending && boot) setSettingsLevelLocal(boot.level);
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function useSettingsLevel(): SettingsLevel {
  return useSyncExternalStore(subscribe, settingsLevel, () => DEFAULT_SETTINGS_LEVEL);
}

// Sets the person's own level: at once here, then on the server
// (profile.settingsLevel, all devices); back to the previous one when that
// fails. `mutate` is the app's command function (components/workspace-app.tsx
// hands it to Settings and the introduction).
export async function setOwnSettingsLevel(mutate: (body: Record<string, unknown>) => Promise<unknown>, level: SettingsLevel) {
  const before = current;
  setSettingsLevelLocal(level);
  pending++;
  try {
    await mutate({ action: "profile.settingsLevel", level });
  } catch (e) {
    setSettingsLevelLocal(before);
    throw e;
  } finally {
    pending--;
  }
}
