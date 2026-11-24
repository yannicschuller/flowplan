// Editing the content of a saved page template (#461). Record templates
// open as a record and are saved back over the template ("Bearbeiten",
// components/row-document.tsx); saved page templates work the same way with
// a page:
//
// - "template.draft" opens a draft: a page made from the template in its
//   space (a template of the whole workspace: in a space the person may
//   write in), marked with pages.template_draft (schema 130). Only the
//   person who opened it reads it (lib/permissions.ts), so it shows nowhere
//   for others – not in the sidebar, search, links or exports – and not in
//   the opener's sidebar or search either (components/workspace-app.tsx,
//   lib/search-index.ts). Opening it again resumes the same draft.
// - "template.content" writes a page's content into the template: the draft
//   ("Vorlage speichern") or any other page of the same kind ("Aus Seite
//   ersetzen …"). Same rules as template.save: own copies of the files, the
//   space's or the workspace's tags and properties, the size limits. The
//   draft goes with it.
// - "template.draft.discard" throws a draft away.
// - Drafts left alone for TEMPLATE_DRAFT_DAYS go by themselves
//   (expireTemplateDrafts(), the retention worker), as do the drafts of a
//   template deleted for good.
//
// Who may: whoever may change the template's name and visibility
// (managePageTemplate()): its creator or an owner of the workspace, an
// administrator for templates of all workspaces. Pages made from the
// template earlier are never changed.
import { z } from "zod";
import { all, audit, daysAgoText, one, run, transaction } from "./db";
import { HttpError } from "./auth";
import { requireMember, requirePage } from "./permissions";
import { createPage } from "./seed";
import { requirePlaintextSpace } from "./e2ee-server";
import { purgePages } from "./workspace-lifecycle";
import { quotaCheckpoint } from "./instance-ops";
import { captureTemplateFiles } from "./template-files";
import {
  applyPageTemplate,
  requireTemplate,
  requireTemplateSpace,
  spaceRefsMessage,
  stripSpaceRefs,
  templateSpaceRefs,
  type PageTemplate,
} from "./page-templates";
import type { Identity, Page } from "./types";

export const TEMPLATE_DRAFT_DAYS = 7;
const uuid = z.string().uuid();
// The kinds a template's content can be edited of: those template.save makes.
const EDITABLE_KINDS = new Set(["document", "database", "notebook"]);

// The template whose content this person may change, as managePageTemplate()
// decides for its name and visibility; not one in the trash.
export async function requireEditableTemplate(user: Identity, workspaceId: string, templateId: unknown, version?: unknown) {
  const template = await requireTemplate(user, templateId, workspaceId, true);
  const role = await requireMember(user, workspaceId, "editor");
  if (template.workspace_id !== workspaceId || (template.created_by !== user.id && role !== "owner"))
    throw new HttpError(403, "Nur der Ersteller oder ein Besitzer darf die Vorlage verwalten.");
  if (["instance", "public"].includes(template.visibility) && !user.isAdmin)
    throw new HttpError(403, "Nur Admins veröffentlichen Vorlagen für alle Arbeitsbereiche.");
  if (template.deleted_at) throw new HttpError(409, "Vorlage zuerst wiederherstellen.");
  if (version !== undefined && version !== template.version)
    throw new HttpError(409, "Vorlage wurde zwischenzeitlich geändert. Bitte neu laden.");
  if (!EDITABLE_KINDS.has(template.kind))
    throw new HttpError(409, "Der Inhalt dieser Vorlage lässt sich nicht bearbeiten.");
  return template;
}

// "template.draft": { workspaceId, templateId, spaceId? } – the draft of the
// template, a new one or the one this person opened before. `spaceId` is
// where a template of the whole workspace opens (one the person may write
// in); a space's template opens in its space.
export async function openTemplateDraft(user: Identity, input: Record<string, unknown>) {
  const workspaceId = uuid.parse(input.workspaceId);
  const template = await requireEditableTemplate(user, workspaceId, input.templateId, input.version);
  const existing = await one<Page>(
    "SELECT * FROM pages WHERE template_draft=? AND created_by=? AND workspace_id=? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1",
    template.id,
    user.id,
    workspaceId,
  );
  if (existing) return { id: existing.id, resumed: true };
  const spaceId = template.space_id ?? (input.spaceId ? uuid.parse(input.spaceId) : null);
  if (!spaceId) throw new HttpError(400, "Bereich fehlt.");
  await requireTemplateSpace(user, workspaceId, spaceId);
  // Not into an end-to-end encrypted space: the template is plaintext.
  await requirePlaintextSpace({ id: spaceId });
  const pageId = await createPage(workspaceId, spaceId, user.id, template.name.slice(0, 200), template.kind);
  await run("UPDATE pages SET template_draft=? WHERE id=?", template.id, pageId);
  const page = await requirePage(user, pageId, true);
  // The template's own space (or the workspace's tags): nothing to map.
  await applyPageTemplate(user, page, template, false);
  return { id: pageId, resumed: false };
}

