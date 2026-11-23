// Directory groups by hand (#451, Administration → Benutzer → a person, and
// "Mitglieder" of a directory group under Grenzen pro Gruppe / KI →
// Kontingente): administrators add people to directory groups ("dir:<name>",
// lib/group-keys.ts) and remove them without the SCIM API, LDAP or the
// identity provider. Administrators only (the commands call requireAdmin;
// API tokens never administer, lib/api.ts), every change audited.
//
// Where a hand-made membership is stored – the rule:
// - A SCIM group of that name exists (the name compared without case, as
//   SCIM's displayName is unique): a row of scim_group_members with
//   added_by/added_at (schema 123). It is an ordinary member: SCIM clients
//   such as flowplan-billing see it in GET /Groups when the person is a SCIM
//   user (an account the client never provisioned has no SCIM resource to
//   list), and billing's reconciliation only reports a member without a
//   grant, it never removes one. A client's PUT/PATCH can remove the members
//   it sees, as for any member; the ones it cannot see stay (lib/scim.ts
//   setMembers), and so does a hand-made membership when the client
//   deletes the SCIM user. The group's version (its ETag) moves.
// - Else, the name is a group of LDAP accounts or of SSO sign-ins: a row of
//   directory_group_members. LDAP syncs and SSO sign-ins replace their own
//   lists every time, so the hand-made membership is kept apart and merged
//   in by lib/person-groups.ts (and lib/sso-mappings.ts directoryGroups) –
//   it survives every sync and sign-in.
// - Else (a new name): a SCIM group is created, so SCIM clients see the
//   same group, with the person as its hand-made member.
//
// Removing: only what was made here or by SCIM – the person's row of the
// SCIM group (hand-made or from the client; a client may add it again) and
// the hand-made row. A membership that comes from LDAP or the SSO sign-in
// cannot be removed by hand – the next sync or sign-in would bring it
// back – so it is shown read-only ("kommt aus LDAP/SSO – dort ändern") and
// the command refuses it.
//
// Afterwards the SSO group mappings are applied again for the person (as
// after a SCIM change). Limits, AI quotas and models read the groups per
// request (lib/person-groups.ts, no memo), so they apply at once.
import { all, audit, id, lockFor, one, run, transaction } from "./db";
import { HttpError } from "./auth";
import { reapplySsoUser } from "./sso-mappings";
import { allGroupKeys, groupChoices } from "./person-groups";
import { directoryKey, directoryName, isDirectoryKey, MAX_DIRECTORY_NAME } from "./group-keys";

export type DirectorySource = "scim" | "ldap" | "sso";
// One directory group of a person: where the membership comes from
// (sources), whether an administrator made it (byHand), whether it can be
// removed here (a SCIM or hand-made row) and whether it would remain
// through LDAP/SSO afterwards (fixed).
export type DirectoryMembership = {
  name: string;
  sources: DirectorySource[];
  byHand: boolean;
  removable: boolean;
  fixed: ("ldap" | "sso")[];
};
export type DirectoryMember = DirectoryMembership & { userId: string; userName: string; email: string };
export type DirectoryGroupInfo = { name: string; scim: boolean; members: DirectoryMember[] };

// The rules of a SCIM displayName (lib/scim.ts groupInput): text without
// leading or trailing spaces, at most 200 characters; no control
// characters here (a name typed by hand).
export function directoryGroupName(raw: unknown): string {
  if (typeof raw !== "string") throw new HttpError(400, "Gruppenname fehlt.");
  const name = raw.trim();
  if (!name) throw new HttpError(400, "Gruppenname fehlt.");
  if (name.length > MAX_DIRECTORY_NAME) throw new HttpError(400, "Der Gruppenname darf höchstens 200 Zeichen haben.");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new HttpError(400, "Der Gruppenname enthält Steuerzeichen.");
  return name;
}

const groupList = (json: string | null | undefined) => {
  try {
    const parsed = JSON.parse(json || "[]");
    return Array.isArray(parsed) ? parsed.filter((g): g is string => typeof g === "string" && g.length > 0 && g.length <= MAX_DIRECTORY_NAME) : [];
  } catch {
    return [];
  }
};
const ldapGroups = async (userId: string) => groupList((await one<{ groups_json: string }>("SELECT groups_json FROM ldap_accounts WHERE user_id=?", userId))?.groups_json);
// As lib/person-groups.ts: the groups of the latest live SSO session.
const ssoGroups = async (userId: string) =>
  groupList((await one<{ groups_json: string }>("SELECT groups_json FROM sessions WHERE user_id=? AND sso=1 AND expires>? ORDER BY created_at DESC LIMIT 1", userId, Date.now()))?.groups_json);

