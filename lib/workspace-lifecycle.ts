import { duplicatePages } from "./page-tree";
import { z } from "zod";
import { all, one, run, id } from "./db";
import { HttpError } from "./auth";
import { memberRole, requireMember, spaceRole } from "./permissions";
import type { Field, Identity, Page, Space } from "./types";
const uuid = z.string().uuid();
export function canManageSpace(user: Identity, space: Space) {
  const role = memberRole(user, space.workspace_id);
  return role === "owner" || (role === "editor" && space.owner_id === user.id);
}
export function requireSpaceManager(user: Identity, spaceId: string) {
  const space = one<Space>("SELECT * FROM spaces WHERE id=?", spaceId);
  if (!space) throw new HttpError(404, "Bereich nicht gefunden.");
  if (!canManageSpace(user, space))
    throw new HttpError(
      403,
      "Nur Bereichs- oder Arbeitsbereichseigentümer dürfen diesen Bereich verwalten.",
    );
  return space;
}
function confirmName(input: unknown, name: string) {
  if (z.string().max(500).parse(input) !== name)
    throw new HttpError(
      409,
      "Der Name stimmt nicht mehr überein. Bitte neu laden und den aktuellen Namen bestätigen.",
    );
}
function revokePage(pageId: string) {
  run(
    "DELETE FROM publication_pages WHERE root_id=? OR page_id=?",
    pageId,
    pageId,
  );
  run("DELETE FROM publications WHERE page_id=?", pageId);
  run("DELETE FROM share_links WHERE root_id=?", pageId);
  run("DELETE FROM share_link_pages WHERE page_id=?", pageId);
  run("UPDATE pages SET public_token=NULL WHERE id=?", pageId);
  run("UPDATE forms SET enabled=0 WHERE page_id=?", pageId);
  run("DELETE FROM notifications WHERE page_id=?", pageId);
  run("DELETE FROM presence WHERE page_id=?", pageId);
}
// Only invoked inside the command transaction. File removal is queued until commit.
function purgePages(workspaceId: string, pages: Page[]) {
  const ids = new Set(pages.map((page) => page.id));
  // Sever pairs before deleting their endpoints. Remaining relation fields stay visible,
  // but their references to deleted records are removed as referential cleanup.
  for (const page of pages)
    run(
      "DELETE FROM two_way_relations WHERE left_page=? OR right_page=?",
      page.id,
      page.id,
    );
  for (const db of all<{ page_id: string; fields: string }>(
    "SELECT d.* FROM databases d JOIN pages p ON p.id=d.page_id WHERE p.workspace_id=?",
    workspaceId,
  )) {
    if (ids.has(db.page_id)) continue;
    const fields = (JSON.parse(db.fields) as Field[]).filter(
      (field) => field.type === "relation" && ids.has(field.relationPage || ""),
    );
    if (!fields.length) continue;
    for (const row of all<{ id: string; cells: string }>(
      "SELECT id,cells FROM rows WHERE page_id=?",
      db.page_id,
    )) {
      const cells = JSON.parse(row.cells);
      let changed = false;
      for (const field of fields)
        if (Array.isArray(cells[field.id]) && cells[field.id].length) {
          cells[field.id] = [];
          changed = true;
        }
      if (changed)
        run(
          "UPDATE rows SET cells=?,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=?",
          JSON.stringify(cells),
          row.id,
        );
    }
  }
  for (const page of pages) {
    revokePage(page.id);
    run(
      "INSERT OR IGNORE INTO pending_file_deletions(id) SELECT id FROM files WHERE page_id=?",
      page.id,
    );
    run(
      "DELETE FROM form_submissions WHERE form_token IN (SELECT token FROM forms WHERE page_id=?)",
      page.id,
    );
    run("DELETE FROM grants WHERE resource_id=?", page.id);
    run(
      "UPDATE pages SET parent_id=NULL WHERE parent_id=? AND workspace_id=?",
      page.id,
      workspaceId,
    );
  }
  for (const page of pages) run("DELETE FROM pages WHERE id=?", page.id);
}
export function manageSpace(user: Identity, input: Record<string, unknown>) {
  const space = requireSpaceManager(user, uuid.parse(input.spaceId));
  if (z.number().int().positive().parse(input.version) !== space.version)
    throw new HttpError(
      409,
      "Der Bereich wurde inzwischen geändert. Bitte neu laden.",
    );
  if (input.action === "space.delete") {
    if (
      (one<{ n: number }>(
        "SELECT count(*) n FROM spaces WHERE workspace_id=? AND deleted_at IS NULL",
        space.workspace_id,
      )?.n || 0) <= 1
    )
      throw new HttpError(
        409,
        "Lege zuerst einen weiteren Bereich an. Der letzte aktive Bereich muss erhalten bleiben.",
      );
    if (space.deleted_at)
      throw new HttpError(409, "Der Bereich liegt bereits im Papierkorb.");
    confirmName(input.confirmName, space.name);
    run("DELETE FROM space_trash_pages WHERE space_id=?", space.id);
    run(
      "INSERT INTO space_trash_pages(space_id,page_id) SELECT ?,id FROM pages WHERE space_id=? AND deleted_at IS NULL",
      space.id,
      space.id,
    );
    for (const page of all<Page>(
      "SELECT * FROM pages WHERE space_id=?",
      space.id,
    ))
      revokePage(page.id);
    run(
      "UPDATE pages SET deleted_at=CURRENT_TIMESTAMP WHERE space_id=? AND deleted_at IS NULL",
      space.id,
    );
    run(
      "UPDATE spaces SET deleted_at=CURRENT_TIMESTAMP,version=version+1 WHERE id=?",
      space.id,
    );
  } else if (input.action === "space.restore") {
    if (!space.deleted_at)
      throw new HttpError(409, "Der Bereich ist nicht gelöscht.");
    run(
      "UPDATE spaces SET deleted_at=NULL,version=version+1 WHERE id=?",
      space.id,
    );
    run(
      "UPDATE pages SET deleted_at=NULL WHERE space_id=? AND id IN (SELECT page_id FROM space_trash_pages WHERE space_id=?)",
      space.id,
      space.id,
    );
    run("DELETE FROM space_trash_pages WHERE space_id=?", space.id);
  } else if (input.action === "space.purge") {
    if (!space.deleted_at)
      throw new HttpError(
        409,
        "Den Bereich zuerst in den Papierkorb verschieben.",
      );
    confirmName(input.confirmName, space.name);
    purgePages(
      space.workspace_id,
      all<Page>("SELECT * FROM pages WHERE space_id=?", space.id),
    );
    run("DELETE FROM grants WHERE resource_id=?", space.id);
    run("DELETE FROM spaces WHERE id=?", space.id);
  } else throw new HttpError(400, "Unbekannte Bereichsaktion.");
  return { ok: true };
}
export function manageWorkspace(
  user: Identity,
  input: Record<string, unknown>,
) {
  const wid = uuid.parse(input.workspaceId),
    role = requireMember(user, wid);
  const workspace = one<{ name: string }>(
    "SELECT name FROM workspaces WHERE id=?",
    wid,
  )!;
  const next =
    one<{ id: string }>(
      "SELECT w.id FROM workspaces w JOIN members m ON m.workspace_id=w.id WHERE m.user_id=? AND w.id!=? ORDER BY w.created_at,w.id",
      user.id,
      wid,
    )?.id || null;
  if (input.action === "workspace.delete") {
    requireMember(user, wid, "owner");
    if (!next)
      throw new HttpError(
        409,
        "Lege zuerst einen weiteren Arbeitsbereich an. Dein einziger Arbeitsbereich kann nicht gelöscht werden.",
      );
    confirmName(input.confirmName, workspace.name);
    purgePages(wid, all<Page>("SELECT * FROM pages WHERE workspace_id=?", wid));
    run(
      "DELETE FROM grants WHERE resource_id IN (SELECT id FROM spaces WHERE workspace_id=?) OR group_id IN (SELECT id FROM groups WHERE workspace_id=?)",
      wid,
      wid,
    );
    run("DELETE FROM templates WHERE workspace_id=?", wid);
    run("DELETE FROM invites WHERE workspace_id=?", wid);
    run("DELETE FROM workspaces WHERE id=?", wid);
  } else if (input.action === "workspace.leave") {
    confirmName(input.confirmName, workspace.name);
    const owners = all<{ id: string }>(
      "SELECT u.id FROM members m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? AND m.role='owner' AND u.id!=? AND u.disabled=0",
      wid,
      user.id,
    );
    if (role === "owner" && !owners.length)
      throw new HttpError(
        409,
        "Übertrage zuerst die Eigentümerrolle an ein aktives Mitglied.",
      );
    const owned = one(
      "SELECT id FROM spaces WHERE workspace_id=? AND owner_id=?",
      wid,
      user.id,
    );
    if (owned) {
      const target = uuid.parse(input.transferTo);
      if (!owners.some((owner) => owner.id === target))
        throw new HttpError(
          409,
          "Für die Bereichsübergabe ist ein aktiver verbleibender Eigentümer erforderlich.",
        );
      run(
        "UPDATE spaces SET owner_id=?,version=version+1 WHERE workspace_id=? AND owner_id=?",
        target,
        wid,
        user.id,
      );
    }
    run(
      "DELETE FROM grants WHERE user_id=? AND resource_id IN (SELECT id FROM pages WHERE workspace_id=? UNION SELECT id FROM spaces WHERE workspace_id=?)",
      user.id,
      wid,
      wid,
    );
    run(
      "DELETE FROM group_members WHERE user_id=? AND group_id IN (SELECT id FROM groups WHERE workspace_id=?)",
      user.id,
      wid,
    );
    run(
      "DELETE FROM favorites WHERE user_id=? AND page_id IN (SELECT id FROM pages WHERE workspace_id=?)",
      user.id,
      wid,
    );
    run(
      "DELETE FROM notifications WHERE user_id=? AND page_id IN (SELECT id FROM pages WHERE workspace_id=?)",
      user.id,
      wid,
    );
    run(
      "DELETE FROM presence WHERE user_id=? AND page_id IN (SELECT id FROM pages WHERE workspace_id=?)",
      user.id,
      wid,
    );
    run(
      "DELETE FROM invites WHERE workspace_id=? AND lower(email)=lower(?)",
      wid,
      user.email,
    );
    run("DELETE FROM members WHERE workspace_id=? AND user_id=?", wid, user.id);
  } else throw new HttpError(400, "Unbekannte Arbeitsbereichsaktion.");
  return { ok: true, nextWorkspaceId: next };
}

