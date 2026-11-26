// The workspace as a library and its hidden places (#564,
// lib/workspace-navigation.ts) on the server: read for the bootstrap, the
// library (lib/library-server.ts) and MCP; changed by the workspace's
// owners with workspace.update (`library`, `hidden`); in the workspace's
// export and taken over on import into a workspace that has none yet.
import { z } from "zod";
import { one, run } from "./db";
import { requireMember } from "./permissions";
import { memoized } from "./read-memo";
import { treeChanged } from "./workspace-live";
import { isDefaultNavigation, navigationOf, WORKSPACE_PLACES, type WorkspaceNavigation } from "./workspace-navigation";
import type { Identity } from "./types";

// What workspace.update accepts: each field optional, places known and
// each once.
export const navigationInputSchema = z.object({
  library: z.boolean().optional(),
  hidden: z
    .array(z.enum(WORKSPACE_PLACES))
    .max(WORKSPACE_PLACES.length)
    .refine((list) => new Set(list).size === list.length, "A place may be listed only once.")
    .optional(),
});

export async function workspaceNavigation(workspaceId: string): Promise<WorkspaceNavigation> {
  return await memoized(`workspace-navigation:${workspaceId}`, async () =>
    navigationOf((await one<{ navigation: string | null }>("SELECT navigation FROM workspaces WHERE id=?", workspaceId))?.navigation),
  );
}

async function store(workspaceId: string, nav: WorkspaceNavigation) {
  await run("UPDATE workspaces SET navigation=? WHERE id=?", isDefaultNavigation(nav) ? null : JSON.stringify(nav), workspaceId);
  // Every open tab of the workspace asks for its sidebar again.
  treeChanged(workspaceId);
}

// Owners only. Fields left out keep their value.
export async function saveWorkspaceNavigation(user: Identity, workspaceId: string, input: { library?: unknown; hidden?: unknown }) {
  await requireMember(user, workspaceId, "owner");
  const parsed = navigationInputSchema.parse(input);
  const current = navigationOf((await one<{ navigation: string | null }>("SELECT navigation FROM workspaces WHERE id=?", workspaceId))?.navigation);
  const next = navigationOf({ library: parsed.library ?? current.library, hidden: parsed.hidden ?? current.hidden });
  await store(workspaceId, next);
  return next;
}

// The export's part: only when something is set.
export async function exportNavigation(workspaceId: string) {
  const nav = await workspaceNavigation(workspaceId);
  return isDefaultNavigation(nav) ? {} : { navigation: nav };
}
// The import's part: an owner importing into a workspace that has none
// yet takes it over; an unreadable value counts as left out.
export async function importNavigation(user: Identity, workspaceId: string, input: unknown) {
  if (input === undefined || input === null) return { dropped: 0 };
  if ((await one<{ role: string }>("SELECT role FROM members WHERE workspace_id=? AND user_id=?", workspaceId, user.id))?.role !== "owner") return { dropped: 0 };
  const parsed = navigationInputSchema.safeParse(input);
  if (!parsed.success) return { dropped: 1 };
  if ((await one<{ navigation: string | null }>("SELECT navigation FROM workspaces WHERE id=?", workspaceId))?.navigation) return { dropped: 0 };
  await store(workspaceId, navigationOf(parsed.data));
  return { dropped: 0 };
}
