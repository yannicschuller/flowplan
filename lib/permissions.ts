import { all, one } from "./db";
import { HttpError } from "./auth";
import { memoized } from "./read-memo";
import type { Identity, Page, Role, Space } from "./types";
const rank: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };
// The lookups below are remembered within a request or command until the
// next write (lib/read-memo.ts): checking many pages asks once per
// workspace, space, grant target and parent page.
export async function memberRole(user: Identity, workspace: string): Promise<Role | null> {
  return await memoized(`member:${workspace}:${user.id}`, async () =>
    (await one<{ role: Role }>(
      "SELECT role FROM members WHERE workspace_id=? AND user_id=?",
      workspace,
      user.id,
    ))?.role || null,
  );
}
export async function isGuest(user: Pick<Identity, "id">, workspace: string) {
  return await memoized(`guest:${workspace}:${user.id}`, async () =>
    !!(await one(
      "SELECT 1 FROM workspace_guests WHERE workspace_id=? AND user_id=?",
      workspace,
      user.id,
    )),
  );
}
// Stored rows, shared by the checks: never handed out or changed.
const spaceRow = async (id: string) =>
  await memoized(`space:${id}`, async () => await one<Space>("SELECT * FROM spaces WHERE id=?", id));
const pageRow = async (id: string) =>
  await memoized(`page:${id}`, async () => await one<Page>("SELECT * FROM pages WHERE id=?", id));
// Guests act only on what is shared with them; workspace-wide actions need
// full membership. Their stored role caps what page grants allow.
export async function requireMember(
  user: Identity,
  workspace: string,
  min: Role = "viewer",
) {
  const role = await memberRole(user, workspace);
  if (!role || rank[role] < rank[min])
    throw new HttpError(403, "Keine Berechtigung für diesen Arbeitsbereich.");
  // Read tokens never write, whichever route they come through.
  if (min !== "viewer" && user.apiScope === "read")
    throw new HttpError(403, "Dieses API-Token darf nur lesen.");
  if (min !== "viewer" && await isGuest(user, workspace))
    throw new HttpError(
      403,
      "Gäste haben nur Zugriff auf die für sie freigegebenen Seiten.",
    );
  return role;
}
// A grant counts only for the resource it was written for: a page or a
// space, in its workspace. Pages and spaces once could share an id (an
// encrypted space chooses its own), so the id alone does not say which.
async function grantRole(user: Identity, kind: "page" | "space", resource: string, workspace: string): Promise<Role | null> {
  return await memoized(`grant:${kind}:${workspace}:${resource}:${user.id}`, async () => {
    const grants = await all<{ role: Role }>(
      "SELECT role FROM grants WHERE resource_id=? AND resource_kind=? AND workspace_id=? AND (user_id=? OR group_id IN (SELECT group_id FROM group_members WHERE user_id=?))",
      resource,
      kind,
      workspace,
      user.id,
      user.id,
    );
    return grants.sort((a, b) => rank[b.role] - rank[a.role])[0]?.role || null;
  });
}
export async function spaceRole(user: Identity, space: Space): Promise<Role | null> {
  if (space.deleted_at) return null;
  const membership = await memberRole(user, space.workspace_id);
  if (!membership) return null;
  if (space.owner_id === user.id) return membership;
  const grant = await grantRole(user, "space", space.id, space.workspace_id);
  if (grant) return rank[grant] < rank[membership] ? grant : membership;
  return space.visibility === "team" && !(await isGuest(user, space.workspace_id))
    ? membership
    : null;
}
export async function pageRole(user: Identity, page: Page): Promise<Role | null> {
  const space = await spaceRow(page.space_id as string);
  if (!space || space.deleted_at) return null;
  const membership = await memberRole(user, page.workspace_id);
  if (!membership) return null;
  const direct = await grantRole(user, "page", page.id, page.workspace_id);
  if (direct) return rank[direct] < rank[membership] ? direct : membership;
  const seen = new Set<string>();
  let current: Page | undefined = page;
  while (current?.parent_id) {
    if (seen.has(current.id)) return null;
    seen.add(current.id);
    current = await pageRow(current.parent_id);
    if (current) {
      const inherited = await grantRole(user, "page", current.id, page.workspace_id);
      if (inherited)
        return rank[inherited] < rank[membership] ? inherited : membership;
    }
  }
  return space ? (await spaceRole(user, space)) : null;
}
export async function requirePage(
  user: Identity,
  pageId: string,
  write = false,
  allowDeleted = false,
): Promise<Page> {
  const stored = await pageRow(pageId);
  // A copy: callers may change the page they get.
  const page = stored && { ...stored };
  if (!page || (!allowDeleted && page.deleted_at))
    throw new HttpError(404, "Seite nicht gefunden.");
  const role = await pageRole(user, page);
  if (!role || (write && rank[role] < 2))
    throw new HttpError(403, "Keine Berechtigung für diese Seite.");
  if (write && user.apiScope === "read")
    throw new HttpError(403, "Dieses API-Token darf nur lesen.");
  return page;
}
export function requireAdmin(user: Identity) {
  if (!user.isAdmin)
    throw new HttpError(403, "Administrator-Gruppe erforderlich.");
}
