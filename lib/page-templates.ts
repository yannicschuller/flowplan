import { reconcileTagFields } from "./tag-fields";
import { reindexRowTasks } from "./doc-tasks";
import { hiddenRowIds } from "./row-access";
import { appearanceSchema, pageIconSchema } from "./page-appearance";
import { templateCategoryIds } from "./template-categories";
import { quotaCheckpoint } from "./instance-ops";
import { applyAppearance } from "./page-covers";
import { remapViewReferences } from "./view-references";
import { instantiateTemplateFiles } from "./template-files";
import { applyPortableMeta, canManageTaxonomy, contextTags, portableMetaSchema } from "./page-properties-server";
import { canSeeScopedTemplate, createTemplateCopies, parseMetaPlan, resolveTemplatePayload, templateDependencies, type MoveTarget } from "./meta-scope-server";
import { metaKey, type ForeignMeta, type MetaKind, type MetaPlan } from "./meta-scope";
import { foldName, isTagField, type PortableMeta } from "./page-properties";
import { z } from "zod";
import { all, one, run, id, nowText, sql } from "./db";
import { HttpError } from "./auth";
import { isGuest, requireMember, requirePage, spaceRole } from "./permissions";
import { cleanHtml, htmlState } from "./document-server";
import { field, view } from "./database-schema";
import { databaseSnapshot } from "./database-operations";
import { readableTemplateCells, replaceRowDocument } from "./row-documents";
import {
  relationPairSchema,
  relationPairs,
  insertRelationPair,
  initializeRelationPair,
  flushRelationChanges,
  validateRelationGraph,
} from "./relation-sync";
import { formConfigSchema } from "./form-settings";
import { importNotebook, notebookArchiveSchema } from "./notebook";
import type { Identity, Page, Field, Space } from "./types";
import { filterAsync, flatMapAsync, mapAsync } from "./each-async";

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
// The icon a template may bring (imported templates, #116): an emoji or a
// symbol, never an image of another page.
const templateIconSchema = pageIconSchema.refine((value) => !!value && !value.startsWith("/"));
export type PageTemplate = {
  id: string;
  workspace_id: string;
  name: string;
  kind: "document" | "database" | "notebook";
  payload: string;
  visibility: string;
  category?: string;
  created_by: string;
  version: number;
  deleted_at: string | null;
  // The space the template belongs to (#136); null: the whole workspace.
  space_id?: string | null;
};
// A space a template may belong to: a live one of the workspace the person
// may write in.
export async function requireTemplateSpace(user: Identity, workspaceId: string, spaceId: string): Promise<Space> {
  const space = await one<Space>("SELECT * FROM spaces WHERE id=? AND workspace_id=?", spaceId, workspaceId);
  if (!space || space.deleted_at) throw new HttpError(404, "Bereich nicht gefunden.");
  if (!["editor", "owner"].includes(await spaceRole(user, space) || "")) throw new HttpError(403, "Keine Schreibrechte in diesem Bereich.");
  return space;
}
// Templates of the whole workspace shared with it: only its owners (#136);
// private ones and those of a space whoever may write there.
export async function requireTemplateScope(user: Identity, workspaceId: string, spaceId: string | null, visibility: string) {
  if (spaceId) await requireTemplateSpace(user, workspaceId, spaceId);
  else if (visibility === "workspace" && !(await canManageTaxonomy(user, workspaceId)))
    throw new HttpError(403, "Vorlagen für den ganzen Arbeitsbereich speichern nur Eigentümer. Speichere sie für diesen Bereich.");
}
// The tags and definitions of a space a template refers to (#136): its
// page's marked ones and the tags its records name that belong to the
// space `spaceId` it was made in.
export async function templateSpaceRefs(payload: string, workspaceId: string, spaceId: string | null): Promise<{ kind: MetaKind; name: string }[]> {
  if (!spaceId) return [];
  const data = JSON.parse(payload) as { meta?: PortableMeta; database?: { fields: Field[] }; rows?: { cells: Record<string, unknown> }[]; rowTemplates?: { cells: Record<string, unknown> }[] };
  const refs = new Map<string, { kind: MetaKind; name: string }>();
  for (const t of data.meta?.tags ?? []) if (t.space) refs.set(metaKey("tag", t.name), { kind: "tag", name: t.name });
  for (const p of data.meta?.properties ?? []) if (p.space) refs.set(metaKey("property", p.name), { kind: "property", name: p.name });
  const own = new Set((await contextTags(workspaceId, spaceId)).filter((t) => t.spaceId).map((t) => foldName(t.name)));
  const fields = (data.database?.fields ?? []).filter(isTagField);
  for (const row of [...(data.rows ?? []), ...(data.rowTemplates ?? [])])
    for (const f of fields) {
      const value = row.cells?.[f.id];
      if (Array.isArray(value)) for (const v of value) if (typeof v === "string" && own.has(foldName(v))) refs.set(metaKey("tag", v), { kind: "tag", name: v });
    }
  return [...refs.values()];
}
// The refs taken out of a template (for the whole workspace).
export async function stripSpaceRefs(payload: string, refs: { kind: MetaKind; name: string }[]) {
  const items: ForeignMeta[] = refs.map((r) => ({ kind: r.kind, id: metaKey(r.kind, r.name), name: r.name, spaceId: null, pages: 0, records: 0, sameName: null, candidates: [] }));
  return (await resolveTemplatePayload(payload, items, { default: "remove" })).payload;
}
export function spaceRefsMessage(refs: { kind: MetaKind; name: string }[]) {
  return `Eine Vorlage für den ganzen Arbeitsbereich verwendet nur Tags und Eigenschaften des ganzen Arbeitsbereichs. Diese gehören zu einem Bereich: ${refs
    .map((r) => (r.kind === "tag" ? `#${r.name}` : r.name))
    .join(", ")}. Nimm sie heraus („spaceMeta: remove“) oder mache sie zuerst arbeitsbereichsweit.`;
}
export async function requireTemplate(
  user: Identity,
  templateId: unknown,
  workspaceId: string,
  includeDeleted = false,
) {
  const template = await one<PageTemplate>(
    "SELECT * FROM templates WHERE id=?",
    z.string().uuid().parse(templateId),
  );
  if (!template || (template.deleted_at && !includeDeleted))
    throw new HttpError(404, "Vorlage fehlt.");
  // Instance templates are published by admins for every workspace.
  if (
    ["instance", "public"].includes(template.visibility) &&
    !template.deleted_at &&
    template.workspace_id !== workspaceId
  ) {
    await requireMember(user, workspaceId);
    return template;
  }
  await requireMember(user, template.workspace_id);
  if (template.visibility === "private" && template.created_by !== user.id)
    throw new HttpError(403, "Private Vorlage.");
  // Templates of the workspace carry its content; guests see only what is
  // shared with them.
  if (template.visibility === "workspace" && template.created_by !== user.id && await isGuest(user, template.workspace_id))
    throw new HttpError(403, "Private Vorlage.");
  // A space's templates: for whoever may open that space (#136).
  if (template.created_by !== user.id && !(await canSeeScopedTemplate(user, template))) throw new HttpError(403, "Vorlage eines anderen Bereichs.");
  if (template.workspace_id !== workspaceId)
    throw new HttpError(400, "Vorlage muss im Arbeitsbereich liegen.");
  return template;
}

// The enclosing command transaction makes validation, backup and replacement atomic.
// `plan`: what to do with the tags and definitions of the template's space
// when it is used in another one (#136, lib/meta-scope-server.ts); without
// one the same-named ones there, else copies.
export async function applyPageTemplate(
  user: Identity,
  page: Page,
  template: PageTemplate,
  backup = true,
  plan?: MetaPlan,
) {
  if (template.kind !== page.kind)
    throw new HttpError(400, "Vorlagentyp passt nicht zur Seite.");
  const quota = await quotaCheckpoint(page.workspace_id);
  const instantiated = await instantiateTemplateFiles(
    user,
    page.id,
    template.id,
    template.payload,
  );
  quota();
  const scope = { workspaceId: page.workspace_id, spaceId: page.space_id };
  const resolved = await resolveTemplatePayload(instantiated, await templateDependencies(template, scope), plan, scope);
  const payload = resolved.payload;
  let snapshotId: string | undefined;
  if (page.kind === "document") {
    const source = z
      .object({ html: z.string().max(2_000_000) })
      .parse(JSON.parse(payload));
    const html = cleanHtml(source.html);
    if (backup) {
      snapshotId = id();
      await run(
        "INSERT INTO snapshots(id,page_id,state,html,title,created_by) SELECT ?,page_id,state,html,?,? FROM documents WHERE page_id=?",
        snapshotId,
        page.title,
        user.id,
        page.id,
      );
    }
    await run(
      "UPDATE documents SET html=?,state=?,generation=? WHERE page_id=?",
      html,
      htmlState(html),
      id(),
      page.id,
    );
  } else if (page.kind === "notebook") {
    // Paper and handwriting of the sheets; imported PDF pages become plain
    // paper of their size (the PDFs are not part of templates).
    const source = z.object({ notebook: notebookArchiveSchema }).parse(JSON.parse(payload));
    await importNotebook(page.id, source.notebook, new Map(), user.id);
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
    const nextFields = await mapAsync(fields, async (f) => {
      if (!f.relationPage) return f;
      if (f.relationPage === source.database.page_id)
        return { ...f, relationPage: page.id };
      try {
        const related = await requirePage(user, f.relationPage);
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
    const rewriteCells = async (values: Record<string, unknown>) =>
      Object.fromEntries(
        await mapAsync(fields
          .filter(
            (f) =>
              ![
                "formula",
                "rollup",
                "created_at",
                "updated_at",
                "created_by",
                "updated_by",
                "id",
                "progress",
                "time",
              ].includes(f.type) && Object.hasOwn(values, f.id),
          ), async (f) => {
            let value = values[f.id];
            if (f.type === "relation") {
              const target = nextFields.find(
                (n) => n.id === f.id,
              )?.relationPage;
              value = await flatMapAsync((Array.isArray(value) ? value : []), async (rid) => {
                if (typeof rid !== "string" || !target) return [];
                if (f.relationPage === source.database.page_id)
                  return rowMap.has(rid) ? [rowMap.get(rid)!] : [];
                return (await one(
                  "SELECT id FROM rows WHERE id=? AND page_id=?",
                  rid,
                  target,
                ))
                  ? [rid]
                  : [];
              });
            } else if (
              f.type === "person" &&
              !(await one(
                "SELECT user_id FROM members WHERE workspace_id=? AND user_id=?",
                page.workspace_id,
                typeof value === "string" ? value : "",
              ))
            )
              value = "";
            return [f.id, value];
          }),
      );
    const rows = await mapAsync(source.rows, async (r) => ({
      ...r,
      cells: await rewriteCells(r.cells),
      html: rewriteHtml(r.content),
    }));
    const templates = await mapAsync((source.rowTemplates || []), async (t) => ({
      ...t,
      cells: await rewriteCells(t.cells),
      html: rewriteHtml(t.html),
    }));
    if (
      rows.some((r) => JSON.stringify(r.cells).length > 200000) ||
      templates.some((t) => JSON.stringify(t.cells).length > 200000)
    )
      throw new HttpError(413, "Datensatz in Vorlage zu groß.");
    if ((await hiddenRowIds(user, page)).size)
      throw new HttpError(
        403,
        "Die Datenbank enthält private Einträge, die du nicht siehst. Nur Besitzer ersetzen sie durch eine Vorlage.",
      );
    if (backup) snapshotId = await databaseSnapshot(user, page);
    await run("DELETE FROM comments WHERE page_id=? AND row_id IS NOT NULL", page.id);
    await run("DELETE FROM rows WHERE page_id=?", page.id);
    await flushRelationChanges(user);
    await run(
      "DELETE FROM two_way_relations WHERE left_page=? OR right_page=?",
      page.id,
      page.id,
    );
    await run("DELETE FROM row_templates WHERE page_id=?", page.id);
    await run(
      "UPDATE databases SET fields=?,views=?,version=version+1 WHERE page_id=?",
      JSON.stringify(nextFields),
      JSON.stringify(
        remapViewReferences(source.database.views, fields, rowMap),
      ),
      page.id,
    );
    for (const row of rows) {
      const rid = rowMap.get(row.id)!;
      await run(
        "INSERT INTO rows(id,page_id,cells,position,created_by,updated_by) VALUES(?,?,?,?,?,?)",
        rid,
        page.id,
        JSON.stringify(row.cells),
        row.position,
        user.id,
        user.id,
      );
      await replaceRowDocument(rid, row.html, user.id);
    }
    // Tasks in the template's records count in "My tasks" right away.
    await reindexRowTasks(user, page, rows.map((row) => rowMap.get(row.id)!));
    // Tag-backed properties use this workspace's tags (#79).
    await reconcileTagFields(user, page.id);
    for (const pair of source.relationPairs) {
      const copied = {
        ...pair,
        id: id(),
        left_page: page.id,
        right_page: page.id,
      };
      await insertRelationPair(copied);
      await initializeRelationPair(copied);
    }
    let defaultUsed: boolean = false;
    for (const t of templates) {
      const isDefault: boolean = t.is_default === 1 && !defaultUsed;
      defaultUsed ||= isDefault;
      await run(
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
    await run(
      "INSERT INTO forms(page_id,token,enabled,internal,anonymous,config) VALUES(?,?,0,1,0,?) ON CONFLICT(page_id) DO UPDATE SET token=excluded.token,enabled=0,internal=1,anonymous=0,config=excluded.config",
      page.id,
      id(),
      JSON.stringify(source.formConfig || formConfigSchema.parse({})),
    );
  }
  await run("UPDATE pages SET updated_at=? WHERE id=?", nowText(), page.id);
  const appearance = z
    .object({ appearance: appearanceSchema.optional() })
    .parse(JSON.parse(payload)).appearance;
  if (appearance) await applyAppearance(page.id, appearance);
  // An emoji the template brings (imported templates, #116).
  const icon = z.object({ icon: templateIconSchema }).safeParse(JSON.parse(payload));
  if (icon.success) await run("UPDATE pages SET icon=? WHERE id=?", icon.data.icon, page.id);
  // Tags and property values of the template's page (lib/page-properties-server.ts).
  const meta = z.object({ meta: portableMetaSchema }).safeParse(JSON.parse(payload));
  if (meta.success) await applyPortableMeta(user, page, meta.data.meta, { createProperties: resolved.createProperties });
  return { ok: true, snapshotId };
}

export async function databaseTemplateExtras(user: Identity, page: Page) {
  const pageId = page.id;
  return {
    relationPairs: (await relationPairs(pageId)).filter(
      (p) => p.left_page === pageId && p.right_page === pageId,
    ),
    rowTemplates: await mapAsync(await all<{
      name: string;
      cells: string;
      html: string;
      is_default: number;
    }>(
      "SELECT name,cells,html,is_default FROM row_templates WHERE page_id=?",
      pageId,
      // Without the values of properties hidden from the person saving.
    ), async (t) => ({ ...t, cells: await readableTemplateCells(user, page, t.cells) })),
    formConfig: formConfigSchema.parse(
      JSON.parse(
        String(
          (await one("SELECT config FROM forms WHERE page_id=?", pageId))?.config ||
            "{}",
        ),
      ),
    ),
  };
}

export async function listPageTemplates(user: Identity, workspaceId: string) {
  const role = await requireMember(user, workspaceId);
  const guest = await isGuest(user, workspaceId);
  const spaces = new Map((await all<Space>("SELECT * FROM spaces WHERE workspace_id=?", workspaceId)).map((sp) => [sp.id, sp]));
  return (await filterAsync(await all<PageTemplate & { icon?: unknown }>(
    `SELECT id,workspace_id,space_id,name,kind,visibility,category,created_by,version,deleted_at,${sql.jsonText("payload", "$.icon")} icon FROM templates
     WHERE (workspace_id=? AND (visibility IN (${guest ? "'instance','public'" : "'workspace','instance','public'"}) OR created_by=?))
        OR (workspace_id<>? AND visibility IN ('instance','public') AND deleted_at IS NULL)
     ORDER BY name`,
    workspaceId,
    user.id,
    workspaceId,
  ), async (t) => t.workspace_id !== workspaceId || t.created_by === user.id || await canSeeScopedTemplate(user, t)))
    .map(({ workspace_id, icon, ...t }) => ({
    ...t,
    space_id: workspace_id === workspaceId ? (t.space_id ?? null) : null,
    ...(t.space_id && workspace_id === workspaceId ? { space_name: spaces.get(t.space_id)?.name ?? "" } : {}),
    ...(templateIconSchema.safeParse(icon).success ? { icon } : {}),
    // Instance templates from other workspaces are only used, not managed.
    shared: workspace_id !== workspaceId,
    can_manage:
      workspace_id === workspaceId &&
      role !== "viewer" &&
      (t.created_by === user.id || role === "owner") &&
      (!["instance", "public"].includes(t.visibility) || user.isAdmin),
  }));
}
export async function managePageTemplate(
  user: Identity,
  input: Record<string, unknown>,
) {
  const workspaceId = z.string().uuid().parse(input.workspaceId);
  const template = await requireTemplate(user, input.templateId, workspaceId, true);
  const role = await requireMember(user, workspaceId, "editor");
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
    await run(
      "UPDATE templates SET deleted_at=?,version=version+1 WHERE id=?", nowText(),
      template.id,
    );
  else if (input.action === "template.restore")
    await run(
      "UPDATE templates SET deleted_at=NULL,version=version+1 WHERE id=?",
      template.id,
    );
  else {
    if (template.deleted_at)
      throw new HttpError(409, "Vorlage zuerst wiederherstellen.");
    const visibility = z
      .enum(["private", "workspace", "instance", "public"])
      .parse(input.visibility);
    if (
      (["instance", "public"].includes(visibility) ||
        ["instance", "public"].includes(template.visibility)) &&
      !user.isAdmin
    )
      throw new HttpError(
        403,
        "Nur Admins veröffentlichen Vorlagen für alle Arbeitsbereiche.",
      );
    // The scope (#136): `spaceId` null for the whole workspace, a space's
    // id, or left out to keep it. Instance and public templates belong to
    // the whole workspace.
    const before = template.space_id ?? null;
    let spaceId = input.spaceId === undefined ? before : input.spaceId === null ? null : z.string().uuid().parse(input.spaceId);
    if (["instance", "public"].includes(visibility)) spaceId = null;
    let payload = template.payload;
    if (spaceId !== before || (visibility === "workspace" && template.visibility !== "workspace")) {
      await requireTemplateScope(user, workspaceId, spaceId, visibility);
      payload = await rescopedPayload(user, template, workspaceId, spaceId, input);
    }
    await run(
      "UPDATE templates SET name=?,visibility=?,category=?,space_id=?,payload=?,version=version+1 WHERE id=?",
      z.string().trim().min(1).max(500).parse(input.name),
      visibility,
      z
        .enum(templateCategoryIds)
        .or(z.literal(""))
        .catch("")
        .parse(input.category ?? template.category ?? ""),
      spaceId,
      payload,
      template.id,
    );
  }
  return { ok: true };
}

// A template's payload for another scope (#136): for the whole workspace
// without its space's tags and definitions (refused unless `spaceMeta:
// "remove"`); for another space with them mapped, copied there (created
// now) or removed per `meta`.
async function rescopedPayload(user: Identity, template: PageTemplate, workspaceId: string, spaceId: string | null, input: Record<string, unknown>) {
  const before = template.space_id ?? null;
  if (!spaceId) {
    const refs = await templateSpaceRefs(template.payload, workspaceId, before);
    if (!refs.length) return template.payload;
    if (input.spaceMeta !== "remove") throw new HttpError(409, spaceRefsMessage(refs));
    return await stripSpaceRefs(template.payload, refs);
  }
  if (!before || before === spaceId) return template.payload;
  return await materializedPayload(user, template, { workspaceId, spaceId }, parseMetaPlan(input.meta));
}
// The payload for a template of `target`: what it brings from its space,
// resolved – copies are created in the target space right away, so the
// template finds them there.
async function materializedPayload(user: Identity, template: PageTemplate, target: MoveTarget, plan: MetaPlan | undefined) {
  const items = await templateDependencies(template, target);
  if (!items.length) return template.payload;
  const resolved = await resolveTemplatePayload(template.payload, items, plan, target);
  await createTemplateCopies(user.id, resolved.copies, target);
  return resolved.payload;
}

