import { notFound } from "next/navigation";
import { publicTemplate } from "@/lib/public-templates";
import { ReadOnlyDocument } from "@/components/read-only-document";
import { publicField } from "@/lib/shared-content";
import { displayText } from "@/lib/field-format";
import { cellText } from "@/lib/cell-text";
import { HttpError } from "@/lib/auth";
export const dynamic = "force-dynamic";

export default async function TemplatePreview({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
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
        {template.kind === "database" ? "Datenbank" : "Dokument"}
        {template.categoryLabel && ` · ${template.categoryLabel}`}
      </p>
      <h1>{template.name}</h1>
      {/* After signing in, the app creates a page from this template. */}
      <a
        className="button primary"
        href={`/?useTemplate=${encodeURIComponent(template.id)}`}
      >
        In meinem Arbeitsbereich verwenden
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
