// The groups limits can be set for (AI quotas and models, lib/ai/quota.ts;
// storage, own workspaces and uploads, lib/user-limits.ts), as one key
// each. Safe for the browser: no server imports.
//
// - A workspace group: its id (groups.id). SSO, SCIM and LDAP groups reach
//   these through the SSO group mappings – for members of that workspace.
// - A directory group: "dir:<name>" – a group of the identity provider by
//   its name, exactly as the SSO group mappings match it: a SCIM group's
//   displayName, an LDAP group or a group of the person's SSO sign-in. It
//   needs no workspace and no mapping, and also counts for accounts with
//   e-mail and password that a directory lists as members (SCIM), which the
//   mappings never touch.
export const DIRECTORY_PREFIX = "dir:";
export const MAX_DIRECTORY_NAME = 200;
export const directoryKey = (name: string) => `${DIRECTORY_PREFIX}${name}`;
export const isDirectoryKey = (key: string) => key.startsWith(DIRECTORY_PREFIX);
export const directoryName = (key: string) => key.slice(DIRECTORY_PREFIX.length);
// A choice for the group pickers of the administration.
export type GroupChoice = { id: string; name: string; workspace: string | null; directory: boolean; members: number };