// The directory groups of one person, by name (A–Z).
export async function personDirectoryGroups(userId: string): Promise<DirectoryMembership[]> {
  const out = new Map<string, DirectoryMembership>();
  const entry = (name: string) => {
    let m = out.get(name);
    if (!m) out.set(name, (m = { name, sources: [], byHand: false, removable: false, fixed: [] }));
    return m;
  };
  for (const g of await all<{ name: string; added_by: string | null }>(
    "SELECT g.display_name name,m.added_by FROM scim_group_members m JOIN scim_groups g ON g.id=m.group_id WHERE m.user_id=?",
    userId,
  )) {
    const m = entry(g.name);
    if (!m.sources.includes("scim")) m.sources.push("scim");
    if (g.added_by !== null && g.added_by !== undefined) m.byHand = true;
    m.removable = true;
  }
  for (const g of await all<{ name: string }>("SELECT name FROM directory_group_members WHERE user_id=?", userId)) {
    const m = entry(g.name);
    m.byHand = true;
    m.removable = true;
  }
  for (const name of await ldapGroups(userId)) {
    const m = entry(name);
    if (!m.sources.includes("ldap")) m.sources.push("ldap");
    if (!m.fixed.includes("ldap")) m.fixed.push("ldap");
  }
  for (const name of await ssoGroups(userId)) {
    const m = entry(name);
    if (!m.sources.includes("sso")) m.sources.push("sso");
    if (!m.fixed.includes("sso")) m.fixed.push("sso");
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// Every directory group name known (SCIM, LDAP, live SSO sessions, hand-made
// memberships, the names of the SSO group mappings and of limits) – for the
// search of "Zu Gruppe hinzufügen" – and of those the ones with members or a
// SCIM group (`existing`; any other name becomes a new SCIM group).
export async function directoryGroupNames(): Promise<{ names: string[]; existing: string[] }> {
  const names = new Set<string>(),
    existing = new Set<string>();
  const targets = (await all<{ target: string }>("SELECT target FROM group_limits")).map((r) => r.target);
  for (const g of await groupChoices(targets)) if (g.directory) names.add(g.name);
  for (const g of await all<{ name: string }>("SELECT display_name name FROM scim_groups")) existing.add(g.name);
  for (const keys of (await allGroupKeys()).values()) for (const key of keys) if (isDirectoryKey(key)) existing.add(directoryName(key));
  for (const n of existing) names.add(n);
  const list = (set: Set<string>) => [...set].filter((n) => n.length > 0 && n.length <= MAX_DIRECTORY_NAME).sort((a, b) => a.localeCompare(b));
  return { names: list(names), existing: list(existing) };
}

// The members of one directory group with where each membership comes from.
export async function directoryGroupMembers(rawName: unknown): Promise<DirectoryGroupInfo> {
  const name = directoryGroupName(rawName);
  const scim = await scimGroup(name);
  const key = directoryKey(name);
  const ids = new Set<string>();
  for (const [userId, keys] of await allGroupKeys()) if (keys.includes(key)) ids.add(userId);
  // A SCIM group's own name may differ in case from the one asked for.
  if (scim) for (const m of await all<{ user_id: string }>("SELECT user_id FROM scim_group_members WHERE group_id=?", scim.id)) ids.add(m.user_id);
  const members: DirectoryMember[] = [];
  for (const userId of ids) {
    const user = await one<{ name: string; email: string }>("SELECT name,email FROM users WHERE id=?", userId);
    if (!user) continue;
    const own = (await personDirectoryGroups(userId)).find((g) => g.name === name || (scim && g.name === scim.display_name));
    if (own) members.push({ ...own, name: scim?.display_name ?? name, userId, userName: user.name, email: user.email || "" });
  }
  members.sort((a, b) => a.userName.localeCompare(b.userName) || a.email.localeCompare(b.email));
  return { name: scim?.display_name ?? name, scim: !!scim, members };
}

const scimGroup = async (name: string) => await one<{ id: string; display_name: string }>("SELECT id,display_name FROM scim_groups WHERE lower(display_name)=lower(?)", name);
// A name some LDAP account or live SSO session carries.
async function fromLdapOrSso(name: string) {
  for (const l of await all<{ groups_json: string }>("SELECT groups_json FROM ldap_accounts WHERE groups_json<>'[]'")) if (groupList(l.groups_json).includes(name)) return true;
  for (const s of await all<{ groups_json: string }>("SELECT groups_json FROM sessions WHERE sso=1 AND expires>? AND groups_json<>'[]'", Date.now()))
    if (groupList(s.groups_json).includes(name)) return true;
  // Already given by hand to someone else: the same kind of group.
  return !!(await one("SELECT 1 FROM directory_group_members WHERE name=? LIMIT 1", name));
}
async function person(userId: unknown) {
  if (typeof userId !== "string") throw new HttpError(400, "Person fehlt.");
  const user = await one<{ id: string; name: string }>("SELECT id,name FROM users WHERE id=? AND demo_until IS NULL AND subject NOT LIKE 'deleted:%'", userId);
  if (!user) throw new HttpError(404, "Diese Person gibt es nicht.");
  return user;
}
const bumpScimGroup = async (groupId: string) => await run("UPDATE scim_groups SET version=version+1,updated_at=? WHERE id=?", Date.now(), groupId);

export type AddResult = { name: string; stored: "scim" | "manual"; created: boolean; already: boolean };

// "Zu Gruppe hinzufügen": the person into the directory group `name` (see
// the rule above for where it is stored).
export async function addToDirectoryGroup(actorId: string, userId: unknown, rawName: unknown): Promise<AddResult> {
  const name = directoryGroupName(rawName);
  return await transaction(async () => {
    const user = await person(userId);
    await lockFor(`directory-group:${name.toLowerCase()}`);
    const now = Date.now();
    let scim = await scimGroup(name);
    let result: AddResult;
    if (scim || !(await fromLdapOrSso(name))) {
      let created = false;
      if (!scim) {
        const groupId = id();
        await run("INSERT INTO scim_groups(id,display_name,external_id,version,created_at,updated_at) VALUES(?,?,NULL,1,?,?)", groupId, name, now, now);
        await audit(actorId, "admin.directoryGroup.create", groupId, name);
        scim = { id: groupId, display_name: name };
        created = true;
      }
      const already = !!(await one("SELECT 1 FROM scim_group_members WHERE group_id=? AND user_id=?", scim.id, user.id));
      if (!already) {
        await run("INSERT INTO scim_group_members(group_id,user_id,added_by,added_at) VALUES(?,?,?,?)", scim.id, user.id, actorId, now);
        if (!created) await bumpScimGroup(scim.id);
      }
      result = { name: scim.display_name, stored: "scim", created, already };
    } else {
      const already = !!(await one("SELECT 1 FROM directory_group_members WHERE name=? AND user_id=?", name, user.id));
      if (!already) await run("INSERT INTO directory_group_members(name,user_id,added_by,added_at) VALUES(?,?,?,?)", name, user.id, actorId, now);
      result = { name, stored: "manual", created: false, already };
    }
    if (!result.already) {
      await audit(actorId, "admin.directoryGroup.add", user.id, JSON.stringify({ group: result.name, stored: result.stored }));
      await reapplySsoUser(user.id);
    }
    return result;
  });
}

export type RemoveResult = { name: string; removed: ("scim" | "manual")[]; remains: ("ldap" | "sso")[] };

// "Entfernen": the person's SCIM and hand-made memberships of `name`;
// refused when the membership comes from LDAP/SSO only.
export async function removeFromDirectoryGroup(actorId: string, userId: unknown, rawName: unknown): Promise<RemoveResult> {
  const name = directoryGroupName(rawName);
  return await transaction(async () => {
    const user = await person(userId);
    await lockFor(`directory-group:${name.toLowerCase()}`);
    const removed: RemoveResult["removed"] = [];
    const scim = await scimGroup(name);
    if (scim && (await one("SELECT 1 FROM scim_group_members WHERE group_id=? AND user_id=?", scim.id, user.id))) {
      await run("DELETE FROM scim_group_members WHERE group_id=? AND user_id=?", scim.id, user.id);
      await bumpScimGroup(scim.id);
      removed.push("scim");
    }
    if (await one("SELECT 1 FROM directory_group_members WHERE name=? AND user_id=?", name, user.id)) {
      await run("DELETE FROM directory_group_members WHERE name=? AND user_id=?", name, user.id);
      removed.push("manual");
    }
    const remains: RemoveResult["remains"] = [];
    if ((await ldapGroups(user.id)).includes(name)) remains.push("ldap");
    if ((await ssoGroups(user.id)).includes(name)) remains.push("sso");
    if (!removed.length) {
      if (remains.length) throw new HttpError(409, `Die Mitgliedschaft kommt aus ${remains.map((r) => r.toUpperCase()).join("/")} – dort ändern.`);
      throw new HttpError(404, "Diese Person ist nicht in der Gruppe.");
    }
    await audit(actorId, "admin.directoryGroup.remove", user.id, JSON.stringify({ group: scim?.display_name ?? name, removed }));
    await reapplySsoUser(user.id);
    return { name: scim?.display_name ?? name, removed, remains };
  });
}
