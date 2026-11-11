import { z } from "zod";
import { all, audit, one, run, transaction, daysAgoText } from "./db";
import { HttpError } from "./auth";
import { instanceSettings } from "./instance-settings";
import { pageRole, requireMember, requirePage } from "./permissions";
import { journalLocked, requireUnlocked } from "./journal-extras";
import { listRowTrash, purgeTrashedRow, ROW_TRASH_DAYS } from "./row-trash";
import { expireTrashedFiles, listFileTrash, purgeFiles } from "./file-trash";
import { canManageSpace, purgePages, purgeSpace } from "./workspace-lifecycle";
import type { Identity, Page, Space } from "./types";
import { filterAsync } from "./each-async";
import { claimTicketPrefix } from "./ticket-refs";

// The trash (#123): pages, spaces, records (lib/row-trash.ts), files
// (lib/file-trash.ts, #164) and saved templates stay there for `trashDays()`
// days and are then deleted for good; before that, people delete single entries permanently or empty it.
// Admins set the days in Administration → Grenzen & Aufbewahrung (0 = never).
export async function trashDays() {
  const days = (await instanceSettings()).trashDays;
  return Number.isInteger(days) && days >= 0 ? days : ROW_TRASH_DAYS;
}

const uuid = z.string().uuid();

// May this person delete the trashed page for good? The same right as moving
// it to the trash: edit rights on the page (its space active, so pages of a
// space in the trash go with the space).
async function purgeable(user: Identity, page: Page) {
  if (!page.deleted_at) return false;
  const role = await pageRole(user, page);
  return role === "editor" || role === "owner";
}
// The page with its trashed sub-pages – those this person may delete. Others
// (e.g. sub-pages shared with someone else only) stay in the trash on their own.
async function trashedTree(user: Identity, root: Page) {
  const pages = await all<Page>(
    "WITH RECURSIVE tree(id) AS (SELECT id FROM pages WHERE id=? UNION ALL SELECT p.id FROM pages p JOIN tree t ON p.parent_id=t.id WHERE p.deleted_at IS NOT NULL) SELECT p.* FROM pages p JOIN tree t ON t.id=p.id",
    root.id,
  );
  return await filterAsync(pages, async (p) => p.id === root.id || await purgeable(user, p));
}

// page.restore: the page with its trashed sub-pages – those this person may
// edit (as trashedTree) and that lie behind no journal PIN they have not
// entered. A sub-page left out stays in the trash with everything below it.
// A page that is not in the trash brings back nothing below it (sub-pages
// moved to the trash on their own stay there, also those trashed before it:
// they carry an earlier date).
export async function restoreTrashedPage(user: Identity, input: Record<string, unknown>) {
  const page = await requirePage(user, uuid.parse(input.pageId), true, true);
  await requireUnlocked(user, page);
  if (
    page.parent_id &&
    (await one<Page>("SELECT * FROM pages WHERE id=?", page.parent_id))?.deleted_at
  )
    await run("UPDATE pages SET parent_id=NULL WHERE id=?", page.id);
  if (!page.deleted_at) return { ok: true };
  const restored = new Set([page.id]);
  let level = [page.id];
  while (level.length) {
    const children = await all<Page>(
      `SELECT * FROM pages WHERE parent_id IN (${level.map(() => "?").join(",")}) AND deleted_at IS NOT NULL AND deleted_at>=?`,
      ...level,
      page.deleted_at,
    );
    level = (await filterAsync(
      children.filter((p) => !restored.has(p.id)),
      async (p) => (await purgeable(user, p)) && !(await journalLocked(user, p)),
    )).map((p) => p.id);
    for (const id of level) restored.add(id);
  }
  for (const id of restored) await run("UPDATE pages SET deleted_at=NULL WHERE id=?", id);
  // A prefix taken meanwhile by another database: a new one (WEB2).
  for (const id of restored) await claimTicketPrefix(id);
  return { ok: true };
}

