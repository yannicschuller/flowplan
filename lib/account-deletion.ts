// Deleting an account: by an admin once it was deactivated, or by the
// person themself (Settings → General → Your profile).
// tests/account-deletion.test.ts checks that no personal row is left.
// Workspaces only this person belonged to are removed, shared workspaces get
// another owner if needed, private spaces go with the person. What they
// contributed to shared workspaces stays, under "Deleted account"; personal
// data – name, e-mail, password, passkeys, sessions, settings – is removed.
import { z } from "zod";
import { all, audit, lockFor, one, run, inSavepoint, lockMembership } from "./db";
import { HttpError } from "./auth";
import { ADMINS_LOCK, localLoginEnabled } from "./local-auth";
import { ssoOnlyAccount } from "./identities";
import { keepSpaceTemplates, purgePages, purgeWorkspace } from "./workspace-lifecycle";
import type { Identity, Page } from "./types";
import { mapAsync } from "./each-async";
import { stopRunning } from "./time-tracking";

type Plan = {
  name: string;
  removed: { id: string; name: string }[];
  handedOver: { id: string; name: string; to: string }[];
  // Shared only with deactivated accounts: those may be enabled again, so
  // the workspace stays (ownership passes to one of them when needed).
  kept: { id: string; name: string; disabled: number }[];
  privateSpaces: number;
};

// Personal data of the account, removed in any case.
const PERSONAL = [
  "sessions",
  // Whiteboard private mode and planning poker (lib/whiteboard-facilitation.ts).
  "whiteboard_private_parts",
  "whiteboard_private_clients",
  "whiteboard_estimate_votes",
  // AI settings with a sealed key, rules on what the AI may read.
  "ai_user_settings",
  "ai_user_policy",
  "ai_access_rules",
  // AI properties waiting to be computed on this person's behalf.
  "ai_cell_jobs",
  "api_tokens",
  "auth_tokens",
  "auth_challenges",
  "caldav_accesses",
  "carddav_accesses",
  "calendar_feeds",
  "favorites",
  "row_favorites",
  "journal_unlocks",
  "passkeys",
  // Two-factor: the sealed app secret and the recovery codes.
  "user_totp",
  "recovery_codes",
  // Git export of spaces they own, with the sealed access token; the
  // working copies go after the command (lib/space-git-export.ts).
  "space_git_exports",
  "local_accounts",
  "mobile_devices",
  "sso_sources",
  "push_subscriptions",
  // Chat apps with their sealed tokens, choices and Telegram link codes
  // (lib/messengers.ts); their queue goes with the connections.
  "messenger_targets",
  "messenger_settings",
  "telegram_links",
  "notifications",
  "notification_prefs",
  "user_shortcuts",
  // Own start page layouts (lib/home-layout.ts).
  "home_layouts",
  "page_follows",
  "page_visits",
  "page_view_prefs",
  // The own task page per workspace (#208); the page itself stays a page.
  "personal_task_pages",
  "presence",
  "editor_presence",
  "record_views",
  "task_reminders",
  "date_reminders",
  "user_avatars",
  "saved_searches",
  // Own order of the collections in the sidebar (#86).
  "collection_order",
  "group_members",
  "comment_reactions",
  // Directory links: SCIM provisioning and LDAP sign-in.
  "scim_users",
  "scim_group_members",
  "ldap_accounts",
  // SSO identities (#101): a shell left behind never signs in again.
  "user_identities",
  "oidc_pending_links",
  // What a real deletion removes by cascade has to go from a shell too:
  // calendar sync (sealed tokens; the worker would keep syncing), guest
  // access, encryption keys, devices and in-flight sign-ins, the person's
  // own settings, drafts and sticker library.
  "calendar_sync_mappings",
  "calendar_connections",
  "calendar_oauth_flows",
  "caldav_profile_links",
  "carddav_profile_links",
  "workspace_guests",
  "e2ee_space_keys",
  "e2ee_identities",
  "app_devices",
  "idempotency_keys",
  "push_tests",
  "background_jobs",
  "widget_counter_days",
  "widget_focus",
  "weekly_digests",
  "sidebar_state",
  "form_drafts",
  "capture_targets",
  "instance_banner_seen",
  "notebook_stickers",
  "inline_reactions",
  // No foreign key, so not even a real deletion removed these: access to
  // single records and the cursor on a whiteboard.
  "row_grants",
  "whiteboard_presence",
];

