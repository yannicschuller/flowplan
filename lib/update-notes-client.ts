import { useSyncExternalStore } from "react";
import { DEFAULT_UPDATE_NOTES_LEVEL, updateNotesLevelOf, type UpdateNotesLevel } from "./update-notes-pref";

// "Neuigkeiten nach Updates" (#223, lib/update-notes-pref.ts) in the browser:
// the level, set from the bootstrap (components/workspace-app.tsx) and by the
// settings; and the request to open "Was ist neu" from anywhere (menus,
// settings), which components/whats-new.tsx answers.
type Listener = () => void;
const listeners = new Set<Listener>();
let level: UpdateNotesLevel = DEFAULT_UPDATE_NOTES_LEVEL;
let openRequests = 0;
const notify = () => listeners.forEach((listener) => listener());
function subscribe(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const updateNotesLevel = (): UpdateNotesLevel => level;
export function setUpdateNotesLevelLocal(value: unknown) {
  const next = updateNotesLevelOf(value);
  if (next === level) return;
  level = next;
  notify();
}
export function useUpdateNotesLevel(): UpdateNotesLevel {
  return useSyncExternalStore(subscribe, updateNotesLevel, () => DEFAULT_UPDATE_NOTES_LEVEL);
}

// "Was ist neu": a counter, so asking twice opens it twice.
export function openWhatsNew() {
  openRequests++;
  notify();
}
export function useWhatsNewRequests(): number {
  return useSyncExternalStore(subscribe, () => openRequests, () => 0);
}
