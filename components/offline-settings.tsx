"use client";
import { useLocale, useT } from "./i18n";
import { friendlyError } from "./ui";
import { useCallback, useEffect, useState } from "react";
import { ago } from "./page-activity";
import { SettingGroup, SettingRow, StatusBadge, SwitchRow } from "./settings-ui";
import { bytes } from "./admin-storage";
import {
  OFFLINE_CHANGED,
  RECORD_LIMIT,
  disableOffline,
  enableOffline,
  offlineMarker,
  offlineSupported,
  refreshOffline,
  setOfflineRecords,
  type OfflineMarker,
} from "./offline";

// Settings → Offline & Geräte. Opt-in per device: the copies contain the
// workspace's private content.
export function OfflineSettings({
  userId,
  workspaceId,
}: {
  userId: string;
  workspaceId: string;
}) {
  const t = useT();
  const locale = useLocale();
  const [supported, setSupported] = useState(true),
    [marker, setMarker] = useState<OfflineMarker | null>(null),
    [busy, setBusy] = useState(false),
    [progress, setProgress] = useState<[number, number] | null>(null),
    [message, setMessage] = useState("");
  const load = useCallback(
    () => void offlineMarker().then((m) => setMarker(m?.user === userId ? m : null)),
    [userId],
  );
  useEffect(() => {
    if (!offlineSupported()) {
      setSupported(false);
      return;
    }
    load();
    window.addEventListener(OFFLINE_CHANGED, load);
    return () => window.removeEventListener(OFFLINE_CHANGED, load);
  }, [load]);
  const enabled = !!marker;
  const pagesText = (n: number) =>
    t(`${n} ${n === 1 ? "Seite" : "Seiten"}`, `${n} ${n === 1 ? "page" : "pages"}`);
  async function enable() {
    setBusy(true);
    setMessage("");
    try {
      const result = await enableOffline(userId, workspaceId, (done, total) => setProgress([done, total]));
      const n = (await offlineMarker())?.pages ?? result.fetched;
      setMessage(
        result.status === "signed-out"
          ? t("Du wurdest abgemeldet – melde dich erneut an, um die Offline-Kopie zu aktualisieren.", "You were signed out – sign in again to update the offline copy.")
          : result.status === "incomplete"
          ? t("Nicht alle Seiten konnten gespeichert werden – sie werden beim nächsten Aktualisieren nachgeholt.", "Not every page could be stored – they follow with the next update.")
          : t(`${pagesText(n)} auf diesem Gerät offline verfügbar.`, `${pagesText(n)} available offline on this device.`),
      );
    } catch (error) {
      setMessage(friendlyError(error));
    } finally {
      setBusy(false);
      setProgress(null);
      load();
    }
  }
  async function update() {
    setBusy(true);
    setMessage("");
    try {
      const result = await refreshOffline({ full: true, onProgress: (done, total) => setProgress([done, total]) });
      setMessage(
        result.status === "signed-out"
          ? t("Du wurdest abgemeldet – melde dich erneut an, um die Offline-Kopie zu aktualisieren.", "You were signed out – sign in again to update the offline copy.")
          : result.status === "incomplete"
            ? t("Nicht alle Seiten konnten aktualisiert werden – sie werden beim nächsten Mal nachgeholt.", "Not every page could be updated – they follow next time.")
            : result.status === "busy"
              ? t("Die Offline-Kopie wird gerade aktualisiert.", "The offline copy is being updated right now.")
              : t("Offline-Kopie ist auf dem neuesten Stand.", "Offline copy is up to date."),
      );
    } catch (error) {
      setMessage(friendlyError(error));
    } finally {
      setBusy(false);
      setProgress(null);
      load();
    }
  }
  async function records(on: boolean) {
    setBusy(true);
    setMessage("");
    setMarker((m) => (m ? { ...m, includeRecords: on } : m));
    try {
      await setOfflineRecords(on);
      load();
      // Fetches the records and files right away.
      if (on) await update();
    } finally {
      setBusy(false);
    }
  }
  async function disable() {
    setBusy(true);
    try {
      await disableOffline();
      setMarker(null);
      setMessage(t("Offline-Kopien auf diesem Gerät wurden entfernt.", "Offline copies on this device were removed."));
    } finally {
      setBusy(false);
    }
  }
  const updated = marker?.lastRefresh;
  return (
    <SettingGroup
      id="offline"
      title={t("Offline-Nutzung", "Offline use")}
      description={t(
        "Speichert die App und die Seiten dieses Arbeitsbereichs auf diesem Gerät, damit du sie ohne Verbindung öffnen kannst. Solange die App geöffnet ist, hält sie die Kopie aktuell. Nur auf eigenen Geräten aktivieren: Die Kopien bleiben bis zum Abmelden oder Ausschalten erhalten.",
        "Stores the app and this workspace's pages on this device so you can open them without a connection. While the app is open it keeps the copy current. Only enable on your own devices: the copies stay until you sign out or turn this off.",
      )}
    >
      {!supported ? (
        <SettingRow label={t("Auf diesem Gerät", "On this device")} description={t("Dieser Browser unterstützt keine Offline-Nutzung (sichere Verbindung und Service Worker erforderlich).", "This browser does not support offline use (secure connection and service worker required).")}>
          <StatusBadge tone="off">{t("Nicht unterstützt", "Not supported")}</StatusBadge>
        </SettingRow>
      ) : enabled ? (
        <>
          <SettingRow
            label={t("Offline-Kopie", "Offline copy")}
            description={
              <span className="offline-state" data-testid="offline-state">
                {updated ? t("Offline-Kopie aktualisiert", "Offline copy updated") + " " + ago(updated, Date.now(), locale) : t("Offline-Kopie noch nicht vollständig", "Offline copy not complete yet")}
                {marker.pages !== undefined && ` · ${pagesText(marker.pages)}`}
                {marker.bytes !== undefined && ` · ${bytes(marker.bytes)}`}
              </span>
            }
          >
            <StatusBadge tone={updated ? "ok" : "warn"}>{t("An", "On")}</StatusBadge>
            <button className="button" disabled={busy} onClick={update}>
              {t("Jetzt aktualisieren", "Update now")}
            </button>
          </SettingRow>
          <SwitchRow
            label={t("Auch Eintragsinhalte und Dateien speichern", "Also store record contents and files")}
            description={t(`Höchstens ${bytes(RECORD_LIMIT)}; sonst nur, was du schon geöffnet hast.`, `At most ${bytes(RECORD_LIMIT)}; otherwise only what you have opened.`)}
            checked={!!marker.includeRecords}
            disabled={busy}
            onChange={(on) => void records(on)}
          />
          <SettingRow label={t("Offline-Kopien entfernen", "Remove offline copies")} description={t("Löscht die Kopien auf diesem Gerät. Du kannst sie jederzeit neu laden.", "Deletes the copies on this device. You can load them again at any time.")}>
            <button className="button danger" disabled={busy} onClick={disable}>
              {t("Offline-Kopien entfernen", "Remove offline copies")}
            </button>
          </SettingRow>
        </>
      ) : (
        <SettingRow label={t("Auf diesem Gerät", "On this device")} description={t("Aus. Inhalte brauchen eine Verbindung.", "Off. Content needs a connection.")}>
          <StatusBadge tone="off">{t("Aus", "Off")}</StatusBadge>
          <button className="button primary" disabled={busy} onClick={enable}>
            {t("Auf diesem Gerät offline verfügbar machen", "Make available offline on this device")}
          </button>
        </SettingRow>
      )}
      {(progress || message) && (
        <p className="setting-note" role="status">
          {progress ? `${t("Wird gespeichert …", "Saving …")} ${progress[0]} ${t("von", "of")} ${progress[1]}` : message}
        </p>
      )}
      <SettingRow
        label={t("Synchronisierung", "Sync")}
        description={t(
          "Dokumente und Whiteboards werden zusätzlich auf diesem Gerät gespeichert und nach Wiederherstellung der Verbindung zusammengeführt. Einträge in Datenbanken lassen sich offline anlegen, ändern und löschen; Konflikte kannst du danach auflösen.",
          "Documents and whiteboards are also stored on this device and merged once the connection is back. Database records can be created, changed and deleted offline; you can resolve conflicts afterwards.",
        )}
      >
        {null}
      </SettingRow>
    </SettingGroup>
  );
}
