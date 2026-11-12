// Merging two accounts of the same person (#101, Administration → Users →
// "Merge accounts"): everything of the source account moves to the target,
// the source's sign-in identities too, and the source account is deleted.
// One transaction (the command's), an entry in the activity log and a
// security event.
//
// Every column that refers to an account is listed in USER_REFERENCES with
// what happens to it; tests/account-merge.test.ts reads the live schema and
// fails for a table that refers to users and is missing here.
//
// - move: the rows now belong to the target. Where the target already has
//   the same row (favourites, sidebar state, preferences …), the target's
//   one stays and the source's is dropped.
// - role: memberships and shares – the higher role of the two stays;
//   guest only if the person was a guest on every side.
// - drop: belongs to the source's sign-ins and goes with it: sessions
//   (signed out everywhere), API tokens (revoked – scripts get a new token
//   from the target account, so no token silently changes whose data it
//   reads), links and challenges in flight, device registrations.
// - custom: one row per account (password, LDAP, SCIM, authenticator app,
//   encryption keys, AI key): the source's moves only when the target has
//   none, re-sealed for the target where it is sealed to the account.
// - none: not an account (a Git author's name).
// User ids inside content – person properties of records, mentions in
// comments and documents, filters of views – are replaced as well.
import { all, audit, foreignKeyColumns, one, run, tableColumns, tableNames, updateIgnoringConflicts, inSavepoint, sql } from "./db";
import { HttpError } from "./auth";
import { securityEvent } from "./security-events";
import { openSecret, sealSecret } from "./secret-box";
import { userAiKeyAad } from "./ai/settings";
import { rewriteDocument, rewriteReferences } from "./document-rewrite";
import type { Identity } from "./types";
import { mapAsync } from "./each-async";

export type MergeStrategy = "move" | "role" | "drop" | "custom" | "none";

