// Each person's language, remembered from their last visit, for what reaches
// them outside of a request: e-mails and push notifications.
import { one, run } from "./db";
import { isLocale, type Locale } from "./i18n";

export async function userLocale(userId: string): Promise<Locale> {
  const value = (await one<{ locale: string | null }>("SELECT locale FROM users WHERE id=?", userId))?.locale;
  return isLocale(value) ? value : "de";
}
export async function rememberLocale(userId: string, locale: Locale) {
  await run("UPDATE users SET locale=? WHERE id=? AND locale IS DISTINCT FROM ?", locale, userId, locale);
}

// A language chosen in the profile: it wins over the browser on every device.
export async function fixedLanguage(userId: string): Promise<Locale | null> {
  const value = (await one<{ language: string | null }>("SELECT language FROM users WHERE id=?", userId))?.language;
  return isLocale(value) ? value : null;
}
export async function setFixedLanguage(userId: string, value: unknown): Promise<Locale | null> {
  const language = isLocale(value) ? value : null;
  await run("UPDATE users SET language=? WHERE id=?", language, userId);
  if (language) await rememberLocale(userId, language);
  return language;
}