// "template.copy": { workspaceId, templateId, spaceId (null: the whole
// workspace), name?, private?, meta?, spaceMeta? } – a copy of a template
// for another scope, its space's tags and definitions resolved (#136).
export async function copyPageTemplate(user: Identity, input: Record<string, unknown>) {
  const workspaceId = z.string().uuid().parse(input.workspaceId);
  await requireMember(user, workspaceId, "editor");
  const template = await requireTemplate(user, input.templateId, workspaceId);
  const spaceId = input.spaceId === null || input.spaceId === undefined ? null : z.string().uuid().parse(input.spaceId);
  const visibility = input.private ? "private" : "workspace";
  await requireTemplateScope(user, workspaceId, spaceId, visibility);
  const payload = await rescopedPayload(user, { ...template, space_id: template.workspace_id === workspaceId ? (template.space_id ?? null) : null }, workspaceId, spaceId, input);
  const copyId = id();
  await run(
    "INSERT INTO templates(id,workspace_id,space_id,name,kind,payload,created_by,visibility,category) VALUES(?,?,?,?,?,?,?,?,?)",
    copyId,
    workspaceId,
    spaceId,
    z.string().trim().min(1).max(500).parse(input.name ?? template.name),
    template.kind,
    payload,
    user.id,
    visibility,
    template.category ?? "",
  );
  for (const file of await all<{ original_id: string; name: string; mime: string; data: Uint8Array }>(
    "SELECT original_id,name,mime,data FROM template_files WHERE template_id=?",
    template.id,
  ))
    await run("INSERT INTO template_files(id,template_id,original_id,name,mime,data) VALUES(?,?,?,?,?,?)", id(), copyId, file.original_id, file.name, file.mime, file.data);
  return { ok: true, id: copyId };
}

// "template.dependencies": { workspaceId, templateId, spaceId } – what using
// (or copying) the template in that space brings from its own space.
export async function pageTemplateDependencies(user: Identity, input: Record<string, unknown>) {
  const workspaceId = z.string().uuid().parse(input.workspaceId);
  const template = await requireTemplate(user, input.templateId, workspaceId);
  const spaceId = z.string().uuid().parse(input.spaceId);
  // Only a space the person may use the template in – nothing about the
  // tags of a space they cannot open.
  await requireTemplateSpace(user, workspaceId, spaceId);
  return { items: template.workspace_id === workspaceId ? (await templateDependencies(template, { workspaceId, spaceId })) : [] };
}
