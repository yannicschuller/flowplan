// The groups of a person as the limits see them (lib/group-keys.ts): their
// workspace groups in every workspace, and the directory groups by name –
// SCIM groups they are a member of, the groups of their LDAP account and of
// their latest live SSO session (the same names the SSO group mappings
// match, lib/sso-mappings.ts) and the memberships of LDAP/SSO groups an
// administrator made by hand (directory_group_members, kept apart because
// LDAP syncs and SSO sign-ins replace their own lists – lib/directory-groups.ts).
// Hand-made members of SCIM groups are rows of scim_group_members. Nothing
// here is memoized: a change applies to the next request. Used by the AI
// quotas and models (lib/ai/quota.ts, lib/ai/model-policy.ts) and the
// limits per group (lib/user-limits.ts). Plain queries only: no imports that lead back to
// the AI or the workspaces.
import { all, one } from "./db";
import { directoryKey, isDirectoryKey, directoryName, MAX_DIRECTORY_NAME, type GroupChoice } from "./group-keys";

const names = (json: string | null | undefined) => {
  try {
    const parsed = JSON.parse(json || "[]");
    return Array.isArray(parsed) ? parsed.filter((g): g is string => typeof g === "string" && g.length > 0 && g.length <= MAX_DIRECTORY_NAME) : [];
  } catch {
    return [];
  }
};

export async function personGroupKeys(userId: string): Promise<string[]> {
  const keys = new Set((await all<{ group_id: string }>("SELECT group_id FROM group_members WHERE user_id=?", userId)).map((g) => g.group_id));
  for (const g of await all<{ name: string }>("SELECT g.display_name name FROM scim_group_members m JOIN scim_groups g ON g.id=m.group_id WHERE m.user_id=?", userId)) keys.add(directoryKey(g.name));
  for (const name of names((await one<{ groups_json: string }>("SELECT groups_json FROM ldap_accounts WHERE user_id=?", userId))?.groups_json)) keys.add(directoryKey(name));
  for (const g of await all<{ name: string }>("SELECT name FROM directory_group_members WHERE user_id=?", userId)) keys.add(directoryKey(g.name));
  const sso = await one<{ groups_json: string }>("SELECT groups_json FROM sessions WHERE user_id=? AND sso=1 AND expires>? ORDER BY created_at DESC LIMIT 1", userId, Date.now());
  for (const name of names(sso?.groups_json)) keys.add(directoryKey(name));
  return [...keys];
}

// Everyone's groups at once (the administration's overviews).
export async function allGroupKeys(): Promise<Map<string, string[]>> {
  const out = new Map<string, Set<string>>();
  const add = (userId: string, key: string) => {
    const set = out.get(userId);
    if (set) set.add(key);
    else out.set(userId, new Set([key]));
  };
  for (const m of await all<{ user_id: string; group_id: string }>("SELECT user_id,group_id FROM group_members")) add(m.user_id, m.group_id);
  for (const m of await all<{ user_id: string; name: string }>("SELECT m.user_id,g.display_name name FROM scim_group_members m JOIN scim_groups g ON g.id=m.group_id")) add(m.user_id, directoryKey(m.name));
  for (const l of await all<{ user_id: string; groups_json: string }>("SELECT user_id,groups_json FROM ldap_accounts WHERE groups_json<>'[]'")) for (const name of names(l.groups_json)) add(l.user_id, directoryKey(name));
  for (const m of await all<{ user_id: string; name: string }>("SELECT user_id,name FROM directory_group_members")) add(m.user_id, directoryKey(m.name));
  const now = Date.now();
  for (const s of await all<{ user_id: string; groups_json: string }>(
    "SELECT s.user_id,s.groups_json FROM sessions s WHERE s.sso=1 AND s.expires>? AND s.created_at=(SELECT MAX(created_at) FROM sessions x WHERE x.user_id=s.user_id AND x.sso=1 AND x.expires>?)",
    now,
    now,
  ))
    for (const name of names(s.groups_json)) add(s.user_id, directoryKey(name));
  return new Map([...out].map(([userId, set]) => [userId, [...set]]));
}

// A key the administration may set a limit for: an existing workspace
// group, or a directory group by name (it may not exist yet – the
// directory can push it later).
export async function validGroupKey(key: string) {
  if (isDirectoryKey(key)) {
    const name = directoryName(key);
    return name.trim().length > 0 && name.length <= MAX_DIRECTORY_NAME && name === name.trim();
  }
  return !!(await one("SELECT 1 FROM groups WHERE id=?", key));
}

// The groups to choose from: every workspace group, and the directory groups
// known so far (SCIM groups, LDAP groups of accounts, hand-made
// memberships, the names the SSO group mappings use) plus `extra` keys
// (targets of existing limits).
export async function groupChoices(extra: string[] = []): Promise<GroupChoice[]> {
  const workspace = await all<{ id: string; name: string; workspace: string | null; members: number }>(
    "SELECT g.id,g.name,w.name workspace,(SELECT COUNT(*) FROM group_members m WHERE m.group_id=g.id) members FROM groups g LEFT JOIN workspaces w ON w.id=g.workspace_id ORDER BY w.name,g.name LIMIT 2000",
  );
  const directory = new Map<string, number>();
  for (const g of await all<{ name: string; members: number }>("SELECT g.display_name name,(SELECT COUNT(*) FROM scim_group_members m WHERE m.group_id=g.id) members FROM scim_groups g LIMIT 2000"))
    directory.set(g.name, Number(g.members));
  for (const l of await all<{ groups_json: string }>("SELECT groups_json FROM ldap_accounts WHERE groups_json<>'[]' LIMIT 5000"))
    for (const name of names(l.groups_json)) directory.set(name, (directory.get(name) ?? 0) + 1);
  for (const m of await all<{ name: string; members: number }>("SELECT name,COUNT(*) members FROM directory_group_members GROUP BY name LIMIT 2000"))
    directory.set(m.name, (directory.get(m.name) ?? 0) + Number(m.members));
  for (const m of await all<{ sso_group: string }>("SELECT DISTINCT sso_group FROM sso_mappings LIMIT 2000")) if (!directory.has(m.sso_group)) directory.set(m.sso_group, 0);
  for (const key of extra) if (isDirectoryKey(key) && !directory.has(directoryName(key))) directory.set(directoryName(key), 0);
  return [
    ...workspace.map((g) => ({ id: g.id, name: g.name, workspace: g.workspace, directory: false, members: Number(g.members) })),
    ...[...directory]
      .filter(([name]) => name.length > 0 && name.length <= MAX_DIRECTORY_NAME)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, members]) => ({ id: directoryKey(name), name, workspace: null, directory: true, members })),
  ];
}