export const USER_REFERENCES: Record<string, MergeStrategy> = {
  // Memberships and shares: the higher role stays.
  "members.user_id": "role",
  "workspace_guests.user_id": "role",
  "grants.user_id": "role",
  "row_grants.user_id": "role",
  // One per account.
  "local_accounts.user_id": "custom",
  "ldap_accounts.user_id": "custom",
  "scim_users.user_id": "custom",
  "user_totp.user_id": "custom",
  "recovery_codes.user_id": "custom",
  "e2ee_identities.user_id": "custom",
  "e2ee_space_keys.user_id": "custom",
  "ai_user_settings.user_id": "custom",
  // Sign-ins of the source: gone with it.
  "sessions.user_id": "drop",
  "api_tokens.user_id": "drop",
  "auth_tokens.user_id": "drop",
  "auth_challenges.user_id": "drop",
  "idempotency_keys.user_id": "drop",
  "mobile_devices.user_id": "drop",
  // Device keys of the apps (lib/app-devices.ts): registered again at the next sign-in.
  "app_devices.user_id": "drop",
  // Progress of the source's background jobs, its widget history and focus timer.
  "background_jobs.user_id": "drop",
  "widget_counter_days.user_id": "drop",
  "widget_focus.user_id": "drop",
  "push_subscriptions.user_id": "drop",
  "push_tests.user_id": "drop",
  "presence.user_id": "drop",
  "whiteboard_presence.user_id": "drop",
  "calendar_oauth_flows.user_id": "drop",
  "telegram_links.user_id": "drop",
  "carddav_profile_links.user_id": "drop",
  "oidc_flows.link_user_id": "drop",
  "oidc_pending_links.user_id": "drop",
  // Not an account.
  "git_links.author": "none",
  // Everything else moves.
  "user_identities.user_id": "move",
  "passkeys.user_id": "move",
  "pages.owner_id": "move",
  "pages.created_by": "move",
  "spaces.owner_id": "move",
  "workspaces.created_by": "move",
  "group_members.user_id": "move",
  "scim_group_members.user_id": "move",
  "sso_sources.user_id": "move",
  "comments.author_id": "move",
  "comment_reactions.user_id": "move",
  "inline_threads.author_id": "move",
  "inline_messages.author_id": "move",
  "inline_reactions.user_id": "move",
  "ticket_messages.author_id": "move",
  "doc_tasks.assignee": "move",
  "doc_tasks.updated_by": "move",
  // The own task page per workspace (#208): the target's stays when it has one.
  "personal_task_pages.user_id": "move",
  "task_done_log.user_id": "move",
  "rows.created_by": "move",
  "rows.updated_by": "move",
  "row_snapshots.created_by": "move",
  "row_templates.created_by": "move",
  "row_trash.deleted_by": "move",
  "row_status_log.user_id": "move",
  "row_favorites.user_id": "move",
  "favorites.user_id": "move",
  "collections.owner_id": "move",
  "collection_order.user_id": "move",
  "saved_searches.user_id": "move",
  "sidebar_state.user_id": "move",
  "home_layouts.user_id": "move",
  "home_defaults.updated_by": "move",
  "journal_unlocks.user_id": "move",
  "notifications.user_id": "move",
  "notification_prefs.user_id": "move",
  "weekly_digests.user_id": "move",
  "messenger_settings.user_id": "move",
  "messenger_targets.user_id": "move",
  "page_follows.user_id": "move",
  "page_visits.user_id": "move",
  "page_edits.user_id": "move",
  "page_view_prefs.user_id": "move",
  "page_ink.updated_by": "move",
  "page_ink_versions.created_by": "move",
  "notebook_recordings.created_by": "move",
  "meetings.created_by": "move",
  "meetings.consent_by": "move",
  "meeting_reminders.user_id": "move",
  "notebook_sheet_trash.deleted_by": "move",
  "notebook_stickers.user_id": "move",
  "notebook_templates.created_by": "move",
  // Faces uploaded for a workspace's look (lib/workspace-fonts.ts).
  "workspace_fonts.created_by": "move",
  "page_tags.created_by": "move",
  "page_property_defs.created_by": "move",
  "document_authors.user_id": "move",
  "snapshots.created_by": "move",
  "files.created_by": "move",
  "files.deleted_by": "move",
  "file_ink.updated_by": "move",
  "file_ink_versions.created_by": "move",
  "templates.created_by": "move",
  "whiteboard_templates.created_by": "move",
  "whiteboard_private.started_by": "move",
  "whiteboard_private_parts.user_id": "move",
  "whiteboard_private_clients.user_id": "move",
  "whiteboard_estimate_votes.user_id": "move",
  "rack_device_templates.created_by": "move",
  "meeting_notes.created_by": "move",
  "bibliography.created_by": "move",
  "record_views.user_id": "move",
  "form_drafts.user_id": "move",
  "task_reminders.user_id": "move",
  "date_reminders.user_id": "move",
  "time_entries.user_id": "move",
  "time_entries.billed_by": "move",
  "user_avatars.user_id": "move",
  "user_shortcuts.user_id": "move",
  "capture_targets.user_id": "move",
  "instance_banner_seen.user_id": "move",
  "instance_banners.created_by": "move",
  "invites.created_by": "move",
  "share_links.created_by": "move",
  "record_shares.created_by": "move",
  "publications.published_by": "move",
  "webhooks.created_by": "move",
  "calendar_connections.user_id": "move",
  "calendar_sync_mappings.user_id": "move",
  "calendar_feeds.user_id": "move",
  "caldav_accesses.user_id": "move",
  "caldav_profile_links.user_id": "move",
  "carddav_accesses.user_id": "move",
  "contact_ldap_sources.created_by": "move",
  "space_git_exports.user_id": "move",
  "issue_connections.created_by": "move",
  "issue_sync_maps.created_by": "move",
  "inbound_addresses.created_by": "move",
  "custom_domains.created_by": "move",
  "plugins.created_by": "move",
  "e2ee_snapshots.created_by": "move",
  "e2ee_updates.created_by": "move",
  "e2ee_space_keys.sealed_by": "move",
  "ai_access_rules.user_id": "move",
  "ai_user_policy.user_id": "move",
  "ai_cell_jobs.user_id": "move",
  "ai_cell_meta.computed_by": "move",
  "ai_blocks.created_by": "move",
  "scim_tokens.created_by": "move",
  "security_blocks.created_by": "move",
  "audit.actor_id": "move",
  "security_events.actor_id": "move",
  "security_incidents.actor_id": "move",
  "security_incidents.resolved_by": "move",
  // Workflows (#168): who runs, paused, edited, activated, decided.
  "workflows.runner_id": "move",
  "workflows.paused_by": "move",
  "workflow_drafts.updated_by": "move",
  "workflow_versions.activated_by": "move",
  "workflow_events.actor_id": "move",
  "workflow_approvals.decided_by": "move",
  "workflow_credentials.created_by": "move",
  // The instance that claimed a step, not a person.
  "workflow_steps.claimed_by": "none",
};

