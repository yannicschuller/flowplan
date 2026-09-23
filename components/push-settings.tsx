"use client";
import { useEffect, useState } from "react";
import { api } from "./ui";
export default function PushSettings() {
  const [registration, setRegistration] =
    useState<ServiceWorkerRegistration | null>(null);
  const [key, setKey] = useState(""),
    [subscribed, setSubscribed] = useState(false),
    [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(""),
    [supported, setSupported] = useState(true),
    [installRequired, setInstallRequired] = useState(false);
  useEffect(() => {
    const ios =
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      !!(navigator as Navigator & { standalone?: boolean }).standalone;
    setInstallRequired(ios && !standalone);
    if (
      !window.isSecureContext ||
      !("serviceWorker" in navigator) ||
      !("PushManager" in window) ||
      !("Notification" in window)
    ) {
      setSupported(false);
      return;
    }
    let active = true;
    Promise.all([
      navigator.serviceWorker
        .register("/sw.js", { scope: "/" })
        .then(() => navigator.serviceWorker.ready),
      api<{ publicKey: string; subscribed: boolean }>("/api/push"),
    ])
      .then(async ([reg, config]) => {
        if (!active) return;
        setRegistration(reg);
        setKey(config.publicKey);
        setSubscribed(
          config.subscribed && !!(await reg.pushManager.getSubscription()),
        );
      })
      .catch((error) => active && setMessage((error as Error).message));
    return () => {
      active = false;
    };
  }, []);
  async function enable() {
    if (!registration || !key) return;
    setBusy(true);
    setMessage("");
    try {
      // Permission is requested directly from this user gesture, never on page load.
      const permission = await Notification.requestPermission();
      if (permission !== "granted")
        throw new Error(
          "Benachrichtigungen wurden nicht erlaubt. Du kannst die Berechtigung in den Geräte- oder Browsereinstellungen ändern.",
        );
      const bytes = Uint8Array.from(
        atob(key.replaceAll("-", "+").replaceAll("_", "/")),
        (char) => char.charCodeAt(0),
      );
      const current = await registration.pushManager.getSubscription();
      const sub =
        current ||
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: bytes,
        }));
      await api("/api/push", {
        action: "subscribe",
        subscription: sub.toJSON(),
      });
      setSubscribed(true);
      setMessage("Push ist auf diesem Gerät aktiviert.");
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function disable() {
    setBusy(true);
    try {
      const sub = await registration?.pushManager.getSubscription();
      if (sub) {
        await api("/api/push", {
          action: "unsubscribe",
          endpoint: sub.endpoint,
        });
        await sub.unsubscribe();
      }
      setSubscribed(false);
      setMessage("Push ist auf diesem Gerät deaktiviert.");
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-section push-settings">
      <h2>Push-Benachrichtigungen</h2>
      <p>
        Erhalte Hinweise zu neuen Kommentaren und Erwähnungen, auch wenn
        Flowplan geschlossen ist. Auf dem Sperrbildschirm erscheint ein
        allgemeiner Hinweis ohne Dokumentinhalt.
      </p>
      <p className="muted">
        Auf iPhone und iPad: Flowplan in Safari über das Teilen-Menü zum
        Home-Bildschirm hinzufügen, von dort öffnen und Benachrichtigungen
        aktivieren. Benötigt iOS/iPadOS 16.4 oder neuer und HTTPS.
      </p>
      {installRequired ? (
        <p role="status">
          Öffne Flowplan zuerst über das Symbol auf deinem Home-Bildschirm.
        </p>
      ) : !supported ? (
        <p role="status">
          Dieser Browser unterstützt Push hier nicht. Verwende eine sichere
          HTTPS-Adresse und einen unterstützten Browser.
        </p>
      ) : (
        <>
          <p>
            Status:{" "}
            <strong>
              {subscribed
                ? "Auf diesem Gerät aktiviert"
                : "Auf diesem Gerät deaktiviert"}
            </strong>
          </p>
          <div className="modal-actions">
            <button
              className="button primary"
              disabled={busy || !registration || !key}
              onClick={subscribed ? disable : enable}
            >
              {subscribed ? "Push deaktivieren" : "Push aktivieren"}
            </button>
            {subscribed && (
              <button
                className="button"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await api("/api/push", { action: "test" });
                    setMessage(
                      "Testbenachrichtigung wurde zum Versand eingereiht.",
                    );
                  } catch (e) {
                    setMessage((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Testbenachrichtigung senden
              </button>
            )}
          </div>
        </>
      )}
      {message && <p role="status">{message}</p>}
      <p className="muted">
        Die Aktivierung gilt für die aktuelle Anmeldung auf diesem Gerät. Nach
        Abmeldung oder Ablauf der Sitzung ist eine erneute Aktivierung nötig.
      </p>
    </section>
  );
}
