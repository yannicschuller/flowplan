"use client";
// The language in the browser: provided by the root layout, switchable.
// Switching stores the choice in a cookie for a year and reloads, so server
// and client render the same language.
import { createContext, useCallback, useContext } from "react";
import { LANGUAGES, LOCALES, LOCALE_COOKIE, translate, type Locale } from "@/lib/i18n";
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
// Stores the language for this address. Copies of the cookie for parent
// domains (flowplan.org shares one with the website and the docs) are
// removed, so the server never reads an older one.
export function writeLocaleCookie(locale: Locale | null) {
  const parts = location.hostname.split(".");
  for (let i = 0; i < parts.length - 1; i++)
    document.cookie = `${LOCALE_COOKIE}=; path=/; max-age=0; samesite=lax; domain=${parts.slice(i).join(".")}`;
  document.cookie = `${LOCALE_COOKIE}=${locale ?? ""}; path=/; max-age=${locale ? 31536000 : 0}; samesite=lax`;
}
export function setLocale(locale: Locale) {
  writeLocaleCookie(locale);
  location.reload();
}
// Back to the browser's language.
export function clearLocale() {
  writeLocaleCookie(null);
  location.reload();
}
// "DE · EN · FR": the other languages are buttons.
export function LanguageSwitch({ className }: { className?: string }) {
  const locale = useLocale();
  const t = useT();
  const choose = useCallback((l: Locale) => l !== locale && setLocale(l), [locale]);
  return (
    <span className={className} role="group" aria-label={t("Sprache", "Language")}>
      {LOCALES.map((l) => (
        <button
          key={l}
          type="button"
          lang={l}
          aria-pressed={l === locale}
          title={LANGUAGES[l].name}
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
  return (status: string) => translate(locale)(status, statusWords[status] || status);
}

