// The admin API of hosted offerings (lib/admin-api.ts): 404 without its
// token, constant-time bearer check with security events and a lockout,
// never a session or personal API token, the User shape, and limits that
// round-trip with null = default, 0 = unlimited and an audit entry.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-admin-api-"));
delete process.env.FLOWPLAN_ADMIN_API_TOKEN;
const { run, all } = await import("../lib/db");
const { command } = await import("../lib/api");
const { saveInstanceSettings } = await import("../lib/instance-settings");
const { adminApi } = await import("../lib/admin-api");
const { securityWritesSettled } = await import("../lib/security-events");
const { createApiToken } = await import("../lib/api-tokens");
const limits = await import("../lib/user-limits");
type User = Parameters<typeof command>[0];

const TOKEN = "a".repeat(20) + "B".repeat(20);
const person = async (name: string, email: string) => {
  const id = randomUUID();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", id, `test:${id}`, name, email);
  return { id, name, email, groups: [], isAdmin: false } as never as User;
};
let address = 0;
// Each test from its own address: the lockout counts per address.
const call = (path: string, init: { method?: string; token?: string | null; body?: unknown; ip?: string; headers?: Record<string, string> } = {}) =>
  adminApi(
    new Request(`https://app.example.org/api/admin-api/${path}`, {
      method: init.method || "GET",
      headers: {
        "x-forwarded-for": init.ip || `198.51.100.${address}`,
        ...(init.token === null ? {} : { authorization: `Bearer ${init.token ?? TOKEN}` }),
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    }),
  );
beforeEach(() => {
  address++;
  process.env.FLOWPLAN_ADMIN_API_TOKEN = TOKEN;
});

test("404 for every path while the token is unset or too short", async () => {
  delete process.env.FLOWPLAN_ADMIN_API_TOKEN;
  assert.equal((await call("users?email=a@example.org")).status, 404);
  process.env.FLOWPLAN_ADMIN_API_TOKEN = "short-token";
  assert.equal((await call("users?email=a@example.org", { token: "short-token" })).status, 404);
});

test("wrong, missing, session and personal tokens are refused, recorded and locked out", async () => {
  const user = await person("Tom", "tom@example.org");
  const { token: personal } = await createApiToken(user, { name: "x", scope: "write" });
  assert.equal((await call("users?email=tom@example.org", { token: null })).status, 401);
  assert.equal((await call("users?email=tom@example.org", { token: "x".repeat(40) })).status, 401);
  assert.equal((await call("users?email=tom@example.org", { token: personal })).status, 401);
  assert.equal((await call("users?email=tom@example.org", { token: null, headers: { cookie: "flowplan_session=abc" } })).status, 401);
  await securityWritesSettled();
  assert.ok((await all("SELECT 1 FROM security_events WHERE kind='admin_api.refused'")).length >= 4);
  for (let i = 0; i < 6; i++) await call("users?email=tom@example.org", { token: "wrong" });
  // Ten failures: this address is locked out, even with the right token.
  assert.equal((await call("users?email=tom@example.org")).status, 429);
  assert.equal((await call("users?email=tom@example.org", { ip: "203.0.113.250" })).status, 200, "other addresses are not");
});

test("find by e-mail (exact, case-insensitive) and read one account", async () => {
  const anna = await person("Anna", "Anna.Beispiel@Example.org");
  await person("Annabel", "anna.beispiel@example.org.evil");
  const found = (await (await call("users?email=anna.beispiel@example.ORG")).json()) as { users: { id: string }[] };
  assert.deepEqual(found.users.map((u) => u.id), [anna.id]);
  assert.deepEqual(((await (await call("users?email=nobody@example.org")).json()) as { users: unknown[] }).users, []);
  assert.equal((await call("users")).status, 400);
  const res = await call(`users/${anna.id}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = await res.json();
  assert.deepEqual(Object.keys(body).sort(), ["createdAt", "effective", "email", "id", "limits", "name", "usage"]);
  assert.equal(body.email, "Anna.Beispiel@Example.org");
  assert.match(body.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(body.limits, { storageMb: null, workspaces: null, ai: null, aiTokensPerMonth: null });
  assert.deepEqual(body.effective, { storageMb: 0, workspaces: 0, ai: true, aiTokensPerMonth: 0 });
  assert.deepEqual(body.usage, { usedBytes: 0, ownedWorkspaces: 0, aiTokensThisMonth: 0 });
  assert.equal((await call(`users/${randomUUID()}`)).status, 404);
  assert.equal((await call("users/not-a-uuid")).status, 404);
  assert.equal((await call("other")).status, 404);
});

test("limits round-trip: partial updates, null = default, 0 = unlimited, idempotent, audited as admin-api", async () => {
  await saveInstanceSettings({ defaultUserStorageMb: 250, defaultUserWorkspaces: 10, defaultUserAi: false, defaultUserAiTokensPerMonth: null });
  try {
    const kim = await person("Kim", "kim@example.org");
    await limits.setUserLimits(kim.id, { uploadMb: 5 });
    const put = (body: unknown) => call(`users/${kim.id}/limits`, { method: "PUT", body });
    let res = await put({ storageMb: 10240, workspaces: 0, ai: true, aiTokensPerMonth: 500000 });
    assert.equal(res.status, 200);
    let body = await res.json();
    assert.deepEqual(body.limits, { storageMb: 10240, workspaces: 0, ai: true, aiTokensPerMonth: 500000 });
    assert.deepEqual(body.effective, { storageMb: 10240, workspaces: 0, ai: true, aiTokensPerMonth: 500000 });
    assert.equal((await limits.storedUserLimits(kim.id)).uploadMb, 5, "other limits stay");
    // Fields left out stay; the same body again changes nothing (no audit entry).
    await put({ storageMb: 10240 });
    body = await (await call(`users/${kim.id}`)).json();
    assert.equal(body.limits.aiTokensPerMonth, 500000);
    const audits = await all<{ actor_id: string; detail: string }>("SELECT actor_id,detail FROM audit WHERE action='admin.userLimits' AND resource_id=?", kim.id);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].actor_id, "admin-api");
    assert.deepEqual(JSON.parse(audits[0].detail), { storageMb: 10240, workspaces: 0, ai: true, aiTokensPerMonth: 500000 });
    // Plan ended: everything back to the instance defaults.
    body = await (await put({ storageMb: null, workspaces: null, ai: null, aiTokensPerMonth: null })).json();
    assert.deepEqual(body.limits, { storageMb: null, workspaces: null, ai: null, aiTokensPerMonth: null });
    assert.deepEqual(body.effective, { storageMb: 250, workspaces: 10, ai: false, aiTokensPerMonth: 0 });
    assert.deepEqual(await limits.storedUserLimits(kim.id), { uploadMb: 5 });
    // Invalid bodies and methods.
    assert.equal((await put({ storageMb: -1 })).status, 400);
    assert.equal((await put({ uploadMb: 5 })).status, 400, "only the four billing limits");
    assert.equal((await put({ ai: "yes" })).status, 400);
    assert.equal((await call(`users/${kim.id}/limits`, { method: "POST", body: {} })).status, 405);
    assert.equal((await call(`users/${randomUUID()}/limits`, { method: "PUT", body: {} })).status, 404);
  } finally {
    await saveInstanceSettings({ defaultUserStorageMb: null, defaultUserWorkspaces: null, defaultUserAi: true });
  }
});

test("usage follows the storage accounting", async () => {
  const owner = await person("Olga", "olga@example.org");
  const wid = ((await command(owner, { action: "workspace.create", name: "WS" })) as { id: string }).id;
  const page = randomUUID();
  await run("INSERT INTO pages(id,workspace_id,title) VALUES(?,?,'P')", page, wid);
  await run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,'f','text/plain',?,NULL)", randomUUID(), page, 1234);
  await limits.addAiTokens(owner.id, 42);
  let usage = (await (await call(`users/${owner.id}`)).json()).usage;
  assert.deepEqual(usage, { usedBytes: 0, ownedWorkspaces: 1, aiTokensThisMonth: 42 });
  await saveInstanceSettings({ storageAccounting: "owner" });
  try {
    usage = (await (await call(`users/${owner.id}`)).json()).usage;
    assert.deepEqual(usage, { usedBytes: 1234, ownedWorkspaces: 1, aiTokensThisMonth: 42 });
  } finally {
    await saveInstanceSettings({ storageAccounting: null });
  }
});