// Text columns that may hold account ids inside JSON or text (person
// properties, mentions, view filters, layouts).
const CONTENT_COLUMNS = [
  "rows.cells",
  "row_templates.cells",
  "form_drafts.cells",
  "comments.body",
  "inline_messages.body",
  "inline_messages.rich_body",
  "databases.fields",
  "databases.views",
  "databases.settings",
  "record_views.config",
  "home_layouts.layout",
  "home_defaults.layout",
  "page_property_values.value",
];

// Columns of the live schema that refer to accounts: a foreign key to
// users, or a name that means an account (…user_id, …_by, owner, author,
// actor, assignee).
const USER_COLUMN = /(^|_)user_id$|_by$|^(owner_id|author_id|author|actor_id|assignee)$/;
export async function userReferenceColumns() {
  const out: { table: string; column: string }[] = [];
  for (const name of await tableNames()) {
    if (name === "users" || name === "search_index" || /_fts(_|$)/.test(name)) continue;
    const fks = new Set(await foreignKeyColumns(name, "users"));
    for (const column of await tableColumns(name)) if (fks.has(column) || USER_COLUMN.test(column)) out.push({ table: name, column });
  }
  return out;
}
const columnsOf = async (table: string) => new Set(await tableColumns(table));
const split = (key: string) => key.split(".") as [string, string];
const count = async (sql: string, ...params: string[]) => Number((await one<{ n: number }>(sql, ...params))?.n || 0);
const like = (id: string) => `%${id}%`;

type Person = { id: string; name: string; email: string; disabled: number; demo_until: number | null; subject: string };
async function person(id: string) {
  const row = await one<Person>("SELECT id,name,email,disabled,demo_until,subject FROM users WHERE id=?", id);
  if (!row || row.subject.startsWith("deleted:")) throw new HttpError(404, "Benutzer nicht gefunden.");
  if (row.demo_until) throw new HttpError(400, "Demo-Konten lassen sich nicht zusammenführen.");
  return row;
}
async function check(admin: Identity, sourceId: string, targetId: string) {
  if (sourceId === targetId) throw new HttpError(400, "Bitte zwei verschiedene Konten wählen.");
  if (sourceId === admin.id) throw new HttpError(400, "Das eigene Konto kann nur das Zielkonto sein.");
  return { source: await person(sourceId), target: await person(targetId) };
}

