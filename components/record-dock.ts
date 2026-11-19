"use client";
// Whether a record can dock beside its view right now (#392,
// lib/side-panel.ts): a window wide enough and the app's shell with the
// panel's place. Known at the first render (no flash of a record page
// before the panel), kept up to date as the window changes.
import { useSyncExternalStore } from "react";
import { RECORD_DOCK_MEDIA } from "@/lib/side-panel";

const subscribe = (listener: () => void) => {
  const media = matchMedia(RECORD_DOCK_MEDIA);
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
};
const snapshot = () => matchMedia(RECORD_DOCK_MEDIA).matches && !!document.getElementById("side-dock-root");
export const useRecordDock = () => useSyncExternalStore(subscribe, snapshot, () => false);
