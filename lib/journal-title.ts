// The title a journal day gets automatically, in the language of the person
// who opened the day first. "Titel des Tages" (#560, #571) picks the form per
// journal: long ("Thursday, 26 November 2026", the default), short ("Thu,
// 26 Nov 2026"), the ISO date ("2026-11-26"), the ISO date with the weekday
// after or before it ("2026-11-26 Thu", "Thu 2026-11-26"), or a custom
// pattern of tokens ("ddd DD.MM.YYYY"). Only new days get the chosen form.
// Recognising an untouched automatic title accepts every preset in every
// interface language, whatever the journal's current choice: switching it
// later makes no old day look renamed (or a renamed one automatic). A custom
// pattern is recognised only as the journal stores it now – days titled with
// an earlier pattern count as renamed once it changes.
import { LOCALES, localeTag, type Locale } from "./i18n";

export const DAY_TITLE_FORMATS = ["long", "short", "iso", "iso-weekday", "weekday-iso", "custom"] as const;
export type DayTitleFormat = (typeof DAY_TITLE_FORMATS)[number];
const PRESETS = DAY_TITLE_FORMATS.filter((format) => format !== "custom");
export const MAX_DAY_TITLE_PATTERN = 64;

// One formatter per language and form: recognising a title tries them all.
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(locale: Locale, options: Intl.DateTimeFormatOptions) {
  const key = `${locale}|${JSON.stringify(options)}`;
  let found = formatters.get(key);
  if (!found) formatters.set(key, (found = new Intl.DateTimeFormat(localeTag(locale), { ...options, timeZone: "UTC" })));
  return found;
}
const utc = (date: string) => new Date(`${date}T00:00:00Z`);
const part = (locale: Locale, options: Intl.DateTimeFormatOptions, type: Intl.DateTimeFormatPartTypes, date: string) =>
  formatter(locale, options).formatToParts(utc(date)).find((p) => p.type === type)?.value || "";
// Names as they read inside a date ("Do." and "Nov." in German, the
// genitive month in Russian); a language that writes the month as a number
// there (Chinese, Portuguese) gets the month's own name.
const weekdayName = (date: string, locale: Locale, width: "long" | "short") =>
  part(locale, { weekday: width, day: "numeric", month: width, year: "numeric" }, "weekday", date) ||
  formatter(locale, { weekday: width }).format(utc(date));
function monthName(date: string, locale: Locale, width: "long" | "short") {
  const inDate = part(locale, { day: "numeric", month: width }, "month", date);
  return inDate && !/^\d+$/.test(inDate) ? inDate : formatter(locale, { month: width }).format(utc(date));
}

// Tokens of a custom pattern; text in [brackets] is kept as it is.
const TOKENS = /\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd/g;
// A pattern that yields a title: at most 64 characters with at least one
// date token. Anything else falls back to the long form.
export function validDayTitlePattern(pattern: string | undefined) {
  const text = (pattern || "").trim();
  if (!text || text.length > MAX_DAY_TITLE_PATTERN) return false;
  return [...text.matchAll(TOKENS)].some((match) => match[1] === undefined);
}
function customTitle(date: string, locale: Locale, pattern: string) {
  const [year, month, day] = date.split("-");
  return pattern.trim().replace(TOKENS, (token, literal: string | undefined) => {
    if (literal !== undefined) return literal;
    switch (token) {
      case "YYYY": return year;
      case "YY": return year.slice(-2);
      case "MMMM": return monthName(date, locale, "long");
      case "MMM": return monthName(date, locale, "short");
      case "MM": return month;
      case "M": return String(Number(month));
      case "DD": return day;
      case "D": return String(Number(day));
      case "dddd": return weekdayName(date, locale, "long");
      default: return weekdayName(date, locale, "short");
    }
  });
}

export function dayTitle(date: string, locale: Locale, format: DayTitleFormat = "long", pattern = "") {
  switch (format) {
    case "iso":
      return date;
    case "short":
      return formatter(locale, { weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(utc(date));
    case "iso-weekday":
      return `${date} ${weekdayName(date, locale, "short")}`;
    case "weekday-iso":
      return `${weekdayName(date, locale, "short")} ${date}`;
    case "custom":
      if (validDayTitlePattern(pattern)) return customTitle(date, locale, pattern);
  }
  // "long", an unknown form (an older or newer client) or an unusable pattern.
  return formatter(locale, { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(utc(date));
}
// Every automatic title a day of `date` can have: each preset in each
// language, and the journal's custom pattern (`pattern`) in each language.
function automaticTitles(date: string, pattern = "") {
  const forms: [DayTitleFormat, string][] = [...PRESETS.map((format) => [format, ""] as [DayTitleFormat, string])];
  if (validDayTitlePattern(pattern)) forms.push(["custom", pattern]);
  return forms.flatMap(([format, own]) =>
    LOCALES.map((locale) => ({ format, title: dayTitle(date, locale, format, own) })),
  );
}
export const isAutoDayTitle = (title: string, date: string, pattern = "") =>
  title === date || automaticTitles(date, pattern).some((auto) => auto.title === title);
// The form an automatic title was made in (null for a renamed day), so the
// Markdown export can write it in the export's language in the same form.
export const dayTitleFormatOf = (title: string, date: string, pattern = ""): DayTitleFormat | null =>
  title === date ? "iso" : automaticTitles(date, pattern).find((auto) => auto.title === title)?.format || null;
// The automatic title in any language or form, or that title with only spaces
// or capitals changed: not renamed (the automatic tidying of empty days,
// lib/journal.ts, and "Leere Tage entfernen", lib/journal-days.ts).
const plain = (title: string) => title.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
export function automaticDayTitle(title: string, date: string, pattern = "") {
  const own = plain(title);
  if (!own) return true;
  if (own === date) return true;
  return automaticTitles(date, pattern).some((auto) => plain(auto.title) === own);
}
