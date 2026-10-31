// The catalogues of the languages beyond German and English on the server
// (lib/i18n-catalogs.ts): registered on import, and served to the browser as
// /i18n/<code> (app/i18n/[locale]/route.ts). Register a new language here
// and in LANGUAGES (lib/i18n.ts). Server only – never import it from a
// client component, or the catalogue lands in every page's JavaScript.
import { createHash } from "node:crypto";
import fr from "../locales/fr.json" with { type: "json" };
import { registerCatalog, type Catalog } from "./i18n-catalogs";

export const serverCatalogs: Record<string, Catalog> = { fr };
for (const [locale, catalog] of Object.entries(serverCatalogs)) registerCatalog(locale, catalog);

const scripts = new Map<string, { body: string; version: string }>();
// The script that registers one catalogue in the page, with a version for
// the address (it changes with the catalogue, so the browser may keep it).
export function catalogScript(locale: string) {
  const catalog = serverCatalogs[locale];
  if (!catalog) return null;
  let entry = scripts.get(locale);
  if (!entry) {
    const body = `(globalThis.flowplanCatalogs||(globalThis.flowplanCatalogs={}))[${JSON.stringify(locale)}]=${JSON.stringify(catalog)};\n`;
    entry = { body, version: createHash("sha256").update(body).digest("hex").slice(0, 12) };
    scripts.set(locale, entry);
  }
  return entry;
}
