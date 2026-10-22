// SCIM 2.0 provisioning (RFC 7643/7644) at /api/scim/v2: identity providers
// such as Okta, Microsoft Entra ID, Authentik or Keycloak create, update and
// deactivate Flowplan accounts and push their groups.
//
// - Authentication: a bearer token created by an administrator
//   (Administration → Users → User provisioning); only its SHA-256 hash is
//   stored, the token is shown once.
// - Users are SSO accounts: a new one gets the subject "scim:<externalId or
//   userName>" until its first OIDC sign-in claims it (by externalId = the
//   provider's "sub", or by a verified e-mail address, see
//   claimProvisionedAccount). An existing account with the same e-mail
//   address is linked instead of creating a second one.
// - "active": false disables the account through the same path as the
//   administration (sessions end at once, API tokens stop working); DELETE
//   deactivates and unlinks, it never deletes data. The last enabled
//   administrator with e-mail and password is never disabled from here.
// - Groups are directory groups, identified by their displayName. They do
//   not create workspace groups themselves: a group's name is matched by the
//   SSO group mappings (lib/sso-mappings.ts) exactly like an SSO group from
//   the OIDC groups claim, so roles and workspace groups follow the mapping
//   rules ("SSO always wins", the last owner stays). A membership change is
//   applied right away.
// - Accounts with e-mail and password can be linked (and deactivated), but
//   mappings never change their memberships, as for SSO.
import { createHash, randomBytes } from "node:crypto";
import { all, audit, id, one, run, transaction } from "./db";
import { appUrl } from "./auth";
import { lastAdmin, setUserDisabled } from "./account-deletion";
import { reapplySsoUser } from "./sso-mappings";
import {
  ENTERPRISE_SCHEMA,
  GROUP_SCHEMA,
  ScimFilterError,
  USER_SCHEMA,
  attributePath,
  getKey,
  matches,
  parseFilter,
  parsePatchPath,
  type Filter,
  type PatchPath,
} from "./scim-filter";

const ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";
const LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
export const SCIM_CONTENT_TYPE = "application/scim+json; charset=utf-8";
const MAX_COUNT = 200;
const MAX_TOKENS = 20;
const KEEP_REQUESTS = 200;

type Json = Record<string, unknown>;
export type ScimRequest = { method: string; path: string[]; query: URLSearchParams; authorization: string | null; body: string };
export type ScimResult = { status: number; body?: unknown; headers?: Record<string, string> };

export class ScimError extends Error {
  constructor(
    public status: number,
    message: string,
    public scimType?: string,
  ) {
    super(message);
  }
}
const errorBody = (e: ScimError) => ({
  schemas: [ERROR_SCHEMA],
  status: String(e.status),
  ...(e.scimType ? { scimType: e.scimType } : {}),
  detail: e.message,
});

export const scimBase = () => `${appUrl().replace(/\/$/, "")}/api/scim/v2`;

// ---- Tokens ----

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
export function createScimToken(createdBy: string, name: unknown) {
  const label = typeof name === "string" && name.trim() ? name.trim().slice(0, 80) : "SCIM";
  if (Number(one<{ n: number }>("SELECT COUNT(*) n FROM scim_tokens")?.n || 0) >= MAX_TOKENS)
    throw new ScimError(409, `At most ${MAX_TOKENS} SCIM tokens.`);
  const token = `fpscim_${randomBytes(32).toString("base64url")}`;
  const tokenId = id();
  run(
    "INSERT INTO scim_tokens(id,name,scope,token_hash,prefix,created_by,created_at) VALUES(?,?,?,?,?,?,?)",
    tokenId,
    label,
    "scim",
    hashToken(token),
    token.slice(0, 12),
    createdBy,
    Date.now(),
  );
  audit(createdBy, "scim.token.create", tokenId, label);
  return { id: tokenId, token };
}
export function revokeScimToken(actor: string, tokenId: unknown) {
  if (typeof tokenId !== "string" || tokenId.length > 100) return;
  if (run("DELETE FROM scim_tokens WHERE id=?", tokenId).changes) audit(actor, "scim.token.revoke", tokenId);
}
function tokenFromHeader(header: string | null) {
  const match = header?.match(/^Bearer\s+(fpscim_[A-Za-z0-9_-]{20,80})\s*$/);
  if (!match) return null;
  const row = one<{ id: string; last_used_at: number | null }>(
    "SELECT id,last_used_at FROM scim_tokens WHERE token_hash=? AND scope='scim'",
    hashToken(match[1]),
  );
  if (row && (!row.last_used_at || Date.now() - row.last_used_at > 60_000))
    run("UPDATE scim_tokens SET last_used_at=? WHERE id=?", Date.now(), row.id);
  return row || null;
}
export function scimOverview() {
  return {
    baseUrl: scimBase(),
    tokens: all<{ id: string; name: string; prefix: string; created_at: number; last_used_at: number | null }>(
      "SELECT id,name,prefix,created_at,last_used_at FROM scim_tokens ORDER BY created_at DESC",
    ),
    users: Number(one<{ n: number }>("SELECT COUNT(*) n FROM scim_users")?.n || 0),
    groups: Number(one<{ n: number }>("SELECT COUNT(*) n FROM scim_groups")?.n || 0),
    requests: all<{ id: number; at: number; method: string; path: string; status: number; detail: string }>(
      "SELECT id,at,method,path,status,detail FROM scim_requests ORDER BY id DESC LIMIT 25",
    ),
  };
}
export type ScimOverview = ReturnType<typeof scimOverview>;

