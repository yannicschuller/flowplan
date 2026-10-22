// SCIM 2.0 provisioning (lib/scim.ts) with Okta- and Entra-style payloads
// and the examples of RFC 7643/7644.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
const dir = mkdtempSync(join(tmpdir(), "flowplan-scim-"));
process.env.FLOWPLAN_DATA_DIR = dir;
process.env.APP_URL = "https://flowplan.example.com";
const { run, id, one } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command } = await import("../lib/api");
const { handleScim, createScimToken, revokeScimToken, claimProvisionedAccount, scimOverview } = await import("../lib/scim");
const { parseFilter, matches } = await import("../lib/scim-filter");

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const admin = id();
run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", admin, `local:${admin}`, "Admin", "admin@example.com");
run("INSERT INTO local_accounts(user_id,email,password_hash,is_admin,created_at) VALUES(?,?,?,1,?)", admin, "admin@example.com", "x", Date.now());
const { token } = createScimToken(admin, "Okta");

function scim(method: string, path: string, body?: unknown, auth = `Bearer ${token}`) {
  const [p, q = ""] = path.split("?");
  const result = handleScim({
    method,
    path: p.split("/").filter(Boolean),
    query: new URLSearchParams(q),
    authorization: auth,
    body: body === undefined ? "" : JSON.stringify(body),
  });
  return { status: result.status, body: result.body as Json, headers: result.headers || {} };
}
const disabled = (userId: string) => one<{ disabled: number }>("SELECT disabled FROM users WHERE id=?", userId)?.disabled;
const userIdOf = (scimId: string) => one<{ user_id: string }>("SELECT user_id FROM scim_users WHERE id=?", scimId)!.user_id;
function session(userId: string, groups: string[] = []) {
  run(
    "INSERT INTO sessions(token,user_id,groups_json,expires,created_at,sso) VALUES(?,?,?,?,?,1)",
    id(),
    userId,
    JSON.stringify(groups),
    Date.now() + 3600_000,
    Date.now(),
  );
}
const sessions = (userId: string) => Number(one<{ n: number }>("SELECT COUNT(*) n FROM sessions WHERE user_id=?", userId)?.n);

const okta = (userName: string, extra: Json = {}) => ({
  schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
  userName,
  name: { givenName: "Barbara", familyName: "Jensen" },
  emails: [{ primary: true, value: userName, type: "work" }],
  displayName: "Babs Jensen",
  locale: "en-US",
  externalId: `00u-${userName.split("@")[0]}`,
  groups: [],
  password: "never-stored",
  active: true,
  ...extra,
});

test("requests need a SCIM token; discovery describes the server", () => {
  const anonymous = scim("GET", "/Users", undefined, "");
  assert.equal(anonymous.status, 401);
  assert.deepEqual(anonymous.body.schemas, ["urn:ietf:params:scim:api:messages:2.0:Error"]);
  assert.equal(anonymous.body.status, "401");
  assert.equal(scim("GET", "/Users", undefined, "Bearer fp_notascimtokenatallxxxxxxxx").status, 401);
  const config = scim("GET", "/ServiceProviderConfig");
  assert.equal(config.status, 200);
  assert.equal(config.body.patch.supported, true);
  assert.equal(config.body.bulk.supported, false);
  assert.equal(scim("GET", "/ResourceTypes").body.totalResults, 2);
  assert.equal(scim("GET", "/ResourceTypes/User").body.endpoint, "/Users");
  assert.equal(scim("GET", "/Schemas/urn:ietf:params:scim:schemas:core:2.0:Group").body.name, "Group");
  assert.equal(scim("GET", "/Nope").status, 404);
  assert.equal(scim("POST", "/Bulk", {}).status, 501);
});

test("a revoked token no longer works", () => {
  const extra = createScimToken(admin, "Temporary");
  assert.equal(scim("GET", "/Users", undefined, `Bearer ${extra.token}`).status, 200);
  revokeScimToken(admin, extra.id);
  assert.equal(scim("GET", "/Users", undefined, `Bearer ${extra.token}`).status, 401);
  // Only the hash is stored.
  assert.equal(one("SELECT 1 FROM scim_tokens WHERE token_hash=?", token), undefined);
});

