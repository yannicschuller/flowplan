// Each person's language, remembered from their last visit, for what reaches
// them outside of a request: e-mails and push notifications. Both lookups
// load the language's catalogue (lib/i18n-catalogs-server.ts) before they
// return, so the texts rendered with it are translated.
import { one, run } from "./db";
import { isLocale, type Locale } from "./i18n";
import { ensureCatalog } from "./i18n-catalogs-server";

export async function userLocale(userId: string): Promise<Locale> {
  const value = (await one<{ locale: string | null }>("SELECT locale FROM users WHERE id=?", userId))?.locale;
  const locale = isLocale(value) ? value : "de";
  await ensureCatalog(locale);
  return locale;
}
export async function rememberLocale(userId: string, locale: Locale) {
  await run("UPDATE users SET locale=? WHERE id=? AND locale IS DISTINCT FROM ?", locale, userId, locale);
}

// A language chosen in the profile: it wins over the browser on every device.
export async function fixedLanguage(userId: string): Promise<Locale | null> {
  const value = (await one<{ language: string | null }>("SELECT language FROM users WHERE id=?", userId))?.language;
  if (!isLocale(value)) return null;
  await ensureCatalog(value);
  return value;
}
export async function setFixedLanguage(userId: string, value: unknown): Promise<Locale | null> {
  const language = isLocale(value) ? value : null;
  await run("UPDATE users SET language=? WHERE id=?", language, userId);
  if (language) await rememberLocale(userId, language);
  return language;
}
