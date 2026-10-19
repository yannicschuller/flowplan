// Sharing one page (document, database, whiteboard …) with a person without
// making them a member of the whole workspace: they become a guest of the
// workspace, who sees only what is shared with them, with a grant on this
// page and its sub-pages. Someone with an account gets access right away
// (and a notification); for anyone else an invitation is sent and the grant
// waits in invite_grants until they sign in (lib/auth.ts acceptInvites).
import { z } from "zod";
import { all, id, one, run } from "./db";
import { HttpError } from "./auth";
import { memberRole, requirePage } from "./permissions";
import { canManageSpace } from "./workspace-lifecycle";
import type { Identity, Page, Role, Space } from "./types";

const rank: Record<string, number> = { viewer: 1, editor: 2, owner: 3 };
const input = z.object({
  pageId: z.uuid(),
  email: z.email().max(320),
  role: z.enum(["editor", "viewer"]),
});

// Workspace owners and the owner of the space share pages.
export function canSharePage(user: Identity, page: Page) {
  if (user.apiScope) return false;
  if (memberRole(user, page.workspace_id) === "owner") return true;
  const space = one<Space>("SELECT * FROM spaces WHERE id=?", page.space_id);
  return !!space && canManageSpace(user, space);
}
function requireSharer(user: Identity, pageId: string) {
  const page = requirePage(user, pageId);
  if (!canSharePage(user, page))
    throw new HttpError(403, "Nur Eigentümer des Arbeitsbereichs oder des Bereichs dürfen Seiten mit weiteren Personen teilen.");
  return page;
}

// People and pending invitations with access to exactly this page.
export function pageShares(user: Identity, pageId: string) {
  const page = requirePage(user, pageId);
  const manage = canSharePage(user, page);
  const people = all<{ id: string; name: string; email: string; role: Role; guest: number }>(
    `SELECT u.id,u.name,u.email,g.role,EXISTS(SELECT 1 FROM workspace_guests w WHERE w.workspace_id=? AND w.user_id=u.id) guest
     FROM grants g JOIN users u ON u.id=g.user_id WHERE g.resource_id=? AND g.user_id<>'' ORDER BY u.name`,
    page.workspace_id,
    page.id,
  ).map((p) => ({ ...p, guest: !!p.guest }));
  const pending = manage
    ? all<{ email: string; role: Role }>("SELECT email,role FROM invite_grants WHERE resource_id=? ORDER BY email", page.id)
    : [];
  return { manage, people, pending };
}

export function sharePage(user: Identity, raw: unknown) {
  const b = input.parse(raw);
  const page = requireSharer(user, b.pageId);
  const email = b.email.trim().toLowerCase();
  const target = one<{ id: string; name: string }>(
    "SELECT id,name FROM users WHERE lower(email)=? AND disabled=0 AND demo_until IS NULL AND subject NOT LIKE 'deleted:%'",
    email,
  );
  if (target?.id === user.id) throw new HttpError(400, "Du hast bereits Zugriff.");
  if (target) {
    const membership = one<{ role: Role }>("SELECT role FROM members WHERE workspace_id=? AND user_id=?", page.workspace_id, target.id);
    const guest = !!one("SELECT 1 FROM workspace_guests WHERE workspace_id=? AND user_id=?", page.workspace_id, target.id);
    if (!membership) {
      run("INSERT INTO members VALUES(?,?,?)", page.workspace_id, target.id, b.role);
      run("INSERT OR IGNORE INTO workspace_guests(workspace_id,user_id) VALUES(?,?)", page.workspace_id, target.id);
    } else if (guest && rank[membership.role] < rank[b.role])
      // A guest's role caps their grants: raise it to what this page needs.
      run("UPDATE members SET role=? WHERE workspace_id=? AND user_id=?", b.role, page.workspace_id, target.id);
    run("DELETE FROM grants WHERE resource_id=? AND user_id=? AND group_id=''", page.id, target.id);
    run("INSERT INTO grants VALUES(?,?,?,?)", page.id, target.id, "", b.role);
    run(
      "INSERT INTO notifications(id,user_id,body,page_id,kind) VALUES(?,?,?,?,'share')",
      id(),
      target.id,
      `${user.name} hat „${page.title}“ mit dir geteilt`,
      page.id,
    );
    return { status: "added" as const, name: target.name, ...pageShares(user, page.id) };
  }
  // No account yet: an invitation as a guest, the grant waits for sign-in.
  const invite = one<{ guest: number; role: Role }>("SELECT guest,role FROM invites WHERE workspace_id=? AND email=?", page.workspace_id, email);
  if (!invite)
    run(
      "INSERT INTO invites(id,workspace_id,email,role,created_by,guest) VALUES(?,?,?,?,?,1)",
      id(),
      page.workspace_id,
      email,
      b.role,
      user.id,
    );
  else if (invite.guest && rank[invite.role] < rank[b.role])
    run("UPDATE invites SET role=? WHERE workspace_id=? AND email=?", b.role, page.workspace_id, email);
  run(
    "INSERT INTO invite_grants(workspace_id,email,resource_id,role) VALUES(?,?,?,?) ON CONFLICT(email,resource_id) DO UPDATE SET role=excluded.role",
    page.workspace_id,
    email,
    page.id,
    b.role,
  );
  const workspace = one<{ name: string }>("SELECT name FROM workspaces WHERE id=?", page.workspace_id);
  return {
    status: "invited" as const,
    mail: { email, inviter: user.name, workspace: workspace?.name || "Flowplan", guest: true, page: page.title },
    ...pageShares(user, page.id),
  };
}

