// The title a journal day gets automatically, in the language of the person
// who opened the day first. "Titel des Tages" (#560) picks the form per
// journal: long ("Thursday, 26 November 2026", the default) or the ISO date
// ("2026-11-26"). Only new days get the chosen form. Recognising an untouched
// automatic title accepts both forms and the long form of every interface
// language, whatever the journal's current choice: switching it later makes
// no old day look renamed (or a renamed one automatic).
import { LOCALES, localeTag, type Locale } from "./i18n";

export const DAY_TITLE_FORMATS = ["long", "iso"] as const;
export type DayTitleFormat = (typeof DAY_TITLE_FORMATS)[number];

export function dayTitle(date: string, locale: Locale, format: DayTitleFormat = "long") {
  if (format === "iso") return date;
  return new Intl.DateTimeFormat(localeTag(locale), {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));
}
export const isAutoDayTitle = (title: string, date: string) =>
  title === date || LOCALES.some((locale) => title === dayTitle(date, locale));
// The automatic title in any language or form, or that title with only spaces
// or capitals changed: not renamed (the automatic tidying of empty days,
// lib/journal.ts, and "Leere Tage entfernen", lib/journal-days.ts).
const plain = (title: string) => title.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
export function automaticDayTitle(title: string, date: string) {
  const own = plain(title);
  if (!own) return true;
  if (own === date) return true;
  return LOCALES.some((locale) => plain(dayTitle(date, locale)) === own);
}
