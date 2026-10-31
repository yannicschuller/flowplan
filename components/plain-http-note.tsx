"use client";
// A calm note where an instance runs on plain http (APP_URL http:// on a
// host other than this machine, lib/instance-https.ts): fine for trying it
// out, not for real use (#62). On the sign-in page and in Administration →
// Instanz.
import { LockSimpleOpen } from "@phosphor-icons/react";
import { useLocale, useT } from "./i18n";

// The installation guide's section on running without HTTPS.
export function httpsDocsUrl(locale: string) {
  return locale === "de" ? "https://docs.flowplan.org/de/installation#ohne-https" : "https://docs.flowplan.org/en/installation#without-https";
}

export function usePlainHttpText() {
  const t = useT();
  return t(
    "Für einen Test in Ordnung – für den echten Betrieb bitte HTTPS einrichten: Passwörter gehen sonst unverschlüsselt durchs Netz, und Passkeys, die Offline-Kopie, die Apps sowie Kamera und Zwischenablage funktionieren nur mit HTTPS.",
    "Fine for a test – for real use, please set up HTTPS: otherwise passwords cross the network unencrypted, and passkeys, the offline copy, the apps, the camera and the clipboard only work with HTTPS.",
  );
}

export function PlainHttpNote() {
  const t = useT();
  const locale = useLocale();
  const text = usePlainHttpText();
  return (
    <p className="login-http-note" role="note">
      <LockSimpleOpen size={16} aria-hidden />
      <span>
        <strong>{t("Diese Instanz läuft ohne HTTPS.", "This instance runs without HTTPS.")}</strong> {text}{" "}
        <a href={httpsDocsUrl(locale)} target="_blank" rel="noreferrer">
          {t("So richtest du HTTPS ein", "How to set up HTTPS")}
        </a>
      </span>
    </p>
  );
}
