import { z } from "zod";
import { all, audit, one, run, transaction } from "./db";
import { HttpError } from "./auth";
import { instanceSettings } from "./instance-settings";
import { pageRole, requireMember } from "./permissions";
import { listRowTrash, purgeTrashedRow, ROW_TRASH_DAYS } from "./row-trash";
import { canManageSpace, purgePages, purgeSpace } from "./workspace-lifecycle";
import type { Identity, Page, Space } from "./types";

// The trash (#123): pages, spaces, records (lib/row-trash.ts) and saved
// templates stay there for `trashDays()` days and are then deleted for good;
// before that, people delete single entries permanently or empty it.
// Admins set the days in Administration → Grenzen & Aufbewahrung (0 = never).
export function trashDays() {
  const days = instanceSettings().trashDays;
  return Number.isInteger(days) && days >= 0 ? days : ROW_TRASH_DAYS;
}

const uuid = z.string().uuid();

// May this person delete the trashed page for good? The same right as moving
// it to the trash: edit rights on the page (its space active, so pages of a
// space in the trash go with the space).
function purgeable(user: Identity, page: Page) {
  if (!page.deleted_at) return false;
  const role = pageRole(user, page);
  return role === "editor" || role === "owner";
}
// The page with its trashed sub-pages – those this person may delete. Others
// (e.g. sub-pages shared with someone else only) stay in the trash on their own.
function trashedTree(user: Identity, root: Page) {
  const pages = all<Page>(
    "WITH RECURSIVE tree(id) AS (SELECT id FROM pages WHERE id=? UNION ALL SELECT p.id FROM pages p JOIN tree t ON p.parent_id=t.id WHERE p.deleted_at IS NOT NULL) SELECT p.* FROM pages p JOIN tree t ON t.id=p.id",
    root.id,
  );
  return pages.filter((p) => p.id === root.id || purgeable(user, p));
}

// page.purge: one trashed page with its trashed sub-pages. Inside the command
// transaction; uploads are removed once it commits (lib/db.ts).
export function purgeTrashedPage(user: Identity, input: Record<string, unknown>) {
  const page = one<Page>("SELECT * FROM pages WHERE id=?", uuid.parse(input.pageId));
  if (!page || !pageRole(user, page)) throw new HttpError(404, "Seite nicht gefunden.");
  if (!page.deleted_at)
    throw new HttpError(409, "Die Seite zuerst in den Papierkorb verschieben.");
  if (!purgeable(user, page))
    throw new HttpError(403, "Keine Berechtigung für diese Seite.");
  const pages = trashedTree(user, page);
  purgePages(page.workspace_id, pages);
  audit(user.id, "page.purged", page.id, `${pages.length} ${pages.length === 1 ? "page" : "pages"}`);
  return { ok: true, pages: pages.length };
}

// trash.empty: everything in the workspace's trash this person may delete –
// pages, spaces they manage and records; or, with scope "templates", the
// template trash. Nothing of others' private spaces or pages is touched.
export function emptyTrash(user: Identity, input: Record<string, unknown>) {
  const workspaceId = uuid.parse(input.workspaceId);
  const scope = z.enum(["workspace", "templates"]).default("workspace").parse(input.scope);
  requireMember(user, workspaceId, "editor");
  if (scope === "templates") {
    const templates = trashedTemplates(user, workspaceId);
    for (const t of templates) run("DELETE FROM templates WHERE id=?", t.id);
    audit(user.id, "trash.emptied", workspaceId, `${templates.length} templates`);
    return { ok: true, templates: templates.length };
  }
  const spaces = all<Space>(
    "SELECT * FROM spaces WHERE workspace_id=? AND deleted_at IS NOT NULL",
    workspaceId,
  ).filter((s) => canManageSpace(user, s));
  for (const space of spaces) purgeSpace(space);
  const pages = all<Page>(
    "SELECT * FROM pages WHERE workspace_id=? AND deleted_at IS NOT NULL AND synced=0",
    workspaceId,
  ).filter((p) => purgeable(user, p));
  purgePages(workspaceId, pages);
  let records = 0;
  for (const entry of listRowTrash(user, workspaceId))
    try {
      purgeTrashedRow(user, { trashId: entry.id });
      records++;
    } catch (error) {
      // Read-only for this person: stays.
      if (!(error instanceof HttpError)) throw error;
    }
  audit(
    user.id,
    "trash.emptied",
    workspaceId,
    `${pages.length} pages, ${spaces.length} spaces, ${records} records`,
  );
  return { ok: true, pages: pages.length, spaces: spaces.length, records };
}