// ---- OIDC sign-in of a provisioned account ----

// Before the OIDC sign-in looks the person up by subject: an account the
// provider provisioned over SCIM (subject "scim:…") takes over the OIDC
// subject when its externalId is the provider's "sub", or – with a verified
// address – when its e-mail matches. Only an unambiguous match counts.
export function claimProvisionedAccount(subject: string, sub: string, email: string, emailVerified: boolean) {
  if (one("SELECT 1 FROM users WHERE subject=?", subject)) return;
  const candidates = all<{ id: string }>(
    `SELECT u.id FROM scim_users s JOIN users u ON u.id=s.user_id WHERE u.subject LIKE 'scim:%'
       AND (s.external_id=? OR (?=1 AND u.email<>'' AND lower(u.email)=lower(?)))`,
    sub,
    emailVerified ? 1 : 0,
    email,
  );
  if (candidates.length === 1) run("UPDATE users SET subject=? WHERE id=?", subject, candidates[0].id);
}

// ---- Resources ----

type UserRow = {
  id: string;
  user_id: string;
  user_name: string;
  external_id: string | null;
  given_name: string | null;
  family_name: string | null;
  display_name: string | null;
  version: number;
  created_at: number;
  updated_at: number;
  name: string;
  email: string;
  disabled: number;
};
type GroupRow = { id: string; display_name: string; external_id: string | null; version: number; created_at: number; updated_at: number };

const iso = (ms: number) => new Date(ms).toISOString();
const meta = (type: "User" | "Group", row: { id: string; version: number; created_at: number; updated_at: number }) => ({
  resourceType: type,
  created: iso(row.created_at),
  lastModified: iso(row.updated_at),
  location: `${scimBase()}/${type}s/${row.id}`,
  version: `W/"${row.version}"`,
});
const USER_SELECT =
  "SELECT s.*,u.name,u.email,u.disabled FROM scim_users s JOIN users u ON u.id=s.user_id";

function renderUser(row: UserRow): Json {
  const groups = all<{ id: string; display_name: string }>(
    "SELECT g.id,g.display_name FROM scim_group_members m JOIN scim_groups g ON g.id=m.group_id WHERE m.user_id=? ORDER BY g.display_name",
    row.user_id,
  );
  const formatted = [row.given_name, row.family_name].filter(Boolean).join(" ");
  return {
    schemas: [USER_SCHEMA],
    id: row.id,
    ...(row.external_id ? { externalId: row.external_id } : {}),
    userName: row.user_name,
    name: {
      ...(formatted ? { formatted } : {}),
      ...(row.given_name ? { givenName: row.given_name } : {}),
      ...(row.family_name ? { familyName: row.family_name } : {}),
    },
    displayName: row.display_name || row.name,
    ...(row.email ? { emails: [{ value: row.email, type: "work", primary: true }] } : {}),
    active: !row.disabled,
    groups: groups.map((g) => ({ value: g.id, display: g.display_name, $ref: `${scimBase()}/Groups/${g.id}` })),
    meta: meta("User", row),
  };
}
function renderGroup(row: GroupRow, withMembers = true): Json {
  const members = withMembers
    ? all<{ id: string; name: string }>(
        "SELECT s.id,u.name FROM scim_group_members m JOIN scim_users s ON s.user_id=m.user_id JOIN users u ON u.id=m.user_id WHERE m.group_id=? ORDER BY u.name",
        row.id,
      )
    : [];
  return {
    schemas: [GROUP_SCHEMA],
    id: row.id,
    ...(row.external_id ? { externalId: row.external_id } : {}),
    displayName: row.display_name,
    ...(withMembers ? { members: members.map((m) => ({ value: m.id, display: m.name, type: "User", $ref: `${scimBase()}/Users/${m.id}` })) } : {}),
    meta: meta("Group", row),
  };
}
const userRow = (scimId: string) => one<UserRow>(`${USER_SELECT} WHERE s.id=?`, scimId);
const groupRow = (scimId: string) => one<GroupRow>("SELECT * FROM scim_groups WHERE id=?", scimId);