// What a merge would do, without changing anything (the preview of the
// administration, and the dry run of the tests).
export async function mergePreview(admin: Identity, sourceId: string, targetId: string) {
  const { source, target } = await check(admin, sourceId, targetId);
  const tables: { table: string; column: string; strategy: MergeStrategy; rows: number }[] = [];
  for (const [key, strategy] of Object.entries(USER_REFERENCES)) {
    if (strategy === "none") continue;
    const [table, column] = split(key);
    if (!(await columnsOf(table)).has(column)) continue;
    const rows = await count(`SELECT COUNT(*) n FROM "${table}" WHERE "${column}"=?`, sourceId);
    if (rows) tables.push({ table, column, strategy, rows });
  }
  const content = (await mapAsync(CONTENT_COLUMNS, async (key) => {
    const [table, column] = split(key);
    return { table, column, rows: (await columnsOf(table)).has(column) ? (await count(`SELECT COUNT(*) n FROM "${table}" WHERE "${column}" LIKE ?`, like(sourceId))) : 0 };
  })).filter((c) => c.rows);
  const documents =
    (await count("SELECT COUNT(*) n FROM documents WHERE html LIKE ?", like(sourceId))) + (await count("SELECT COUNT(*) n FROM row_documents WHERE html LIKE ?", like(sourceId)));
  const n = async (sql: string, id = sourceId) => await count(sql, id);
  // What the person will notice.
  const notes: string[] = [];
  const both = async (table: string) => (await n(`SELECT COUNT(*) n FROM ${table} WHERE user_id=?`)) > 0 && (await n(`SELECT COUNT(*) n FROM ${table} WHERE user_id=?`, targetId)) > 0;
  if (await both("local_accounts")) notes.push("password");
  if (await n("SELECT COUNT(*) n FROM user_totp WHERE user_id=? AND enabled=1")) notes.push((await n("SELECT COUNT(*) n FROM user_totp WHERE user_id=? AND enabled=1", targetId)) ? "totp-dropped" : "totp-moved");
  if (await both("e2ee_identities")) notes.push("e2ee");
  if (await n("SELECT COUNT(*) n FROM api_tokens WHERE user_id=?")) notes.push("tokens");
  return {
    source: { id: source.id, name: source.name, email: source.email },
    target: { id: target.id, name: target.name, email: target.email },
    summary: {
      ownedPages: await count("SELECT COUNT(*) n FROM pages WHERE owner_id=? OR created_by=?", sourceId, sourceId),
      ownedSpaces: await n("SELECT COUNT(*) n FROM spaces WHERE owner_id=?"),
      workspaces: await n("SELECT COUNT(*) n FROM members WHERE user_id=?"),
      groups: await n("SELECT COUNT(*) n FROM group_members WHERE user_id=?"),
      comments: (await n("SELECT COUNT(*) n FROM comments WHERE author_id=?")) + (await n("SELECT COUNT(*) n FROM inline_messages WHERE author_id=?")),
      favorites: (await n("SELECT COUNT(*) n FROM favorites WHERE user_id=?")) + (await n("SELECT COUNT(*) n FROM row_favorites WHERE user_id=?")),
      notifications: await n("SELECT COUNT(*) n FROM notifications WHERE user_id=?"),
      identities: await n("SELECT COUNT(*) n FROM user_identities WHERE user_id=?"),
      passkeys: await n("SELECT COUNT(*) n FROM passkeys WHERE user_id=?"),
      sessions: await n("SELECT COUNT(*) n FROM sessions WHERE user_id=?"),
      apiTokens: await n("SELECT COUNT(*) n FROM api_tokens WHERE user_id=?"),
      records: content.find((c) => c.table === "rows")?.rows || 0,
      documents,
    },
    tables,
    content,
    notes,
  };
}
export type MergePreview = Awaited<ReturnType<typeof mergePreview>>;

const RANK: Record<string, number> = { viewer: 1, commenter: 1.5, editor: 2, owner: 3 };
const higher = (a: string, b: string) => ((RANK[a] || 0) >= (RANK[b] || 0) ? a : b);

// Moves the rows of one column; rows the target already has stay its own.
async function move(table: string, column: string, from: string, to: string) {
  await updateIgnoringConflicts(table, `"${column}"=?`, `"${column}"=?`, [to], [from]);
  await run(`DELETE FROM "${table}" WHERE "${column}"=?`, from);
}

