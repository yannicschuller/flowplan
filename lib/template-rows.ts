// The example records of a catalog template (lib/template-catalog.ts) in a
// language. Most come with the template itself; the records of
// "Flowplan-Tastenkürzel" are written from the keymap by a script
// (lib/template-shortcut-cards.ts) and joined here, on the server, so the
// app's bundle – which knows the catalog for names – does not carry them.
import type { CatalogRow, CatalogTemplate } from "./template-catalog";
import { shortcutCards } from "./template-shortcut-cards";

export function catalogRows(key: string, template: CatalogTemplate, locale: string): CatalogRow[] {
  if (key === "shortcuts") return shortcutCards[locale === "de" ? "de" : "en"];
  return template.rows || [];
}
