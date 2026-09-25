"use client";
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
        `${pageIds.length} ${pageIds.length === 1 ? "Seite ist" : "Seiten sind"} auf diesem Gerät offline verfügbar.`,
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
      setMessage("Offline-Kopien auf diesem Gerät wurden entfernt.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-section">
      <h2>Offline-Nutzung</h2>
      <p>
        Speichert die App und den aktuellen Stand der Seiten dieses
        Arbeitsbereichs auf diesem Gerät, damit du sie ohne Verbindung öffnen
        kannst. Nur auf eigenen Geräten aktivieren: Die Kopien bleiben bis zum
        Abmelden oder Ausschalten erhalten.
      </p>
      {!supported ? (
        <p className="muted">
          Dieser Browser unterstützt keine Offline-Nutzung (sichere Verbindung
          und Service Worker erforderlich).
        </p>
      ) : enabled ? (
        <div className="archive-actions">
          <button className="button" disabled={busy} onClick={enable}>
            Offline-Stand aktualisieren
          </button>
          <button className="button danger" disabled={busy} onClick={disable}>
            Offline-Kopien entfernen
          </button>
        </div>
      ) : (
        <button className="button primary" disabled={busy} onClick={enable}>
          Auf diesem Gerät offline verfügbar machen
        </button>
      )}
      {progress && (
        <p role="status">
          Wird gespeichert … {progress[0]} von {progress[1]}
        </p>
      )}
      {message && !progress && <p role="status">{message}</p>}
    </section>
  );
}
