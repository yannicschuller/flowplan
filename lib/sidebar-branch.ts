// A branch of the page tree focused in the sidebar (#318): the tree shows
// one page as its root, with a path back up above it. Kept per workspace on
// this device (localStorage), not in the account. Pure, no browser or Node
// APIs (the storage is passed in).
type TreePage = { id: string; parent_id: string | null; space_id: string; deleted_at?: string | null };

const MAX_DEPTH = 64;
export const branchKey = (workspaceId: string) => `flowplan-sidebar-branch:${workspaceId}`;

// The pages from the top of the space down to `id` (both included), or []
// when `id` is not a live page.
export function branchPath(pages: readonly TreePage[], id: string | null | undefined): string[] {
  if (!id) return [];
  const byId = new Map(pages.filter((p) => !p.deleted_at).map((p) => [p.id, p]));
  const out: string[] = [];
  const seen = new Set<string>();
  for (let at = byId.get(id); at && !seen.has(at.id) && out.length < MAX_DEPTH; at = at.parent_id ? byId.get(at.parent_id) : undefined) {
    seen.add(at.id);
    out.unshift(at.id);
  }
  return out;
}

// Whether `pageId` is the focused page or one below it.
export function inBranch(pages: readonly TreePage[], branchId: string, pageId: string): boolean {
  return branchPath(pages, pageId).includes(branchId);
}

// "←": the level above – the parent page, or the whole tree (null) for a
// page at the top of its space.
export function branchUp(pages: readonly TreePage[], branchId: string): string | null {
  const path = branchPath(pages, branchId);
  return path.length > 1 ? path[path.length - 2] : null;
}

// Whether the sidebar leaves the focus after the open page changed: a page
// opened outside the branch shows the whole tree again, so the open page
// is never missing from the sidebar.
export function leavesBranch(
  pages: readonly TreePage[],
  branchId: string | null,
  previousPageId: string | null,
  pageId: string | null,
): boolean {
  if (!branchId || !pageId || pageId === previousPageId) return false;
  return !inBranch(pages, branchId, pageId);
}

// The stored focus, only while its page exists (deleted, or gone to the
// trash: the whole tree again).
export function readBranch(storage: Pick<Storage, "getItem"> | null | undefined, workspaceId: string, pages: readonly TreePage[]): string | null {
  try {
    const id = storage?.getItem(branchKey(workspaceId));
    return id && branchPath(pages, id).length ? id : null;
  } catch {
    return null;
  }
}

export function writeBranch(storage: Pick<Storage, "setItem" | "removeItem"> | null | undefined, workspaceId: string, id: string | null) {
  try {
    if (id) storage?.setItem(branchKey(workspaceId), id);
    else storage?.removeItem(branchKey(workspaceId));
  } catch {
    /* kept for this tab only */
  }
}
