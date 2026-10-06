// Creates a page's content from a template of the catalog
// (lib/template-catalog.ts): document HTML, or a database with fields,
// views and example entries.
import { id, run } from "./db";
import { htmlState } from "./document-server";
import { resolveCatalogDates, templateCatalog, type TemplateKey } from "./template-catalog";
import { catalogFor } from "./template-catalogs";
import { contentLocale } from "./content-locale";
import { starterSurvey } from "./survey-server";

export const starterTemplates = templateCatalog;
export type StarterTemplateKey = TemplateKey;

export function applyStarterTemplate(pageId: string, userId: string, key: StarterTemplateKey) {
  const template = catalogFor(contentLocale())[key];
  run("UPDATE pages SET icon=? WHERE id=?", template.icon, pageId);
  if (template.kind === "document") {
    const html = template.html || "";
    run("UPDATE documents SET html=?,state=? WHERE page_id=?", html, htmlState(html), pageId);
    return;
  }
  run(
    "UPDATE databases SET fields=?,views=? WHERE page_id=?",
    JSON.stringify(template.fields || []),
    JSON.stringify(template.views || []),
    pageId,
  );
  if (template.survey) starterSurvey(pageId, contentLocale() === "de");
  (template.rows || []).forEach((row, i) =>
    run(
      "INSERT INTO rows(id,page_id,cells,position,created_by,updated_by,content) VALUES(?,?,?,?,?,?,?)",
      id(),
      pageId,
      JSON.stringify(resolveCatalogDates(row.cells)),
      i,
      userId,
      userId,
      row.content || "",
    ),
  );
}
