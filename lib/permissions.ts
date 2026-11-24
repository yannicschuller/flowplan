import { all, inTransaction, one } from "./db";
import { cacheVersion, VersionedCache } from "./cache-versions";
import { HttpError } from "./auth";
import { inReadMemo, memoized, peekMemo } from "./read-memo";
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
// Whether joining a group gives the person no read access they do not have
// already (#473): every space and page the group holds a grant on must be
// readable without it. A trashed space counts as it will be once restored.
export async function canJoinGroup(user: Identity, groupId: string, workspace: string) {
  const grants = await all<{ resource_id: string; resource_kind: string }>(
    "SELECT resource_id,resource_kind FROM grants WHERE group_id=? AND workspace_id=?",
    groupId,
    workspace,
  );
  for (const g of grants) {
    if (g.resource_kind === "space") {
      const space = await spaceRow(g.resource_id);
      if (space && !(await spaceRole(user, { ...space, deleted_at: null }))) return false;
    } else {
      const page = await pageRow(g.resource_id);
      if (page && !(await pageRole(user, page))) return false;
    }
  }
  return true;
}
// A draft of a saved page template (#461, lib/template-drafts.ts) is read
// only by whoever opened it – no grant, space or ownership lets anyone else
// in, and nothing below it either.
const othersDraft = (user: Identity, page: Pick<Page, "template_draft" | "created_by">) => !!page.template_draft && page.created_by !== user.id;
export async function pageRole(user: Identity, page: Page): Promise<Role | null> {
  // Known from the roles of all pages of the workspace (workspaceRoles()),
  // when they were computed in this request for the page as it is stored.
  const known = knownRole(user, page) ?? knownRole(user, page, await keptRoles(user, page.workspace_id));
  if (known !== undefined) return known;
  // A page given without the column (a partial row): as it is stored.
  if (othersDraft(user, "template_draft" in page ? page : ((await pageRow(page.id)) ?? page))) return null;
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
    // Below a record (#231): the record's role – its database's role with
    // the record's own rules (readonly, private, record grants,
    // lib/row-access.ts). A grant on the page itself or on a page between
    // it and the record (checked above, on the way up) still wins, as a
    // page shared from a private space does.
    if (current.parent_row_id) {
      const database = await pageRow(current.parent_id);
      // Loaded when needed: lib/row-access.ts reaches this module again
      // through its imports (an import cycle at start-up).
      if (database) return await (await import("./row-access")).subPageRecordRole(user, database, current.parent_row_id);
    }
    current = await pageRow(current.parent_id);
    if (current && othersDraft(user, current)) return null;
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

// ---- The roles of all pages of a workspace at once (#383) ----
//
// What pageRole() answers for every page of a workspace (trash, synced
// blocks and all), for one person, in a handful of statements instead of
// a few per page: the person's grants on pages and spaces, the spaces, the
// pages' parents (resolved in memory) and, for pages below records, those
// records with their grants for the person. Must equal pageRole() for
// every page (tests/workspace-roles.test.ts compares them); anything out of
// the ordinary – a parent, a space or a database in another workspace, a
// record in the trash or moved away – is left to pageRole() itself.
//
// `links` keeps what of each page went into its role (parent, space,
// record; shared by everyone's roles of the workspace), so pageRole() takes
// the answer from here only for a page with exactly these – a page changed
// in memory is checked on its own.
type PageLink = Readonly<{ id: string; workspace_id: string; space_id: string | null; parent_id: string | null; parent_row_id: string | null; template_draft: string | null; created_by: string }>;
export type WorkspaceRoles = { readonly roles: ReadonlyMap<string, Role | null>; readonly links: ReadonlyMap<string, PageLink> };
type RecordRow = { id: string; page_id: string; access: string; created_by: string | null };
type RecordGrant = { row_id: string; user_id: string; group_id: string; role: "viewer" | "editor" };
const rolesKey = (workspace: string, user: string) => `roles:${workspace}:${user}`;

function knownRole(user: Identity, page: Page, known = peekMemo<WorkspaceRoles>(rolesKey(page.workspace_id, user.id))): Role | null | undefined {
  const link = known?.links.get(page.id);
  if (!link || !known!.roles.has(page.id)) return undefined;
  if ((link.parent_id ?? null) !== (page.parent_id ?? null) || (link.space_id ?? null) !== (page.space_id ?? null) || (link.parent_row_id ?? null) !== (page.parent_row_id ?? null)) return undefined;
  return known!.roles.get(page.id)!;
}

// Remembered within a request until the next write (lib/read-memo.ts)
// and across requests while the version "roles" stays
// (lib/cache-versions.ts); pageRole() answers from either.
const kept = globalThis as { flowplanRoles?: VersionedCache<WorkspaceRoles>; flowplanPageLinks?: VersionedCache<ReadonlyMap<string, PageLink>> };
const keptAcross = (kept.flowplanRoles ??= new VersionedCache<WorkspaceRoles>(500));
const keptLinks = (kept.flowplanPageLinks ??= new VersionedCache<ReadonlyMap<string, PageLink>>(50));
const pageLinks = async (workspace: string) =>
  new Map((await all<PageLink>("SELECT id,workspace_id,space_id,parent_id,parent_row_id,template_draft,created_by FROM pages WHERE workspace_id=?", workspace)).map((p) => [p.id, Object.freeze(p)]));
export async function workspaceRoles(user: Identity, workspace: string): Promise<WorkspaceRoles> {
  return await memoized(rolesKey(workspace, user.id), async () => {
    if (inTransaction()) return await computeWorkspaceRoles(user, workspace, await pageLinks(workspace));
    const version = await cacheVersion("roles");
    const key = `${workspace}:${user.id}`;
    const kept = keptAcross.get(key, version);
    if (kept) return kept;
    let links = keptLinks.get(workspace, version);
    if (!links) keptLinks.set(workspace, version, (links = await pageLinks(workspace)));
    const roles = await computeWorkspaceRoles(user, workspace, links);
    keptAcross.set(key, version, roles);
    return roles;
  });
}
// The roles kept from an earlier request, when still current; never
// computed here (one page is cheaper to check on its own).
async function keptRoles(user: Identity, workspace: string): Promise<WorkspaceRoles | undefined> {
  // Only within a request (a read memo in place): elsewhere the version
  // would be read again for every page.
  if (inTransaction() || !keptAcross.size || !inReadMemo()) return undefined;
  const version = await cacheVersion("roles");
  const kept = keptAcross.get(`${workspace}:${user.id}`, version);
  // For the rest of the request as if computed in it.
  if (kept) await memoized(rolesKey(workspace, user.id), () => kept);
  return kept;
}

// `links`: every page of the workspace with its place (pageLinks()).
async function computeWorkspaceRoles(user: Identity, workspace: string, links: ReadonlyMap<string, PageLink>): Promise<WorkspaceRoles> {
  const pages = [...links.values()];
  const out = new Map<string, Role | null>();
  const membership = await memberRole(user, workspace);
  if (!membership) {
    for (const p of pages) out.set(p.id, null);
    return { roles: out, links };
  }
  const guest = await isGuest(user, workspace);
  const spaces = new Map((await all<Space>("SELECT * FROM spaces WHERE workspace_id=?", workspace)).map((s) => [s.id, s]));
  const pageGrant = new Map<string, Role>(),
    spaceGrant = new Map<string, Role>();
  for (const g of await all<{ resource_id: string; resource_kind: string; role: Role }>(
    "SELECT resource_id,resource_kind,role FROM grants WHERE workspace_id=? AND resource_kind IN ('page','space') AND (user_id=? OR group_id IN (SELECT group_id FROM group_members WHERE user_id=?))",
    workspace,
    user.id,
    user.id,
  )) {
    const best = g.resource_kind === "page" ? pageGrant : spaceGrant;
    const had = best.get(g.resource_id);
    if (!had || rank[g.role] > rank[had]) best.set(g.resource_id, g.role);
  }
  // The records pages sit below, with the person's grants on those with
  // their own access (as lib/row-access.ts restrictedGrants() reads them).
  const records = new Map<string, RecordRow>(),
    recordGrants = new Map<string, RecordGrant[]>();
  if (pages.some((p) => p.parent_row_id)) {
    const below = "SELECT parent_row_id FROM pages WHERE workspace_id=? AND parent_row_id IS NOT NULL";
    for (const r of await all<RecordRow>(`SELECT id,page_id,access,created_by FROM rows WHERE id IN (${below})`, workspace)) records.set(r.id, r);
    for (const g of await all<RecordGrant>(
      `SELECT g.row_id,g.user_id,g.group_id,g.role FROM row_grants g JOIN rows r ON r.id=g.row_id
       WHERE r.access<>'inherit' AND r.id IN (${below}) AND (g.user_id=? OR g.group_id IN (SELECT group_id FROM group_members WHERE user_id=?))`,
      workspace,
      user.id,
      user.id,
    ))
      recordGrants.set(g.row_id, [...(recordGrants.get(g.row_id) || []), g]);
  }
  // Loaded when needed, as in pageRole() (an import cycle at start-up).
  const { combine } = await import("./row-access");
  const byId = links;
  const capped = (granted: Role) => (rank[granted] < rank[membership] ? granted : membership);
  const ofSpace = (space: Space): Role | null => {
    if (space.deleted_at) return null;
    if (space.owner_id === user.id) return membership;
    const granted = spaceGrant.get(space.id);
    if (granted) return capped(granted);
    return space.visibility === "team" && !guest ? membership : null;
  };
  // undefined: not decided here – pageRole() decides.
  const decided = new Map<string, Role | null | undefined>();
  const busy = new Set<string>();
  const roleOf = (p: PageLink): Role | null | undefined => {
    if (decided.has(p.id)) return decided.get(p.id);
    if (busy.has(p.id)) return undefined;
    busy.add(p.id);
    const role = decide(p);
    busy.delete(p.id);
    decided.set(p.id, role);
    return role;
  };
  // The steps of pageRole(), on the rows above.
  function decide(p: PageLink): Role | null | undefined {
    if (!p.space_id || othersDraft(user, p)) return null;
    const space = spaces.get(p.space_id);
    if (!space) return undefined;
    if (space.deleted_at) return null;
    const direct = pageGrant.get(p.id);
    if (direct) return capped(direct);
    const seen = new Set<string>();
    let current = p;
    while (current.parent_id) {
      if (seen.has(current.id)) return null;
      seen.add(current.id);
      const parent = byId.get(current.parent_id);
      if (!parent) return undefined;
      // Below a record: the record's role (lib/row-access.ts
      // subPageRecordRole()); one in the trash or moved away is left to it.
      if (current.parent_row_id) {
        const row = records.get(current.parent_row_id);
        if (!row || row.page_id !== parent.id) return undefined;
        const role = roleOf(parent);
        return role === undefined ? undefined : combine(user, role, row, recordGrants.get(row.id) || []);
      }
      current = parent;
      if (othersDraft(user, current)) return null;
      const inherited = pageGrant.get(current.id);
      if (inherited) return capped(inherited);
    }
    return ofSpace(space);
  }
  for (const p of pages) {
    const role = roleOf(p);
    out.set(p.id, role === undefined ? await pageRole(user, p as unknown as Page) : role);
  }
  return { roles: out, links };
}