test("Okta creates a user; it is found by filter and paginated", () => {
  const created = scim("POST", "/Users", okta("bjensen@example.com"));
  assert.equal(created.status, 201);
  assert.equal(created.body.userName, "bjensen@example.com");
  assert.equal(created.body.active, true);
  assert.equal(created.body.emails[0].value, "bjensen@example.com");
  assert.equal(created.body.meta.resourceType, "User");
  assert.equal(created.headers.Location, `https://flowplan.example.com/api/scim/v2/Users/${created.body.id}`);
  assert.equal(created.body.password, undefined);
  const user = one<{ subject: string; name: string; email: string }>("SELECT subject,name,email FROM users WHERE id=?", userIdOf(created.body.id))!;
  assert.equal(user.subject, "scim:00u-bjensen");
  assert.equal(user.name, "Babs Jensen");
  // Okta looks a user up before creating it.
  const found = scim("GET", `/Users?filter=${encodeURIComponent('userName eq "BJENSEN@example.com"')}&startIndex=1&count=100`);
  assert.equal(found.body.totalResults, 1);
  assert.equal(found.body.Resources[0].id, created.body.id);
  assert.deepEqual(found.body.schemas, ["urn:ietf:params:scim:api:messages:2.0:ListResponse"]);
  assert.equal(scim("GET", `/Users?filter=${encodeURIComponent('userName eq "nobody@example.com"')}`).body.totalResults, 0);
  scim("POST", "/Users", okta("second@example.com"));
  scim("POST", "/Users", okta("third@example.com"));
  const page = scim("GET", "/Users?startIndex=2&count=1");
  assert.equal(page.body.totalResults, 3);
  assert.equal(page.body.itemsPerPage, 1);
  assert.equal(page.body.Resources[0].userName, "second@example.com");
  assert.equal(scim("GET", "/Users?count=0").body.Resources.length, 0);
  // The same userName again: a uniqueness conflict.
  const duplicate = scim("POST", "/Users", okta("bjensen@example.com"));
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.scimType, "uniqueness");
  assert.equal(scim("GET", `/Users?filter=${encodeURIComponent("userName eq")}`).body.scimType, "invalidFilter");
});

test("an existing account with the same address is linked, not duplicated", () => {
  const existing = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", existing, `https://idp|${existing}`, "Mia", "mia@example.com");
  const created = scim("POST", "/Users", okta("mia@example.com", { externalId: "mia" }));
  assert.equal(created.status, 201);
  assert.equal(userIdOf(created.body.id), existing);
  // Its OIDC subject stays.
  assert.equal(one<{ subject: string }>("SELECT subject FROM users WHERE id=?", existing)!.subject, `https://idp|${existing}`);
});

test("active=false disables the account and ends its sessions (Okta and Entra style)", () => {
  const created = scim("POST", "/Users", okta("off@example.com"));
  const userId = userIdOf(created.body.id);
  session(userId);
  const okta1 = scim("PATCH", `/Users/${created.body.id}`, {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    Operations: [{ op: "replace", value: { active: false } }],
  });
  assert.equal(okta1.status, 200);
  assert.equal(okta1.body.active, false);
  assert.equal(disabled(userId), 1);
  assert.equal(sessions(userId), 0);
  const on = scim("PATCH", `/Users/${created.body.id}`, {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    Operations: [{ op: "Replace", path: "active", value: "True" }],
  });
  assert.equal(on.body.active, true);
  assert.equal(disabled(userId), 0);
  // Okta's PUT with the whole user.
  const put = scim("PUT", `/Users/${created.body.id}`, { ...okta("off@example.com"), active: false });
  assert.equal(put.status, 200);
  assert.equal(disabled(userId), 1);
});

test("Entra ID patches: e-mail by filter, names, extension attributes", () => {
  const created = scim("POST", "/Users", {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User", "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User"],
    externalId: "ryan",
    userName: "ryan@contoso.com",
    active: true,
    displayName: "Ryan Smith",
    emails: [{ primary: true, type: "work", value: "ryan@contoso.com" }],
    name: { familyName: "Smith", givenName: "Ryan", formatted: "Ryan Smith" },
    "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User": { department: "Sales" },
  });
  assert.equal(created.status, 201);
  const patched = scim("PATCH", `/Users/${created.body.id}`, {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    Operations: [
      { op: "Replace", path: 'emails[type eq "work"].value', value: "ryan.smith@contoso.com" },
      { op: "Replace", path: "name.familyName", value: "Smyth" },
      { op: "Add", path: "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:manager", value: "x" },
      { op: "Replace", path: "displayName", value: "Ryan Smyth" },
    ],
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.emails[0].value, "ryan.smith@contoso.com");
  assert.equal(patched.body.name.familyName, "Smyth");
  const user = one<{ name: string; email: string }>("SELECT name,email FROM users WHERE id=?", userIdOf(created.body.id))!;
  assert.deepEqual(user, { name: "Ryan Smyth", email: "ryan.smith@contoso.com" });
  // Errors in SCIM form.
  const bad = scim("PATCH", `/Users/${created.body.id}`, { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "remove" }] });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.scimType, "noTarget");
  assert.equal(scim("PATCH", `/Users/${created.body.id}`, { Operations: [{ op: "move", path: "x" }] }).status, 400);
  assert.equal(scim("GET", "/Users/unknown").status, 404);
});

