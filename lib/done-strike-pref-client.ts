import { useSyncExternalStore } from "react";
import { DEFAULT_STRIKE_DONE_TASKS, strikeDoneTasksOf } from "./done-strike-pref";

// "Erledigte Aufgaben durchstreichen" (#458, lib/done-strike-pref.ts) in the
// browser: set from the bootstrap (components/workspace-app.tsx, which also
// puts the class on <html>) and by the settings; lib/motion.ts reads the
// class (no line drawn when ticking off).
const listeners = new Set<() => void>();
let current = DEFAULT_STRIKE_DONE_TASKS;
export function strikeDoneTasks(): boolean {
  return current;
}
export function setStrikeDoneTasksLocal(value: unknown) {
  const next = strikeDoneTasksOf(value);
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
export function useStrikeDoneTasks(): boolean {
  return useSyncExternalStore(subscribe, strikeDoneTasks, () => DEFAULT_STRIKE_DONE_TASKS);
}
