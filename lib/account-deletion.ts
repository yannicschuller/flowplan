// Deleting an account (administration; only after it was deactivated).
// Workspaces only this person belonged to are removed, shared workspaces get
// another owner if needed, private spaces go with the person. What they
// contributed to shared workspaces stays, under "Deleted account"; personal
// data – name, e-mail, password, passkeys, sessions, settings – is removed.
import { all, audit, one, run } from "./db";
import { HttpError } from "./auth";
import { purgePages, purgeWorkspace } from "./workspace-lifecycle";
import type { Identity, Page } from "./types";

type Plan = {
  name: string;
  removed: { id: string; name: string }[];
  handedOver: { id: string; name: string; to: string }[];
  privateSpaces: number;
};

// Personal data of the account, removed in any case.
const PERSONAL = [
  "sessions",
  "api_tokens",
  "auth_tokens",
  "auth_challenges",
  "caldav_accesses",
  "calendar_feeds",
  "favorites",
  "row_favorites",
  "journal_unlocks",
  "passkeys",
  "local_accounts",
  "push_subscriptions",
  "notifications",
  "notification_prefs",
  "page_follows",
  "page_visits",
  "presence",
  "editor_presence",
  "record_views",
  "task_reminders",
  "date_reminders",
  "user_avatars",
  "saved_searches",
  "group_members",
  "comment_reactions",
];

export function deletionPlan(userId: string): Plan {
  const user = one<{ name: string }>("SELECT name FROM users WHERE id=?", userId);
  if (!user) throw new HttpError(404, "Benutzer nicht gefunden.");
  const removed: Plan["removed"] = [],
    handedOver: Plan["handedOver"] = [];
  for (const w of all<{ id: string; name: string; role: string }>(
    "SELECT w.id,w.name,m.role FROM workspaces w JOIN members m ON m.workspace_id=w.id WHERE m.user_id=?",
    userId,
  )) {
    const others = all<{ user_id: string; role: string; name: string }>(
      "SELECT m.user_id,m.role,u.name FROM members m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? AND m.user_id<>? AND u.disabled=0 ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, u.created_at",
      w.id,
      userId,
    );
    if (!others.length) removed.push({ id: w.id, name: w.name });
    else if (w.role === "owner" && !others.some((o) => o.role === "owner")) handedOver.push({ id: w.id, name: w.name, to: others[0].name });
  }
  const privateSpaces = Number(one<{ n: number }>("SELECT count(*) n FROM spaces WHERE owner_id=? AND visibility='private'", userId)?.n || 0);
  return { name: user.name, removed, handedOver, privateSpaces };
}

// Inside the command's transaction.
export function deleteAccount(admin: Identity, userId: string) {
  if (userId === admin.id) throw new HttpError(400, "Das eigene Konto lässt sich hier nicht löschen.");
  const target = one<{ disabled: number; demo_until: number | null }>("SELECT disabled,demo_until FROM users WHERE id=?", userId);
  if (!target) throw new HttpError(404, "Benutzer nicht gefunden.");
  if (!target.disabled) throw new HttpError(409, "Bitte das Konto zuerst deaktivieren.");
  const isAdmin = !!one("SELECT 1 FROM local_accounts WHERE user_id=? AND is_admin=1", userId);
  if (isAdmin && !one("SELECT 1 FROM local_accounts a JOIN users u ON u.id=a.user_id WHERE a.is_admin=1 AND a.user_id<>? AND u.disabled=0", userId))
    throw new HttpError(409, "Das letzte Admin-Konto lässt sich nicht löschen.");
  const plan = deletionPlan(userId);
  {
    for (const w of plan.removed) purgeWorkspace(w.id);
    for (const w of all<{ id: string }>("SELECT workspace_id id FROM members WHERE user_id=? AND role='owner'", userId)) {
      if (one("SELECT 1 FROM members WHERE workspace_id=? AND user_id<>? AND role='owner'", w.id, userId)) continue;
      const next = one<{ user_id: string }>(
        "SELECT m.user_id FROM members m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? AND m.user_id<>? AND u.disabled=0 ORDER BY CASE m.role WHEN 'editor' THEN 0 ELSE 1 END, u.created_at LIMIT 1",
        w.id,
        userId,
      );
      if (next) run("UPDATE members SET role='owner' WHERE workspace_id=? AND user_id=?", w.id, next.user_id);
    }
    // Private spaces: nobody else can see them, so they go too.
    for (const space of all<{ id: string; workspace_id: string }>("SELECT id,workspace_id FROM spaces WHERE owner_id=? AND visibility='private'", userId)) {
      purgePages(space.workspace_id, all<Page>("SELECT * FROM pages WHERE space_id=?", space.id));
      run("DELETE FROM grants WHERE resource_id=?", space.id);
      run("DELETE FROM spaces WHERE id=?", space.id);
    }
    for (const table of PERSONAL)
      try {
        run(`DELETE FROM ${table} WHERE user_id=?`, userId);
      } catch {}
    run("DELETE FROM grants WHERE user_id=?", userId);
    run("DELETE FROM members WHERE user_id=?", userId);
    run("UPDATE spaces SET owner_id=NULL WHERE owner_id=?", userId);
    try {
      run("DELETE FROM users WHERE id=?", userId);
    } catch {
      // Still named as author somewhere: the account stays as an empty shell.
      run(
        "UPDATE users SET name='Gelöschtes Konto',email='',subject=?,disabled=1,locale=NULL,language=NULL,limits=NULL WHERE id=?",
        `deleted:${userId}`,
        userId,
      );
    }
    audit(admin.id, "admin.deleteUser", userId, plan.name);
  }
  return plan;
}
