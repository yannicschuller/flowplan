// The reader's language on the server (pages, layouts, API answers).
import { cookies, headers } from "next/headers";
import { LOCALE_COOKIE, pickLocale, translate, type Locale } from "./i18n";
import { translateLabel } from "./i18n-labels";

export async function requestLocale(): Promise<Locale> {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  return pickLocale(cookieStore.get(LOCALE_COOKIE)?.value, headerStore.get("accept-language"));
}
// Like useT(): t(de, en), or t(label) for the German tables in lib.
export async function serverT() {
  const locale = await requestLocale();
  const pick = translate(locale);
  return (de: string, en?: string) =>
    en === undefined ? translateLabel(de, locale) : pick(de, en);
}
