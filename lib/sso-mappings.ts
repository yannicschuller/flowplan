// SSO groups → workspace membership and workspace groups. Workspace owners
// (or instance administrators for any workspace) map a group name from the
// identity provider (the OIDC_GROUPS_CLAIM) to a role in the workspace
// and/or to one of its groups. At every SSO sign-in the mappings are applied:
// matching groups add the membership or group membership, and what a mapping
// granted goes again once the person no longer has the SSO group.
//
// What a mapping granted is recorded in sso_sources (target '' = workspace
// membership, otherwise the workspace group's id, plus the SSO group that
// granted it). SSO always wins: a membership or group membership a mapping
// matches is set to what the mapping says, even one added or changed by
// hand, and becomes SSO-managed from then on. Manual changes last until the
// next sign-in (or mapping change) of that person. Memberships no mapping
// matches and that never came from SSO stay untouched. The last owner of a
// workspace always stays.
//
// Directory groups count like SSO groups: groups provisioned over SCIM
// (lib/scim.ts, by their display name) and the LDAP groups of an account
// (lib/ldap-auth.ts) are added to the groups of every sign-in and of every
// re-application, so one set of mappings serves OIDC, SCIM and LDAP.
import { z } from "zod";
import { all, id, one, run, transaction, lockFor, lockMembership } from "./db";
import { HttpError } from "./auth";
import { removeFromWorkspace } from "./workspace-lifecycle";
import type { Role } from "./types";

export type SsoMapping = {
  id: string;
  workspace_id: string;
  sso_group: string;
  role: Role | null;
  group_id: string | null;
  created_at: number;
};
const rank: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };
const MAX_MAPPINGS = 100;

const isLocal = async (userId: string) => !!(await one("SELECT 1 FROM local_accounts WHERE user_id=?", userId));
const owners = async (workspaceId: string) =>
  Number((await one<{ n: number }>("SELECT COUNT(*) n FROM members WHERE workspace_id=? AND role='owner'", workspaceId))?.n || 0);

// Records exactly these SSO groups as the source of one target.
async function setSources(workspaceId: string, userId: string, target: string, groups: string[]) {
  const keep = [...new Set(groups)];
  for (const s of await all<{ sso_group: string }>(
    "SELECT sso_group FROM sso_sources WHERE workspace_id=? AND user_id=? AND target=?",
    workspaceId,
    userId,
    target,
  ))
    if (!keep.includes(s.sso_group))
      await run("DELETE FROM sso_sources WHERE workspace_id=? AND user_id=? AND target=? AND sso_group=?", workspaceId, userId, target, s.sso_group);
  for (const group of keep)
    await run("INSERT INTO sso_sources(workspace_id,user_id,target,sso_group) VALUES(?,?,?,?) ON CONFLICT DO NOTHING", workspaceId, userId, target, group);
}

