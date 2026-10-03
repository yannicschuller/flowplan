"use client";
import { useT } from "./i18n";
import { useEffect, useState } from "react";
import {
  disableOffline,
  enableOffline,
  offlineOwner,
  offlineSupported,
} from "./offline";

// Opt-in per device: the copies contain the workspace's private content.
export function OfflineSettings({
  userId,
  workspaceId,
  pageIds,
}: {
  userId: string;
  workspaceId: string;
  pageIds: string[];
}) {
  const t = useT();
  const [supported, setSupported] = useState(true),
    [enabled, setEnabled] = useState(false),
    [busy, setBusy] = useState(false),
    [progress, setProgress] = useState<[number, number] | null>(null),
    [message, setMessage] = useState("");
  useEffect(() => {
    if (!offlineSupported()) {
      setSupported(false);
      return;
    }
    void offlineOwner().then((owner) => setEnabled(owner === userId));
  }, [userId]);
  async function enable() {
    setBusy(true);
    setMessage("");
    try {
      await enableOffline(userId, workspaceId, pageIds, (done, total) =>
        setProgress([done, total]),
      );
      setEnabled(true);
      setMessage(
        t(`${pageIds.length} ${pageIds.length === 1 ? "Seite ist" : "Seiten sind"} auf diesem Gerät offline verfügbar.`, `${pageIds.length} ${pageIds.length === 1 ? "page is" : "pages are"} available offline on this device.`),
      );
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }
  async function disable() {
    setBusy(true);
    try {
      await disableOffline();
      setEnabled(false);
      setMessage(t("Offline-Kopien auf diesem Gerät wurden entfernt.", "Offline copies on this device were removed."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-section">
      <h2>{t("Offline-Nutzung", "Offline use")}</h2>
      <p>
        {t("Speichert die App und den aktuellen Stand der Seiten dieses Arbeitsbereichs auf diesem Gerät, damit du sie ohne Verbindung öffnen kannst. Nur auf eigenen Geräten aktivieren: Die Kopien bleiben bis zum Abmelden oder Ausschalten erhalten.", "Stores the app and the current state of this workspace's pages on this device so you can open them without a connection. Only enable on your own devices: the copies stay until you sign out or turn this off.")}
      </p>
      {!supported ? (
        <p className="muted">
          {t("Dieser Browser unterstützt keine Offline-Nutzung (sichere Verbindung und Service Worker erforderlich).", "This browser does not support offline use (secure connection and service worker required).")}
        </p>
      ) : enabled ? (
        <div className="archive-actions">
          <button className="button" disabled={busy} onClick={enable}>
            {t("Offline-Stand aktualisieren", "Update offline copy")}
          </button>
          <button className="button danger" disabled={busy} onClick={disable}>
            {t("Offline-Kopien entfernen", "Remove offline copies")}
          </button>
        </div>
      ) : (
        <button className="button primary" disabled={busy} onClick={enable}>
          {t("Auf diesem Gerät offline verfügbar machen", "Make available offline on this device")}
        </button>
      )}
      {progress && (
        <p role="status">
          {t("Wird gespeichert …", "Saving …")}{" "}{progress[0]} {t("von", "of")}{" "}{progress[1]}
        </p>
      )}
      {message && !progress && <p role="status">{message}</p>}
    </section>
  );
}
