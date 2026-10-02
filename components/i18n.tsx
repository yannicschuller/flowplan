"use client";
// The language in the browser: provided by the root layout, switchable.
// Switching stores the choice in a cookie for a year and reloads, so server
// and client render the same language.
import { createContext, useCallback, useContext } from "react";
import { LOCALE_COOKIE, translate, type Locale } from "@/lib/i18n";

const LocaleContext = createContext<Locale>("de");

export function LocaleProvider({ locale, children }: { locale: Locale; children: React.ReactNode }) {
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}
export function useLocale() {
  return useContext(LocaleContext);
}
// t("Anmelden", "Sign in")
export function useT() {
  return translate(useContext(LocaleContext));
}
export function setLocale(locale: Locale) {
  document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=31536000; samesite=lax`;
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
