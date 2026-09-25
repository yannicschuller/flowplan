import { z } from "zod";
import { all, id, one, run } from "./db";
import { HttpError } from "./auth";
import { requireMember, spaceRole } from "./permissions";
import type { Identity, Space } from "./types";

export const MAX_SAVED_SEARCHES = 50;
export type SavedSearch = {
  id: string;
  name: string;
  query: string;
  kind: "all" | "document" | "database" | "whiteboard" | "row" | "comment" | "file";
  spaceId: string | null;
};
const input = z.object({
  workspaceId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  query: z.string().trim().min(1).max(500),
  kind: z.enum(["all", "document", "database", "whiteboard", "row", "comment", "file"]),
  spaceId: z.string().uuid().nullish(),
});

// Saved searches are personal; only the owner lists, runs or deletes them.
export function savedSearches(user: Identity, workspaceId: string) {
  return all<{
    id: string;
    name: string;
    query: string;
    kind: SavedSearch["kind"];
    space_id: string | null;
  }>(
    "SELECT id,name,query,kind,space_id FROM saved_searches WHERE user_id=? AND workspace_id=? ORDER BY created_at,rowid",
    user.id,
    workspaceId,
  ).map((s): SavedSearch => ({
    id: s.id,
    name: s.name,
    query: s.query,
    kind: s.kind,
    spaceId: s.space_id,
  }));
}
export function saveSearch(user: Identity, raw: unknown) {
  const b = input.parse(raw);
  requireMember(user, b.workspaceId);
  if (b.spaceId) {
    const space = one<Space>(
      "SELECT * FROM spaces WHERE id=? AND workspace_id=? AND deleted_at IS NULL",
      b.spaceId,
      b.workspaceId,
    );
    if (!space || !spaceRole(user, space))
      throw new HttpError(404, "Bereich nicht gefunden.");
  }
  const count = Number(
    one<{ n: number }>(
      "SELECT COUNT(*) n FROM saved_searches WHERE user_id=? AND workspace_id=?",
      user.id,
      b.workspaceId,
    )?.n || 0,
  );
  if (count >= MAX_SAVED_SEARCHES)
    throw new HttpError(
      409,
      `Höchstens ${MAX_SAVED_SEARCHES} gespeicherte Suchen je Arbeitsbereich.`,
    );
  const sid = id();
  run(
    "INSERT INTO saved_searches(id,user_id,workspace_id,name,query,kind,space_id) VALUES(?,?,?,?,?,?,?)",
    sid,
    user.id,
    b.workspaceId,
    b.name,
    b.query,
    b.kind,
    b.spaceId || null,
  );
  return { id: sid };
}
export function deleteSavedSearch(user: Identity, raw: unknown) {
  const sid = z.string().uuid().parse(raw);
  if (
    !run("DELETE FROM saved_searches WHERE id=? AND user_id=?", sid, user.id)
      .changes
  )
    throw new HttpError(404, "Gespeicherte Suche nicht gefunden.");
}
