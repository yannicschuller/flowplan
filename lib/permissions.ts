import { all, one } from "./db";
import { HttpError } from "./auth";
import type { Identity, Page, Role, Space } from "./types";
const rank: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };
export function memberRole(user: Identity, workspace: string): Role | null {
  return (
    one<{ role: Role }>(
      "SELECT role FROM members WHERE workspace_id=? AND user_id=?",
      workspace,
      user.id,
    )?.role || null
  );
}
export function isGuest(user: Pick<Identity, "id">, workspace: string) {
  return !!one(
    "SELECT 1 FROM workspace_guests WHERE workspace_id=? AND user_id=?",
    workspace,
    user.id,
  );
}
// Guests act only on what is shared with them; workspace-wide actions need
// full membership. Their stored role caps what page grants allow.
export function requireMember(
  user: Identity,
  workspace: string,
  min: Role = "viewer",
) {
  const role = memberRole(user, workspace);
  if (!role || rank[role] < rank[min])
    throw new HttpError(403, "Keine Berechtigung für diesen Arbeitsbereich.");
  if (min !== "viewer" && isGuest(user, workspace))
    throw new HttpError(
      403,
      "Gäste haben nur Zugriff auf die für sie freigegebenen Seiten.",
    );
  return role;
}
function grantRole(user: Identity, resource: string): Role | null {
  const grants = all<{ role: Role }>(
    "SELECT role FROM grants WHERE resource_id=? AND (user_id=? OR group_id IN (SELECT group_id FROM group_members WHERE user_id=?))",
    resource,
    user.id,
    user.id,
  );
  return grants.sort((a, b) => rank[b.role] - rank[a.role])[0]?.role || null;
}
export function spaceRole(user: Identity, space: Space): Role | null {
  if (space.deleted_at) return null;
  const membership = memberRole(user, space.workspace_id);
  if (!membership) return null;
  if (space.owner_id === user.id) return membership;
  const grant = grantRole(user, space.id);
  if (grant) return rank[grant] < rank[membership] ? grant : membership;
  return space.visibility === "team" && !isGuest(user, space.workspace_id)
    ? membership
    : null;
}
export function pageRole(user: Identity, page: Page): Role | null {
  const space = one<Space>("SELECT * FROM spaces WHERE id=?", page.space_id);
  if (!space || space.deleted_at) return null;
  const membership = memberRole(user, page.workspace_id);
  if (!membership) return null;
  const direct = grantRole(user, page.id);
  if (direct) return rank[direct] < rank[membership] ? direct : membership;
  const seen = new Set<string>();
  let current: Page | undefined = page;
  while (current?.parent_id) {
    if (seen.has(current.id)) return null;
    seen.add(current.id);
    current = one<Page>("SELECT * FROM pages WHERE id=?", current.parent_id);
    if (current) {
      const inherited = grantRole(user, current.id);
      if (inherited)
        return rank[inherited] < rank[membership] ? inherited : membership;
    }
  }
  return space ? spaceRole(user, space) : null;
}
export function requirePage(
  user: Identity,
  pageId: string,
  write = false,
  allowDeleted = false,
): Page {
  const page = one<Page>("SELECT * FROM pages WHERE id=?", pageId);
  if (!page || (!allowDeleted && page.deleted_at))
    throw new HttpError(404, "Seite nicht gefunden.");
  const role = pageRole(user, page);
  if (!role || (write && rank[role] < 2))
    throw new HttpError(403, "Keine Berechtigung für diese Seite.");
  return page;
}
export function requireAdmin(user: Identity) {
  if (!user.isAdmin)
    throw new HttpError(403, "Administrator-Gruppe erforderlich.");
}
