// The reader's language on the server (pages, layouts, API answers).
import { cookies, headers } from "next/headers";
import { LOCALE_COOKIE, pickLocale, translate, type Locale } from "./i18n";

export async function requestLocale(): Promise<Locale> {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  return pickLocale(cookieStore.get(LOCALE_COOKIE)?.value, headerStore.get("accept-language"));
}
export async function serverT() {
  return translate(await requestLocale());
}
