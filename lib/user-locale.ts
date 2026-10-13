// Each person's language, remembered from their last visit, for what reaches
// them outside of a request: e-mails and push notifications.
import { one, run } from "./db";
import { isLocale, type Locale } from "./i18n";

export function userLocale(userId: string): Locale {
  const value = one<{ locale: string | null }>("SELECT locale FROM users WHERE id=?", userId)?.locale;
  return isLocale(value) ? value : "de";
}
export function rememberLocale(userId: string, locale: Locale) {
  run("UPDATE users SET locale=? WHERE id=? AND locale IS NOT ?", locale, userId, locale);
}

// A language chosen in the profile: it wins over the browser on every device.
export function fixedLanguage(userId: string): Locale | null {
  const value = one<{ language: string | null }>("SELECT language FROM users WHERE id=?", userId)?.language;
  return isLocale(value) ? value : null;
}
export function setFixedLanguage(userId: string, value: unknown): Locale | null {
  const language = isLocale(value) ? value : null;
  run("UPDATE users SET language=? WHERE id=?", language, userId);
  if (language) rememberLocale(userId, language);
  return language;
}