// Disabling an account (Administration → Users, SCIM "active": false, the
// LDAP sync): it loses every session at once; API tokens stop working
// because they check the flag. Enabling only clears the flag.
export async function setUserDisabled(userId: string, disabled: boolean) {
  await run("UPDATE users SET disabled=? WHERE id=?", disabled ? 1 : 0, userId);
  if (disabled) await run("DELETE FROM sessions WHERE user_id=?", userId);
  // Enabled again by an admin: the account is wanted, a pending deletion
  // ends and the days without use count from now (lib/inactive-accounts.ts).
  else await run("UPDATE users SET last_active_at=?,deletion_notice_at=NULL,deletion_reminder_at=NULL,deletion_due_at=NULL WHERE id=?", Date.now(), userId);
}

export async function deletionPlan(userId: string): Promise<Plan> {
  const user = await one<{ name: string }>("SELECT name FROM users WHERE id=?", userId);
  if (!user) throw new HttpError(404, "Benutzer nicht gefunden.");
  const removed: Plan["removed"] = [],
    handedOver: Plan["handedOver"] = [],
    kept: Plan["kept"] = [];
  for (const w of await all<{ id: string; name: string; role: string }>(
    "SELECT w.id,w.name,m.role FROM workspaces w JOIN members m ON m.workspace_id=w.id WHERE m.user_id=?",
    userId,
  )) {
    // Active members first, so the longest-standing active owner/editor
    // takes over; deactivated ones only count as members who come back.
    const others = await all<{ user_id: string; role: string; name: string; disabled: number }>(
      "SELECT m.user_id,m.role,u.name,u.disabled FROM members m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? AND m.user_id<>? ORDER BY u.disabled, CASE m.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, u.created_at",
      w.id,
      userId,
    );
    const active = others.filter((o) => !o.disabled);
    if (!others.length) removed.push({ id: w.id, name: w.name });
    else if (!active.length) kept.push({ id: w.id, name: w.name, disabled: others.length });
    else if (w.role === "owner" && !active.some((o) => o.role === "owner")) handedOver.push({ id: w.id, name: w.name, to: active[0].name });
  }
  const privateSpaces = Number((await one<{ n: number }>("SELECT count(*) n FROM spaces WHERE owner_id=? AND visibility='private'", userId))?.n || 0);
  return { name: user.name, removed, handedOver, kept, privateSpaces };
}

// Inside the command's transaction.
export async function deleteAccount(admin: Identity, userId: string) {
  if (userId === admin.id) throw new HttpError(400, "Das eigene Konto lässt sich hier nicht löschen.");
  const target = await one<{ disabled: number; demo_until: number | null }>("SELECT disabled,demo_until FROM users WHERE id=?", userId);
  if (!target) throw new HttpError(404, "Benutzer nicht gefunden.");
  if (!target.disabled) throw new HttpError(409, "Bitte das Konto zuerst deaktivieren.");
  if (await lastAdmin(userId)) throw new HttpError(409, "Das letzte Admin-Konto lässt sich nicht löschen.");
  const plan = await deletionPlan(userId);
  await removeAccount(userId, plan.removed, {});
  await audit(admin.id, "admin.deleteUser", userId, plan.name);
  return plan;
}

// Deleted for inactivity (lib/inactive-accounts.ts): like an admin deletion,
// without an admin. Returns what happened, for the activity log.
export async function deleteInactiveAccount(userId: string) {
  const plan = await deletionPlan(userId);
  await removeAccount(userId, plan.removed, {});
  return plan;
}

