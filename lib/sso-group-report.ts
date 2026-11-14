// The groups an OpenID Connect provider sent at a person's latest sign-in
// (#289): what Administration → Users shows so an administrator can see
// why someone is (not) an admin – which claim was read (OIDC_GROUPS_CLAIM),
// whether the token and userinfo had it at all (the usual misconfiguration:
// the provider's group mapper does not add it), the groups themselves and
// whether the admin group (OIDC_ADMIN_GROUP) was among them. Groups are
// compared exactly, as everywhere else: "/AdminGroup" (Keycloak's "Full
// group path") is not "AdminGroup". Admin-only data.
import { all, run } from "./db";
import { adminGroup } from "./auth";
import { requireAdmin } from "./permissions";
import type { Identity } from "./types";

export const MAX_REPORTED_GROUPS = 100;
export const MAX_GROUP_LENGTH = 200;

export const groupsClaimName = () => process.env.OIDC_GROUPS_CLAIM || "groups";

// Whether the claim (a dot path, as extractGroups reads it) is in the
// provider's claims at all – an empty list counts as present.
export function groupsClaimMissing(claims: Record<string, unknown>): boolean {
  const value = groupsClaimName()
    .split(".")
    .reduce<unknown>((a, k) => (a && typeof a === "object" ? (a as Record<string, unknown>)[k] : undefined), claims);
  return value === undefined || value === null;
}

export type SsoGroupsSeen = { claim: string; missing: boolean | null };
export type SsoGroupReport = {
  userId: string;
  at: number;
  claim: string;
  // null: not known (a sign-in that waited to be connected to an account).
  claimMissing: boolean | null;
  groups: string[];
  // How many the provider sent (groups holds at most MAX_REPORTED_GROUPS).
  groupCount: number;
  adminGroup: string;
  hasAdminGroup: boolean;
};

// Written at the end of every OIDC sign-in, over the previous one.
export async function recordSsoGroups(userId: string, groups: string[], seen?: SsoGroupsSeen, now = Date.now()) {
  const admin = adminGroup();
  const kept = groups.slice(0, MAX_REPORTED_GROUPS).map((g) => g.slice(0, MAX_GROUP_LENGTH));
  const missing = seen ? seen.missing : groups.length ? false : null;
  await run(
    "INSERT INTO sso_group_reports(user_id,at,claim,claim_missing,groups_json,group_count,admin_group,has_admin) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET at=excluded.at,claim=excluded.claim,claim_missing=excluded.claim_missing,groups_json=excluded.groups_json,group_count=excluded.group_count,admin_group=excluded.admin_group,has_admin=excluded.has_admin",
    userId,
    now,
    (seen?.claim || groupsClaimName()).slice(0, MAX_GROUP_LENGTH),
    missing === null ? null : missing ? 1 : 0,
    JSON.stringify(kept),
    groups.length,
    admin.slice(0, MAX_GROUP_LENGTH),
    groups.includes(admin) ? 1 : 0,
  );
}

type Row = { user_id: string; at: number; claim: string; claim_missing: number | null; groups_json: string; group_count: number; admin_group: string; has_admin: number };
const reportOf = (r: Row): SsoGroupReport => {
  let groups: string[] = [];
  try {
    const parsed = JSON.parse(r.groups_json);
    if (Array.isArray(parsed)) groups = parsed.filter((g): g is string => typeof g === "string");
  } catch {}
  return {
    userId: r.user_id,
    at: Number(r.at),
    claim: r.claim,
    claimMissing: r.claim_missing === null || r.claim_missing === undefined ? null : Number(r.claim_missing) === 1,
    groups,
    groupCount: Number(r.group_count),
    adminGroup: r.admin_group,
    hasAdminGroup: Number(r.has_admin) === 1,
  };
};

// Every account's latest report, for the administration only.
export async function ssoGroupReports(user: Identity): Promise<SsoGroupReport[]> {
  requireAdmin(user);
  return (await all<Row>("SELECT user_id,at,claim,claim_missing,groups_json,group_count,admin_group,has_admin FROM sso_group_reports ORDER BY at DESC")).map(reportOf);
}
