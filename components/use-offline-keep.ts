"use client";
// "Offline behalten" / "Keep offline" (#417) for the space and page menus
// (components/workspace-app.tsx) and Settings → Offline & devices: whether
// offline use is on for this person on this device, what is kept, and the
// switch. The choice lives on the device (the offline marker,
// components/offline.ts); switching refreshes the copy right away when
// online, so the records and files follow – or are freed.
import { useCallback, useEffect, useState } from "react";
import { OFFLINE_CHANGED, offlineMarker, offlineSupported, refreshOffline, setOfflineKeep, type OfflineMarker } from "./offline";
import { isKept, type KeepItem } from "@/lib/offline-keep";
import { isStorageRefusal } from "@/lib/offline-store";
import { tr } from "@/lib/locale-tag";
import { showToast } from "./toast";

export function useOfflineKeep(userId: string) {
  const [marker, setMarker] = useState<OfflineMarker | null>(null);
  useEffect(() => {
    if (!offlineSupported()) return;
    let stopped = false;
    const load = () =>
      void offlineMarker().then((m) => {
        if (!stopped) setMarker(m?.user === userId ? m : null);
      });
    load();
    window.addEventListener(OFFLINE_CHANGED, load);
    return () => {
      stopped = true;
      window.removeEventListener(OFFLINE_CHANGED, load);
    };
  }, [userId]);
  const toggle = useCallback(async (item: KeepItem, on: boolean) => {
    try {
      await setOfflineKeep(item, on);
    } catch (error) {
      // Not stored on the device (#417): said so instead of a switch that
      // silently stays as it was.
      showToast({
        tone: "error",
        text: isStorageRefusal(error)
          ? tr(
              "„Offline behalten“ konnte nicht gespeichert werden – auf diesem Gerät ist zu wenig Speicher frei.",
              "“Keep offline” could not be saved – too little storage left on this device.",
            )
          : tr("„Offline behalten“ konnte nicht gespeichert werden.", "“Keep offline” could not be saved."),
      });
      return;
    }
    if (navigator.onLine) void refreshOffline({ again: true }).catch(() => undefined);
  }, []);
  return {
    enabled: !!marker,
    keep: marker?.keep || [],
    kept: (item: KeepItem) => isKept(marker?.keep, item),
    toggle,
  };
}
