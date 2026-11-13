import { revokeRecordSharesOfPage } from "./record-share";
import { duplicatePages } from "./page-tree";
import { placeAfter } from "./space-order";
import { claimTicketPrefix } from "./ticket-refs";
import { z } from "zod";
import { all, one, run, id, nowText, lockMembership } from "./db";
import { handOverWorkspaceCreator } from "./user-limits";
import { removePages } from "./search-store";
import { HttpError } from "./auth";
import { memberRole, requireMember, spaceRole } from "./permissions";
import type { Field, Identity, Page, Space } from "./types";
import { dropLiveProjectionsOfRoot } from "./shared-live";
const uuid = z.string().uuid();
export async function canManageSpace(user: Identity, space: Space) {
  const role = await memberRole(user, space.workspace_id);
  return role === "owner" || (role === "editor" && space.owner_id === user.id);
}
export async function requireSpaceManager(user: Identity, spaceId: string) {
  const space = await one<Space>("SELECT * FROM spaces WHERE id=?", spaceId);
  if (!space) throw new HttpError(404, "Bereich nicht gefunden.");
  if (!(await canManageSpace(user, space)))
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
async function revokePage(pageId: string) {
  await run(
    "DELETE FROM publication_pages WHERE root_id=? OR page_id=?",
    pageId,
    pageId,
  );
  await run("DELETE FROM publications WHERE page_id=?", pageId);
  await dropLiveProjectionsOfRoot(pageId);
  await run("DELETE FROM share_links WHERE root_id=?", pageId);
  await run("DELETE FROM share_link_pages WHERE page_id=?", pageId);
  await revokeRecordSharesOfPage(pageId);
  await run("UPDATE pages SET public_token=NULL WHERE id=?", pageId);
  await run("UPDATE forms SET enabled=0 WHERE page_id=?", pageId);
  await run("DELETE FROM notifications WHERE page_id=?", pageId);
  await run("DELETE FROM presence WHERE page_id=?", pageId);
}
// Only invoked inside the command transaction. File removal is queued until commit.
export async function purgePages(workspaceId: string, pages: Page[]) {
  const ids = new Set(pages.map((page) => page.id));
  // Sever pairs before deleting their endpoints. Remaining relation fields stay visible,
  // but their references to deleted records are removed as referential cleanup.
  for (const page of pages)
    await run(
      "DELETE FROM two_way_relations WHERE left_page=? OR right_page=?",
      page.id,
      page.id,
    );
  for (const db of await all<{ page_id: string; fields: string }>(
    "SELECT d.* FROM databases d JOIN pages p ON p.id=d.page_id WHERE p.workspace_id=?",
    workspaceId,
  )) {
    if (ids.has(db.page_id)) continue;
    const fields = (JSON.parse(db.fields) as Field[]).filter(
      (field) => field.type === "relation" && ids.has(field.relationPage || ""),
    );
    if (!fields.length) continue;
    for (const row of await all<{ id: string; cells: string }>(
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
        await run(
          "UPDATE rows SET cells=?,version=version+1,updated_at=? WHERE id=?",
          JSON.stringify(cells), nowText(),
          row.id,
        );
    }
  }
  for (const page of pages) {
    await revokePage(page.id);
    await run(
      "INSERT INTO pending_file_deletions(id) SELECT id FROM files WHERE page_id=? ON CONFLICT DO NOTHING",
      page.id,
    );
    await run(
      "DELETE FROM form_submissions WHERE form_token IN (SELECT token FROM forms WHERE page_id=?)",
      page.id,
    );
    await run("DELETE FROM grants WHERE resource_id=?", page.id);
    await run(
      "UPDATE pages SET parent_id=NULL WHERE parent_id=? AND workspace_id=?",
      page.id,
      workspaceId,
    );
  }
  // What does not go with the page by itself (no foreign key): search and AI
  // entries, reminders, rules and logs naming the page or its records.
  for (const page of pages) {
    for (const table of ["automation_runs", "ticket_messages", "calendar_sync_items"])
      await run(`DELETE FROM ${table} WHERE row_id IN (SELECT id FROM rows WHERE page_id=?)`, page.id);
    for (const table of ["task_reminders", "ai_auto_dirty", "ai_embeddings", "offline_changes", "webhooks"])
      await run(`DELETE FROM ${table} WHERE page_id=?`, page.id);
    await run("DELETE FROM ai_access_rules WHERE target_id=? AND kind='page'", page.id);
    await run("DELETE FROM ai_blocks WHERE target_id=? AND kind='page'", page.id);
    await run("DELETE FROM invite_grants WHERE resource_id=?", page.id);
    await run("DELETE FROM time_rates WHERE kind='project' AND target_id=?", page.id);
    await run("UPDATE inbound_messages SET page_id=NULL,row_id=NULL WHERE page_id=?", page.id);
  }
  // The full-text index in one pass per batch (a scan, page_id is not indexed).
  await removePages([...ids]);
  for (const page of pages) await run("DELETE FROM pages WHERE id=?", page.id);
}
// A space in the trash with all its pages, for good. Inside a transaction.
export async function purgeSpace(space: Space) {
  await purgePages(
    space.workspace_id,
    await all<Page>("SELECT * FROM pages WHERE space_id=?", space.id),
  );
  await run("DELETE FROM grants WHERE resource_id=?", space.id);
  await keepSpaceTemplates(space.id);
  await run("DELETE FROM spaces WHERE id=?", space.id);
}
// The templates of a space deleted for good (#136) are not lost: they
// become private templates of their creators (nobody else could see the
// space's content before either).
export async function keepSpaceTemplates(spaceId: string) {
  await run(
    "UPDATE templates SET space_id=NULL,visibility=CASE WHEN visibility IN ('instance','public') THEN visibility ELSE 'private' END,version=version+1 WHERE space_id=?",
    spaceId,
  );
}
// Removes a workspace with everything in it. Inside a transaction.
export async function purgeWorkspace(wid: string) {
  await purgePages(wid, await all<Page>("SELECT * FROM pages WHERE workspace_id=?", wid));
  await run(
    "DELETE FROM grants WHERE resource_id IN (SELECT id FROM spaces WHERE workspace_id=?) OR group_id IN (SELECT id FROM groups WHERE workspace_id=?)",
    wid,
    wid,
  );
  await run("DELETE FROM templates WHERE workspace_id=?", wid);
  await run("DELETE FROM invites WHERE workspace_id=?", wid);
  await run("DELETE FROM workspaces WHERE id=?", wid);
}
export async function manageSpace(user: Identity, input: Record<string, unknown>) {
  const space = await requireSpaceManager(user, uuid.parse(input.spaceId));
  if (z.number().int().positive().parse(input.version) !== space.version)
    throw new HttpError(
      409,
      "Der Bereich wurde inzwischen geändert. Bitte neu laden.",
    );
  if (input.action === "space.delete") {
    if (
      ((await one<{ n: number }>(
        "SELECT count(*) n FROM spaces WHERE workspace_id=? AND deleted_at IS NULL",
        space.workspace_id,
      ))?.n || 0) <= 1
    )
      throw new HttpError(
        409,
        "Lege zuerst einen weiteren Bereich an. Der letzte aktive Bereich muss erhalten bleiben.",
      );
    if (space.deleted_at)
      throw new HttpError(409, "Der Bereich liegt bereits im Papierkorb.");
    confirmName(input.confirmName, space.name);
    await run("DELETE FROM space_trash_pages WHERE space_id=?", space.id);
    await run(
      "INSERT INTO space_trash_pages(space_id,page_id) SELECT ?,id FROM pages WHERE space_id=? AND deleted_at IS NULL",
      space.id,
      space.id,
    );
    for (const page of await all<Page>(
      "SELECT * FROM pages WHERE space_id=?",
      space.id,
    ))
      await revokePage(page.id);
    await run(
      "UPDATE pages SET deleted_at=? WHERE space_id=? AND deleted_at IS NULL", nowText(),
      space.id,
    );
    await run(
      "UPDATE spaces SET deleted_at=?,version=version+1 WHERE id=?", nowText(),
      space.id,
    );
  } else if (input.action === "space.restore") {
    if (!space.deleted_at)
      throw new HttpError(409, "Der Bereich ist nicht gelöscht.");
    await run(
      "UPDATE spaces SET deleted_at=NULL,version=version+1 WHERE id=?",
      space.id,
    );
    await run(
      "UPDATE pages SET deleted_at=NULL WHERE space_id=? AND id IN (SELECT page_id FROM space_trash_pages WHERE space_id=?)",
      space.id,
      space.id,
    );
    // Prefixes taken meanwhile by another database: new ones (WEB2).
    for (const p of await all<{ page_id: string }>("SELECT page_id FROM space_trash_pages WHERE space_id=?", space.id))
      await claimTicketPrefix(p.page_id);
    await run("DELETE FROM space_trash_pages WHERE space_id=?", space.id);
  } else if (input.action === "space.purge") {
    if (!space.deleted_at)
      throw new HttpError(
        409,
        "Den Bereich zuerst in den Papierkorb verschieben.",
      );
    confirmName(input.confirmName, space.name);
    await purgeSpace(space);
  } else throw new HttpError(400, "Unbekannte Bereichsaktion.");
  return { ok: true };
}
export async function manageWorkspace(
  user: Identity,
  input: Record<string, unknown>,
) {
  const wid = uuid.parse(input.workspaceId);
  // Leaving checks that another owner remains, then removes: owners leaving
  // (or demoting each other) at once take turns (PostgreSQL).
  await lockMembership(wid);
  const role = await requireMember(user, wid);
  const workspace = (await one<{ name: string }>(
    "SELECT name FROM workspaces WHERE id=?",
    wid,
  ))!;
  const next =
    (await one<{ id: string }>(
      "SELECT w.id FROM workspaces w JOIN members m ON m.workspace_id=w.id WHERE m.user_id=? AND w.id!=? ORDER BY w.created_at,w.id",
      user.id,
      wid,
    ))?.id || null;
  if (input.action === "workspace.delete") {
    await requireMember(user, wid, "owner");
    if (!next)
      throw new HttpError(
        409,
        "Lege zuerst einen weiteren Arbeitsbereich an. Dein einziger Arbeitsbereich kann nicht gelöscht werden.",
      );
    confirmName(input.confirmName, workspace.name);
    await purgeWorkspace(wid);
  } else if (input.action === "workspace.leave") {
    confirmName(input.confirmName, workspace.name);
    const owners = await all<{ id: string }>(
      "SELECT u.id FROM members m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? AND m.role='owner' AND u.id!=? AND u.disabled=0",
      wid,
      user.id,
    );
    if (role === "owner" && !owners.length)
      throw new HttpError(
        409,
        "Übertrage zuerst die Eigentümerrolle an ein aktives Mitglied.",
      );
    const owned = await one(
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
      await run(
        "UPDATE spaces SET owner_id=?,version=version+1 WHERE workspace_id=? AND owner_id=?",
        target,
        wid,
        user.id,
      );
    }
    await removeFromWorkspace(user.id, wid);
  } else throw new HttpError(400, "Unbekannte Arbeitsbereichsaktion.");
  return { ok: true, nextWorkspaceId: next };
}

// Everything that ties a person to a workspace: membership, guest status,
// grants (pages, spaces, records), groups and personal traces. Used when
// someone leaves, is removed, or a guest loses the last shared page – so a
// later invitation starts from nothing instead of reviving old access.
// Spaces they own go to `spacesTo` (or stay, when none is given and they
// own none).
export async function removeFromWorkspace(userId: string, wid: string, spacesTo?: string) {
  await lockMembership(wid);
  if (spacesTo)
    await run("UPDATE spaces SET owner_id=?,version=version+1 WHERE workspace_id=? AND owner_id=?", spacesTo, wid, userId);
  await run(
    "DELETE FROM grants WHERE user_id=? AND resource_id IN (SELECT id FROM pages WHERE workspace_id=? UNION SELECT id FROM spaces WHERE workspace_id=?)",
    userId,
    wid,
    wid,
  );
  await run(
    "DELETE FROM row_grants WHERE user_id=? AND row_id IN (SELECT r.id FROM rows r JOIN pages p ON p.id=r.page_id WHERE p.workspace_id=?)",
    userId,
    wid,
  );
  await run("DELETE FROM group_members WHERE user_id=? AND group_id IN (SELECT id FROM groups WHERE workspace_id=?)", userId, wid);
  // Own collections of the workspace (#86) leave with the person.
  await run("DELETE FROM collections WHERE owner_id=? AND workspace_id=?", userId, wid);
  for (const table of ["favorites", "date_reminders", "notifications", "presence", "page_follows", "page_view_prefs", "search_visits"])
    await run(`DELETE FROM ${table} WHERE user_id=? AND page_id IN (SELECT id FROM pages WHERE workspace_id=?)`, userId, wid);
  const email = (await one<{ email: string }>("SELECT email FROM users WHERE id=?", userId))?.email || "";
  await run("DELETE FROM invites WHERE workspace_id=? AND lower(email)=lower(?)", wid, email);
  await run("DELETE FROM invite_grants WHERE workspace_id=? AND lower(email)=lower(?)", wid, email);
  await run("DELETE FROM workspace_guests WHERE workspace_id=? AND user_id=?", wid, userId);
  await run("DELETE FROM sso_sources WHERE workspace_id=? AND user_id=?", wid, userId);
  await run("DELETE FROM members WHERE workspace_id=? AND user_id=?", wid, userId);
  // The workspace's creator left: its storage passes on ("owner" accounting).
  await handOverWorkspaceCreator(wid, spacesTo);
}

export async function duplicateSpace(user: Identity, input: Record<string, unknown>) {
  const space = await requireSpaceManager(
    user,
    z.string().uuid().parse(input.spaceId),
  );
  await requireMember(user, space.workspace_id, "editor");
  if (space.deleted_at)
    throw new HttpError(409, "Den Bereich zuerst wiederherstellen.");
  if (!(await spaceRole(user, space)))
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
  const pages = await all<Page>(
    "SELECT * FROM pages WHERE space_id=? AND workspace_id=? AND deleted_at IS NULL ORDER BY position,id",
    space.id,
    space.workspace_id,
  );
  const target = id();
  await run(
    "INSERT INTO spaces(id,workspace_id,name,icon,icon_color,visibility,owner_id) VALUES(?,?,?,?,?,?,?)",
    target,
    space.workspace_id,
    name,
    space.icon,
    space.icon_color || "none",
    visibility,
    user.id,
  );
  // Right after the original in the sidebar.
  await placeAfter(target, space.id);
  const copied = await duplicatePages(user, pages, space.workspace_id, target);
  return { id: target, pages: copied.pages };
}
