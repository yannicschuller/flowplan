"use client";
// Push on this device: Web Push in the browser, the Flowplan app's own push
// (flowplan-app) or the desktop app's system notifications (Electron has no
// Web Push). In the settings (`group`) a card of setting rows; in the
// introduction (components/onboarding.tsx) the plain section.
import { useT } from "./i18n";
import { useEffect, useState } from "react";
import { api } from "./ui";
import { desktopApp, inDesktopApp, nativeApp } from "@/lib/native-app";
import { SettingGroup, SettingRow, StatusBadge } from "./settings-ui";
import PushTest, { type ThisBrowser } from "./push-test";
export default function PushSettings({ group = false }: { group?: boolean }) {
  const t = useT();
  // In the Flowplan app the app delivers push itself (flowplan-app).
  const [app, setApp] = useState<ReturnType<typeof nativeApp>>(undefined);
  // In the desktop app the app shows system notifications itself: Electron
  // has no Web Push. "old" is a desktop app from before it could.
  const [desktop, setDesktop] = useState<ReturnType<typeof desktopApp> | "old">(undefined);
  const [desktopOn, setDesktopOn] = useState(false);
  const [registration, setRegistration] =
    useState<ServiceWorkerRegistration | null>(null);
  const [key, setKey] = useState(""),
    [subscribed, setSubscribed] = useState(false),
    [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(""),
    [supported, setSupported] = useState(true),
    [installRequired, setInstallRequired] = useState(false),
    [ios, setIos] = useState(false);
  useEffect(() => {
    const ios =
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      !!(navigator as Navigator & { standalone?: boolean }).standalone;
    setIos(ios);
    setInstallRequired(ios && !standalone);
    const inDesktop = desktopApp();
    if (inDesktop?.notifications) {
      setDesktop(inDesktop);
      let active = true;
      inDesktop.notifications
        .enabled()
        .then((on) => active && setDesktopOn(on))
        .catch(() => {});
      return () => {
        active = false;
      };
    }
    if (inDesktopApp()) {
      setDesktop("old");
      return;
    }
    const inApp = nativeApp();
    if (inApp) {
      setApp(inApp);
      let active = true;
      api<{ subscribed: boolean }>("/api/push")
        .then((config) => active && setSubscribed(config.subscribed))
        .catch((error) => active && setMessage((error as Error).message));
      return () => {
        active = false;
      };
    }
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
  // What the test can tell about this browser beyond the server's list.
  const thisBrowser: ThisBrowser =
    desktop || app || installRequired || !supported
      ? null
      : subscribed
        ? "subscribed"
        : typeof Notification !== "undefined" && Notification.permission === "denied"
          ? "denied"
          : "off";
  const iosHint = t(
    "Auf iPhone und iPad: Flowplan in Safari über das Teilen-Menü zum Home-Bildschirm hinzufügen, von dort öffnen und Benachrichtigungen aktivieren. Benötigt iOS/iPadOS 16.4 oder neuer und HTTPS.",
    "On iPhone and iPad: add Flowplan to the Home Screen in Safari via the share menu, open it from there and enable notifications. Requires iOS/iPadOS 16.4 or newer and HTTPS.",
  );
  if (group) {
    return (
      <SettingGroup
        id="push"
        title={t("Push-Benachrichtigungen", "Push notifications")}
        description={
          desktop
            ? t("Benachrichtigungen übernimmt die Desktop-App: Sie fragt, solange sie läuft, nach neuen Benachrichtigungen und zeigt sie als Mitteilungen des Systems mit der Zahl am App-Symbol. „Nicht stören“ und „Alle Profile“ findest du im Menü der App.", "Notifications are handled by the desktop app: while it runs, it asks for new notifications and shows them as system notifications with the count on the app icon. Find “Do Not Disturb” and “All Profiles” in the app's menu.")
            : t("Erhalte Hinweise zu neuen Kommentaren und Erwähnungen, auch wenn Flowplan geschlossen ist. Auf dem Sperrbildschirm erscheint ein allgemeiner Hinweis ohne Dokumentinhalt.", "Get notified about new comments and mentions even when Flowplan is closed. The lock screen shows a general notice without document content.")
        }
      >
        {desktop === "old" ? (
          <SettingRow label={t("Desktop-App", "Desktop app")} description={t("Aktualisiere die Flowplan-Desktop-App, damit sie Benachrichtigungen anzeigt.", "Update the Flowplan desktop app so it shows notifications.")}>
            <StatusBadge tone="warn">{t("Veraltet", "Outdated")}</StatusBadge>
          </SettingRow>
        ) : desktop?.notifications ? (
          <SettingRow
            label={t("Mitteilungen der Desktop-App", "Desktop app notifications")}
            description={desktopOn ? t("Die Desktop-App zeigt Mitteilungen an", "The desktop app shows notifications") : t("Die Desktop-App zeigt keine Mitteilungen an", "The desktop app does not show notifications")}
          >
            <StatusBadge tone={desktopOn ? "ok" : "off"}>{desktopOn ? t("An", "On") : t("Aus", "Off")}</StatusBadge>
            <button
              className="button primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  setDesktopOn(await desktop.notifications!.setEnabled(!desktopOn));
                } catch (e) {
                  setMessage((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {desktopOn ? t("Mitteilungen ausschalten", "Turn off notifications") : t("Mitteilungen einschalten", "Turn on notifications")}
            </button>
          </SettingRow>
        ) : app ? (
          <SettingRow
            label={t("Flowplan-App", "Flowplan app")}
            description={subscribed ? t("Die Flowplan-App erhält Benachrichtigungen", "The Flowplan app receives notifications") : t("Die Flowplan-App erhält keine Benachrichtigungen", "The Flowplan app does not receive notifications")}
          >
            <StatusBadge tone={subscribed ? "ok" : "off"}>{subscribed ? t("An", "On") : t("Aus", "Off")}</StatusBadge>
            {app.openSettings && (
              <button className="button primary" onClick={() => app.openSettings?.()}>
                {t("App-Einstellungen öffnen", "Open app settings")}
              </button>
            )}
          </SettingRow>
        ) : installRequired ? (
          <SettingRow label={t("Auf diesem Gerät", "On this device")} description={iosHint}>
            <StatusBadge tone="warn">{t("Vom Home-Bildschirm öffnen", "Open from the Home Screen")}</StatusBadge>
          </SettingRow>
        ) : !supported ? (
          <SettingRow label={t("Auf diesem Gerät", "On this device")} description={t("Dieser Browser unterstützt Push hier nicht. Verwende eine sichere HTTPS-Adresse und einen unterstützten Browser.", "This browser does not support push here. Use a secure HTTPS address and a supported browser.")}>
            <StatusBadge tone="off">{t("Nicht unterstützt", "Not supported")}</StatusBadge>
          </SettingRow>
        ) : (
          <SettingRow
            label={t("Auf diesem Gerät", "On this device")}
            description={t("Gilt für die aktuelle Anmeldung auf diesem Gerät. Nach Abmeldung oder Ablauf der Sitzung ist eine erneute Aktivierung nötig.", "Applies to the current sign-in on this device. After signing out or when the session expires, enable it again.")}
          >
            <StatusBadge tone={subscribed ? "ok" : "off"}>{subscribed ? t("Aktiviert", "Enabled") : t("Deaktiviert", "Disabled")}</StatusBadge>
            <button className={`button${subscribed ? "" : " primary"}`} disabled={busy || !registration || !key} onClick={subscribed ? disable : enable}>
              {subscribed ? t("Push deaktivieren", "Disable push") : t("Push aktivieren", "Enable push")}
            </button>
          </SettingRow>
        )}
        {desktop !== "old" && (
          <SettingRow
            wide
            anchor="push-test"
            label={t("Testbenachrichtigung", "Test notification")}
            description={t("Prüft, ob Benachrichtigungen auf deinen Geräten ankommen, und zeigt pro Gerät, was passiert ist.", "Checks whether notifications reach your devices and shows what happened for each one.")}
          >
            <PushTest thisBrowser={thisBrowser} />
          </SettingRow>
        )}
        {!desktop && !app && !installRequired && (
          <SettingRow label={t("iPhone und iPad", "iPhone and iPad")} description={iosHint}>
            {null}
          </SettingRow>
        )}
        {message && (
          <p className="setting-note" role="status">
            {message}
          </p>
        )}
      </SettingGroup>
    );
  }
  return (
    <section className="settings-section push-settings">
      <h2>{t("Push-Benachrichtigungen", "Push notifications")}</h2>
      {!desktop && (
      <p>
        {t("Erhalte Hinweise zu neuen Kommentaren und Erwähnungen, auch wenn Flowplan geschlossen ist. Auf dem Sperrbildschirm erscheint ein allgemeiner Hinweis ohne Dokumentinhalt.", "Get notified about new comments and mentions even when Flowplan is closed. The lock screen shows a general notice without document content.")}
      </p>
      )}
      {/* The iOS steps matter on iOS; elsewhere they stay behind a disclosure. */}
      {desktop ? null : ios ? (
        <p className="muted">
          {t("Auf iPhone und iPad: Flowplan in Safari über das Teilen-Menü zum Home-Bildschirm hinzufügen, von dort öffnen und Benachrichtigungen aktivieren. Benötigt iOS/iPadOS 16.4 oder neuer und HTTPS.", "On iPhone and iPad: add Flowplan to the Home Screen in Safari via the share menu, open it from there and enable notifications. Requires iOS/iPadOS 16.4 or newer and HTTPS.")}
        </p>
      ) : (
        <details className="push-ios-hint">
          <summary>{t("Hinweis für iPhone und iPad", "Note for iPhone and iPad")}</summary>
          <p className="muted">
            {t("Auf iPhone und iPad: Flowplan in Safari über das Teilen-Menü zum Home-Bildschirm hinzufügen, von dort öffnen und Benachrichtigungen aktivieren. Benötigt iOS/iPadOS 16.4 oder neuer und HTTPS.", "On iPhone and iPad: add Flowplan to the Home Screen in Safari via the share menu, open it from there and enable notifications. Requires iOS/iPadOS 16.4 or newer and HTTPS.")}
          </p>
        </details>
      )}
      {desktop === "old" ? (
        <p role="status">
          {t("Aktualisiere die Flowplan-Desktop-App, damit sie Benachrichtigungen anzeigt.", "Update the Flowplan desktop app so it shows notifications.")}
        </p>
      ) : desktop?.notifications ? (
        <>
          <p>
            {t("Benachrichtigungen übernimmt die Desktop-App: Sie fragt, solange sie läuft, nach neuen Benachrichtigungen und zeigt sie als Mitteilungen des Systems mit der Zahl am App-Symbol. „Nicht stören“ und „Alle Profile“ findest du im Menü der App.", "Notifications are handled by the desktop app: while it runs, it asks for new notifications and shows them as system notifications with the count on the app icon. Find “Do Not Disturb” and “All Profiles” in the app's menu.")}
          </p>
          <p>
            {t("Status:", "Status:")}{" "}
            <strong>
              {desktopOn
                ? t("Die Desktop-App zeigt Mitteilungen an", "The desktop app shows notifications")
                : t("Die Desktop-App zeigt keine Mitteilungen an", "The desktop app does not show notifications")}
            </strong>
          </p>
          <div className="modal-actions">
            <button
              className="button primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  setDesktopOn(await desktop.notifications!.setEnabled(!desktopOn));
                } catch (e) {
                  setMessage((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {desktopOn ? t("Mitteilungen ausschalten", "Turn off notifications") : t("Mitteilungen einschalten", "Turn on notifications")}
            </button>
          </div>
        </>
      ) : app ? (
        <>
          <p>
            {t("Status:", "Status:")}{" "}
            <strong>
              {subscribed
                ? t("Die Flowplan-App erhält Benachrichtigungen", "The Flowplan app receives notifications")
                : t("Die Flowplan-App erhält keine Benachrichtigungen", "The Flowplan app does not receive notifications")}
            </strong>
          </p>
          <div className="modal-actions">
            {app.openSettings && (
              <button className="button primary" onClick={() => app.openSettings?.()}>
                {t("App-Einstellungen öffnen", "Open app settings")}
              </button>
            )}
          </div>
        </>
      ) : installRequired ? (
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
          </div>
        </>
      )}
      {message && <p role="status">{message}</p>}
      {!desktop && subscribed && <PushTest thisBrowser={thisBrowser} />}
      {!desktop && (
        <p className="muted">
          {t("Die Aktivierung gilt für die aktuelle Anmeldung auf diesem Gerät. Nach Abmeldung oder Ablauf der Sitzung ist eine erneute Aktivierung nötig.", "Enabling applies to the current sign-in on this device. After signing out or when the session expires, enable it again.")}
        </p>
      )}
    </section>
  );
}