// The last enabled administrator with e-mail and password.
export async function lastAdmin(userId: string) {
  // Checked before a deletion writes: one at a time (lib/local-auth.ts).
  await lockFor(ADMINS_LOCK);
  return (
    !!(await one("SELECT 1 FROM local_accounts WHERE user_id=? AND is_admin=1", userId)) &&
    !(await one("SELECT 1 FROM local_accounts a JOIN users u ON u.id=a.user_id WHERE a.is_admin=1 AND a.user_id<>? AND u.disabled=0", userId))
  );
}

// What deleting one's own account would do. A workspace is only removed
// when nobody else is a member at all; one shared with deactivated accounts
// only has no successor and stops the deletion (an admin deletion keeps it
// for them instead).
type OwnPlan = Omit<Plan, "handedOver"> & {
  handedOver: (Plan["handedOver"][number] & { toId: string; candidates: { id: string; name: string }[] })[];
  blocked: { id: string; name: string }[];
  // Typing the e-mail address (or the name without one); accounts with a
  // password confirm with the password instead.
  confirm: { kind: "password" | "text"; text: string };
  refusal?: string;
};
export async function ownDeletionPlan(user: Identity): Promise<OwnPlan> {
  const plan = await deletionPlan(user.id);
  const blocked: OwnPlan["blocked"] = plan.kept.map((w) => ({ id: w.id, name: w.name }));
  const handedOver = await mapAsync(plan.handedOver, async (w) => {
    const candidates = await all<{ id: string; name: string }>(
      "SELECT u.id,u.name FROM members m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? AND m.user_id<>? AND u.disabled=0 ORDER BY CASE m.role WHEN 'editor' THEN 0 ELSE 1 END, u.created_at",
      w.id,
      user.id,
    );
    return { ...w, toId: candidates[0].id, to: candidates[0].name, candidates };
  });
  const row = await one<{ email: string; demo_until: number | null }>("SELECT email,demo_until FROM users WHERE id=?", user.id);
  const local = await confirmsWithPassword(user.id);
  const refusal =
    user.demo || row?.demo_until
      ? "Demo-Konten lassen sich nicht löschen – sie enden mit dem Abmelden von selbst."
      : (await lastAdmin(user.id))
        ? "Du bist das letzte Admin-Konto. Ernenne zuerst eine andere Person zum Admin."
        : blocked.length
          ? `„${blocked[0].name}“ hat außer dir nur deaktivierte Mitglieder und niemanden, der den Arbeitsbereich übernimmt. Bitte wende dich an die Admins.`
          : undefined;
  return {
    ...plan,
    handedOver,
    blocked,
    confirm: { kind: local ? "password" : "text", text: local ? "" : row?.email || plan.name },
    ...(refusal ? { refusal } : {}),
  };
}

// Only an account that still has a password (#101: it can be removed once
// SSO is connected) and may use it (OIDC_LINKED_SSO_ONLY).
export const confirmsWithPassword = async (userId: string) =>
  localLoginEnabled() && !!(await one("SELECT 1 FROM local_accounts WHERE user_id=? AND password_hash<>''", userId)) && !(await ssoOnlyAccount(userId));

// The person deletes their own account (command "account.delete"). The
// confirmation is the account's e-mail address (or name without one); the
// sign-in route checks the password first and passes the address on.
// passwordChecked: set only by the sign-in route after checking the
// password; accounts with a password cannot be deleted through a command.
export async function deleteOwnAccount(user: Identity, input: unknown, passwordChecked = false) {
  if (user.apiScope) throw new HttpError(403, "Mit einem API-Token nicht erlaubt.");
  if (!passwordChecked && !user.demo && await confirmsWithPassword(user.id))
    throw new HttpError(403, "Bitte bestätige mit deinem Passwort.");
  const { confirm, successors = {} } = z
    .object({ confirm: z.string().max(300), successors: z.record(z.string(), z.string()).optional() })
    .parse(input);
  const plan = await ownDeletionPlan(user);
  if (plan.refusal) throw new HttpError(409, plan.refusal);
  const expected = (await one<{ email: string }>("SELECT email FROM users WHERE id=?", user.id))?.email || plan.name;
  if (confirm.trim().toLowerCase() !== expected.trim().toLowerCase())
    throw new HttpError(400, "Die Bestätigung stimmt nicht mit deinem Konto überein.");
  const chosen: Record<string, string> = {};
  for (const w of plan.handedOver) {
    const pick = successors[w.id] ?? w.toId;
    if (!w.candidates.some((c) => c.id === pick)) throw new HttpError(400, `Für „${w.name}“ bitte ein Mitglied als neuen Eigentümer wählen.`);
    chosen[w.id] = pick;
  }
  await removeAccount(user.id, plan.removed, chosen);
  await audit(user.id, "account.delete", user.id, plan.name);
  return { ok: true, removed: plan.removed, handedOver: plan.handedOver.map((w) => ({ id: w.id, name: w.name, to: w.candidates.find((c) => c.id === chosen[w.id])!.name })) };
}

