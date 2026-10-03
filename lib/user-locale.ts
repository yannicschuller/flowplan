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
