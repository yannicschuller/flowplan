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
await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", admin, `local:${admin}`, "Admin", "admin@example.com");
await run("INSERT INTO local_accounts(user_id,email,password_hash,is_admin,email_verified,created_at) VALUES(?,?,?,1,1,?)", admin, "admin@example.com", "x", Date.now());
const { token } = await createScimToken(admin, "Okta");

async function scim(method: string, path: string, body?: unknown, auth = `Bearer ${token}`) {
  const [p, q = ""] = path.split("?");
  const result = await handleScim({
    method,
    path: p.split("/").filter(Boolean),
    query: new URLSearchParams(q),
    authorization: auth,
    body: body === undefined ? "" : JSON.stringify(body),
  });
  return { status: result.status, body: result.body as Json, headers: result.headers || {} };
}
const disabled = async (userId: string) => (await one<{ disabled: number }>("SELECT disabled FROM users WHERE id=?", userId))?.disabled;
const userIdOf = async (scimId: string) => (await one<{ user_id: string }>("SELECT user_id FROM scim_users WHERE id=?", scimId))!.user_id;
async function session(userId: string, groups: string[] = []) {
  await run(
    "INSERT INTO sessions(token,user_id,groups_json,expires,created_at,sso) VALUES(?,?,?,?,?,1)",
    id(),
    userId,
    JSON.stringify(groups),
    Date.now() + 3600_000,
    Date.now(),
  );
}
const sessions = async (userId: string) => Number((await one<{ n: number }>("SELECT COUNT(*) n FROM sessions WHERE user_id=?", userId))?.n);

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

test("requests need a SCIM token; discovery describes the server", async () => {
  const anonymous = await scim("GET", "/Users", undefined, "");
  assert.equal(anonymous.status, 401);
  assert.deepEqual(anonymous.body.schemas, ["urn:ietf:params:scim:api:messages:2.0:Error"]);
  assert.equal(anonymous.body.status, "401");
  assert.equal((await scim("GET", "/Users", undefined, "Bearer fp_notascimtokenatallxxxxxxxx")).status, 401);
  const config = await scim("GET", "/ServiceProviderConfig");
  assert.equal(config.status, 200);
  assert.equal(config.body.patch.supported, true);
  assert.equal(config.body.bulk.supported, false);
  assert.equal((await scim("GET", "/ResourceTypes")).body.totalResults, 2);
  assert.equal((await scim("GET", "/ResourceTypes/User")).body.endpoint, "/Users");
  assert.equal((await scim("GET", "/Schemas/urn:ietf:params:scim:schemas:core:2.0:Group")).body.name, "Group");
  assert.equal((await scim("GET", "/Nope")).status, 404);
  assert.equal((await scim("POST", "/Bulk", {})).status, 501);
});

test("a revoked token no longer works", async () => {
  const extra = await createScimToken(admin, "Temporary");
  assert.equal((await scim("GET", "/Users", undefined, `Bearer ${extra.token}`)).status, 200);
  await revokeScimToken(admin, extra.id);
  assert.equal((await scim("GET", "/Users", undefined, `Bearer ${extra.token}`)).status, 401);
  // Only the hash is stored.
  assert.equal(await one("SELECT 1 FROM scim_tokens WHERE token_hash=?", token), undefined);
});

