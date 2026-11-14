import { useSyncExternalStore } from "react";
import { DEFAULT_START_SCREEN, startScreenOf, type StartScreen } from "./start-screen";

// "Beim Öffnen auf dem Handy" (lib/start-screen.ts) in the browser: set
// from the bootstrap (components/workspace-app.tsx) and by the settings.
const listeners = new Set<() => void>();
let current: StartScreen = DEFAULT_START_SCREEN;
let known = false;
export function startScreen(): StartScreen {
  return current;
}
export function setStartScreenLocal(value: unknown) {
  const next = startScreenOf(value);
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
/** The choice; `fallback` (the bootstrap's) until the browser's copy is set. */
export function useStartScreen(fallback: StartScreen = DEFAULT_START_SCREEN): StartScreen {
  return useSyncExternalStore(
    subscribe,
    () => (known ? current : fallback),
    () => fallback,
  );
}
