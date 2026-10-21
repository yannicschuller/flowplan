"use client";
// The language in the browser: provided by the root layout, switchable.
// Switching stores the choice in a cookie for a year and reloads, so server
// and client render the same language.
import { createContext, useContext } from "react";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { CaretDown, Check } from "@phosphor-icons/react";
import { LANGUAGES, LOCALES, LOCALE_COOKIE, isLocale, translate, type Locale } from "@/lib/i18n";
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
// "🇩🇪 DE ▾": a small menu of all languages (flag and own name), so the
// switch keeps its size however many languages there are.
export function LanguageSwitch({ className }: { className?: string }) {
  const locale = useLocale();
  const t = useT();
  return (
    <Dropdown.Root modal={false}>
      <Dropdown.Trigger className={className} aria-label={`${t("Sprache", "Language")}: ${LANGUAGES[locale].name}`}>
        <span aria-hidden>{LANGUAGES[locale].flag}</span>
        {locale.toUpperCase()}
        <CaretDown size={11} aria-hidden />
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content className="dropdown language-menu" side="top" align="end" sideOffset={6} collisionPadding={8}>
          <Dropdown.RadioGroup value={locale} onValueChange={(l) => isLocale(l) && l !== locale && setLocale(l)}>
            {LOCALES.map((l) => (
              <Dropdown.RadioItem key={l} value={l} lang={l} className="dropdown-item">
                <span className="language-flag" aria-hidden>{LANGUAGES[l].flag}</span>
                <span>{LANGUAGES[l].name}</span>
                <Dropdown.ItemIndicator className="language-check">
                  <Check size={14} aria-hidden />
                </Dropdown.ItemIndicator>
              </Dropdown.RadioItem>
            ))}
          </Dropdown.RadioGroup>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

// Saving states travel through the app as German words (and are compared as
// such); they are translated only where they are shown.
const statusWords: Record<string, string> = {
  Gespeichert: "Saved",
  "Speichern …": "Saving …",
  "Synchronisieren …": "Syncing …",
  "Änderungen …": "Unsaved changes",
  "Offline gespeichert": "Saved offline",
  Offline: "Offline",
  "Speichern fehlgeschlagen": "Saving failed",
  "Verbindung unterbrochen – wird wiederholt …": "Connection lost – retrying …",
  "Neue Dokumentversion wird geladen …": "Loading the new document version …",
  "Sprachnotiz wird in Text umgewandelt …": "Turning the voice note into text …",
  "Bild wird hochgeladen …": "Uploading image …",
  "Änderungen gespeichert": "Changes saved",
  "Laden …": "Loading …",
};
export function useStatusLabel() {
  const locale = useLocale();
  return (status: string) => translate(locale)(status, statusWords[status] || status);
}