// ---- Input ----

const str = (value: unknown, field: string, max = 200) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ScimError(400, `${field} must be a string.`, "invalidValue");
  const v = value.trim();
  if (v.length > max) throw new ScimError(400, `${field} is too long.`, "invalidValue");
  return v || null;
};
const bool = (value: unknown, fallback: boolean) => {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  // Entra ID sends "True" and "False" as strings.
  if (typeof value === "string" && /^(true|false)$/i.test(value)) return value.toLowerCase() === "true";
  throw new ScimError(400, "active must be a boolean.", "invalidValue");
};
type UserInput = { userName: string; externalId: string | null; givenName: string | null; familyName: string | null; displayName: string | null; email: string; active: boolean };
function userInput(r: unknown): UserInput {
  if (!r || typeof r !== "object" || Array.isArray(r)) throw new ScimError(400, "A JSON object is expected.", "invalidSyntax");
  const userName = str(getKey(r, "userName"), "userName");
  if (!userName) throw new ScimError(400, "userName is required.", "invalidValue");
  const name = getKey(r, "name");
  const emails = getKey(r, "emails");
  let email = "";
  if (Array.isArray(emails) && emails.length) {
    const chosen = emails.find((e) => bool(getKey(e, "primary"), false)) || emails.find((e) => str(getKey(e, "type"), "type") === "work") || emails[0];
    email = str(getKey(chosen, "value"), "emails.value") || "";
  }
  if (!email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(userName)) email = userName;
  if (email && !/^[^@\s]+@[^@\s]+$/.test(email)) throw new ScimError(400, "Invalid e-mail address.", "invalidValue");
  return {
    userName,
    externalId: str(getKey(r, "externalId"), "externalId"),
    givenName: str(getKey(name, "givenName"), "name.givenName", 100),
    familyName: str(getKey(name, "familyName"), "name.familyName", 100),
    displayName: str(getKey(r, "displayName"), "displayName", 100) || str(getKey(name, "formatted"), "name.formatted", 100),
    email: email.toLowerCase(),
    active: bool(getKey(r, "active"), true),
  };
}
const flowplanName = (u: UserInput) => (u.displayName || [u.givenName, u.familyName].filter(Boolean).join(" ") || u.userName).slice(0, 80);
type GroupInput = { displayName: string; externalId: string | null; members: string[] | null };
function groupInput(r: unknown): GroupInput {
  if (!r || typeof r !== "object" || Array.isArray(r)) throw new ScimError(400, "A JSON object is expected.", "invalidSyntax");
  const displayName = str(getKey(r, "displayName"), "displayName");
  if (!displayName) throw new ScimError(400, "displayName is required.", "invalidValue");
  const raw = getKey(r, "members");
  let members: string[] | null = null;
  if (raw !== undefined && raw !== null) {
    if (!Array.isArray(raw)) throw new ScimError(400, "members must be a list.", "invalidValue");
    if (raw.length > 50_000) throw new ScimError(400, "Too many members.", "invalidValue");
    members = raw.map((m) => str(getKey(m, "value"), "members.value", 100)).filter((v): v is string => !!v);
  }
  return { displayName, externalId: str(getKey(r, "externalId"), "externalId"), members };
}

// ---- PATCH (RFC 7644 §3.5.2) ----

