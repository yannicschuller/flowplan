import { z } from "zod";
import { all, one, run, id } from "./db";
import { requirePage } from "./permissions";
import { HttpError } from "./auth";
import type { Identity, Page } from "./types";

export type ShareLink = {
  token: string;
  name: string;
  role: "viewer" | "commenter" | "editor";
  include_children: number;
  count: number;
};
export function listShareLinks(user: Identity, pageId: string): ShareLink[] {
  requirePage(user, pageId, true);
  return all<ShareLink>(
    `SELECT token,name,role,include_children,
    (SELECT count(*) FROM share_link_pages p WHERE p.token=l.token) count
    FROM share_links l WHERE root_id=? ORDER BY created_at,token`,
    pageId,
  );
}
// Called inside the command transaction; the explicit page set never grows implicitly.
export function manageShareLink(
  user: Identity,
  input: Record<string, unknown>,
) {
  const pageId = z.string().uuid().parse(input.pageId);
  const root = requirePage(user, pageId, true);
  if (input.action === "share.revoke") {
    run(
      "DELETE FROM share_links WHERE token=? AND root_id=?",
      z.string().uuid().parse(input.token),
      pageId,
    );
    return { ok: true };
  }
  const role = z.enum(["viewer", "commenter", "editor"]).parse(input.role);
  const name = z.string().trim().min(1).max(100).parse(input.name);
  const includeChildren = z.boolean().parse(input.includeChildren ?? false);
  if (
    (one<{ n: number }>(
      "SELECT count(*) n FROM share_links WHERE root_id=?",
      pageId,
    )?.n || 0) >= 50
  )
    throw new HttpError(400, "Maximal 50 aktive Links pro Seite.");
  const pages = includeChildren
    ? all<Page>(
        `WITH RECURSIVE tree AS (
    SELECT * FROM pages WHERE id=? AND deleted_at IS NULL UNION ALL
    SELECT p.* FROM pages p JOIN tree t ON p.parent_id=t.id WHERE p.deleted_at IS NULL
  ) SELECT * FROM tree`,
        pageId,
      )
    : [root];
  for (const page of pages) requirePage(user, page.id, true);
  const token = id();
  run(
    "INSERT INTO share_links(token,root_id,name,role,include_children,created_by) VALUES(?,?,?,?,?,?)",
    token,
    pageId,
    name,
    role,
    includeChildren ? 1 : 0,
    user.id,
  );
  for (const page of pages)
    run("INSERT INTO share_link_pages VALUES(?,?)", token, page.id);
  return { token };
}
