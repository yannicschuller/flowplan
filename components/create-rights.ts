"use client";
// Whether the signed-in person may create pages in the open workspace (not
// a viewer, not a guest) – set by the workspace shell, read by editors deep
// below it (the table's "In Datenbank umwandeln", #118). The server checks
// again; this only keeps actions out of sight that would be refused.
import { useSyncExternalStore } from "react";

let canCreate = false;
const listeners = new Set<() => void>();
export function setCanCreatePages(value: boolean) {
  if (value === canCreate) return;
  canCreate = value;
  listeners.forEach((l) => l());
}
export function useCanCreatePages() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => canCreate,
    () => false,
  );
}