function setKey(obj: Json, key: string, value: unknown) {
  const existing = Object.keys(obj).find((k) => k.toLowerCase() === key.toLowerCase());
  if (value === undefined) {
    if (existing) delete obj[existing];
  } else obj[existing ?? key] = value;
}
function containerFor(resource: Json, segments: string[]) {
  let obj = resource;
  for (const segment of segments.slice(0, -1)) {
    let next = getKey(obj, segment);
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      next = {};
      setKey(obj, segment, next);
    }
    obj = next as Json;
  }
  return obj;
}
const valueOf = (item: unknown) => (item && typeof item === "object" ? getKey(item, "value") : item);
function sameValue(a: unknown, b: unknown) {
  const x = valueOf(a),
    y = valueOf(b);
  return x !== undefined && y !== undefined && String(x) === String(y);
}
function merge(target: unknown, value: unknown) {
  if (target && typeof target === "object" && !Array.isArray(target) && value && typeof value === "object" && !Array.isArray(value)) {
    const out = { ...(target as Json) };
    for (const [k, v] of Object.entries(value as Json)) setKey(out, k, v);
    return out;
  }
  return value;
}
// The attribute/value pairs an "eq" filter names (to create a missing value).
function equalities(filter: Filter): Json {
  if (filter.kind === "cmp" && filter.op === "eq" && filter.path.length === 1) return { [filter.path[0]]: filter.value };
  if (filter.kind === "and") return { ...equalities(filter.left), ...equalities(filter.right) };
  return {};
}
function applyAt(resource: Json, path: PatchPath, op: string, value: unknown) {
  const container = containerFor(resource, path.attr);
  const key = path.attr[path.attr.length - 1];
  const current = getKey(container, key);
  if (!path.filter) {
    if (op === "remove") {
      // Entra ID removes members by listing them as the value.
      if (Array.isArray(current) && Array.isArray(value)) setKey(container, key, current.filter((c) => !value.some((v) => sameValue(c, v))));
      else setKey(container, key, undefined);
      return;
    }
    if (Array.isArray(current) || Array.isArray(value)) {
      const list = Array.isArray(value) ? value : [value];
      if (op === "replace") return setKey(container, key, list);
      const existing = Array.isArray(current) ? [...current] : current === undefined || current === null ? [] : [current];
      for (const item of list) if (!existing.some((e) => sameValue(e, item))) existing.push(item);
      return setKey(container, key, existing);
    }
    return setKey(container, key, op === "add" || op === "replace" ? merge(current, value) : value);
  }
  const list = Array.isArray(current) ? [...current] : [];
  const hit = (item: unknown) => matches(item, path.filter!);
  if (op === "remove") {
    if (path.sub) {
      for (const item of list) if (hit(item) && item && typeof item === "object") setKey(item as Json, path.sub, undefined);
      return setKey(container, key, list);
    }
    return setKey(container, key, list.filter((item) => !hit(item)));
  }
  const found = list.filter(hit);
  if (!found.length) {
    list.push(path.sub ? { ...equalities(path.filter), [path.sub]: value } : merge(equalities(path.filter), value));
    return setKey(container, key, list);
  }
  setKey(
    container,
    key,
    list.map((item) => (!hit(item) ? item : path.sub ? merge(item, { [path.sub]: value }) : merge(item, value))),
  );
}
function applyPatch(resource: Json, body: unknown): Json {
  const ops = getKey(body, "Operations");
  if (!Array.isArray(ops) || !ops.length) throw new ScimError(400, "Operations are required.", "invalidSyntax");
  if (ops.length > 1000) throw new ScimError(400, "Too many operations.", "tooMany");
  const result = structuredClone(resource);
  for (const operation of ops) {
    const op = String(getKey(operation, "op") || "").toLowerCase();
    if (!["add", "replace", "remove"].includes(op)) throw new ScimError(400, `Unknown operation ${String(getKey(operation, "op"))}.`, "invalidSyntax");
    const rawPath = getKey(operation, "path");
    const value = getKey(operation, "value");
    try {
      if (typeof rawPath === "string" && rawPath.trim()) applyAt(result, parsePatchPath(rawPath), op, value);
      else {
        if (op === "remove") throw new ScimError(400, "remove needs a path.", "noTarget");
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new ScimError(400, "The value must be an object.", "invalidValue");
        for (const [k, v] of Object.entries(value as Json)) applyAt(result, { attr: attributePath(k) }, op, v);
      }
    } catch (e) {
      if (e instanceof ScimFilterError) throw new ScimError(400, e.message, "invalidPath");
      throw e;
    }
  }
  return result;
}

// ---- Users ----

