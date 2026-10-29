"use client";
// On a phone or tablet in the browser, once per device after signing in: a
// hint that Flowplan is also an app (TestFlight on iPhone and iPad, the APK
// on Android). Not inside the apps, and not while the introduction runs;
// "Not now" and "Get the app" both end it. The links stay in Settings →
// Offline & devices → Apps.
import { useEffect, useState } from "react";
import {
  ANDROID_APK_URL,
  DOWNLOAD_URL,
  TESTFLIGHT_URL,
  phoneSystem,
  type PhoneSystem,
} from "@/lib/app-links";
import { inDesktopApp, nativeApp } from "@/lib/native-app";
import { settingsHash } from "@/lib/settings-sections";
import { useT } from "./i18n";
import { Modal } from "./ui";

const SEEN = "flowplan-app-promo";

export function AppPromo({ paused }: { paused: boolean }) {
  const t = useT();
  const [system, setSystem] = useState<PhoneSystem | null>(null);
  useEffect(() => {
    if (paused || nativeApp() || inDesktopApp() || "FlowplanApp" in window)
      return;
    const found = phoneSystem(navigator.userAgent, navigator.maxTouchPoints);
    if (!found) return;
    try {
      if (localStorage.getItem(SEEN)) return;
    } catch {
      return;
    }
    // A moment after the workspace is there, not over its first paint.
    const timer = window.setTimeout(() => setSystem(found), 1500);
    return () => window.clearTimeout(timer);
  }, [paused]);
  const close = () => {
    try {
      localStorage.setItem(SEEN, String(Date.now()));
    } catch {}
    setSystem(null);
  };
  if (!system) return null;
  const ios = system === "ios";
  return (
    <Modal
      open
      sheet
      onClose={close}
      title={t("Flowplan gibt es auch als App", "Flowplan is an app, too")}
    >
      <p>
        {ios
          ? t(
              "Für iPhone und iPad gibt es Flowplan als App – mit Widgets, Mitteilungen, Siri und Kurzbefehlen, Teilen aus jeder App und einer Offline-Kopie. Sie ist gerade als Beta über TestFlight zu haben: erst Apples App TestFlight installieren, dann den Link öffnen.",
              "Flowplan is an app for iPhone and iPad – with widgets, notifications, Siri and Shortcuts, sharing from any app and an offline copy. It is in beta on TestFlight right now: install Apple's TestFlight app first, then open the link.",
            )
          : t(
              "Für Android gibt es Flowplan als App – mit Widgets, Mitteilungen mit Knöpfen, Schnellerfassung als Kachel und Teilen aus jeder App. Du lädst sie direkt von flowplan.org, ohne Play Store; neue Versionen findet sie selbst.",
              "Flowplan is an app for Android – with widgets, notifications with buttons, quick capture as a tile and sharing from any app. You get it straight from flowplan.org, without the Play Store; it finds new versions by itself.",
            )}
      </p>
      <p className="muted">
        {t(
          "In der App meldest du dich bei dieser Instanz an. ",
          "In the app you sign in to this instance. ",
        )}
        {!ios && (
          <>
            <a href={DOWNLOAD_URL} target="_blank" rel="noopener noreferrer">
              {t("So geht die Installation", "How to install it")}
            </a>
            {" · "}
          </>
        )}
        <a
          href={settingsHash({
            area: "settings",
            section: "devices",
            anchor: "apps",
          })}
          onClick={close}
        >
          {t("Später in den Einstellungen", "Later in the settings")}
        </a>
      </p>
      <div className="modal-actions">
        <button type="button" className="button" onClick={close}>
          {t("Nicht jetzt", "Not now")}
        </button>
        <a
          className="button primary"
          href={ios ? TESTFLIGHT_URL : ANDROID_APK_URL}
          target="_blank"
          rel="noopener noreferrer"
          onClick={close}
        >
          {ios
            ? t("Beta testen", "Try the beta")
            : t("App herunterladen", "Download the app")}
        </a>
      </div>
    </Modal>
  );
}
