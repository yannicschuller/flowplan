// German and English. The language comes from the "flowplan-lang" cookie
// (the reader's choice) or the browser: German for German browsers,
// English for everyone else. Texts sit next to each other in the code:
// t("Anmelden", "Sign in").
export type Locale = "de" | "en";
export const LOCALES: Locale[] = ["de", "en"];
export const LOCALE_COOKIE = "flowplan-lang";

export function isLocale(value: unknown): value is Locale {
  return value === "de" || value === "en";
}

// The first supported language of an Accept-Language header, by weight.
export function pickLocale(cookie?: string | null, acceptLanguage?: string | null): Locale {
  if (isLocale(cookie)) return cookie;
  const wanted = (acceptLanguage || "")
    .split(",")
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(";");
      const q = Number(params.find((p) => p.trim().startsWith("q="))?.split("=")[1] ?? 1);
      return { lang: tag.trim().toLowerCase().slice(0, 2), q: Number.isFinite(q) ? q : 0, index };
    })
    .filter((x) => x.lang && x.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);
  for (const { lang } of wanted) {
    if (lang === "de") return "de";
    if (lang === "en") return "en";
  }
  return "en";
}

export const translate = (locale: Locale) => (de: string, en: string) => (locale === "de" ? de : en);
