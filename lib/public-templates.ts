import { all, one } from "./db";
import { HttpError } from "./auth";
import { cleanHtml } from "./document-server";
import { mapTemplateFiles } from "./template-files";
import { templateCategories } from "./template-categories";
import type { Field } from "./types";

// Templates admins published for everyone, including visitors without an
// account. Only the stored template content is shown, with its own files.
export type PublicTemplate = {
  id: string;
  name: string;
  kind: "document" | "database";
  category: string;
};
export function publicTemplates(category?: string) {
  return all<PublicTemplate>(
    `SELECT id,name,kind,category FROM templates
     WHERE visibility='public' AND deleted_at IS NULL
     ${category ? "AND category=?" : ""} ORDER BY name`,
    ...(category ? [category] : []),
  );
}
export function publicTemplate(id: string) {
  const template = one<PublicTemplate & { payload: string }>(
    "SELECT id,name,kind,category,payload FROM templates WHERE id=? AND visibility='public' AND deleted_at IS NULL",
    id,
  );
  if (!template) throw new HttpError(404, "Vorlage nicht gefunden.");
  // Files of the template are served from the template, never from pages.
  const payload = JSON.parse(
    mapTemplateFiles(template.payload, (url) => {
      const fid = /^\/api\/files\/([0-9a-f-]{36})$/i.exec(url)?.[1];
      return fid ? `/api/public-templates/${template.id}/files/${fid}` : url;
    }),
  ) as {
    html?: string;
    database?: { fields: Field[] };
    rows?: { cells: Record<string, unknown> }[];
  };
  return {
    ...template,
    categoryLabel:
      templateCategories[
        template.category as keyof typeof templateCategories
      ] || "",
    html: typeof payload.html === "string" ? cleanHtml(payload.html) : "",
    fields: payload.database?.fields || [],
    rows: (payload.rows || []).slice(0, 100),
  };
}
export function publicTemplateFile(templateId: string, originalId: string) {
  const file = one<{ name: string; mime: string; data: Uint8Array }>(
    `SELECT f.name,f.mime,f.data FROM template_files f JOIN templates t ON t.id=f.template_id
     WHERE t.id=? AND t.visibility='public' AND t.deleted_at IS NULL AND f.original_id=?`,
    templateId,
    originalId,
  );
  if (!file) throw new HttpError(404, "Datei nicht gefunden.");
  return file;
}