test("groups follow the SSO mappings; membership changes apply at once", () => {
  const owner = { id: admin, name: "Admin", email: "admin@example.com", groups: [], isAdmin: true, disabled: 0, created_at: "" } as unknown as Identity;
  const wid = createWorkspace(admin, "Firma");
  const sales = (command(owner, { action: "group.create", workspaceId: wid, name: "Sales" }) as { id: string }).id;
  command(owner, { action: "sso.mapping.add", workspaceId: wid, ssoGroup: "Flowplan Sales", role: "editor", groupId: sales });
  const a = scim("POST", "/Users", okta("anna@example.com")).body;
  const b = scim("POST", "/Users", okta("ben@example.com")).body;
  const role = (scimId: string) => one<{ role: string }>("SELECT role FROM members WHERE workspace_id=? AND user_id=?", wid, userIdOf(scimId))?.role ?? null;
  const inSales = (scimId: string) => !!one("SELECT 1 FROM group_members WHERE group_id=? AND user_id=?", sales, userIdOf(scimId));
  const group = scim("POST", "/Groups", { schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"], displayName: "Flowplan Sales", members: [{ value: a.id }] });
  assert.equal(group.status, 201);
  assert.equal(group.body.members.length, 1);
  assert.equal(role(a.id), "editor");
  assert.ok(inSales(a.id));
  assert.equal(role(b.id), null);
  assert.equal(scim("GET", `/Users/${a.id}`).body.groups[0].display, "Flowplan Sales");
  // Okta adds a member.
  scim("PATCH", `/Groups/${group.body.id}`, {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    Operations: [{ op: "add", path: "members", value: [{ value: b.id, display: "ben@example.com" }] }],
  });
  assert.equal(role(b.id), "editor");
  // Okta removes by filter, Entra by value list.
  scim("PATCH", `/Groups/${group.body.id}`, {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    Operations: [{ op: "remove", path: `members[value eq "${a.id}"]` }],
  });
  assert.equal(role(a.id), null);
  assert.ok(!inSales(a.id));
  scim("PATCH", `/Groups/${group.body.id}`, {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    Operations: [{ op: "Remove", path: "members", value: [{ value: b.id }] }],
  });
  assert.equal(role(b.id), null);
  // Filter and excluded members as Entra asks.
  scim("PUT", `/Groups/${group.body.id}`, { displayName: "Flowplan Sales", members: [{ value: a.id }, { value: b.id }] });
  assert.equal(role(a.id), "editor");
  const listed = scim("GET", `/Groups?filter=${encodeURIComponent('displayName eq "flowplan sales"')}&excludedAttributes=members`);
  assert.equal(listed.body.totalResults, 1);
  assert.equal(listed.body.Resources[0].members, undefined);
  // A rename no mapping matches removes what the mapping gave.
  scim("PATCH", `/Groups/${group.body.id}`, {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    Operations: [{ op: "replace", value: { id: group.body.id, displayName: "Renamed" } }],
  });
  assert.equal(role(a.id), null);
  scim("PATCH", `/Groups/${group.body.id}`, {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    Operations: [{ op: "replace", path: "displayName", value: "Flowplan Sales" }],
  });
  assert.equal(role(b.id), "editor");
  // OIDC groups of a live session stay next to the SCIM groups.
  command(owner, { action: "sso.mapping.add", workspaceId: wid, ssoGroup: "oidc-viewers", role: "viewer" });
  const c = scim("POST", "/Users", okta("carla@example.com")).body;
  session(userIdOf(c.id), ["oidc-viewers"]);
  command(owner, { action: "sso.mapping.delete", workspaceId: wid, id: "none" });
  assert.equal(role(c.id), "viewer");
  assert.equal(scim("POST", "/Groups", { displayName: "FLOWPLAN SALES" }).status, 409);
  assert.equal(scim("DELETE", `/Groups/${group.body.id}`).status, 204);
  assert.equal(role(a.id), null);
  assert.equal(role(b.id), null);
  assert.equal(scim("GET", `/Groups/${group.body.id}`).status, 404);
});

test("DELETE deactivates and unlinks, never deletes", () => {
  const created = scim("POST", "/Users", okta("gone@example.com"));
  const userId = userIdOf(created.body.id);
  session(userId);
  assert.equal(scim("DELETE", `/Users/${created.body.id}`).status, 204);
  assert.equal(scim("GET", `/Users/${created.body.id}`).status, 404);
  assert.equal(disabled(userId), 1);
  assert.equal(sessions(userId), 0);
  assert.ok(one("SELECT 1 FROM users WHERE id=?", userId));
  // Provisioned again: the same account comes back.
  const again = scim("POST", "/Users", okta("gone@example.com"));
  assert.equal(userIdOf(again.body.id), userId);
  assert.equal(disabled(userId), 0);
});

test("the last administrator with a password is never deactivated", () => {
  const linked = scim("POST", "/Users", okta("admin@example.com"));
  assert.equal(userIdOf(linked.body.id), admin);
  const off = scim("PATCH", `/Users/${linked.body.id}`, { Operations: [{ op: "replace", path: "active", value: false }] });
  assert.equal(off.status, 409);
  assert.equal(disabled(admin), 0);
  // Its e-mail address stays: it signs in with it.
  scim("PUT", `/Users/${linked.body.id}`, okta("admin@example.com", { emails: [{ value: "other@example.com", primary: true }] }));
  assert.equal(one<{ email: string }>("SELECT email FROM users WHERE id=?", admin)!.email, "admin@example.com");
});

test("the first OIDC sign-in claims a provisioned account", () => {
  const created = scim("POST", "/Users", okta("oidc@example.com", { externalId: "sub-123" }));
  const userId = userIdOf(created.body.id);
  claimProvisionedAccount("https://idp|other", "other", "oidc@example.com", false);
  assert.equal(one<{ subject: string }>("SELECT subject FROM users WHERE id=?", userId)!.subject, "scim:sub-123");
  claimProvisionedAccount("https://idp|sub-123", "sub-123", "", false);
  assert.equal(one<{ subject: string }>("SELECT subject FROM users WHERE id=?", userId)!.subject, "https://idp|sub-123");
  const byMail = scim("POST", "/Users", okta("verified@example.com", { externalId: "x-1" }));
  claimProvisionedAccount("https://idp|y-2", "y-2", "Verified@example.com", true);
  assert.equal(one<{ subject: string }>("SELECT subject FROM users WHERE id=?", userIdOf(byMail.body.id))!.subject, "https://idp|y-2");
});

test("filters: logic, value paths and case rules (RFC 7644 §3.4.2.2)", () => {
  const user = {
    id: "2819c223",
    externalId: "AbC",
    userName: "bjensen",
    name: { familyName: "Jensen" },
    emails: [
      { value: "bjensen@example.com", type: "work" },
      { value: "babs@jensen.org", type: "home" },
    ],
    meta: { lastModified: "2011-05-13T04:42:34Z" },
    active: true,
  };
  const ok = (f: string) => matches(user, parseFilter(f));
  assert.ok(ok('userName Eq "BJENSEN"'));
  assert.ok(ok('name.familyName co "ens"'));
  assert.ok(ok('userName sw "bj" and not (userName ew "x")'));
  assert.ok(ok('emails[type eq "work" and value co "@example.com"]'));
  assert.ok(!ok('emails[type eq "home" and value co "@example.com"]'));
  assert.ok(ok('emails co "jensen.org"'));
  assert.ok(ok('meta.lastModified gt "2011-05-13T04:42:34Z" or active eq true'));
  assert.ok(ok("title pr or userName pr"));
  assert.ok(!ok("title pr"));
  assert.ok(ok('externalId eq "AbC"'));
  assert.ok(!ok('externalId eq "abc"'));
  assert.ok(ok('urn:ietf:params:scim:schemas:core:2.0:User:userName eq "bjensen"'));
  assert.throws(() => parseFilter('userName eq "x" junk'));
  assert.throws(() => parseFilter("userName regex x"));
});

test("the administration sees the last requests", () => {
  const overview = scimOverview();
  assert.equal(overview.baseUrl, "https://flowplan.example.com/api/scim/v2");
  assert.ok(one("SELECT 1 FROM scim_requests WHERE status=401 AND token_id IS NULL"));
  assert.ok(overview.requests.length <= 25);
  assert.ok(one("SELECT 1 FROM scim_requests WHERE method='POST' AND path='/Users' AND status=201"));
  assert.ok(overview.tokens.every((t) => !("token_hash" in t)));
});