// The draft this person opened, or a 404 – also for others' drafts (they do
// not see them at all).
async function ownDraft(user: Identity, pageId: string) {
  const page = await one<Page>("SELECT * FROM pages WHERE id=?", pageId);
  if (!page || !page.template_draft || page.created_by !== user.id)
    throw new HttpError(404, "Entwurf nicht gefunden.");
  return page;
}

// The draft with every page below it (sub-pages made inside it, in the trash
// or not): they are as private as the draft and go with it.
async function draftTree(page: Page) {
  return await all<Page>(
    "WITH RECURSIVE tree(id) AS (SELECT id FROM pages WHERE id=? UNION ALL SELECT p.id FROM pages p JOIN tree t ON p.parent_id=t.id) SELECT p.* FROM pages p JOIN tree t ON t.id=p.id",
    page.id,
  );
}
async function purgeDraft(page: Page) {
  await purgePages(page.workspace_id, await draftTree(page));
}

// "template.draft.discard": { pageId } – the draft and its files, for good.
export async function discardTemplateDraft(user: Identity, input: Record<string, unknown>) {
  const page = await ownDraft(user, uuid.parse(input.pageId));
  await purgeDraft(page);
  return { ok: true };
}

// "template.content": { workspaceId, templateId, pageId, version?, spaceMeta? }
// – the page's content (`payload`, built like template.save's) becomes the
// template's. The page must be of the template's kind and, for a space's
// template, in that space; for the whole workspace only the workspace's tags
// and properties go in (409 naming the space's, or `spaceMeta: "remove"`
// leaves them out). The page's files are copied into the template; its
// draft is deleted afterwards. Pages made from the template stay as they are.
export async function replaceTemplateContent(
  user: Identity,
  template: PageTemplate,
  page: Page,
  payload: string,
  input: Record<string, unknown>,
) {
  if (page.workspace_id !== template.workspace_id)
    throw new HttpError(400, "Vorlage muss im Arbeitsbereich liegen.");
  if (page.kind !== template.kind) throw new HttpError(400, "Vorlagentyp passt nicht zur Seite.");
  if (page.template_draft && page.template_draft !== template.id)
    throw new HttpError(409, "Diese Seite ist der Entwurf einer anderen Vorlage.");
  if (template.space_id && page.space_id !== template.space_id)
    throw new HttpError(400, "Eine Vorlage gehört zum Bereich ihrer Seite oder zum ganzen Arbeitsbereich.");
  if (payload.length > 20_000_000) throw new HttpError(413, "Vorlage zu groß.");
  let stored = payload;
  if (!template.space_id) {
    const refs = await templateSpaceRefs(payload, template.workspace_id, page.space_id);
    if (refs.length && input.spaceMeta !== "remove") throw new HttpError(409, spaceRefsMessage(refs));
    if (refs.length) stored = await stripSpaceRefs(payload, refs);
  }
  // The template keeps only copies of the files its new content refers to.
  await run("DELETE FROM template_files WHERE template_id=?", template.id);
  await run("UPDATE templates SET payload=?,version=version+1 WHERE id=?", stored, template.id);
  const quota = await quotaCheckpoint(template.workspace_id);
  await captureTemplateFiles(user, template.id, stored);
  await quota();
  const draft = page.template_draft === template.id && page.created_by === user.id;
  if (draft) await purgeDraft(page);
  return { ok: true, version: template.version + 1, draftDeleted: draft };
}

// The drafts of a template deleted for good (template.purge, trash.empty).
export async function purgeTemplateDrafts(templateId: string) {
  for (const page of await all<Page>("SELECT * FROM pages WHERE template_draft=?", templateId))
    if (await one("SELECT 1 FROM pages WHERE id=?", page.id)) await purgeDraft(page);
}

// What the page view shows on a draft: the template it belongs to (null:
// not a draft of this person's, or the template is gone).
export async function templateDraftInfo(user: Identity, page: Page) {
  if (!page.template_draft || page.created_by !== user.id) return null;
  const template = await one<{ id: string; name: string; version: number; deleted_at: string | null; space_id: string | null }>(
    "SELECT id,name,version,deleted_at,space_id FROM templates WHERE id=?",
    page.template_draft,
  );
  return template ? { id: template.id, name: template.name, version: template.version, deleted: !!template.deleted_at, workspaceWide: !template.space_id } : null;
}

// Retention (lib/version-history.ts): drafts nobody touched for `days`, and
// those of templates deleted for good. Each in a transaction of its own.
export async function expireTemplateDrafts(days = TEMPLATE_DRAFT_DAYS) {
  const stale = await all<Page>(
    "SELECT * FROM pages WHERE template_draft IS NOT NULL AND (updated_at<? OR NOT EXISTS(SELECT 1 FROM templates t WHERE t.id=pages.template_draft))",
    daysAgoText(days),
  );
  let removed = 0;
  for (const page of stale)
    await transaction(async () => {
      if (!(await one("SELECT 1 FROM pages WHERE id=?", page.id))) return;
      await purgeDraft(page);
      await audit("", "template.draft.expired", page.id, page.template_draft || "");
      removed++;
    });
  return removed;
}
