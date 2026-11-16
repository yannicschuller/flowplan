"use client";
// The open page's save state in the top bar ("Gespeichert", "Speichert …").
//
// While one types it changes several times a second (unsaved → saving →
// saved). Held as state of the workspace, every change re-rendered the
// whole workspace – sidebar tree, dialogs, palette – which against
// `next dev` took the main thread for hundreds of milliseconds each time
// and held back the keystrokes and the save itself (live-editing.spec.ts:
// a word reached the second window up to 1 s late). Now the state lives in
// a store of its own and only this badge follows it.
import { useState, useSyncExternalStore } from "react";
import { CloudCheck, WifiSlash } from "@phosphor-icons/react";
import { saveStatusOf } from "@/lib/save-status";
import { useStatusLabel } from "./i18n";
import { CrossFade } from "./motion";

export type SaveStatusStore = {
  get: () => string;
  set: (value: string) => void;
  subscribe: (listener: () => void) => () => void;
};

export function createSaveStatusStore(initial: string): SaveStatusStore {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next) => {
      if (next === value) return;
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

// One store per workspace view; `set` is stable (an editor's onStatus).
export function useSaveStatusStore(initial: string) {
  return useState(() => createSaveStatusStore(initial))[0];
}

export function SaveStatusBadge({ store, online }: { store: SaveStatusStore; online: boolean }) {
  const status = useSyncExternalStore(store.subscribe, store.get, store.get);
  const statusLabel = useStatusLabel();
  return (
    <CrossFade
      className={`save-status${online && ["saved", "changes-saved", "loading", "syncing"].includes(saveStatusOf(status) || "") ? " save-status-quiet" : ""}`}
      value={`${online}:${statusLabel(status)}`}
    >
      {/* The icon after the text, so it stays put while the text
          changes its width. */}
      <span>{statusLabel(status)}</span>
      {online ? <CloudCheck size={15} /> : <WifiSlash size={15} />}
    </CrossFade>
  );
}
