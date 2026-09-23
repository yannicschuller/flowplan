import { appearanceSchema } from "./page-appearance";
import { applyAppearance } from "./page-covers";
import { remapViewReferences } from "./view-references";
import { instantiateTemplateFiles } from "./template-files";
import { z } from "zod";
import { all, one, run, id } from "./db";
import { HttpError } from "./auth";
import { requireMember, requirePage } from "./permissions";
import { cleanHtml, htmlState } from "./document-server";
import { field, view } from "./database-schema";
import { databaseSnapshot } from "./database-operations";
import { replaceRowDocument } from "./row-documents";
import {
  relationPairSchema,
  relationPairs,
  insertRelationPair,
  initializeRelationPair,
  flushRelationChanges,
  validateRelationGraph,
} from "./relation-sync";
import { formConfigSchema } from "./form-settings";
import type { Identity, Page, Field } from "./types";

export const savedRowTemplateSchema = z.object({
  name: z.string().min(1).max(500),
  cells: z.record(z.string(), z.unknown()),
  html: z.string().max(2_000_000),
  is_default: z.number().int().min(0).max(1),
});
export const savedDatabaseTemplateSchema = z.object({
  appearance: appearanceSchema.optional(),
  database: z.object({
    page_id: z.string().uuid().optional(),
    fields: z.array(field).min(1).max(80),
    views: z.array(view).min(1).max(30),
  }),
  rows: z
    .array(
      z.object({
        id: z.string().uuid(),
        cells: z.record(z.string(), z.unknown()),
        content: z.string().max(2_000_000).default(""),
        position: z.number().finite().default(0),
      }),
    )
    .max(5000)
    .default([]),
  relationPairs: z.array(relationPairSchema).max(40).default([]),
  rowTemplates: z.array(savedRowTemplateSchema).max(500).optional(),
  formConfig: formConfigSchema.optional(),
});
export type PageTemplate = {
  id: string;
  workspace_id: string;
  name: string;
  kind: "document" | "database";
  payload: string;
  visibility: string;
  created_by: string;
  version: number;
  deleted_at: string | null;
};
export function requireTemplate(
  user: Identity,
  templateId: unknown,
  workspaceId: string,
  includeDeleted = false,
) {
  const template = one<PageTemplate>(
    "SELECT * FROM templates WHERE id=?",
    z.string().uuid().parse(templateId),
  );
  if (!template || (template.deleted_at && !includeDeleted))
    throw new HttpError(404, "Vorlage fehlt.");
  requireMember(user, template.workspace_id);
  if (template.visibility === "private" && template.created_by !== user.id)
    throw new HttpError(403, "Private Vorlage.");
  if (template.workspace_id !== workspaceId)
    throw new HttpError(400, "Vorlage muss im Arbeitsbereich liegen.");
  return template;
}

