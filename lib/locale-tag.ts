// The language tag for dates and numbers in the browser: the page's language
// (switching it reloads the page). German on the server; server components
// that render for readers pass their language explicitly.
export const LOCALE_TAG =
  typeof document !== "undefined" && document.documentElement.lang === "en" ? "en-GB" : "de-DE";
// For texts outside of components (tables, helpers) in the browser.
export const tr = (de: string, en: string) => (LOCALE_TAG === "de-DE" ? de : en);
