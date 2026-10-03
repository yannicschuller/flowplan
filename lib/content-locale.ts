// The language for content the server creates on behalf of a request: the
// first workspace, new databases, journal day titles, copies. Set at the
// entry points (API routes, the start page); German outside of a request.
import { AsyncLocalStorage } from "node:async_hooks";
import { LOCALE_COOKIE, pickLocale, type Locale } from "./i18n";

const store = new AsyncLocalStorage<Locale>();
export const contentLocale = (): Locale => store.getStore() ?? "de";
export const withContentLocale = <T>(locale: Locale, fn: () => T): T => store.run(locale, fn);
// ct("Ohne Titel", "Untitled")
export const ct = (de: string, en: string) => (contentLocale() === "de" ? de : en);

export function localeOfRequest(req: Request): Locale {
  const cookie = req.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim().split("="))
    .find(([name]) => name === LOCALE_COOKIE)?.[1];
  return pickLocale(cookie, req.headers.get("accept-language"));
}
// Wraps a route handler so everything it creates follows the reader's language.
export function withRequestLocale<A extends unknown[], R>(
  handler: (req: Request, ...rest: A) => Promise<R>,
) {
  return (req: Request, ...rest: A) => withContentLocale(localeOfRequest(req), () => handler(req, ...rest));
}