function setActive(userId: string, active: boolean) {
  const user = one<{ disabled: number }>("SELECT disabled FROM users WHERE id=?", userId);
  if (!user) return;
  if (!active && !user.disabled) {
    if (lastAdmin(userId)) throw new ScimError(409, "The last administrator cannot be deactivated.", "mutability");
    setUserDisabled(userId, true);
    audit("", "scim.user.deactivate", userId);
  } else if (active && user.disabled) {
    setUserDisabled(userId, false);
    audit("", "scim.user.activate", userId);
  }
}
const isLocal = (userId: string) => !!one("SELECT 1 FROM local_accounts WHERE user_id=?", userId);
function updateProfile(userId: string, input: UserInput) {
  run("UPDATE users SET name=? WHERE id=?", flowplanName(input), userId);
  // An account with e-mail and password keeps its address: it signs in with it.
  if (input.email && !isLocal(userId)) run("UPDATE users SET email=? WHERE id=?", input.email, userId);
}
function uniqueUserName(userName: string, except?: string) {
  if (one("SELECT 1 FROM scim_users WHERE user_name=? AND id<>?", userName, except || ""))
    throw new ScimError(409, "userName is already in use.", "uniqueness");
}

function createUser(body: unknown) {
  const input = userInput(body);
  return transaction(() => {
    uniqueUserName(input.userName);
    const subject = `scim:${input.externalId || input.userName}`;
    let userId =
      one<{ id: string }>("SELECT id FROM users WHERE subject=?", subject)?.id ||
      (input.email
        ? one<{ id: string }>(
            `SELECT id FROM users WHERE lower(email)=lower(?) AND email<>'' AND demo_until IS NULL AND subject NOT LIKE 'deleted:%' AND subject<>'local-development'
               AND id NOT IN (SELECT user_id FROM scim_users) ORDER BY created_at LIMIT 1`,
            input.email,
          )?.id
        : undefined);
    if (userId && one("SELECT 1 FROM scim_users WHERE user_id=?", userId)) throw new ScimError(409, "This account is already provisioned.", "uniqueness");
    if (!userId) {
      userId = id();
      run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", userId, subject, flowplanName(input), input.email);
    } else updateProfile(userId, input);
    const scimId = id();
    const now = Date.now();
    run(
      "INSERT INTO scim_users(id,user_id,user_name,external_id,given_name,family_name,display_name,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,1,?,?)",
      scimId,
      userId,
      input.userName,
      input.externalId,
      input.givenName,
      input.familyName,
      input.displayName,
      now,
      now,
    );
    setActive(userId, input.active);
    reapplySsoUser(userId);
    audit("", "scim.user.create", userId, input.userName);
    return renderUser(userRow(scimId)!);
  });
}
function replaceUser(scimId: string, input: UserInput) {
  return transaction(() => {
    const row = userRow(scimId);
    if (!row) throw new ScimError(404, "User not found.");
    uniqueUserName(input.userName, scimId);
    run(
      "UPDATE scim_users SET user_name=?,external_id=?,given_name=?,family_name=?,display_name=?,version=version+1,updated_at=? WHERE id=?",
      input.userName,
      input.externalId,
      input.givenName,
      input.familyName,
      input.displayName,
      Date.now(),
      scimId,
    );
    updateProfile(row.user_id, input);
    setActive(row.user_id, input.active);
    return renderUser(userRow(scimId)!);
  });
}
function deleteUser(scimId: string) {
  transaction(() => {
    const row = userRow(scimId);
    if (!row) throw new ScimError(404, "User not found.");
    setActive(row.user_id, false);
    run("DELETE FROM scim_group_members WHERE user_id=?", row.user_id);
    run("DELETE FROM scim_users WHERE id=?", scimId);
    audit("", "scim.user.delete", row.user_id, row.user_name);
  });
}

// ---- Groups ----

