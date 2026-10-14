// Languages of the interface. German and English sit next to each other in
// the code – t("Anmelden", "Sign in") – and every further language is a
// catalogue in locales/<code>.json keyed by the English text, maintained
// with `npm run i18n` and any translation tool (docs: Translations). A text
// missing from a catalogue shows in English. The language comes from the
// "flowplan-lang" cookie (the reader's or the profile's choice) or the
// browser; English for languages Flowplan does not speak.
import { translateCatalog } from "./i18n-catalogs";

// To add a language: its catalogue in locales/, an entry here and one in
// lib/i18n-catalogs.ts. `tag` formats dates and numbers.
export const LANGUAGES = {
  de: { name: "Deutsch", tag: "de-DE" },
  en: { name: "English", tag: "en-GB" },
  fr: { name: "Français", tag: "fr-FR" },
} as const;
export type Locale = keyof typeof LANGUAGES;
export const LOCALES = Object.keys(LANGUAGES) as Locale[];
export const LOCALE_COOKIE = "flowplan-lang";

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && Object.hasOwn(LANGUAGES, value);
}
export const localeTag = (locale: Locale) => LANGUAGES[locale].tag;
// Numbers with a decimal comma (2,5) rather than a point (2.5).
export const decimalComma = (locale: Locale) => (1.5).toLocaleString(localeTag(locale)).includes(",");

// The first supported language of an Accept-Language header, by weight.
export function pickLocale(cookie?: string | null, acceptLanguage?: string | null): Locale {
  if (isLocale(cookie)) return cookie;
  const wanted = (acceptLanguage || "")
    .split(",")
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(";");
      const q = Number(params.find((p) => p.trim().startsWith("q="))?.split("=")[1] ?? 1);
      return { lang: tag.trim().toLowerCase().slice(0, 2), q: Number.isFinite(q) ? q : 0, index };
    })
    .filter((x) => x.lang && x.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);
  for (const { lang } of wanted) if (isLocale(lang)) return lang;
  return "en";
}

export const translate = (locale: Locale) => (de: string, en: string) =>
  locale === "de" ? de : locale === "en" ? en : translateCatalog(locale, en);