async function mergeMemberships(from: string, to: string) {
  const guestOf = async (user: string) => new Set((await all<{ workspace_id: string }>("SELECT workspace_id FROM workspace_guests WHERE user_id=?", user)).map((g) => g.workspace_id));
  const memberOf = async (user: string) => new Map((await all<{ workspace_id: string; role: string }>("SELECT workspace_id,role FROM members WHERE user_id=?", user)).map((m) => [m.workspace_id, m.role]));
  const [fromGuest, toGuest, fromMember, toMember] = [await guestOf(from), await guestOf(to), await memberOf(from), await memberOf(to)];
  for (const [ws, role] of fromMember) {
    const mine = toMember.get(ws);
    if (mine) await run("UPDATE members SET role=? WHERE workspace_id=? AND user_id=?", higher(role, mine), ws, to);
    else await run("INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,?)", ws, to, role);
  }
  await run("DELETE FROM members WHERE user_id=?", from);
  // A guest only where the person was a guest on every side they were in.
  for (const ws of new Set([...fromMember.keys(), ...fromGuest])) {
    const guest = (!fromMember.has(ws) || fromGuest.has(ws)) && (!toMember.has(ws) || toGuest.has(ws));
    await run("DELETE FROM workspace_guests WHERE workspace_id=? AND user_id IN (?,?)", ws, from, to);
    if (guest) await run("INSERT INTO workspace_guests(workspace_id,user_id) VALUES(?,?) ON CONFLICT DO NOTHING", ws, to);
  }
  await run("DELETE FROM workspace_guests WHERE user_id=?", from);
  for (const table of ["grants", "row_grants"]) {
    const key = table === "grants" ? "resource_id" : "row_id";
    for (const g of await all<{ res: string; group_id: string; role: string }>(`SELECT ${key} res,group_id,role FROM ${table} WHERE user_id=?`, from)) {
      const mine = await one<{ role: string }>(`SELECT role FROM ${table} WHERE ${key}=? AND user_id=? AND group_id=?`, g.res, to, g.group_id);
      if (mine) await run(`UPDATE ${table} SET role=? WHERE ${key}=? AND user_id=? AND group_id=?`, higher(g.role, mine.role), g.res, to, g.group_id);
      else await run(`UPDATE ${table} SET user_id=? WHERE ${key}=? AND user_id=? AND group_id=?`, to, g.res, from, g.group_id);
    }
    await run(`DELETE FROM ${table} WHERE user_id=?`, from);
  }
}

// One row per account: the source's moves only into an empty place.
async function mergeSingles(from: string, to: string) {
  const has = async (table: string, user: string, extra = "") => !!(await one(`SELECT 1 FROM ${table} WHERE user_id=?${extra}`, user));
  // Password (and admin flag) of an account with e-mail and password.
  if (await has("local_accounts", from)) {
    if (!(await has("local_accounts", to))) await run("UPDATE local_accounts SET user_id=? WHERE user_id=?", to, from);
    else {
      if (await one("SELECT 1 FROM local_accounts WHERE user_id=? AND is_admin=1", from)) await run("UPDATE local_accounts SET is_admin=1 WHERE user_id=?", to);
      // The target without a password takes the source's.
      await run(
        "UPDATE local_accounts SET password_hash=(SELECT password_hash FROM local_accounts WHERE user_id=?) WHERE user_id=? AND password_hash=''",
        from,
        to,
      );
      await run("DELETE FROM local_accounts WHERE user_id=?", from);
    }
  }
  for (const table of ["ldap_accounts", "scim_users"]) {
    if (!(await has(table, to))) await run(`UPDATE ${table} SET user_id=? WHERE user_id=?`, to, from);
    await run(`DELETE FROM ${table} WHERE user_id=?`, from);
  }
  // The authenticator app is sealed to its account: re-sealed for the target
  // when it has none. Recovery codes are hashed with the account and cannot
  // move – a new set is made in the settings.
  const totp = await one<{ secret: string; enabled: number }>("SELECT secret,enabled FROM user_totp WHERE user_id=?", from);
  if (totp?.enabled && !(await has("user_totp", to))) {
    try {
      const secret = openSecret(totp.secret, `totp:${from}`);
      await inSavepoint(async () => await run("UPDATE user_totp SET user_id=?,secret=? WHERE user_id=?", to, sealSecret(secret, `totp:${to}`), from));
    } catch {}
  }
  await run("DELETE FROM user_totp WHERE user_id=?", from);
  await run("DELETE FROM recovery_codes WHERE user_id=?", from);
  // End-to-end encryption: the source's keys only when the target has none.
  if (!(await has("e2ee_identities", to))) {
    await run("UPDATE e2ee_identities SET user_id=? WHERE user_id=?", to, from);
    await move("e2ee_space_keys", "user_id", from, to);
  }
  await run("DELETE FROM e2ee_identities WHERE user_id=?", from);
  await run("DELETE FROM e2ee_space_keys WHERE user_id=?", from);
  // Own AI provider key, sealed to the account.
  const ai = await one<{ key_cipher: string | null }>("SELECT key_cipher FROM ai_user_settings WHERE user_id=?", from);
  if (ai && !(await has("ai_user_settings", to))) {
    let cipher: string | null = null;
    try {
      cipher = ai.key_cipher ? sealSecret(openSecret(ai.key_cipher, userAiKeyAad(from)), userAiKeyAad(to)) : null;
    } catch {}
    await run("UPDATE ai_user_settings SET user_id=?,key_cipher=?,key_hint=CASE WHEN ? IS NULL THEN '' ELSE key_hint END WHERE user_id=?", to, cipher, cipher, from);
  }
  await run("DELETE FROM ai_user_settings WHERE user_id=?", from);
}