function memberUserIds(scimIds: string[]) {
  const ids = new Set<string>();
  for (const scimId of scimIds) {
    const userId = one<{ user_id: string }>("SELECT user_id FROM scim_users WHERE id=?", scimId)?.user_id;
    if (userId) ids.add(userId);
  }
  return ids;
}
function uniqueGroupName(name: string, except?: string) {
  if (one("SELECT 1 FROM scim_groups WHERE display_name=? AND id<>?", name, except || ""))
    throw new ScimError(409, "displayName is already in use.", "uniqueness");
}
// Sets the members; returns everyone whose groups changed.
function setMembers(groupId: string, wanted: Set<string>) {
  const current = new Set(all<{ user_id: string }>("SELECT user_id FROM scim_group_members WHERE group_id=?", groupId).map((m) => m.user_id));
  const changed = new Set<string>();
  for (const userId of current)
    if (!wanted.has(userId)) {
      run("DELETE FROM scim_group_members WHERE group_id=? AND user_id=?", groupId, userId);
      changed.add(userId);
    }
  for (const userId of wanted)
    if (!current.has(userId)) {
      run("INSERT INTO scim_group_members(group_id,user_id) VALUES(?,?)", groupId, userId);
      changed.add(userId);
    }
  return changed;
}
const groupMembers = (groupId: string) => all<{ user_id: string }>("SELECT user_id FROM scim_group_members WHERE group_id=?", groupId).map((m) => m.user_id);

function createGroup(body: unknown) {
  const input = groupInput(body);
  return transaction(() => {
    uniqueGroupName(input.displayName);
    const groupId = id();
    const now = Date.now();
    run("INSERT INTO scim_groups(id,display_name,external_id,version,created_at,updated_at) VALUES(?,?,?,1,?,?)", groupId, input.displayName, input.externalId, now, now);
    for (const userId of setMembers(groupId, memberUserIds(input.members || []))) reapplySsoUser(userId);
    audit("", "scim.group.create", groupId, input.displayName);
    return renderGroup(groupRow(groupId)!);
  });
}
function replaceGroup(groupId: string, input: GroupInput) {
  return transaction(() => {
    const row = groupRow(groupId);
    if (!row) throw new ScimError(404, "Group not found.");
    uniqueGroupName(input.displayName, groupId);
    const renamed = row.display_name !== input.displayName;
    run("UPDATE scim_groups SET display_name=?,external_id=?,version=version+1,updated_at=? WHERE id=?", input.displayName, input.externalId, Date.now(), groupId);
    const affected = input.members ? setMembers(groupId, memberUserIds(input.members)) : new Set<string>();
    if (renamed) for (const userId of groupMembers(groupId)) affected.add(userId);
    for (const userId of affected) reapplySsoUser(userId);
    return renderGroup(groupRow(groupId)!);
  });
}
function deleteGroup(groupId: string) {
  transaction(() => {
    const row = groupRow(groupId);
    if (!row) throw new ScimError(404, "Group not found.");
    const members = groupMembers(groupId);
    run("DELETE FROM scim_groups WHERE id=?", groupId);
    for (const userId of members) reapplySsoUser(userId);
    audit("", "scim.group.delete", groupId, row.display_name);
  });
}

// ---- Listing ----

function listParams(query: URLSearchParams) {
  const start = Math.max(1, Math.floor(Number(query.get("startIndex")) || 1));
  const rawCount = query.get("count");
  const count = rawCount === null ? 100 : Math.min(MAX_COUNT, Math.max(0, Math.floor(Number(rawCount) || 0)));
  let filter: Filter | null = null;
  const raw = query.get("filter");
  if (raw)
    try {
      filter = parseFilter(raw);
    } catch (e) {
      throw new ScimError(400, e instanceof Error ? e.message : "Invalid filter.", "invalidFilter");
    }
  return { start, count, filter };
}
// "attributes" and "excludedAttributes" (top-level names); id and schemas
// always stay.
function project(resource: Json, query: URLSearchParams) {
  const names = (key: string) =>
    (query.get(key) || "")
      .split(",")
      .map((a) => a.trim())
      .filter(Boolean)
      .map((a) => attributePathSafe(a)[0]?.toLowerCase())
      .filter(Boolean);
  const include = names("attributes");
  const exclude = names("excludedAttributes");
  const out: Json = {};
  for (const [k, v] of Object.entries(resource)) {
    const lower = k.toLowerCase();
    const always = lower === "id" || lower === "schemas";
    if (!always && include.length && !include.includes(lower)) continue;
    if (!always && exclude.includes(lower)) continue;
    out[k] = v;
  }
  return out;
}
function attributePathSafe(a: string) {
  try {
    return attributePath(a);
  } catch {
    return [];
  }
}
function list(resources: Json[], query: URLSearchParams) {
  const { start, count, filter } = listParams(query);
  const matching = filter ? resources.filter((r) => matches(r, filter)) : resources;
  return {
    schemas: [LIST_SCHEMA],
    totalResults: matching.length,
    startIndex: start,
    itemsPerPage: Math.min(count, Math.max(0, matching.length - start + 1)),
    Resources: matching.slice(start - 1, start - 1 + count).map((r) => project(r, query)),
  };
}

