// The title a journal day gets automatically, in the language of the person
// who opened the day first. Both languages count as "not renamed".
import type { Locale } from "./i18n";

export function dayTitle(date: string, locale: Locale) {
  return new Intl.DateTimeFormat(locale === "de" ? "de-DE" : "en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));
}
export const isAutoDayTitle = (title: string, date: string) =>
  title === dayTitle(date, "de") || title === dayTitle(date, "en");
