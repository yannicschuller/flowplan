// The template catalog in the reader's language (same keys in both).
import type { Locale } from "./i18n";
import { templateCatalog, type CatalogTemplate } from "./template-catalog";
import { templateCatalogEn } from "./template-catalog-en";

export const catalogFor = (locale: Locale): Record<string, CatalogTemplate> =>
  locale === "de" ? templateCatalog : templateCatalogEn;