// Changes the role, or removes the person from this page. A guest without
// any shared page left is no longer in the workspace either.
export function updatePageShare(user: Identity, raw: unknown) {
  const b = z
    .object({ pageId: z.uuid(), userId: z.uuid().optional(), email: z.email().optional(), role: z.enum(["editor", "viewer", "remove"]) })
    .parse(raw);
  const page = requireSharer(user, b.pageId);
  if (b.email) {
    const email = b.email.toLowerCase();
    if (b.role === "remove") {
      run("DELETE FROM invite_grants WHERE email=? AND resource_id=?", email, page.id);
      // An invitation that only existed for shared pages goes with the last one.
      if (!one("SELECT 1 FROM invite_grants WHERE email=? AND workspace_id=?", email, page.workspace_id))
        run("DELETE FROM invites WHERE workspace_id=? AND email=? AND guest=1", page.workspace_id, email);
    } else run("UPDATE invite_grants SET role=? WHERE email=? AND resource_id=?", b.role, email, page.id);
    return pageShares(user, page.id);
  }
  if (!b.userId) throw new HttpError(400, "Person fehlt.");
  if (b.role === "remove") {
    run("DELETE FROM grants WHERE resource_id=? AND user_id=? AND group_id=''", page.id, b.userId);
    const guest = one("SELECT 1 FROM workspace_guests WHERE workspace_id=? AND user_id=?", page.workspace_id, b.userId);
    const left = one(
      `SELECT 1 FROM grants g WHERE g.user_id=? AND g.resource_id IN (SELECT id FROM pages WHERE workspace_id=? UNION SELECT id FROM spaces WHERE workspace_id=?)`,
      b.userId,
      page.workspace_id,
      page.workspace_id,
    );
    if (guest && !left) {
      run("DELETE FROM members WHERE workspace_id=? AND user_id=?", page.workspace_id, b.userId);
      run("DELETE FROM workspace_guests WHERE workspace_id=? AND user_id=?", page.workspace_id, b.userId);
    }
  } else {
    if (!one("SELECT 1 FROM members WHERE workspace_id=? AND user_id=?", page.workspace_id, b.userId)) throw new HttpError(400, "Mitglied fehlt.");
    run("DELETE FROM grants WHERE resource_id=? AND user_id=? AND group_id=''", page.id, b.userId);
    run("INSERT INTO grants VALUES(?,?,?,?)", page.id, b.userId, "", b.role);
    if (b.role === "editor" && one("SELECT 1 FROM workspace_guests WHERE workspace_id=? AND user_id=?", page.workspace_id, b.userId))
      run("UPDATE members SET role='editor' WHERE workspace_id=? AND user_id=? AND role='viewer'", page.workspace_id, b.userId);
  }
  return pageShares(user, page.id);
}