export function duplicateSpace(user: Identity, input: Record<string, unknown>) {
  const space = requireSpaceManager(
    user,
    z.string().uuid().parse(input.spaceId),
  );
  requireMember(user, space.workspace_id, "editor");
  if (space.deleted_at)
    throw new HttpError(409, "Den Bereich zuerst wiederherstellen.");
  if (!spaceRole(user, space))
    throw new HttpError(
      403,
      "Zum Duplizieren ist Zugriff auf den Bereichsinhalt erforderlich.",
    );
  if (z.number().int().positive().parse(input.version) !== space.version)
    throw new HttpError(
      409,
      "Der Bereich wurde inzwischen geändert. Bitte neu laden.",
    );
  const name = z.string().trim().min(1).max(500).parse(input.name);
  const visibility = z.enum(["team", "private"]).parse(input.visibility);
  const pages = all<Page>(
    "SELECT * FROM pages WHERE space_id=? AND workspace_id=? AND deleted_at IS NULL ORDER BY position,id",
    space.id,
    space.workspace_id,
  );
  const target = id();
  run(
    "INSERT INTO spaces(id,workspace_id,name,icon,icon_color,visibility,owner_id) VALUES(?,?,?,?,?,?,?)",
    target,
    space.workspace_id,
    name,
    space.icon,
    space.icon_color || "none",
    visibility,
    user.id,
  );
  const copied = duplicatePages(user, pages, space.workspace_id, target);
  return { id: target, pages: copied.pages };
}
