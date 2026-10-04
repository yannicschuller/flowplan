"use client";
// The language in the browser: provided by the root layout, switchable.
// Switching stores the choice in a cookie for a year and reloads, so server
// and client render the same language.
import { createContext, useCallback, useContext } from "react";
import { LOCALE_COOKIE, translate, type Locale } from "@/lib/i18n";
import { translateLabel } from "@/lib/i18n-labels";

const LocaleContext = createContext<Locale>("de");

export function LocaleProvider({ locale, children }: { locale: Locale; children: React.ReactNode }) {
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}
export function useLocale() {
  return useContext(LocaleContext);
}
// t("Anmelden", "Sign in"); t(label) alone translates a label from the
// German tables in lib (operators, rollups, formats …).
export function useT() {
  const locale = useContext(LocaleContext);
  const pick = translate(locale);
  return (de: string, en?: string) =>
    en === undefined ? translateLabel(de, locale) : pick(de, en);
}
// On flowplan.org the choice is shared with the website and the docs.
export function setLocale(locale: Locale) {
  const domain = /(^|\.)flowplan\.org$/.test(location.hostname) ? "; domain=flowplan.org" : "";
  document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=31536000; samesite=lax${domain}`;
  location.reload();
}
// "DE · EN": the other language is a button.
export function LanguageSwitch({ className }: { className?: string }) {
  const locale = useLocale();
  const choose = useCallback((l: Locale) => l !== locale && setLocale(l), [locale]);
  return (
    <span className={className} role="group" aria-label={locale === "de" ? "Sprache" : "Language"}>
      {(["de", "en"] as const).map((l) => (
        <button
          key={l}
          type="button"
          lang={l}
          aria-pressed={l === locale}
          title={l === "de" ? "Deutsch" : "English"}
          onClick={() => choose(l)}
        >
          {l.toUpperCase()}
        </button>
      ))}
    </span>
  );
}

// Saving states travel through the app as German words (and are compared as
// such); they are translated only where they are shown.
const statusWords: Record<string, string> = {
  Gespeichert: "Saved",
  "Speichern …": "Saving …",
  "Änderungen …": "Changes …",
  "Offline gespeichert": "Saved offline",
  Offline: "Offline",
  "Speichern fehlgeschlagen": "Saving failed",
  "Verbindung unterbrochen – wird wiederholt …": "Connection lost – retrying …",
  "Neue Dokumentversion wird geladen …": "Loading the new document version …",
  "Sprachnotiz wird in Text umgewandelt …": "Turning the voice note into text …",
  "Bild wird hochgeladen …": "Uploading image …",
  "Änderungen gespeichert": "Changes saved",
};
export function useStatusLabel() {
  const locale = useLocale();
  return (status: string) => (locale === "en" ? statusWords[status] || status : status);
}

