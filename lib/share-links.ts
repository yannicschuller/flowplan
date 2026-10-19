import { z } from "zod";
import { all, one, run, id } from "./db";
import { requirePage } from "./permissions";
import { lockedPageIds, requireUnlocked } from "./journal-extras";
import { HttpError } from "./auth";
import { protectionChanges } from "./share-access";
import type { Identity, Page } from "./types";

export type ShareLink = {
  token: string;
  name: string;
  role: "viewer" | "commenter" | "editor";
  include_children: number;
  count: number;
  // Whether visitors enter a password; when the link ends (ms, or null).
  password: boolean;
  expires_at: number | null;
};
export function listShareLinks(user: Identity, pageId: string): ShareLink[] {
  requirePage(user, pageId, true);
  return all<Omit<ShareLink, "password"> & { password: number }>(
    `SELECT token,name,role,include_children,password_hash IS NOT NULL password,expires_at,
    (SELECT count(*) FROM share_link_pages p WHERE p.token=l.token) count
    FROM share_links l WHERE root_id=? ORDER BY created_at,token`,
    pageId,
  ).map((link) => ({ ...link, password: !!link.password }));
}
// Called inside the command transaction; the explicit page set never grows implicitly.
export function manageShareLink(
  user: Identity,
  input: Record<string, unknown>,
) {
  const pageId = z.string().uuid().parse(input.pageId);
  const root = requirePage(user, pageId, true);
  // A journal behind a PIN is shared only by someone who has entered it.
  requireUnlocked(user, root);
  if (input.action === "share.revoke") {
    run(
      "DELETE FROM share_links WHERE token=? AND root_id=?",
      z.string().uuid().parse(input.token),
      pageId,
    );
    return { ok: true };
  }
  // Password and end date of an existing link (lib/share-access.ts).
  if (input.action === "share.protect") {
    const token = z.string().uuid().parse(input.token);
    if (!one("SELECT 1 FROM share_links WHERE token=? AND root_id=?", token, pageId))
      throw new HttpError(404, "Link nicht gefunden.");
    const changes = protectionChanges(input);
    if (changes.password_hash !== undefined)
      run("UPDATE share_links SET password_hash=? WHERE token=?", changes.password_hash, token);
    if (changes.expires_at !== undefined)
      run("UPDATE share_links SET expires_at=? WHERE token=?", changes.expires_at, token);
    return { ok: true };
  }
  const protection = protectionChanges({ password: input.password, expiresAt: input.expiresAt });
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
  const locked = lockedPageIds(user, root.workspace_id);
  for (const page of pages) {
    requirePage(user, page.id, true);
    if (locked.has(page.id)) throw new HttpError(423, "Dieses Journal ist gesperrt.");
  }
  const token = id();
  run(
    "INSERT INTO share_links(token,root_id,name,role,include_children,created_by,password_hash,expires_at) VALUES(?,?,?,?,?,?,?,?)",
    token,
    pageId,
    name,
    role,
    includeChildren ? 1 : 0,
    user.id,
    protection.password_hash ?? null,
    protection.expires_at ?? null,
  );
  for (const page of pages)
    run("INSERT INTO share_link_pages VALUES(?,?)", token, page.id);
  return { token };
}