// What the trash holds for this person, for the confirmation of "Empty trash".
export function trashCounts(user: Identity, workspaceId: string) {
  requireMember(user, workspaceId);
  const pages = all<Page>(
    "SELECT * FROM pages WHERE workspace_id=? AND deleted_at IS NOT NULL AND synced=0",
    workspaceId,
  ).filter((p) => purgeable(user, p)).length;
  const spaces = all<Space>(
    "SELECT * FROM spaces WHERE workspace_id=? AND deleted_at IS NOT NULL",
    workspaceId,
  ).filter((s) => canManageSpace(user, s)).length;
  return { pages, spaces, records: listRowTrash(user, workspaceId).length };
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
function trashedTemplates(user: Identity, workspaceId: string) {
  const role = requireMember(user, workspaceId, "editor");
  return all<TemplateRow>(
    "SELECT id,workspace_id,visibility,created_by,deleted_at,version FROM templates WHERE workspace_id=? AND deleted_at IS NOT NULL",
    workspaceId,
  ).filter((t) => mayManageTemplate(user, role, t));
}
// template.purge: one template from the template trash, with its stored files.
export function purgeTemplate(user: Identity, input: Record<string, unknown>) {
  const workspaceId = uuid.parse(input.workspaceId);
  const role = requireMember(user, workspaceId, "editor");
  const template = one<TemplateRow>(
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
  run("DELETE FROM templates WHERE id=?", template.id);
  return { ok: true };
}

// Retention: run by the retention worker (lib/version-history.ts). Spaces,
// pages, records and templates longer than `days` in the trash go for good.
// Each workspace in a transaction of its own.
export function expireTrash(days = trashDays()) {
  const result = { pages: 0, spaces: 0, records: 0, templates: 0 };
  if (!(days > 0)) return result;
  const cutoff = `-${days} days`;
  for (const space of all<Space>(
    "SELECT * FROM spaces WHERE deleted_at IS NOT NULL AND deleted_at<datetime('now',?)",
    cutoff,
  ))
    transaction(() => {
      purgeSpace(space);
      audit("", "space.expired", space.id, `trash older than ${days} days`);
      result.spaces++;
    });
  const expired = all<Page>(
    `SELECT p.* FROM pages p JOIN spaces s ON s.id=p.space_id
     WHERE p.deleted_at IS NOT NULL AND p.deleted_at<datetime('now',?) AND s.deleted_at IS NULL`,
    cutoff,
  );
  const byWorkspace = new Map<string, Page[]>();
  for (const page of expired)
    byWorkspace.set(page.workspace_id, [...(byWorkspace.get(page.workspace_id) || []), page]);
  for (const [workspaceId, pages] of byWorkspace)
    transaction(() => {
      purgePages(workspaceId, pages);
      audit("", "trash.expired", workspaceId, `${pages.length} pages older than ${days} days`);
      result.pages += pages.length;
    });
  transaction(() => {
    result.records = Number(
      run("DELETE FROM row_trash WHERE deleted_at<datetime('now',?)", cutoff).changes,
    );
    result.templates = Number(
      run(
        "DELETE FROM templates WHERE deleted_at IS NOT NULL AND deleted_at<datetime('now',?)",
        cutoff,
      ).changes,
    );
  });
  return result;
}
