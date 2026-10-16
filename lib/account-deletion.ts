// Deleting an account: by an admin once it was deactivated, or by the
// person themself (Settings → General → Your profile).
// Workspaces only this person belonged to are removed, shared workspaces get
// another owner if needed, private spaces go with the person. What they
// contributed to shared workspaces stays, under "Deleted account"; personal
// data – name, e-mail, password, passkeys, sessions, settings – is removed.
import { z } from "zod";
import { all, audit, one, run } from "./db";
import { HttpError } from "./auth";
import { localLoginEnabled } from "./local-auth";
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
  "mobile_devices",
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
  if (lastAdmin(userId)) throw new HttpError(409, "Das letzte Admin-Konto lässt sich nicht löschen.");
  const plan = deletionPlan(userId);
  removeAccount(userId, plan.removed, {});
  audit(admin.id, "admin.deleteUser", userId, plan.name);
  return plan;
}

function lastAdmin(userId: string) {
  return (
    !!one("SELECT 1 FROM local_accounts WHERE user_id=? AND is_admin=1", userId) &&
    !one("SELECT 1 FROM local_accounts a JOIN users u ON u.id=a.user_id WHERE a.is_admin=1 AND a.user_id<>? AND u.disabled=0", userId)
  );
}

// What deleting one's own account would do. Unlike an admin deletion, a
// workspace is only removed when nobody else is a member at all; one shared
// with deactivated accounts only has no successor and stops the deletion.
type OwnPlan = Omit<Plan, "handedOver"> & {
  handedOver: (Plan["handedOver"][number] & { toId: string; candidates: { id: string; name: string }[] })[];
  blocked: { id: string; name: string }[];
  // Typing the e-mail address (or the name without one); accounts with a
  // password confirm with the password instead.
  confirm: { kind: "password" | "text"; text: string };
  refusal?: string;
};
export function ownDeletionPlan(user: Identity): OwnPlan {
  const plan = deletionPlan(user.id);
  const blocked: OwnPlan["blocked"] = [];
  const removed = plan.removed.filter((w) => {
    if (!one("SELECT 1 FROM members WHERE workspace_id=? AND user_id<>?", w.id, user.id)) return true;
    blocked.push(w);
    return false;
  });
  const handedOver = plan.handedOver.map((w) => {
    const candidates = all<{ id: string; name: string }>(
      "SELECT u.id,u.name FROM members m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? AND m.user_id<>? AND u.disabled=0 ORDER BY CASE m.role WHEN 'editor' THEN 0 ELSE 1 END, u.created_at",
      w.id,
      user.id,
    );
    return { ...w, toId: candidates[0].id, to: candidates[0].name, candidates };
  });
  const row = one<{ email: string; demo_until: number | null }>("SELECT email,demo_until FROM users WHERE id=?", user.id);
  const local = confirmsWithPassword(user.id);
  const refusal =
    user.demo || row?.demo_until
      ? "Demo-Konten lassen sich nicht löschen – sie enden mit dem Abmelden von selbst."
      : lastAdmin(user.id)
        ? "Du bist das letzte Admin-Konto. Ernenne zuerst eine andere Person zum Admin."
        : blocked.length
          ? `„${blocked[0].name}“ hat außer dir nur deaktivierte Mitglieder und niemanden, der den Arbeitsbereich übernimmt. Bitte wende dich an die Admins.`
          : undefined;
  return {
    ...plan,
    removed,
    handedOver,
    blocked,
    confirm: { kind: local ? "password" : "text", text: local ? "" : row?.email || plan.name },
    ...(refusal ? { refusal } : {}),
  };
}

export const confirmsWithPassword = (userId: string) =>
  localLoginEnabled() && !!one("SELECT 1 FROM local_accounts WHERE user_id=?", userId);

// The person deletes their own account (command "account.delete"). The
// confirmation is the account's e-mail address (or name without one); the
// sign-in route checks the password first and passes the address on.
// passwordChecked: set only by the sign-in route after checking the
// password; accounts with a password cannot be deleted through a command.
export function deleteOwnAccount(user: Identity, input: unknown, passwordChecked = false) {
  if (user.apiScope) throw new HttpError(403, "Mit einem API-Token nicht erlaubt.");
  if (!passwordChecked && !user.demo && confirmsWithPassword(user.id))
    throw new HttpError(403, "Bitte bestätige mit deinem Passwort.");
  const { confirm, successors = {} } = z
    .object({ confirm: z.string().max(300), successors: z.record(z.string(), z.string()).optional() })
    .parse(input);
  const plan = ownDeletionPlan(user);
  if (plan.refusal) throw new HttpError(409, plan.refusal);
  const expected = one<{ email: string }>("SELECT email FROM users WHERE id=?", user.id)?.email || plan.name;
  if (confirm.trim().toLowerCase() !== expected.trim().toLowerCase())
    throw new HttpError(400, "Die Bestätigung stimmt nicht mit deinem Konto überein.");
  const chosen: Record<string, string> = {};
  for (const w of plan.handedOver) {
    const pick = successors[w.id] ?? w.toId;
    if (!w.candidates.some((c) => c.id === pick)) throw new HttpError(400, `Für „${w.name}“ bitte ein Mitglied als neuen Eigentümer wählen.`);
    chosen[w.id] = pick;
  }
  removeAccount(user.id, plan.removed, chosen);
  audit(user.id, "account.delete", user.id, plan.name);
  return { ok: true, removed: plan.removed, handedOver: plan.handedOver.map((w) => ({ id: w.id, name: w.name, to: w.candidates.find((c) => c.id === chosen[w.id])!.name })) };
}

// Removes the account; successors name the new owner per workspace, the
// others get the longest-standing editor (or member).
function removeAccount(userId: string, removed: { id: string }[], successors: Record<string, string>) {
  for (const w of removed) purgeWorkspace(w.id);
  for (const w of all<{ id: string }>("SELECT workspace_id id FROM members WHERE user_id=? AND role='owner'", userId)) {
    if (one("SELECT 1 FROM members m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? AND m.user_id<>? AND m.role='owner' AND u.disabled=0", w.id, userId)) continue;
    const next =
      successors[w.id] ||
      one<{ user_id: string }>(
        "SELECT m.user_id FROM members m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? AND m.user_id<>? AND u.disabled=0 ORDER BY CASE m.role WHEN 'editor' THEN 0 ELSE 1 END, u.created_at LIMIT 1",
        w.id,
        userId,
      )?.user_id;
    if (next) run("UPDATE members SET role='owner' WHERE workspace_id=? AND user_id=?", w.id, next);
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
}
