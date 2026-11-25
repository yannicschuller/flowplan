// The title a journal day gets automatically, in the language of the person
// who opened the day first. The form of every interface language counts as
// "not renamed".
import { LOCALES, localeTag, type Locale } from "./i18n";

export function dayTitle(date: string, locale: Locale) {
  return new Intl.DateTimeFormat(localeTag(locale), {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));
}
export const isAutoDayTitle = (title: string, date: string) => LOCALES.some((locale) => title === dayTitle(date, locale));
// The automatic title in any language, or that title with only spaces or
// capitals changed: not renamed (the automatic tidying of empty days,
// lib/journal.ts, and "Leere Tage entfernen", lib/journal-days.ts).
const plain = (title: string) => title.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
export function automaticDayTitle(title: string, date: string) {
  const own = plain(title);
  if (!own) return true;
  return LOCALES.some((locale) => plain(dayTitle(date, locale)) === own);
}