// Account ids inside content: person properties, view filters, comments.
async function mergeContent(from: string, to: string) {
  for (const key of CONTENT_COLUMNS) {
    const [table, column] = split(key);
    if (!(await columnsOf(table)).has(column)) continue;
    await run(`UPDATE "${table}" SET "${column}"=REPLACE("${column}",?,?) WHERE "${column}" LIKE ?`, from, to, like(from));
  }
  // A record with both accounts in one person property names the target once.
  for (const row of await all<{ id: string; cells: string }>("SELECT id,cells FROM rows WHERE cells LIKE ?", like(to))) {
    try {
      const cells = JSON.parse(row.cells) as Record<string, unknown>;
      let changed = false;
      for (const [k, v] of Object.entries(cells))
        if (Array.isArray(v) && v.filter((x) => x === to).length > 1) {
          cells[k] = [...new Set(v)];
          changed = true;
        }
      if (changed) await run("UPDATE rows SET cells=? WHERE id=?", JSON.stringify(cells), row.id);
    } catch {}
  }
  // Mentions and assigned tasks in documents (versions keep what they had).
  const publish: (() => void)[] = [];
  const swap = (value: string) => (value === from ? to : value);
  const docs = [
    ...await all<{ page_id: string; row_id: string | null }>("SELECT page_id,NULL row_id FROM documents WHERE html LIKE ?", like(from)),
    ...await all<{ page_id: string; row_id: string | null }>("SELECT r.page_id,d.row_id FROM row_documents d JOIN rows r ON r.id=d.row_id WHERE d.html LIKE ?", like(from)),
  ];
  for (const d of docs) {
    try {
      const result = await rewriteDocument(d.page_id, d.row_id, to, (doc) => rewriteReferences(doc, swap));
      if (result) publish.push(result.publish);
    } catch {}
  }
  return publish;
}

// Inside the command's transaction. Returns what moved and what to send to
// open editors after the commit.
export async function mergeAccounts(admin: Identity, sourceId: string, targetId: string) {
  const preview = await mergePreview(admin, sourceId, targetId);
  const from = sourceId,
    to = targetId;
  await mergeMemberships(from, to);
  await mergeSingles(from, to);
  const publish = await mergeContent(from, to);
  for (const [key, strategy] of Object.entries(USER_REFERENCES)) {
    const [table, column] = split(key);
    if (!(await columnsOf(table)).has(column)) continue;
    if (strategy === "move") await move(table, column, from, to);
    else if (strategy === "drop") await run(`DELETE FROM "${table}" WHERE "${column}"=?`, from);
  }
  // The target is the one that stays: active if either was in use.
  await run(`UPDATE users SET last_login_at=${sql.greatest("COALESCE(last_login_at,0)", "COALESCE((SELECT last_login_at FROM users WHERE id=?),0)")} WHERE id=?`, from, to);
  // A reference this list does not know makes the delete fail and the whole
  // merge roll back – nothing is lost half-way.
  await run("DELETE FROM users WHERE id=?", from);
  await audit(admin.id, "admin.mergeUsers", to, `${preview.source.email || preview.source.name} → ${preview.target.email || preview.target.name}`);
  securityEvent("admin.merge", { actorId: admin.id, detail: `${from} → ${to}` });
  return { preview, publish };
}