// ---- Discovery ----

function serviceProviderConfig() {
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
    documentationUri: "https://docs.flowplan.org/en/sign-in#user-provisioning-scim",
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: MAX_COUNT },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: "oauthbearertoken",
        name: "Bearer token",
        description: "A SCIM token from Administration → Users → User provisioning.",
        primary: true,
      },
    ],
    meta: { resourceType: "ServiceProviderConfig", location: `${scimBase()}/ServiceProviderConfig` },
  };
}
const resourceTypes = () => [
  {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
    id: "User",
    name: "User",
    endpoint: "/Users",
    description: "Flowplan account",
    schema: USER_SCHEMA,
    schemaExtensions: [{ schema: ENTERPRISE_SCHEMA, required: false }],
    meta: { resourceType: "ResourceType", location: `${scimBase()}/ResourceTypes/User` },
  },
  {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
    id: "Group",
    name: "Group",
    endpoint: "/Groups",
    description: "Directory group, matched by the SSO group mappings",
    schema: GROUP_SCHEMA,
    meta: { resourceType: "ResourceType", location: `${scimBase()}/ResourceTypes/Group` },
  },
];
const attribute = (name: string, extra: Json = {}) => ({
  name,
  type: "string",
  multiValued: false,
  required: false,
  caseExact: false,
  mutability: "readWrite",
  returned: "default",
  uniqueness: "none",
  ...extra,
});
const schemas = () => [
  {
    id: USER_SCHEMA,
    name: "User",
    description: "User Account",
    attributes: [
      attribute("userName", { required: true, uniqueness: "server" }),
      attribute("externalId", { caseExact: true }),
      attribute("name", {
        type: "complex",
        subAttributes: [attribute("formatted"), attribute("givenName"), attribute("familyName")],
      }),
      attribute("displayName"),
      attribute("active", { type: "boolean" }),
      attribute("emails", {
        type: "complex",
        multiValued: true,
        subAttributes: [attribute("value"), attribute("type"), attribute("primary", { type: "boolean" })],
      }),
      attribute("groups", {
        type: "complex",
        multiValued: true,
        mutability: "readOnly",
        subAttributes: [attribute("value", { mutability: "readOnly" }), attribute("display", { mutability: "readOnly" })],
      }),
    ],
    meta: { resourceType: "Schema", location: `${scimBase()}/Schemas/${USER_SCHEMA}` },
  },
  {
    id: GROUP_SCHEMA,
    name: "Group",
    description: "Group",
    attributes: [
      attribute("displayName", { required: true, uniqueness: "server" }),
      attribute("externalId", { caseExact: true }),
      attribute("members", {
        type: "complex",
        multiValued: true,
        subAttributes: [attribute("value", { mutability: "immutable" }), attribute("display", { mutability: "readOnly" })],
      }),
    ],
    meta: { resourceType: "Schema", location: `${scimBase()}/Schemas/${GROUP_SCHEMA}` },
  },
];

// ---- Requests ----

function parseBody(body: string) {
  if (!body.trim()) throw new ScimError(400, "A JSON body is expected.", "invalidSyntax");
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new ScimError(400, "The body is not valid JSON.", "invalidSyntax");
  }
}
function patchSchema(body: unknown) {
  const s = getKey(body, "schemas");
  if (Array.isArray(s) && !s.includes(PATCH_SCHEMA)) throw new ScimError(400, "PATCH needs the PatchOp schema.", "invalidSyntax");
}