test("Okta creates a user; it is found by filter and paginated", async () => {
  const created = await scim("POST", "/Users", okta("bjensen@example.com"));
  assert.equal(created.status, 201);
  assert.equal(created.body.userName, "bjensen@example.com");
  assert.equal(created.body.active, true);
  assert.equal(created.body.emails[0].value, "bjensen@example.com");
  assert.equal(created.body.meta.resourceType, "User");
  assert.equal(created.headers.Location, `https://flowplan.example.com/api/scim/v2/Users/${created.body.id}`);
  assert.equal(created.body.password, undefined);
  const user = (await one<{ subject: string; name: string; email: string }>("SELECT subject,name,email FROM users WHERE id=?", await userIdOf(created.body.id)))!;
  assert.equal(user.subject, "scim:00u-bjensen");
  assert.equal(user.name, "Babs Jensen");
  // Okta looks a user up before creating it.
  const found = await scim("GET", `/Users?filter=${encodeURIComponent('userName eq "BJENSEN@example.com"')}&startIndex=1&count=100`);
  assert.equal(found.body.totalResults, 1);
  assert.equal(found.body.Resources[0].id, created.body.id);
  assert.deepEqual(found.body.schemas, ["urn:ietf:params:scim:api:messages:2.0:ListResponse"]);
  assert.equal((await scim("GET", `/Users?filter=${encodeURIComponent('userName eq "nobody@example.com"')}`)).body.totalResults, 0);
  await scim("POST", "/Users", okta("second@example.com"));
  await scim("POST", "/Users", okta("third@example.com"));
  const page = await scim("GET", "/Users?startIndex=2&count=1");
  assert.equal(page.body.totalResults, 3);
  assert.equal(page.body.itemsPerPage, 1);
  assert.equal(page.body.Resources[0].userName, "second@example.com");
  assert.equal((await scim("GET", "/Users?count=0")).body.Resources.length, 0);
  // The same userName again: a uniqueness conflict.
  const duplicate = await scim("POST", "/Users", okta("bjensen@example.com"));
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.scimType, "uniqueness");
  assert.equal((await scim("GET", `/Users?filter=${encodeURIComponent("userName eq")}`)).body.scimType, "invalidFilter");
});

test("an existing account with an unconfirmed address is not taken over", async () => {
  // Audit F2: provisioning must not land in an account whose address nobody vouched for.
  const squatter = id();
  await run("INSERT INTO users(id,subject,name,email,email_verified) VALUES(?,?,?,?,0)", squatter, `https://idp|${squatter}`, "Dave?", "dave@example.com");
  const created = await scim("POST", "/Users", okta("dave@example.com", { externalId: "dave" }));
  assert.equal(created.status, 201);
  assert.notEqual(await userIdOf(created.body.id), squatter);
});

test("an existing account with the same address is linked, not duplicated", async () => {
  const existing = id();
  await run("INSERT INTO users(id,subject,name,email,email_verified) VALUES(?,?,?,?,1)", existing, `https://idp|${existing}`, "Mia", "mia@example.com");
  const created = await scim("POST", "/Users", okta("mia@example.com", { externalId: "mia" }));
  assert.equal(created.status, 201);
  assert.equal(await userIdOf(created.body.id), existing);
  // Its OIDC subject stays.
  assert.equal((await one<{ subject: string }>("SELECT subject FROM users WHERE id=?", existing))!.subject, `https://idp|${existing}`);
});

test("active=false disables the account and ends its sessions (Okta and Entra style)", async () => {
  const created = await scim("POST", "/Users", okta("off@example.com"));
  const userId = await userIdOf(created.body.id);
  await session(userId);
  const okta1 = await scim("PATCH", `/Users/${created.body.id}`, {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    Operations: [{ op: "replace", value: { active: false } }],
  });
  assert.equal(okta1.status, 200);
  assert.equal(okta1.body.active, false);
  assert.equal(await disabled(userId), 1);
  assert.equal(await sessions(userId), 0);
  const on = await scim("PATCH", `/Users/${created.body.id}`, {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    Operations: [{ op: "Replace", path: "active", value: "True" }],
  });
  assert.equal(on.body.active, true);
  assert.equal(await disabled(userId), 0);
  // Okta's PUT with the whole user.
  const put = await scim("PUT", `/Users/${created.body.id}`, { ...okta("off@example.com"), active: false });
  assert.equal(put.status, 200);
  assert.equal(await disabled(userId), 1);
});

