"use client";
// Offline use switched on from the iPhone, iPad and Android app (lib/app-offline-offer.ts):
// the page reports where it stands and, when the app asks, stores the copy
// like Settings → Offline & devices – with its progress and outcome as a
// short notice here, since the settings are not open.
import { useEffect, useState } from "react";
import { nativeApp } from "@/lib/native-app";
import { installAppOfflineOffer, type AppOfflineResult } from "@/lib/app-offline-offer";
import { offlineStore } from "@/lib/offline-store";
import { useT } from "./i18n";
import { OFFLINE_CHANGED, enableOffline, offlineMarker, offlineSupported } from "./offline";

export function useAppOfflineOffer(userId: string, workspaceId: string, guest: boolean, demo: boolean) {
  const t = useT();
  const [progress, setProgress] = useState<[number, number] | null>(null);
  const [outcome, setOutcome] = useState<{ result: AppOfflineResult; pages?: number } | null>(null);
  useEffect(() => {
    let hide: ReturnType<typeof setTimeout> | undefined;
    const stop = installAppOfflineOffer(
      { userId, workspaceId, guest, demo },
      {
        app: nativeApp(),
        target: window,
        changedEvent: OFFLINE_CHANGED,
        supported: offlineSupported,
        secure: () => window.isSecureContext,
        online: () => navigator.onLine,
        marker: offlineMarker,
        estimate: async () => (await offlineStore()?.estimate()) ?? null,
        enable: enableOffline,
        onProgress: (next) => {
          setProgress(next);
          if (next) setOutcome(null);
        },
        onResult: (result, pages) => {
          setOutcome({ result, pages });
          clearTimeout(hide);
          hide = setTimeout(() => setOutcome(null), 6000);
        },
      },
    );
    return () => {
      clearTimeout(hide);
      stop();
    };
  }, [userId, workspaceId, guest, demo]);
  if (progress)
    return (
      <div className="offline-refresh-status" role="status">
        {`${t("Wird gespeichert …", "Saving …")} ${progress[0]} ${t("von", "of")} ${progress[1]}`}
      </div>
    );
  if (!outcome) return null;
  const n = outcome.pages ?? 0;
  const pagesText = t(`${n} ${n === 1 ? "Seite" : "Seiten"}`, `${n} ${n === 1 ? "page" : "pages"}`);
  return (
    <div className="offline-refresh-status" role="status">
      {outcome.result === "signed-out"
        ? t(
            "Du wurdest abgemeldet – melde dich erneut an, um die Offline-Kopie zu aktualisieren.",
            "You were signed out – sign in again to update the offline copy.",
          )
        : outcome.result === "incomplete"
          ? t(
              "Nicht alle Seiten konnten gespeichert werden – sie werden beim nächsten Aktualisieren nachgeholt.",
              "Not every page could be stored – they follow with the next update.",
            )
          : outcome.result === "failed"
            ? t("Die Offline-Kopie konnte nicht gespeichert werden.", "The offline copy could not be stored.")
            : t(`${pagesText} auf diesem Gerät offline verfügbar.`, `${pagesText} available offline on this device.`)}
    </div>
  );
}