function route(req: ScimRequest): ScimResult {
  const [resource, resourceId, ...rest] = req.path;
  const method = req.method.toUpperCase();
  if (rest.length) throw new ScimError(404, "Not found.");
  const only = (...allowed: string[]) => {
    if (!allowed.includes(method)) throw new ScimError(405, "Method not allowed.");
  };
  switch (resource) {
    case "ServiceProviderConfig":
      only("GET");
      return { status: 200, body: serviceProviderConfig() };
    case "ResourceTypes": {
      only("GET");
      const types = resourceTypes();
      if (!resourceId) return { status: 200, body: { schemas: [LIST_SCHEMA], totalResults: types.length, startIndex: 1, itemsPerPage: types.length, Resources: types } };
      const type = types.find((t) => t.id === resourceId);
      if (!type) throw new ScimError(404, "Resource type not found.");
      return { status: 200, body: type };
    }
    case "Schemas": {
      only("GET");
      const all = schemas();
      if (!resourceId) return { status: 200, body: { schemas: [LIST_SCHEMA], totalResults: all.length, startIndex: 1, itemsPerPage: all.length, Resources: all } };
      const schema = all.find((s) => s.id === resourceId);
      if (!schema) throw new ScimError(404, "Schema not found.");
      return { status: 200, body: schema };
    }
    case "Users": {
      if (!resourceId) {
        only("GET", "POST");
        if (method === "POST") {
          const created = createUser(parseBody(req.body));
          return { status: 201, body: created, headers: { Location: String((created.meta as Json).location) } };
        }
        const users = all<UserRow>(`${USER_SELECT} ORDER BY s.created_at,s.id`).map(renderUser);
        return { status: 200, body: list(users, req.query) };
      }
      only("GET", "PUT", "PATCH", "DELETE");
      const row = userRow(resourceId);
      if (!row) throw new ScimError(404, "User not found.");
      if (method === "GET") return { status: 200, body: project(renderUser(row), req.query) };
      if (method === "DELETE") {
        deleteUser(resourceId);
        return { status: 204 };
      }
      const body = parseBody(req.body);
      if (method === "PUT") return { status: 200, body: replaceUser(resourceId, userInput(body)) };
      patchSchema(body);
      return { status: 200, body: replaceUser(resourceId, userInput(applyPatch(renderUser(row), body))) };
    }
    case "Groups": {
      if (!resourceId) {
        only("GET", "POST");
        if (method === "POST") {
          const created = createGroup(parseBody(req.body));
          return { status: 201, body: created, headers: { Location: String((created.meta as Json).location) } };
        }
        const withMembers = !/\bmembers\b/i.test(req.query.get("excludedAttributes") || "");
        const groups = all<GroupRow>("SELECT * FROM scim_groups ORDER BY created_at,id").map((g) => renderGroup(g, withMembers));
        return { status: 200, body: list(groups, req.query) };
      }
      only("GET", "PUT", "PATCH", "DELETE");
      const row = groupRow(resourceId);
      if (!row) throw new ScimError(404, "Group not found.");
      if (method === "GET") return { status: 200, body: project(renderGroup(row), req.query) };
      if (method === "DELETE") {
        deleteGroup(resourceId);
        return { status: 204 };
      }
      const body = parseBody(req.body);
      if (method === "PUT") return { status: 200, body: replaceGroup(resourceId, groupInput(body)) };
      patchSchema(body);
      const patched = applyPatch(renderGroup(row), body);
      // Members only change when the operations touched them.
      const input = groupInput(patched);
      return { status: 200, body: replaceGroup(resourceId, input) };
    }
    case "Me":
    case "Bulk":
      throw new ScimError(501, "Not supported.");
    default:
      throw new ScimError(404, "Not found.");
  }
}

// One SCIM request: authentication, the answer, and a line in the log of
// the last requests (shown in the administration).
export function handleScim(req: ScimRequest): ScimResult {
  let tokenId: string | null = null;
  let result: ScimResult;
  try {
    const token = tokenFromHeader(req.authorization);
    if (!token) throw new ScimError(401, "A valid SCIM bearer token is required.");
    tokenId = token.id;
    result = route(req);
  } catch (e) {
    const error =
      e instanceof ScimError
        ? e
        : (() => {
            console.error("SCIM request failed", e);
            return new ScimError(500, "Internal error.");
          })();
    result = { status: error.status, body: errorBody(error), ...(error.status === 401 ? { headers: { "WWW-Authenticate": 'Bearer realm="scim"' } } : {}) };
  }
  try {
    const detail = result.status >= 400 ? String((result.body as Json)?.detail || "") : "";
    run(
      "INSERT INTO scim_requests(at,method,path,status,token_id,detail) VALUES(?,?,?,?,?,?)",
      Date.now(),
      req.method.toUpperCase().slice(0, 10),
      `/${req.path.join("/")}`.slice(0, 200),
      result.status,
      tokenId,
      detail.slice(0, 300),
    );
    run("DELETE FROM scim_requests WHERE id<=(SELECT MAX(id) FROM scim_requests)-?", KEEP_REQUESTS);
  } catch (error) {
    console.error("SCIM request log failed", error);
  }
  return result;
}