// Removes the account; successors name the new owner per workspace, the
// others get the longest-standing active editor (or member) – a workspace
// kept for deactivated accounts only passes to one of them.
async function removeAccount(userId: string, removed: { id: string }[], successors: Record<string, string>) {
  for (const w of removed) await purgeWorkspace(w.id);
  for (const w of await all<{ id: string }>("SELECT workspace_id id FROM members WHERE user_id=? AND role='owner' ORDER BY workspace_id", userId)) {
    // Not counted while another owner leaves or is demoted at the same time.
    await lockMembership(w.id);
    if (await one("SELECT 1 FROM members m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? AND m.user_id<>? AND m.role='owner' AND u.disabled=0", w.id, userId)) continue;
    const next =
      successors[w.id] ||
      (await one<{ user_id: string }>(
        "SELECT m.user_id FROM members m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? AND m.user_id<>? ORDER BY u.disabled, CASE m.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, u.created_at LIMIT 1",
        w.id,
        userId,
      ))?.user_id;
    if (next) await run("UPDATE members SET role='owner' WHERE workspace_id=? AND user_id=?", w.id, next);
  }
  // Private spaces: nobody else can see them, so they go too.
  for (const space of await all<{ id: string; workspace_id: string }>("SELECT id,workspace_id FROM spaces WHERE owner_id=? AND visibility='private'", userId)) {
    await purgePages(space.workspace_id, await all<Page>("SELECT * FROM pages WHERE space_id=?", space.id));
    await run("DELETE FROM grants WHERE resource_id=?", space.id);
    await keepSpaceTemplates(space.id);
    await run("DELETE FROM spaces WHERE id=?", space.id);
  }
  for (const table of PERSONAL)
    try {
      await inSavepoint(async () => await run(`DELETE FROM ${table} WHERE user_id=?`, userId));
    } catch {}
  // Own collections (#86), shared ones too: they are queries of this person.
  await run("DELETE FROM collections WHERE owner_id=?", userId);
  await run("DELETE FROM grants WHERE user_id=?", userId);
  await run("DELETE FROM members WHERE user_id=?", userId);
  await run("UPDATE spaces SET owner_id=NULL WHERE owner_id=?", userId);
  // Who made records done (schema 96): nobody any more.
  await run("UPDATE row_status_log SET user_id=NULL WHERE user_id=?", userId);
  // Share links keep working for those who have them; who created one is
  // no reason to keep the account as a shell.
  await run("UPDATE share_links SET created_by=NULL WHERE created_by=?", userId);
  // Tracked time stays with the records (reports, billing); a timer still
  // running stops now (after the devices went: no push to them).
  await stopRunning(userId);
  try {
    await inSavepoint(async () => await run("DELETE FROM oidc_flows WHERE link_user_id=?", userId));
  } catch {}
  try {
    await inSavepoint(async () => await run("DELETE FROM users WHERE id=?", userId));
  } catch {
    // Still named as author somewhere: the account stays as an empty shell.
    await run(
      "UPDATE users SET name='Gelöschtes Konto',email='',subject=?,disabled=1,locale=NULL,language=NULL,limits=NULL WHERE id=?",
      `deleted:${userId}`,
      userId,
    );
  }
}
