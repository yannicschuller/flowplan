"use client";
import { useT } from "./i18n";
import { useEffect, useState } from "react";
import { api } from "./ui";
export default function PushSettings() {
  const t = useT();
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
          t("Benachrichtigungen wurden nicht erlaubt. Du kannst die Berechtigung in den Geräte- oder Browsereinstellungen ändern.", "Notifications were not allowed. You can change the permission in the device or browser settings."),
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
      setMessage(t("Push ist auf diesem Gerät aktiviert.", "Push is enabled on this device."));
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
      setMessage(t("Push ist auf diesem Gerät deaktiviert.", "Push is disabled on this device."));
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-section push-settings">
      <h2>{t("Push-Benachrichtigungen", "Push notifications")}</h2>
      <p>
        {t("Erhalte Hinweise zu neuen Kommentaren und Erwähnungen, auch wenn Flowplan geschlossen ist. Auf dem Sperrbildschirm erscheint ein allgemeiner Hinweis ohne Dokumentinhalt.", "Get notified about new comments and mentions even when Flowplan is closed. The lock screen shows a general notice without document content.")}
      </p>
      <p className="muted">
        {t("Auf iPhone und iPad: Flowplan in Safari über das Teilen-Menü zum Home-Bildschirm hinzufügen, von dort öffnen und Benachrichtigungen aktivieren. Benötigt iOS/iPadOS 16.4 oder neuer und HTTPS.", "On iPhone and iPad: add Flowplan to the Home Screen in Safari via the share menu, open it from there and enable notifications. Requires iOS/iPadOS 16.4 or newer and HTTPS.")}
      </p>
      {installRequired ? (
        <p role="status">
          {t("Öffne Flowplan zuerst über das Symbol auf deinem Home-Bildschirm.", "Open Flowplan from the icon on your Home Screen first.")}
        </p>
      ) : !supported ? (
        <p role="status">
          {t("Dieser Browser unterstützt Push hier nicht. Verwende eine sichere HTTPS-Adresse und einen unterstützten Browser.", "This browser does not support push here. Use a secure HTTPS address and a supported browser.")}
        </p>
      ) : (
        <>
          <p>
            {t("Status:", "Status:")}{" "}
            <strong>
              {subscribed
                ? t("Auf diesem Gerät aktiviert", "Enabled on this device")
                : t("Auf diesem Gerät deaktiviert", "Disabled on this device")}
            </strong>
          </p>
          <div className="modal-actions">
            <button
              className="button primary"
              disabled={busy || !registration || !key}
              onClick={subscribed ? disable : enable}
            >
              {subscribed ? t("Push deaktivieren", "Disable push") : t("Push aktivieren", "Enable push")}
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
                      t("Testbenachrichtigung wurde zum Versand eingereiht.", "The test notification has been queued."),
                    );
                  } catch (e) {
                    setMessage((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {t("Testbenachrichtigung senden", "Send test notification")}
              </button>
            )}
          </div>
        </>
      )}
      {message && <p role="status">{message}</p>}
      <p className="muted">
        {t("Die Aktivierung gilt für die aktuelle Anmeldung auf diesem Gerät. Nach Abmeldung oder Ablauf der Sitzung ist eine erneute Aktivierung nötig.", "Enabling applies to the current sign-in on this device. After signing out or when the session expires, enable it again.")}
      </p>
    </section>
  );
}
