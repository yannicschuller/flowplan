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
import { z } from "zod";
import { all, id, one, run, transaction } from "./db";
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

const isLocal = (userId: string) => !!one("SELECT 1 FROM local_accounts WHERE user_id=?", userId);
const owners = (workspaceId: string) =>
  Number(one<{ n: number }>("SELECT COUNT(*) n FROM members WHERE workspace_id=? AND role='owner'", workspaceId)?.n || 0);

// Records exactly these SSO groups as the source of one target.
function setSources(workspaceId: string, userId: string, target: string, groups: string[]) {
  const keep = [...new Set(groups)];
  for (const s of all<{ sso_group: string }>(
    "SELECT sso_group FROM sso_sources WHERE workspace_id=? AND user_id=? AND target=?",
    workspaceId,
    userId,
    target,
  ))
    if (!keep.includes(s.sso_group))
      run("DELETE FROM sso_sources WHERE workspace_id=? AND user_id=? AND target=? AND sso_group=?", workspaceId, userId, target, s.sso_group);
  for (const group of keep)
    run("INSERT OR IGNORE INTO sso_sources(workspace_id,user_id,target,sso_group) VALUES(?,?,?,?)", workspaceId, userId, target, group);
}

function applyWorkspace(userId: string, workspaceId: string, matched: SsoMapping[]) {
  // Workspace membership with the highest mapped role.
  const roleMappings = matched.filter((m): m is SsoMapping & { role: Role } => !!m.role);
  const member = one<{ role: Role }>("SELECT role FROM members WHERE workspace_id=? AND user_id=?", workspaceId, userId);
  const managed = !!one("SELECT 1 FROM sso_sources WHERE workspace_id=? AND user_id=? AND target=''", workspaceId, userId);
  if (roleMappings.length) {
    let desired = roleMappings.map((m) => m.role).sort((a, b) => rank[b] - rank[a])[0];
    const guest = !!one("SELECT 1 FROM workspace_guests WHERE workspace_id=? AND user_id=?", workspaceId, userId);
    if (guest && desired === "owner") desired = "editor";
    if (!member) {
      run("INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,?)", workspaceId, userId, desired);
      setSources(workspaceId, userId, "", roleMappings.map((m) => m.sso_group));
    } else {
      // Also a membership added or changed by hand: the mapping wins.
      const lastOwner = member.role === "owner" && owners(workspaceId) <= 1;
      if (member.role !== desired && !lastOwner)
        run("UPDATE members SET role=? WHERE workspace_id=? AND user_id=?", desired, workspaceId, userId);
      setSources(workspaceId, userId, "", roleMappings.map((m) => m.sso_group));
    }
  } else if (managed) {
    if (member?.role === "owner" && owners(workspaceId) <= 1) {
      // The last owner stays; the membership remains SSO-managed and goes
      // once another owner exists.
    } else {
      if (member) {
        const heir = one<{ user_id: string }>(
          "SELECT user_id FROM members WHERE workspace_id=? AND role='owner' AND user_id<>? ORDER BY user_id LIMIT 1",
          workspaceId,
          userId,
        )?.user_id;
        removeFromWorkspace(userId, workspaceId, heir);
      }
      run("DELETE FROM sso_sources WHERE workspace_id=? AND user_id=?", workspaceId, userId);
    }
  }
  // Workspace groups (permissions on spaces and pages), for members only.
  const isMember = !!one("SELECT 1 FROM members WHERE workspace_id=? AND user_id=?", workspaceId, userId);
  const wanted = new Map<string, string[]>();
  if (isMember)
    for (const m of matched)
      if (m.group_id && one("SELECT 1 FROM groups WHERE id=? AND workspace_id=?", m.group_id, workspaceId))
        wanted.set(m.group_id, [...(wanted.get(m.group_id) || []), m.sso_group]);
  const sourced = new Set(
    all<{ target: string }>(
      "SELECT DISTINCT target FROM sso_sources WHERE workspace_id=? AND user_id=? AND target<>''",
      workspaceId,
      userId,
    ).map((s) => s.target),
  );
  for (const [groupId, ssoGroups] of wanted) {
    const has = !!one("SELECT 1 FROM group_members WHERE group_id=? AND user_id=?", groupId, userId);
    if (!has) run("INSERT INTO group_members(group_id,user_id) VALUES(?,?)", groupId, userId);
    // Added by hand or not: from now on it comes from SSO.
    setSources(workspaceId, userId, groupId, ssoGroups);
  }
  for (const groupId of sourced)
    if (!wanted.has(groupId)) {
      run("DELETE FROM sso_sources WHERE workspace_id=? AND user_id=? AND target=?", workspaceId, userId, groupId);
      run("DELETE FROM group_members WHERE group_id=? AND user_id=?", groupId, userId);
    }
}

