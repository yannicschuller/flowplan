// The reader's language on the server (pages, layouts, API answers).
import { cookies, headers } from "next/headers";
import { LOCALE_COOKIE, pickLocale, translate, type Locale } from "./i18n";
import { translateLabel } from "./i18n-labels";
import { currentUser } from "./auth";
import { fixedLanguage } from "./user-locale";

// A language fixed in the profile wins: the cookie can be stale or doubled
// (flowplan.org shares one with the website and the docs).
export async function requestLocale(): Promise<Locale> {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  const fixed = await profileLanguage();
  return fixed ?? pickLocale(cookieStore.get(LOCALE_COOKIE)?.value, headerStore.get("accept-language"));
}
async function profileLanguage() {
  try {
    const user = await currentUser();
    return user && !user.demo ? fixedLanguage(user.id) : null;
  } catch {
    return null;
  }
}
// Like useT(): t(de, en), or t(label) for the German tables in lib.
export async function serverT() {
  const locale = await requestLocale();
  const pick = translate(locale);
  return (de: string, en?: string) =>
    en === undefined ? translateLabel(de, locale) : pick(de, en);
}