async function applyWorkspace(userId: string, workspaceId: string, matched: SsoMapping[]) {
  // The last-owner checks below hold only while nobody else changes members.
  await lockMembership(workspaceId);
  // Workspace membership with the highest mapped role.
  const roleMappings = matched.filter((m): m is SsoMapping & { role: Role } => !!m.role);
  const member = await one<{ role: Role }>("SELECT role FROM members WHERE workspace_id=? AND user_id=?", workspaceId, userId);
  const managed = !!(await one("SELECT 1 FROM sso_sources WHERE workspace_id=? AND user_id=? AND target=''", workspaceId, userId));
  if (roleMappings.length) {
    let desired = roleMappings.map((m) => m.role).sort((a, b) => rank[b] - rank[a])[0];
    const guest = !!(await one("SELECT 1 FROM workspace_guests WHERE workspace_id=? AND user_id=?", workspaceId, userId));
    if (guest && desired === "owner") desired = "editor";
    if (!member) {
      await run("INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,?)", workspaceId, userId, desired);
      await setSources(workspaceId, userId, "", roleMappings.map((m) => m.sso_group));
    } else {
      // Also a membership added or changed by hand: the mapping wins.
      const lastOwner = member.role === "owner" && (await owners(workspaceId)) <= 1;
      if (member.role !== desired && !lastOwner)
        await run("UPDATE members SET role=? WHERE workspace_id=? AND user_id=?", desired, workspaceId, userId);
      await setSources(workspaceId, userId, "", roleMappings.map((m) => m.sso_group));
    }
  } else if (managed) {
    if (member?.role === "owner" && (await owners(workspaceId)) <= 1) {
      // The last owner stays; the membership remains SSO-managed and goes
      // once another owner exists.
    } else {
      if (member) {
        const heir = (await one<{ user_id: string }>(
          "SELECT user_id FROM members WHERE workspace_id=? AND role='owner' AND user_id<>? ORDER BY user_id LIMIT 1",
          workspaceId,
          userId,
        ))?.user_id;
        await removeFromWorkspace(userId, workspaceId, heir);
      }
      await run("DELETE FROM sso_sources WHERE workspace_id=? AND user_id=?", workspaceId, userId);
    }
  }
  // Workspace groups (permissions on spaces and pages), for members only.
  const isMember = !!(await one("SELECT 1 FROM members WHERE workspace_id=? AND user_id=?", workspaceId, userId));
  const wanted = new Map<string, string[]>();
  if (isMember)
    for (const m of matched)
      if (m.group_id && await one("SELECT 1 FROM groups WHERE id=? AND workspace_id=?", m.group_id, workspaceId))
        wanted.set(m.group_id, [...(wanted.get(m.group_id) || []), m.sso_group]);
  const sourced = new Set(
    (await all<{ target: string }>(
      "SELECT DISTINCT target FROM sso_sources WHERE workspace_id=? AND user_id=? AND target<>''",
      workspaceId,
      userId,
    )).map((s) => s.target),
  );
  for (const [groupId, ssoGroups] of wanted) {
    const has = !!(await one("SELECT 1 FROM group_members WHERE group_id=? AND user_id=?", groupId, userId));
    if (!has) await run("INSERT INTO group_members(group_id,user_id) VALUES(?,?)", groupId, userId);
    // Added by hand or not: from now on it comes from SSO.
    await setSources(workspaceId, userId, groupId, ssoGroups);
  }
  for (const groupId of sourced)
    if (!wanted.has(groupId)) {
      await run("DELETE FROM sso_sources WHERE workspace_id=? AND user_id=? AND target=?", workspaceId, userId, groupId);
      await run("DELETE FROM group_members WHERE group_id=? AND user_id=?", groupId, userId);
    }
}

// The groups a directory gives this person: SCIM groups they are a member
// of and the groups of their LDAP account.
export async function directoryGroups(userId: string) {
  const groups = (await all<{ name: string }>(
    "SELECT g.display_name name FROM scim_group_members m JOIN scim_groups g ON g.id=m.group_id WHERE m.user_id=?",
    userId,
  )).map((g) => g.name);
  const ldap = await one<{ groups_json: string }>("SELECT groups_json FROM ldap_accounts WHERE user_id=?", userId);
  if (ldap) groups.push(...sessionGroups(ldap.groups_json));
  return groups;
}

// Applies the mappings for one person and their current SSO groups (inside
// a transaction of the caller), together with their directory groups.
// Accounts with e-mail and password are never touched. With a workspace,
// only that one.
export async function applySsoGroups(userId: string, ssoGroups: string[], workspaceId?: string) {
  if (await isLocal(userId)) return;
  const user = await one<{ demo_until: number | null; disabled: number }>("SELECT demo_until,disabled FROM users WHERE id=?", userId);
  if (!user || user.demo_until) return;
  const groups = new Set([...ssoGroups, ...await directoryGroups(userId)]);
  const mappings = workspaceId
    ? (await all<SsoMapping>("SELECT * FROM sso_mappings WHERE workspace_id=?", workspaceId))
    : (await all<SsoMapping>("SELECT * FROM sso_mappings"));
  const workspaces = new Set(mappings.map((m) => m.workspace_id));
  for (const s of await all<{ workspace_id: string }>("SELECT DISTINCT workspace_id FROM sso_sources WHERE user_id=?", userId))
    if (!workspaceId || s.workspace_id === workspaceId) workspaces.add(s.workspace_id);
  // In a fixed order: each workspace's membership lock (applyWorkspace) is
  // taken the same way by parallel sign-ins.
  for (const ws of [...workspaces].sort())
    await applyWorkspace(
      userId,
      ws,
      mappings.filter((m) => m.workspace_id === ws && groups.has(m.sso_group)),
    );
}

// At SSO sign-in: its own transaction.
export async function syncSsoMemberships(userId: string, ssoGroups: string[]) {
  await transaction(async () => await applySsoGroups(userId, ssoGroups));
}

// A list of group names stored as JSON (sessions, LDAP accounts).
function sessionGroups(json: string) {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((g): g is string => typeof g === "string") : [];
  } catch {
    return [];
  }
}
// The SSO groups of a person's latest live SSO session (none without one).
export async function latestSsoGroups(userId: string) {
  const s = await one<{ groups_json: string }>(
    "SELECT groups_json FROM sessions WHERE user_id=? AND sso=1 AND expires>? ORDER BY created_at DESC LIMIT 1",
    userId,
    Date.now(),
  );
  return s ? sessionGroups(s.groups_json) : [];
}
// After the directory groups of one person changed (SCIM, LDAP sync): the
// mappings again, with the groups of their latest SSO session.
export async function reapplySsoUser(userId: string) {
  await applySsoGroups(userId, await latestSsoGroups(userId));
}

