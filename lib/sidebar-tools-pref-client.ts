import { useSyncExternalStore } from "react";
import { hiddenSidebarToolsOf, sameHiddenSidebarTools, type SidebarToolId } from "./sidebar-tools-pref";

// "Symbole unten in der Seitenleiste" (#589, lib/sidebar-tools-pref.ts) in
// the browser: set from the bootstrap (components/workspace-app.tsx), by
// the settings and by the row's own menu ("Aus Leiste ausblenden"); the
// sidebar reads it.
const listeners = new Set<() => void>();
const NONE: SidebarToolId[] = [];
let current: SidebarToolId[] = NONE;
const emit = () => listeners.forEach((listener) => listener());

export function hiddenSidebarTools(): SidebarToolId[] {
  return current;
}
function setLocal(value: unknown) {
  const next = hiddenSidebarToolsOf(value);
  if (sameHiddenSidebarTools(next, current)) return;
  current = next;
  emit();
}
// The first bootstrap, while the app renders for the first time: taken
// without telling anyone (nothing has read it yet), so hidden symbols never
// flash up.
let primed = false;
export function primeHiddenSidebarTools(value: unknown) {
  if (primed || value === undefined) return;
  primed = true;
  current = hiddenSidebarToolsOf(value);
}
// A save on its way wins over a bootstrap loaded meanwhile (it was read
// before the save).
let pending = 0;
export function setHiddenSidebarToolsFromServer(value: unknown) {
  if (pending) return;
  primed = true;
  setLocal(value);
}
// The person's choice: at once here, then on the server
// (profile.sidebarTools, all devices); back to the previous one when that
// fails. Saves go one after the other, each with the choice as it is then.
let queue: Promise<unknown> = Promise.resolve();
export function saveHiddenSidebarTools(next: readonly SidebarToolId[], save: (hidden: SidebarToolId[]) => Promise<unknown>): Promise<unknown> {
  const before = current;
  setLocal(next);
  pending++;
  const done = queue.then(() => save(current));
  queue = done.catch(() => undefined);
  return done
    .catch((e) => {
      setLocal(before);
      throw e;
    })
    .finally(() => {
      pending--;
    });
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function useHiddenSidebarTools(): SidebarToolId[] {
  return useSyncExternalStore(subscribe, hiddenSidebarTools, () => NONE);
}
