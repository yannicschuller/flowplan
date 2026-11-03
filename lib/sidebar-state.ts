// What a person folded or unfolded in the sidebar (#97), stored in their
// account per workspace (schema 86, table sidebar_state) and so the same on
// all their devices. The bootstrap sends it along; the client saves changes
// (debounced) with the command `sidebar.state` and keeps a copy on the
// device so the first render does not flicker.
//
// The state is a short list of keys, each one a choice that differs from
// the default (lib/sidebar-folds.ts).
// Keys of pages and spaces that are gone (deleted, in the trash) or pages
// without sub-pages are dropped whenever the state is read or saved, and the
// list keeps at most SIDEBAR_STATE_LIMIT keys (the oldest go first).
// Folding is nobody else's business: no event, no version, no activity.
import { z } from "zod";
import { all, one, run } from "./db";
import { requireMember } from "./permissions";
import type { Identity } from "./types";
import { applySidebarChanges, isSidebarKey, pruneSidebarKeys, SIDEBAR_CHANGES_LIMIT } from "./sidebar-folds";

function knownIn(workspaceId: string) {
  const pages = all<{ id: string; parent_id: string | null }>(
    "SELECT id,parent_id FROM pages WHERE workspace_id=? AND deleted_at IS NULL",
    workspaceId,
  );
  return {
    pages: new Set(pages.map((p) => p.id)),
    parents: new Set(pages.flatMap((p) => (p.parent_id ? [p.parent_id] : []))),
    spaces: new Set(
      all<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=? AND deleted_at IS NULL", workspaceId).map((s) => s.id),
    ),
  };
}

function stored(userId: string, workspaceId: string) {
  const row = one<{ keys: string; updated_at: number }>(
    "SELECT keys,updated_at FROM sidebar_state WHERE user_id=? AND workspace_id=?",
    userId,
    workspaceId,
  );
  if (!row) return null;
  let keys: unknown;
  try {
    keys = JSON.parse(row.keys);
  } catch {
    keys = [];
  }
  return { keys: Array.isArray(keys) ? keys.filter(isSidebarKey) : [], updatedAt: row.updated_at };
}

// For the bootstrap: null when the person never folded anything here (the
// client then takes over what this device remembered before #97).
export function sidebarState(
  user: Pick<Identity, "id">,
  workspaceId: string,
): { keys: string[]; updatedAt: number } | null {
  const state = stored(user.id, workspaceId);
  if (!state) return null;
  return { keys: pruneSidebarKeys(state.keys, knownIn(workspaceId)), updatedAt: state.updatedAt };
}

const input = z.object({
  workspaceId: z.string().uuid(),
  changes: z
    .record(z.string().max(80), z.boolean())
    .refine((changes) => Object.keys(changes).length <= SIDEBAR_CHANGES_LIMIT, "Zu viele Änderungen."),
});

// The command `sidebar.state`: { workspaceId, changes: { key: boolean } }.
export function saveSidebarState(user: Identity, body: unknown): { keys: string[]; updatedAt: number } {
  const b = input.parse(body);
  requireMember(user, b.workspaceId);
  const keys = pruneSidebarKeys(
    applySidebarChanges(stored(user.id, b.workspaceId)?.keys || [], b.changes),
    knownIn(b.workspaceId),
  );
  const updatedAt = Date.now();
  run(
    `INSERT INTO sidebar_state(user_id,workspace_id,keys,updated_at) VALUES(?,?,?,?)
     ON CONFLICT(user_id,workspace_id) DO UPDATE SET keys=excluded.keys,updated_at=excluded.updated_at`,
    user.id,
    b.workspaceId,
    JSON.stringify(keys),
    updatedAt,
  );
  return { keys, updatedAt };
}
