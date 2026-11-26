// The catalogues of the languages beyond German and English on the server
// (lib/i18n-catalogs.ts), loaded on first use: each is a chunk of its own,
// imported and registered only once a request, e-mail or push in that
// language needs it (ensureCatalog), then kept. An instance whose people
// only use German and English never holds them – about 20 MB of heap each.
// Also served to the browser as /i18n/<code> (app/i18n/[locale]/route.ts).
// Register a new language here and in LANGUAGES (lib/i18n.ts). Server only –
// never import it from a client component.
//
// The boundaries where the language becomes known await ensureCatalog –
// requestLocale() (serverT, pages, API answers), userLocale() and
// fixedLanguage() (e-mails, push, notices), withRequestLocale() (ct()) –
// so the synchronous translate(locale) after them finds the catalogue. A
// synchronous text that comes first shows in English, logs once and loads
// the catalogue for the next one.
import { createHash } from "node:crypto";
import { registerCatalog, registeredCatalog, setCatalogMissingHandler, type Catalog } from "./i18n-catalogs";

const loaders: Record<string, () => Promise<{ default: Catalog }>> = {
  fr: () => import("../locales/fr.json", { with: { type: "json" } }),
  pl: () => import("../locales/pl.json", { with: { type: "json" } }),
  pt: () => import("../locales/pt.json", { with: { type: "json" } }),
  zh: () => import("../locales/zh.json", { with: { type: "json" } }),
  ru: () => import("../locales/ru.json", { with: { type: "json" } }),
};
export const SERVER_CATALOGS: readonly string[] = Object.keys(loaders);

// One state per process, whichever bundle imports this module.
const holder = globalThis as unknown as { flowplanCatalogLoads?: { loading: Map<string, Promise<Catalog | null>>; warned: Set<string> } };
const state = (holder.flowplanCatalogLoads ??= { loading: new Map(), warned: new Set() });

// The catalogue of a language ("fr", or "fr-FR" for its texts), loaded and
// registered once; null for German, English and unknown languages.
export function ensureCatalog(locale: string): Promise<Catalog | null> {
  const lang = locale.split("-")[0];
  const loader = Object.hasOwn(loaders, lang) ? loaders[lang] : undefined;
  if (!loader) return Promise.resolve(null);
  let pending = state.loading.get(lang);
  if (!pending) {
    const known = registeredCatalog(lang);
    pending = known
      ? Promise.resolve(known)
      : loader().then(
          ({ default: catalog }) => {
            registerCatalog(lang, catalog);
            return catalog;
          },
          (error: unknown) => {
            // Try again next time; until then the texts show in English.
            state.loading.delete(lang);
            console.error(`[i18n] Could not load the "${lang}" catalogue:`, error);
            return null;
          },
        );
    state.loading.set(lang, pending);
  }
  return pending;
}

// Which catalogues this process holds (for tests and the memory check).
export const loadedCatalogs = () => SERVER_CATALOGS.filter((locale) => !!registeredCatalog(locale));

// A synchronous text in a language whose catalogue is not loaded yet: it
// shows in English (translateCatalog), this says so once per language with
// the caller, and loads the catalogue for the next text.
setCatalogMissingHandler((locale) => {
  if (!Object.hasOwn(loaders, locale)) return;
  if (!state.warned.has(locale)) {
    state.warned.add(locale);
    const caller = (new Error().stack || "").split("\n").slice(4, 7).map((line) => line.trim()).join(" ← ");
    console.warn(`[i18n] A "${locale}" text was needed before its catalogue was loaded; shown in English, loading it now. ${caller}`);
  }
  void ensureCatalog(locale);
});

const scripts = new Map<string, { body: string; version: string }>();
// The script that registers one catalogue in the page, with a version for
// the address (it changes with the catalogue, so the browser may keep it).
export async function catalogScript(locale: string) {
  if (!Object.hasOwn(loaders, locale)) return null;
  const catalog = await ensureCatalog(locale);
  if (!catalog) return null;
  let entry = scripts.get(locale);
  if (!entry) {
    const body = `(globalThis.flowplanCatalogs||(globalThis.flowplanCatalogs={}))[${JSON.stringify(locale)}]=${JSON.stringify(catalog)};\n`;
    entry = { body, version: createHash("sha256").update(body).digest("hex").slice(0, 12) };
    scripts.set(locale, entry);
  }
  return entry;
}