// After a mapping changed: applied right away to everyone signed in through
// SSO, with the groups of their latest session, and to everyone with
// directory groups. Others follow at sign-in.
export async function reapplySsoMappings(workspaceId: string) {
  const sessions = await all<{ user_id: string; groups_json: string }>(
    `SELECT s.user_id,s.groups_json FROM sessions s
     WHERE s.sso=1 AND s.expires>? AND s.created_at=(SELECT MAX(created_at) FROM sessions x WHERE x.user_id=s.user_id AND x.sso=1 AND x.expires>?)`,
    Date.now(),
    Date.now(),
  );
  const seen = new Set<string>();
  for (const s of sessions) {
    if (seen.has(s.user_id)) continue;
    seen.add(s.user_id);
    await applySsoGroups(s.user_id, sessionGroups(s.groups_json), workspaceId);
  }
  for (const u of await all<{ user_id: string }>(
    "SELECT DISTINCT user_id FROM scim_group_members UNION SELECT user_id FROM ldap_accounts WHERE groups_json<>'[]'",
  ))
    if (!seen.has(u.user_id)) {
      seen.add(u.user_id);
      await applySsoGroups(u.user_id, [], workspaceId);
    }
}

export async function listSsoMappings(workspaceId?: string) {
  return workspaceId
    ? (await all<SsoMapping>("SELECT * FROM sso_mappings WHERE workspace_id=? ORDER BY sso_group,created_at", workspaceId))
    : (await all<SsoMapping>("SELECT * FROM sso_mappings ORDER BY workspace_id,sso_group,created_at"));
}

// Where memberships and group memberships of a workspace come from.
export async function ssoSources(workspaceId: string) {
  return await all<{ user_id: string; target: string; sso_group: string }>(
    "SELECT user_id,target,sso_group FROM sso_sources WHERE workspace_id=? ORDER BY sso_group",
    workspaceId,
  );
}

const mappingInput = z
  .object({
    ssoGroup: z.string().trim().min(1).max(200),
    role: z.enum(["viewer", "editor", "owner"]).nullable().optional(),
    groupId: z.uuid().nullable().optional(),
  })
  .refine((m) => m.role || m.groupId, { message: "Rolle oder Gruppe erforderlich." });

// Permission checks are the caller's (workspace owner or administrator).
export async function addSsoMapping(workspaceId: string, input: unknown) {
  const b = mappingInput.parse(input);
  if (!(await one("SELECT 1 FROM workspaces WHERE id=?", workspaceId))) throw new HttpError(404, "Arbeitsbereich nicht gefunden.");
  if (b.groupId && !(await one("SELECT 1 FROM groups WHERE id=? AND workspace_id=?", b.groupId, workspaceId)))
    throw new HttpError(400, "Gruppe fehlt.");
  await lockFor(`sso-mappings:${workspaceId}`);
  if (Number((await one<{ n: number }>("SELECT COUNT(*) n FROM sso_mappings WHERE workspace_id=?", workspaceId))?.n) >= MAX_MAPPINGS)
    throw new HttpError(409, "Höchstens 100 SSO-Zuordnungen pro Arbeitsbereich.");
  if (
    await one(
      "SELECT 1 FROM sso_mappings WHERE workspace_id=? AND sso_group=? AND COALESCE(role,'')=? AND COALESCE(group_id,'')=?",
      workspaceId,
      b.ssoGroup,
      b.role || "",
      b.groupId || "",
    )
  )
    throw new HttpError(409, "Diese SSO-Zuordnung gibt es schon.");
  const mappingId = id();
  await run(
    "INSERT INTO sso_mappings(id,workspace_id,sso_group,role,group_id,created_at) VALUES(?,?,?,?,?,?)",
    mappingId,
    workspaceId,
    b.ssoGroup,
    b.role || null,
    b.groupId || null,
    Date.now(),
  );
  await reapplySsoMappings(workspaceId);
  return { id: mappingId };
}

export async function deleteSsoMapping(workspaceId: string, mappingId: unknown) {
  await run("DELETE FROM sso_mappings WHERE id=? AND workspace_id=?", z.string().max(100).parse(mappingId), workspaceId);
  await reapplySsoMappings(workspaceId);
}
