import { serverT } from "@/lib/i18n-server";
import { notFound } from "next/navigation";
import { publicTemplate } from "@/lib/public-templates";
import { ReadOnlyDocument } from "@/components/read-only-document";
import { publicField } from "@/lib/shared-content";
import { displayText } from "@/lib/field-format";
import { cellText } from "@/lib/cell-text";
import { HttpError } from "@/lib/auth";
import { resolveCatalogDates } from "@/lib/template-catalog";
import { catalogFor } from "@/lib/template-catalogs";
import { requestLocale } from "@/lib/i18n-server";
import { computedCells } from "@/lib/database";
import type { Row } from "@/lib/types";
import { templateCategories } from "@/lib/template-categories";
export const dynamic = "force-dynamic";

export default async function TemplatePreview({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const t = await serverT();
  const { id } = await params;
  // Templates that come with Flowplan: "starter-<key>".
  const builtIn = id.startsWith("starter-") ? catalogFor(await requestLocale())[id.slice(8)] : undefined;
  if (id.startsWith("starter-") && !builtIn) notFound();
  if (builtIn) {
    const fields = builtIn.fields || [];
    // Formulas are computed like in the app.
    const rows = (builtIn.rows || []).map((r) =>
      computedCells({ cells: resolveCatalogDates(r.cells) } as Row, fields),
    );
    return (
      <main className="public-page template-preview">
        <a href="/templates" className="public-brand">
          flowplan <span className="muted">/ Vorlagen</span>
        </a>
        <p className="muted">
          {builtIn.kind === "database" ? t("Datenbank", "Database") : t("Dokument", "Document")} · {templateCategories[builtIn.category]}
        </p>
        <h1>
          <span aria-hidden="true">{builtIn.icon}</span> {builtIn.name}
        </h1>
        <p>{builtIn.description}</p>
        <a className="button primary" href={`/?useTemplate=starter:${encodeURIComponent(id.slice(8))}`}>
          {t("In meinem Arbeitsbereich verwenden", "Use in my workspace")}
        </a>
        {builtIn.kind === "database" ? (
          <>
            <p className="muted">
              {t("Ansichten:", "Views:")}{" "}{(builtIn.views || []).map((v) => v.name).join(" · ")}
            </p>
            <div className="data-table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    {fields.map((f) => (
                      <th key={f.id}>{f.name}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((cells, i) => (
                    <tr key={i}>
                      {fields.map((f) => (
                        <td key={f.id}>
                          {f.type === "text" ? cellText(cells[f.id]) : displayText(f, cells[f.id], "UTC")}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <ReadOnlyDocument html={builtIn.html || ""} />
        )}
      </main>
    );
  }
  let template;
  try {
    template = publicTemplate(id);
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) notFound();
    throw e;
  }
  const fields = template.fields.filter(publicField);
  return (
    <main className="public-page template-preview">
      <a href="/templates" className="public-brand">
        flowplan <span className="muted">/ Vorlagen</span>
      </a>
      <p className="muted">
        {template.kind === "database" ? t("Datenbank", "Database") : t("Dokument", "Document")}
        {template.categoryLabel && ` · ${template.categoryLabel}`}
      </p>
      <h1>{template.name}</h1>
      {/* After signing in, the app creates a page from this template. */}
      <a
        className="button primary"
        href={`/?useTemplate=${encodeURIComponent(template.id)}`}
      >
        {t("In meinem Arbeitsbereich verwenden", "Use in my workspace")}
      </a>
      {template.kind === "database" ? (
        <div className="data-table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                {fields.map((f) => (
                  <th key={f.id}>{f.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {template.rows.map((row, i) => (
                <tr key={i}>
                  {fields.map((f) => (
                    <td key={f.id}>
                      {f.type === "text"
                        ? cellText(row.cells[f.id])
                        : displayText(f, row.cells[f.id], "UTC")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <ReadOnlyDocument html={template.html} />
      )}
    </main>
  );
}