// The enclosing command transaction makes validation, backup and replacement atomic.
export function applyPageTemplate(
  user: Identity,
  page: Page,
  template: PageTemplate,
  backup = true,
) {
  if (template.kind !== page.kind)
    throw new HttpError(400, "Vorlagentyp passt nicht zur Seite.");
  const payload = instantiateTemplateFiles(
    user,
    page.id,
    template.id,
    template.payload,
  );
  let snapshotId: string | undefined;
  if (page.kind === "document") {
    const source = z
      .object({ html: z.string().max(2_000_000) })
      .parse(JSON.parse(payload));
    const html = cleanHtml(source.html);
    if (backup) {
      snapshotId = id();
      run(
        "INSERT INTO snapshots(id,page_id,state,html,title,created_by) SELECT ?,page_id,state,html,?,? FROM documents WHERE page_id=?",
        snapshotId,
        page.title,
        user.id,
        page.id,
      );
    }
    run(
      "UPDATE documents SET html=?,state=?,generation=? WHERE page_id=?",
      html,
      htmlState(html),
      id(),
      page.id,
    );
  } else {
    const source = savedDatabaseTemplateSchema.parse(JSON.parse(payload));
    const fields: Field[] = source.database.fields;
    validateRelationGraph(
      source.relationPairs,
      new Map(
        source.database.page_id
          ? [[source.database.page_id, { fields, rows: source.rows }]]
          : [],
      ),
    );
    if (
      new Set(fields.map((f) => f.id)).size !== fields.length ||
      new Set(source.database.views.map((v) => v.id)).size !==
        source.database.views.length ||
      new Set(source.rows.map((r) => r.id)).size !== source.rows.length
    )
      throw new HttpError(
        400,
        "Doppelte Eigenschaft, Ansicht oder Datensatz-ID in Vorlage.",
      );
    const rowMap = new Map(source.rows.map((r) => [r.id, id()]));
    const nextFields = fields.map((f) => {
      if (!f.relationPage) return f;
      if (f.relationPage === source.database.page_id)
        return { ...f, relationPage: page.id };
      try {
        const related = requirePage(user, f.relationPage);
        if (
          related.workspace_id === page.workspace_id &&
          related.kind === "database"
        )
          return f;
      } catch {
        /* inaccessible external relations are not copied */
      }
      return { ...f, relationPage: undefined };
    });
    const rewriteHtml = (html: string) =>
      cleanHtml(html, (tagName, attribs) => {
        const attrs = { ...attribs };
        if (
          source.database.page_id &&
          attrs.href === `/#page=${source.database.page_id}`
        )
          attrs.href = `/#page=${page.id}`;
        return { tagName, attribs: attrs };
      });
    const rewriteCells = (values: Record<string, unknown>) =>
      Object.fromEntries(
        fields
          .filter(
            (f) =>
              ![
                "formula",
                "rollup",
                "created_at",
                "updated_at",
                "created_by",
                "updated_by",
              ].includes(f.type) && Object.hasOwn(values, f.id),
          )
          .map((f) => {
            let value = values[f.id];
            if (f.type === "relation") {
              const target = nextFields.find(
                (n) => n.id === f.id,
              )?.relationPage;
              value = (Array.isArray(value) ? value : []).flatMap((rid) => {
                if (typeof rid !== "string" || !target) return [];
                if (f.relationPage === source.database.page_id)
                  return rowMap.has(rid) ? [rowMap.get(rid)!] : [];
                return one(
                  "SELECT id FROM rows WHERE id=? AND page_id=?",
                  rid,
                  target,
                )
                  ? [rid]
                  : [];
              });
            } else if (
              f.type === "person" &&
              !one(
                "SELECT user_id FROM members WHERE workspace_id=? AND user_id=?",
                page.workspace_id,
                typeof value === "string" ? value : "",
              )
            )
              value = "";
            return [f.id, value];
          }),
      );
    const rows = source.rows.map((r) => ({
      ...r,
      cells: rewriteCells(r.cells),
      html: rewriteHtml(r.content),
    }));
    const templates = (source.rowTemplates || []).map((t) => ({
      ...t,
      cells: rewriteCells(t.cells),
      html: rewriteHtml(t.html),
    }));
    if (
      rows.some((r) => JSON.stringify(r.cells).length > 200000) ||
      templates.some((t) => JSON.stringify(t.cells).length > 200000)
    )
      throw new HttpError(413, "Datensatz in Vorlage zu groß.");
    if (backup) snapshotId = databaseSnapshot(user, page);
    run("DELETE FROM comments WHERE page_id=? AND row_id IS NOT NULL", page.id);
    run("DELETE FROM rows WHERE page_id=?", page.id);
    flushRelationChanges(user);
    run(
      "DELETE FROM two_way_relations WHERE left_page=? OR right_page=?",
      page.id,
      page.id,
    );
    run("DELETE FROM row_templates WHERE page_id=?", page.id);
    run(
      "UPDATE databases SET fields=?,views=?,version=version+1 WHERE page_id=?",
      JSON.stringify(nextFields),
      JSON.stringify(
        remapViewReferences(source.database.views, fields, rowMap),
      ),
      page.id,
    );
    for (const row of rows) {
      const rid = rowMap.get(row.id)!;
      run(
        "INSERT INTO rows(id,page_id,cells,position,created_by,updated_by) VALUES(?,?,?,?,?,?)",
        rid,
        page.id,
        JSON.stringify(row.cells),
        row.position,
        user.id,
        user.id,
      );
      replaceRowDocument(rid, row.html, user.id);
    }
    for (const pair of source.relationPairs) {
      const copied = {
        ...pair,
        id: id(),
        left_page: page.id,
        right_page: page.id,
      };
      insertRelationPair(copied);
      initializeRelationPair(copied);
    }
    let defaultUsed: boolean = false;
    for (const t of templates) {
      const isDefault: boolean = t.is_default === 1 && !defaultUsed;
      defaultUsed ||= isDefault;
      run(
        "INSERT INTO row_templates(id,page_id,name,cells,html,is_default,created_by) VALUES(?,?,?,?,?,?,?)",
        id(),
        page.id,
        t.name,
        JSON.stringify(t.cells),
        t.html,
        isDefault ? 1 : 0,
        user.id,
      );
    }
    // A copied form always starts with a new inactive, members-only link.
    run(
      "INSERT INTO forms(page_id,token,enabled,internal,anonymous,config) VALUES(?,?,0,1,0,?) ON CONFLICT(page_id) DO UPDATE SET token=excluded.token,enabled=0,internal=1,anonymous=0,config=excluded.config",
      page.id,
      id(),
      JSON.stringify(source.formConfig || formConfigSchema.parse({})),
    );
  }
  run("UPDATE pages SET updated_at=CURRENT_TIMESTAMP WHERE id=?", page.id);
  const appearance = z
    .object({ appearance: appearanceSchema.optional() })
    .parse(JSON.parse(payload)).appearance;
  if (appearance) applyAppearance(page.id, appearance);
  return { ok: true, snapshotId };
}