// page.purge: one trashed page with its trashed sub-pages. Inside the command
// transaction; uploads are removed once it commits (lib/db.ts).
export async function purgeTrashedPage(user: Identity, input: Record<string, unknown>) {
  const page = await one<Page>("SELECT * FROM pages WHERE id=?", uuid.parse(input.pageId));
  if (!page || !(await pageRole(user, page))) throw new HttpError(404, "Seite nicht gefunden.");
  if (!page.deleted_at)
    throw new HttpError(409, "Die Seite zuerst in den Papierkorb verschieben.");
  if (!(await purgeable(user, page)))
    throw new HttpError(403, "Keine Berechtigung für diese Seite.");
  const pages = await trashedTree(user, page);
  await purgePages(page.workspace_id, pages);
  await audit(user.id, "page.purged", page.id, `${pages.length} ${pages.length === 1 ? "page" : "pages"}`);
  return { ok: true, pages: pages.length };
}

// trash.empty: everything in the workspace's trash this person may delete –
// pages, spaces they manage, records and files; or, with scope "templates", the
// template trash. Nothing of others' private spaces or pages is touched.
export async function emptyTrash(user: Identity, input: Record<string, unknown>) {
  const workspaceId = uuid.parse(input.workspaceId);
  const scope = z.enum(["workspace", "templates"]).default("workspace").parse(input.scope);
  await requireMember(user, workspaceId, "editor");
  if (scope === "templates") {
    const templates = await trashedTemplates(user, workspaceId);
    for (const t of templates) await run("DELETE FROM templates WHERE id=?", t.id);
    await audit(user.id, "trash.emptied", workspaceId, `${templates.length} templates`);
    return { ok: true, templates: templates.length };
  }
  const spaces = await filterAsync(await all<Space>(
    "SELECT * FROM spaces WHERE workspace_id=? AND deleted_at IS NOT NULL",
    workspaceId,
  ), async (s) => await canManageSpace(user, s));
  for (const space of spaces) await purgeSpace(space);
  const pages = await filterAsync(await all<Page>(
    "SELECT * FROM pages WHERE workspace_id=? AND deleted_at IS NOT NULL AND synced=0",
    workspaceId,
  ), async (p) => await purgeable(user, p));
  await purgePages(workspaceId, pages);
  const files = await listFileTrash(user, workspaceId);
  await purgeFiles(files.map((f) => ({ id: f.id, page_id: f.pageId })));
  let records = 0;
  for (const entry of await listRowTrash(user, workspaceId))
    try {
      await purgeTrashedRow(user, { trashId: entry.id });
      records++;
    } catch (error) {
      // Read-only for this person: stays.
      if (!(error instanceof HttpError)) throw error;
    }
  await audit(
    user.id,
    "trash.emptied",
    workspaceId,
    `${pages.length} pages, ${spaces.length} spaces, ${records} records, ${files.length} files`,
  );
  return { ok: true, pages: pages.length, spaces: spaces.length, records, files: files.length };
}

// What the trash holds for this person, for the confirmation of "Empty trash".
export async function trashCounts(user: Identity, workspaceId: string) {
  await requireMember(user, workspaceId);
  const pages = (await filterAsync(await all<Page>(
    "SELECT * FROM pages WHERE workspace_id=? AND deleted_at IS NOT NULL AND synced=0",
    workspaceId,
  ), async (p) => await purgeable(user, p))).length;
  const spaces = (await filterAsync(await all<Space>(
    "SELECT * FROM spaces WHERE workspace_id=? AND deleted_at IS NOT NULL",
    workspaceId,
  ), async (s) => await canManageSpace(user, s))).length;
  return {
    pages,
    spaces,
    records: (await listRowTrash(user, workspaceId)).length,
    files: (await listFileTrash(user, workspaceId)).length,
  };
}

