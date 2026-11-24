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
import { CloudArrowUp, CloudCheck } from "@phosphor-icons/react";
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

// The usual states while one types need no words (#527): only the cloud
// shows them – a check when saved, an arrow while saving – with the words
// in its tooltip and for screen readers. Text appears when attention is
// needed: offline, failed, retrying, not kept on the device, and longer
// work (an upload, a transcription, a new version loading).
const CALM = ["saved", "changes-saved", "loading", "syncing", "saving", "unsaved"];

export function SaveStatusBadge({ store, online }: { store: SaveStatusStore; online: boolean }) {
  const status = useSyncExternalStore(store.subscribe, store.get, store.get);
  const statusLabel = useStatusLabel();
  const key = saveStatusOf(status) || "";
  const label = statusLabel(status);
  // Offline, the top bar's offline icon (components/offline-status.tsx) is
  // the one indicator (#332): the badge keeps its words ("Offline
  // gespeichert") without an icon of its own, and on phones, where only
  // the icon would show, it steps back like a quiet state.
  const quiet = !online || ["saved", "changes-saved", "loading", "syncing"].includes(key);
  const calm = online && CALM.includes(key);
  const busy = ["saving", "unsaved", "syncing", "loading"].includes(key);
  if (calm)
    return (
      <CrossFade className={`save-status save-status-icon${quiet ? " save-status-quiet" : ""}`} value={busy ? "busy" : "done"} title={label}>
        <span className="sr-only">{label}</span>
        {busy ? <CloudArrowUp size={15} aria-hidden /> : <CloudCheck size={15} aria-hidden />}
      </CrossFade>
    );
  return (
    <CrossFade className={`save-status${quiet ? " save-status-quiet" : ""}`} value={`${online}:${label}`}>
      {/* The icon after the text, so it stays put while the text
          changes its width. */}
      <span>{label}</span>
      {online && <CloudCheck size={15} />}
    </CrossFade>
  );
}