export function databaseTemplateExtras(pageId: string) {
  return {
    relationPairs: relationPairs(pageId).filter(
      (p) => p.left_page === pageId && p.right_page === pageId,
    ),
    rowTemplates: all<{
      name: string;
      cells: string;
      html: string;
      is_default: number;
    }>(
      "SELECT name,cells,html,is_default FROM row_templates WHERE page_id=?",
      pageId,
    ).map((t) => ({ ...t, cells: JSON.parse(t.cells) })),
    formConfig: formConfigSchema.parse(
      JSON.parse(
        String(
          one("SELECT config FROM forms WHERE page_id=?", pageId)?.config ||
            "{}",
        ),
      ),
    ),
  };
}

export function listPageTemplates(user: Identity, workspaceId: string) {
  const role = requireMember(user, workspaceId);
  return all<PageTemplate>(
    "SELECT id,name,kind,visibility,created_by,version,deleted_at FROM templates WHERE workspace_id=? AND (visibility='workspace' OR created_by=?) ORDER BY name",
    workspaceId,
    user.id,
  ).map((t) => ({
    ...t,
    can_manage:
      role !== "viewer" && (t.created_by === user.id || role === "owner"),
  }));
}
export function managePageTemplate(
  user: Identity,
  input: Record<string, unknown>,
) {
  const workspaceId = z.string().uuid().parse(input.workspaceId);
  const template = requireTemplate(user, input.templateId, workspaceId, true);
  const role = requireMember(user, workspaceId, "editor");
  if (template.created_by !== user.id && role !== "owner")
    throw new HttpError(
      403,
      "Nur der Ersteller oder ein Besitzer darf die Vorlage verwalten.",
    );
  if (input.version !== template.version)
    throw new HttpError(
      409,
      "Vorlage wurde zwischenzeitlich geändert. Bitte neu laden.",
    );
  if (input.action === "template.delete")
    run(
      "UPDATE templates SET deleted_at=CURRENT_TIMESTAMP,version=version+1 WHERE id=?",
      template.id,
    );
  else if (input.action === "template.restore")
    run(
      "UPDATE templates SET deleted_at=NULL,version=version+1 WHERE id=?",
      template.id,
    );
  else {
    if (template.deleted_at)
      throw new HttpError(409, "Vorlage zuerst wiederherstellen.");
    run(
      "UPDATE templates SET name=?,visibility=?,version=version+1 WHERE id=?",
      z.string().trim().min(1).max(500).parse(input.name),
      z.enum(["private", "workspace"]).parse(input.visibility),
      template.id,
    );
  }
  return { ok: true };
}