test("Entra ID patches: e-mail by filter, names, extension attributes", async () => {
  const created = await scim("POST", "/Users", {
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
  const patched = await scim("PATCH", `/Users/${created.body.id}`, {
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
  const user = (await one<{ name: string; email: string }>("SELECT name,email FROM users WHERE id=?", await userIdOf(created.body.id)))!;
  assert.deepEqual(user, { name: "Ryan Smyth", email: "ryan.smith@contoso.com" });
  // Errors in SCIM form.
  const bad = await scim("PATCH", `/Users/${created.body.id}`, { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "remove" }] });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.scimType, "noTarget");
  assert.equal((await scim("PATCH", `/Users/${created.body.id}`, { Operations: [{ op: "move", path: "x" }] })).status, 400);
  assert.equal((await scim("GET", "/Users/unknown")).status, 404);
});

test("groups follow the SSO mappings; membership changes apply at once", async () => {
  const owner = { id: admin, name: "Admin", email: "admin@example.com", groups: [], isAdmin: true, disabled: 0, created_at: "" } as unknown as Identity;
  const wid = await createWorkspace(admin, "Firma");
  const sales = ((await command(owner, { action: "group.create", workspaceId: wid, name: "Sales" })) as { id: string }).id;
  await command(owner, { action: "sso.mapping.add", workspaceId: wid, ssoGroup: "Flowplan Sales", role: "editor", groupId: sales });
  const a = (await scim("POST", "/Users", okta("anna@example.com"))).body;
  const b = (await scim("POST", "/Users", okta("ben@example.com"))).body;
  const role = async (scimId: string) => (await one<{ role: string }>("SELECT role FROM members WHERE workspace_id=? AND user_id=?", wid, await userIdOf(scimId)))?.role ?? null;
  const inSales = async (scimId: string) => !!(await one("SELECT 1 FROM group_members WHERE group_id=? AND user_id=?", sales, await userIdOf(scimId)));
  const group = await scim("POST", "/Groups", { schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"], displayName: "Flowplan Sales", members: [{ value: a.id }] });
  assert.equal(group.status, 201);
  assert.equal(group.body.members.length, 1);
  assert.equal(await role(a.id), "editor");
  assert.ok(await inSales(a.id));
  assert.equal(await role(b.id), null);
  assert.equal((await scim("GET", `/Users/${a.id}`)).body.groups[0].display, "Flowplan Sales");
  // Okta adds a member.
  await scim("PATCH", `/Groups/${group.body.id}`, {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    Operations: [{ op: "add", path: "members", value: [{ value: b.id, display: "ben@example.com" }] }],
  });
  assert.equal(await role(b.id), "editor");
  // Okta removes by filter, Entra by value list.
  await scim("PATCH", `/Groups/${group.body.id}`, {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    Operations: [{ op: "remove", path: `members[value eq "${a.id}"]` }],
  });
  assert.equal(await role(a.id), null);
  assert.ok(!(await inSales(a.id)));
  await scim("PATCH", `/Groups/${group.body.id}`, {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    Operations: [{ op: "Remove", path: "members", value: [{ value: b.id }] }],
  });
  assert.equal(await role(b.id), null);
  // Filter and excluded members as Entra asks.
  await scim("PUT", `/Groups/${group.body.id}`, { displayName: "Flowplan Sales", members: [{ value: a.id }, { value: b.id }] });
  assert.equal(await role(a.id), "editor");
  const listed = await scim("GET", `/Groups?filter=${encodeURIComponent('displayName eq "flowplan sales"')}&excludedAttributes=members`);
  assert.equal(listed.body.totalResults, 1);
  assert.equal(listed.body.Resources[0].members, undefined);
  // A rename no mapping matches removes what the mapping gave.
  await scim("PATCH", `/Groups/${group.body.id}`, {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    Operations: [{ op: "replace", value: { id: group.body.id, displayName: "Renamed" } }],
  });
  assert.equal(await role(a.id), null);
  await scim("PATCH", `/Groups/${group.body.id}`, {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    Operations: [{ op: "replace", path: "displayName", value: "Flowplan Sales" }],
  });
  assert.equal(await role(b.id), "editor");
  // OIDC groups of a live session stay next to the SCIM groups.
  await command(owner, { action: "sso.mapping.add", workspaceId: wid, ssoGroup: "oidc-viewers", role: "viewer" });
  const c = (await scim("POST", "/Users", okta("carla@example.com"))).body;
  await session(await userIdOf(c.id), ["oidc-viewers"]);
  await command(owner, { action: "sso.mapping.delete", workspaceId: wid, id: "none" });
  assert.equal(await role(c.id), "viewer");
  assert.equal((await scim("POST", "/Groups", { displayName: "FLOWPLAN SALES" })).status, 409);
  assert.equal((await scim("DELETE", `/Groups/${group.body.id}`)).status, 204);
  assert.equal(await role(a.id), null);
  assert.equal(await role(b.id), null);
  assert.equal((await scim("GET", `/Groups/${group.body.id}`)).status, 404);
});

test("DELETE deactivates and unlinks, never deletes", async () => {
  const created = await scim("POST", "/Users", okta("gone@example.com"));
  const userId = await userIdOf(created.body.id);
  await session(userId);
  assert.equal((await scim("DELETE", `/Users/${created.body.id}`)).status, 204);
  assert.equal((await scim("GET", `/Users/${created.body.id}`)).status, 404);
  assert.equal(await disabled(userId), 1);
  assert.equal(await sessions(userId), 0);
  assert.ok(await one("SELECT 1 FROM users WHERE id=?", userId));
  // Provisioned again: the same account comes back.
  const again = await scim("POST", "/Users", okta("gone@example.com"));
  assert.equal(await userIdOf(again.body.id), userId);
  assert.equal(await disabled(userId), 0);
});

test("the last administrator with a password is never deactivated", async () => {
  const linked = await scim("POST", "/Users", okta("admin@example.com"));
  assert.equal(await userIdOf(linked.body.id), admin);
  const off = await scim("PATCH", `/Users/${linked.body.id}`, { Operations: [{ op: "replace", path: "active", value: false }] });
  assert.equal(off.status, 409);
  assert.equal(await disabled(admin), 0);
  // Its e-mail address stays: it signs in with it.
  await scim("PUT", `/Users/${linked.body.id}`, okta("admin@example.com", { emails: [{ value: "other@example.com", primary: true }] }));
  assert.equal((await one<{ email: string }>("SELECT email FROM users WHERE id=?", admin))!.email, "admin@example.com");
});

test("the first OIDC sign-in claims a provisioned account", async () => {
  const created = await scim("POST", "/Users", okta("oidc@example.com", { externalId: "sub-123" }));
  const userId = await userIdOf(created.body.id);
  await claimProvisionedAccount("https://idp|other", "other", "oidc@example.com", false);
  assert.equal((await one<{ subject: string }>("SELECT subject FROM users WHERE id=?", userId))!.subject, "scim:sub-123");
  await claimProvisionedAccount("https://idp|sub-123", "sub-123", "", false);
  assert.equal((await one<{ subject: string }>("SELECT subject FROM users WHERE id=?", userId))!.subject, "https://idp|sub-123");
  const byMail = await scim("POST", "/Users", okta("verified@example.com", { externalId: "x-1" }));
  await claimProvisionedAccount("https://idp|y-2", "y-2", "Verified@example.com", true);
  assert.equal((await one<{ subject: string }>("SELECT subject FROM users WHERE id=?", await userIdOf(byMail.body.id)))!.subject, "https://idp|y-2");
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

test("the administration sees the last requests", async () => {
  const overview = await scimOverview();
  assert.equal(overview.baseUrl, "https://flowplan.example.com/api/scim/v2");
  assert.ok(await one("SELECT 1 FROM scim_requests WHERE status=401 AND token_id IS NULL"));
  assert.ok(overview.requests.length <= 25);
  assert.ok(await one("SELECT 1 FROM scim_requests WHERE method='POST' AND path='/Users' AND status=201"));
  assert.ok(overview.tokens.every((t) => !("token_hash" in t)));
});

test("a new address from SCIM is not confirmed by the old address's confirmation", async () => {
  // users-email/changed-without-resetting-email-verified
  const mallory = id();
  await run("INSERT INTO users(id,subject,name,email,email_verified) VALUES(?,?,?,?,1)", mallory, `https://idp|${mallory}`, "Mallory", "mallory@example.com");
  const created = await scim("POST", "/Users", okta("mallory@example.com", { externalId: "mallory" }));
  assert.equal(await userIdOf(created.body.id), mallory);
  const verified = async () => (await one<{ email: string; email_verified: number }>("SELECT email,email_verified FROM users WHERE id=?", mallory))!;
  // The same address again (case aside): the confirmation stays.
  await scim("PUT", `/Users/${created.body.id}`, okta("mallory@example.com", { externalId: "mallory", emails: [{ primary: true, value: "Mallory@example.com" }] }));
  assert.equal((await verified()).email_verified, 1);
  // Another address: nobody vouched for it yet.
  await scim("PUT", `/Users/${created.body.id}`, okta("mallory@example.com", { externalId: "mallory", emails: [{ primary: true, value: "victim2@example.com" }] }));
  assert.deepEqual({ ...(await verified()) }, { email: "victim2@example.com", email_verified: 0 });
});
