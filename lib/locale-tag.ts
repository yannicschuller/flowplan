import { isLocale, localeTag, translate, weekStart, type Locale } from "./i18n";

// The language tag for dates and numbers in the browser: the page's language
// (switching it reloads the page). German on the server; server components
// that render for readers pass their language explicitly.
export const PAGE_LOCALE: Locale =
  typeof document !== "undefined" && isLocale(document.documentElement.lang) ? document.documentElement.lang : "de";
export const LOCALE_TAG = localeTag(PAGE_LOCALE);
// The first column of calendars in the browser.
export const WEEK_START = weekStart(PAGE_LOCALE);
// For texts outside of components (tables, helpers) in the browser.
export const tr = (de: string, en: string) => translate(PAGE_LOCALE)(de, en);