// Templates: the same rights as moving one to the template trash
// (lib/page-templates.ts managePageTemplate).
type TemplateRow = { id: string; workspace_id: string; visibility: string; created_by: string; deleted_at: string | null; version: number };
function mayManageTemplate(user: Identity, role: string | null, t: TemplateRow) {
  if (!role || role === "viewer") return false;
  if (t.created_by !== user.id && role !== "owner") return false;
  if (t.visibility === "private" && t.created_by !== user.id) return false;
  return !["instance", "public"].includes(t.visibility) || !!user.isAdmin;
}
async function trashedTemplates(user: Identity, workspaceId: string) {
  const role = await requireMember(user, workspaceId, "editor");
  return (await all<TemplateRow>(
    "SELECT id,workspace_id,visibility,created_by,deleted_at,version FROM templates WHERE workspace_id=? AND deleted_at IS NOT NULL",
    workspaceId,
  )).filter((t) => mayManageTemplate(user, role, t));
}
// template.purge: one template from the template trash, with its stored files.
export async function purgeTemplate(user: Identity, input: Record<string, unknown>) {
  const workspaceId = uuid.parse(input.workspaceId);
  const role = await requireMember(user, workspaceId, "editor");
  const template = await one<TemplateRow>(
    "SELECT id,workspace_id,visibility,created_by,deleted_at,version FROM templates WHERE id=? AND workspace_id=?",
    uuid.parse(input.templateId),
    workspaceId,
  );
  if (!template || (template.visibility === "private" && template.created_by !== user.id))
    throw new HttpError(404, "Vorlage fehlt.");
  if (!mayManageTemplate(user, role, template))
    throw new HttpError(403, "Nur der Ersteller oder ein Besitzer darf die Vorlage verwalten.");
  if (!template.deleted_at)
    throw new HttpError(409, "Die Vorlage zuerst in den Papierkorb verschieben.");
  if (input.version !== undefined && input.version !== template.version)
    throw new HttpError(409, "Vorlage wurde zwischenzeitlich geändert. Bitte neu laden.");
  await run("DELETE FROM templates WHERE id=?", template.id);
  return { ok: true };
}

// Retention: run by the retention worker (lib/version-history.ts). Spaces,
// pages, records, files and templates longer than `days` in the trash go for good.
// Each workspace in a transaction of its own.
export async function expireTrash(days?: number) {
  if (days === undefined) days = await trashDays();
  const result = { pages: 0, spaces: 0, records: 0, templates: 0, files: 0 };
  if (!(days > 0)) return result;
  const cutoff = daysAgoText(days);
  for (const space of await all<Space>(
    "SELECT * FROM spaces WHERE deleted_at IS NOT NULL AND deleted_at<?",
    cutoff,
  ))
    await transaction(async () => {
      await purgeSpace(space);
      await audit("", "space.expired", space.id, `trash older than ${days} days`);
      result.spaces++;
    });
  const expired = await all<Page>(
    `SELECT p.* FROM pages p JOIN spaces s ON s.id=p.space_id
     WHERE p.deleted_at IS NOT NULL AND p.deleted_at<? AND s.deleted_at IS NULL`,
    cutoff,
  );
  const byWorkspace = new Map<string, Page[]>();
  for (const page of expired)
    byWorkspace.set(page.workspace_id, [...(byWorkspace.get(page.workspace_id) || []), page]);
  for (const [workspaceId, pages] of byWorkspace)
    await transaction(async () => {
      await purgePages(workspaceId, pages);
      await audit("", "trash.expired", workspaceId, `${pages.length} pages older than ${days} days`);
      result.pages += pages.length;
    });
  await transaction(async () => {
    result.files = await expireTrashedFiles(cutoff);
    if (result.files) await audit("", "files.expired", "", `${result.files} files older than ${days} days`);
    result.records = Number(
      (await run("DELETE FROM row_trash WHERE deleted_at<?", cutoff)).changes,
    );
    result.templates = Number(
      (await run(
        "DELETE FROM templates WHERE deleted_at IS NOT NULL AND deleted_at<?",
        cutoff,
      )).changes,
    );
  });
  return result;
}