// Applies the mappings for one person and their current SSO groups (inside
// a transaction of the caller). Accounts with e-mail and password are never
// touched. With a workspace, only that one.
export function applySsoGroups(userId: string, ssoGroups: string[], workspaceId?: string) {
  if (isLocal(userId)) return;
  const user = one<{ demo_until: number | null; disabled: number }>("SELECT demo_until,disabled FROM users WHERE id=?", userId);
  if (!user || user.demo_until) return;
  const groups = new Set(ssoGroups);
  const mappings = workspaceId
    ? all<SsoMapping>("SELECT * FROM sso_mappings WHERE workspace_id=?", workspaceId)
    : all<SsoMapping>("SELECT * FROM sso_mappings");
  const workspaces = new Set(mappings.map((m) => m.workspace_id));
  for (const s of all<{ workspace_id: string }>("SELECT DISTINCT workspace_id FROM sso_sources WHERE user_id=?", userId))
    if (!workspaceId || s.workspace_id === workspaceId) workspaces.add(s.workspace_id);
  for (const ws of workspaces)
    applyWorkspace(
      userId,
      ws,
      mappings.filter((m) => m.workspace_id === ws && groups.has(m.sso_group)),
    );
}

// At SSO sign-in: its own transaction.
export function syncSsoMemberships(userId: string, ssoGroups: string[]) {
  transaction(() => applySsoGroups(userId, ssoGroups));
}

// After a mapping changed: applied right away to everyone signed in through
// SSO, with the groups of their latest session. Others follow at sign-in.
export function reapplySsoMappings(workspaceId: string) {
  const sessions = all<{ user_id: string; groups_json: string }>(
    `SELECT s.user_id,s.groups_json FROM sessions s
     WHERE s.sso=1 AND s.expires>? AND s.created_at=(SELECT MAX(created_at) FROM sessions x WHERE x.user_id=s.user_id AND x.sso=1 AND x.expires>?)`,
    Date.now(),
    Date.now(),
  );
  const seen = new Set<string>();
  for (const s of sessions) {
    if (seen.has(s.user_id)) continue;
    seen.add(s.user_id);
    let groups: string[] = [];
    try {
      const parsed = JSON.parse(s.groups_json);
      if (Array.isArray(parsed)) groups = parsed.filter((g): g is string => typeof g === "string");
    } catch {
      groups = [];
    }
    applySsoGroups(s.user_id, groups, workspaceId);
  }
}

export function listSsoMappings(workspaceId?: string) {
  return workspaceId
    ? all<SsoMapping>("SELECT * FROM sso_mappings WHERE workspace_id=? ORDER BY sso_group,created_at", workspaceId)
    : all<SsoMapping>("SELECT * FROM sso_mappings ORDER BY workspace_id,sso_group,created_at");
}

// Where memberships and group memberships of a workspace come from.
export function ssoSources(workspaceId: string) {
  return all<{ user_id: string; target: string; sso_group: string }>(
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
export function addSsoMapping(workspaceId: string, input: unknown) {
  const b = mappingInput.parse(input);
  if (!one("SELECT 1 FROM workspaces WHERE id=?", workspaceId)) throw new HttpError(404, "Arbeitsbereich nicht gefunden.");
  if (b.groupId && !one("SELECT 1 FROM groups WHERE id=? AND workspace_id=?", b.groupId, workspaceId))
    throw new HttpError(400, "Gruppe fehlt.");
  if (Number(one<{ n: number }>("SELECT COUNT(*) n FROM sso_mappings WHERE workspace_id=?", workspaceId)?.n) >= MAX_MAPPINGS)
    throw new HttpError(409, "Höchstens 100 SSO-Zuordnungen pro Arbeitsbereich.");
  if (
    one(
      "SELECT 1 FROM sso_mappings WHERE workspace_id=? AND sso_group=? AND COALESCE(role,'')=? AND COALESCE(group_id,'')=?",
      workspaceId,
      b.ssoGroup,
      b.role || "",
      b.groupId || "",
    )
  )
    throw new HttpError(409, "Diese SSO-Zuordnung gibt es schon.");
  const mappingId = id();
  run(
    "INSERT INTO sso_mappings(id,workspace_id,sso_group,role,group_id,created_at) VALUES(?,?,?,?,?,?)",
    mappingId,
    workspaceId,
    b.ssoGroup,
    b.role || null,
    b.groupId || null,
    Date.now(),
  );
  reapplySsoMappings(workspaceId);
  return { id: mappingId };
}

export function deleteSsoMapping(workspaceId: string, mappingId: unknown) {
  run("DELETE FROM sso_mappings WHERE id=? AND workspace_id=?", z.string().max(100).parse(mappingId), workspaceId);
  reapplySsoMappings(workspaceId);
}
