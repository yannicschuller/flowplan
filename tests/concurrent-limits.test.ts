// Audit (Nov 2026): checks that count and then write ran without a lock on
// PostgreSQL (READ COMMITTED, several requests at once): two owners
// demoting each other or leaving at the same time left a workspace without
// an owner (and spaces owned by people no longer in it); parallel requests
// passed the per-account workspace limit, storage and quota, and the
// limits on share links, API tokens and SCIM tokens. Each now takes turns
// (lib/db.ts lockMembership, lockFor). Run with DATABASE_URL against
// PostgreSQL to see the race; on SQLite transactions already take turns.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-concurrent-limits-"));
const { run, id, all, one } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const { setUserLimits, ownedWorkspaces, userBytes } = await import("../lib/user-limits");
const { setWorkspaceQuota } = await import("../lib/instance-ops");
const { storeUpload } = await import("../lib/page-upload");
const { createScimToken } = await import("../lib/scim");

const backend = process.env.DATABASE_URL ? "postgres" : "sqlite";
async function person(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
// The status of each request: 200 or the error's.
const settle = (p: Promise<unknown>) => p.then(() => 200, (e: { status?: number; message?: string }) => e.status ?? String(e.message));
const owners = async (wid: string) =>
  (await all<{ user_id: string }>("SELECT user_id FROM members WHERE workspace_id=? AND role='owner'", wid)).map((o) => o.user_id);
const parallel = <T>(n: number, fn: (i: number) => Promise<T>) => Promise.all(Array.from({ length: n }, (_, i) => settle(fn(i))));

test("two owners demoting each other at once: one owner stays", async () => {
  for (let round = 0; round < 3; round++) {
    const a = await person(`anna${round}`),
      b = await person(`bert${round}`);
    const wid = await createWorkspace(a.id, "WS");
    await run("INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,'owner')", wid, b.id);
    const results = await Promise.all([
      settle(command(a, { action: "member.role", workspaceId: wid, userId: b.id, role: "viewer" })),
      settle(command(b, { action: "member.role", workspaceId: wid, userId: a.id, role: "viewer" })),
    ]);
    assert.equal((await owners(wid)).length, 1, `${backend}: ${JSON.stringify(results)}`);
    // The second request saw that its sender is no owner any more.
    assert.deepEqual([...results].sort(), [200, 403]);
  }
});

test("two owners removing each other at once: one owner stays", async () => {
  const a = await person("carla"),
    b = await person("dirk");
  const wid = await createWorkspace(a.id, "WS");
  await run("INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,'owner')", wid, b.id);
  await Promise.all([
    settle(command(a, { action: "member.role", workspaceId: wid, userId: b.id, role: "remove" })),
    settle(command(b, { action: "member.role", workspaceId: wid, userId: a.id, role: "remove" })),
  ]);
  assert.equal((await owners(wid)).length, 1);
  assert.equal(Number((await one<{ n: number }>("SELECT count(*) n FROM members WHERE workspace_id=?", wid))!.n), 1);
});

test("two owners leaving at once: one stays, no space of a departed member", async () => {
  for (let round = 0; round < 3; round++) {
    const a = await person(`dora${round}`),
      b = await person(`emil${round}`),
      c = await person(`fynn${round}`);
    const wid = await createWorkspace(a.id, "WS2");
    await createWorkspace(a.id, "A-other");
    await createWorkspace(b.id, "B-other");
    await run("INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,'owner')", wid, b.id);
    await run("INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,'editor')", wid, c.id);
    const results = await Promise.all([
      settle(command(a, { action: "workspace.leave", workspaceId: wid, confirmName: "WS2", transferTo: b.id })),
      settle(command(b, { action: "workspace.leave", workspaceId: wid, confirmName: "WS2", transferTo: a.id })),
    ]);
    assert.equal((await owners(wid)).length, 1, `${backend}: ${JSON.stringify(results)}`);
    const orphans = await all(
      "SELECT s.id FROM spaces s WHERE s.workspace_id=? AND s.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM members m WHERE m.workspace_id=s.workspace_id AND m.user_id=s.owner_id)",
      wid,
    );
    assert.equal(orphans.length, 0);
  }
});

test("demoting one owner while the other leaves: one owner stays", async () => {
  const a = await person("gina"),
    b = await person("hugo");
  const wid = await createWorkspace(a.id, "WS3");
  await createWorkspace(b.id, "B-own");
  await run("INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,'owner')", wid, b.id);
  await Promise.all([
    settle(command(a, { action: "member.role", workspaceId: wid, userId: b.id, role: "editor" })),
    settle(command(b, { action: "workspace.leave", workspaceId: wid, confirmName: "WS3", transferTo: a.id })),
  ]);
  const left = await owners(wid);
  assert.equal(left.length, 1);
});

test("made owner and guest at the same time: never both", async () => {
  const a = await person("ida"),
    b = await person("jan");
  const wid = await createWorkspace(a.id, "WS4");
  await run("INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,'editor')", wid, b.id);
  await Promise.all([
    settle(command(a, { action: "member.role", workspaceId: wid, userId: b.id, role: "owner" })),
    settle(command(a, { action: "member.guest", workspaceId: wid, userId: b.id, guest: true })),
  ]);
  const role = (await one<{ role: string }>("SELECT role FROM members WHERE workspace_id=? AND user_id=?", wid, b.id))!.role;
  const guest = !!(await one("SELECT 1 FROM workspace_guests WHERE workspace_id=? AND user_id=?", wid, b.id));
  assert.ok(!(role === "owner" && guest), `${role} and guest`);
});

test("parallel workspace.create stays within the per-account workspace limit", async () => {
  const user = await person("lena");
  await setUserLimits(user.id, { workspaces: 1 });
  const results = await parallel(8, (i) => command(user, { action: "workspace.create", name: `W${i}` }));
  assert.equal(await ownedWorkspaces(user.id), 1, JSON.stringify(results));
  assert.equal(results.filter((r) => r === 200).length, 1);
});

const pdf = (kb: number) => Buffer.alloc(kb * 1024, 1);
test("parallel uploads stay within the person's storage", async () => {
  const user = await person("mia");
  const wid = await createWorkspace(user.id, "Uploads");
  const sid = (await bootstrap(user, wid)).spaces[0].id;
  const page = { id: ((await command(user, { action: "page.create", workspaceId: wid, spaceId: sid, title: "Files" })) as { id: string }).id, workspace_id: wid };
  await setUserLimits(user.id, { storageMb: 1 });
  const results = await parallel(8, () => storeUpload(user, page, { id: id(), name: "a.bin", mime: "application/octet-stream", content: pdf(300) }));
  assert.ok((await userBytes(user.id)) <= 1024 * 1024, `${await userBytes(user.id)} bytes: ${JSON.stringify(results)}`);
  assert.equal(results.filter((r) => r === 200).length, 3);
  assert.equal(results.filter((r) => r === 413).length, 5);
  // Refused uploads leave no file behind.
  const stored = new Set((await all<{ id: string }>("SELECT id FROM files WHERE created_by=?", user.id)).map((f) => f.id));
  const onDisk = readdirSync(join(process.env.FLOWPLAN_DATA_DIR!, "uploads"));
  assert.deepEqual(onDisk.filter((f) => !stored.has(f)), []);
});

test("parallel uploads stay within the workspace quota", async () => {
  const user = await person("nina");
  const wid = await createWorkspace(user.id, "Quota");
  const sid = (await bootstrap(user, wid)).spaces[0].id;
  const page = { id: ((await command(user, { action: "page.create", workspaceId: wid, spaceId: sid, title: "Files" })) as { id: string }).id, workspace_id: wid };
  await setWorkspaceQuota(wid, 1);
  const results = await parallel(8, () => storeUpload(user, page, { id: id(), name: "b.bin", mime: "application/octet-stream", content: pdf(300) }));
  const used = Number((await one<{ n: number }>("SELECT SUM(f.size) n FROM files f JOIN pages p ON p.id=f.page_id WHERE p.workspace_id=?", wid))?.n || 0);
  assert.ok(used <= 1024 * 1024, `${used} bytes: ${JSON.stringify(results)}`);
  assert.equal(results.filter((r) => r === 200).length, 3);
});

test("parallel share links of one page stay within 50", async () => {
  const user = await person("olga");
  const wid = await createWorkspace(user.id, "Links");
  const sid = (await bootstrap(user, wid)).spaces[0].id;
  const pageId = ((await command(user, { action: "page.create", workspaceId: wid, spaceId: sid, title: "Shared" })) as { id: string }).id;
  for (let i = 0; i < 47; i++) await command(user, { action: "share.create", pageId, role: "viewer", name: `L${i}` });
  const results = await parallel(8, (i) => command(user, { action: "share.create", pageId, role: "viewer", name: `P${i}` }));
  const n = Number((await one<{ n: number }>("SELECT count(*) n FROM share_links WHERE root_id=?", pageId))!.n);
  assert.equal(n, 50, JSON.stringify(results));
});

test("parallel API tokens stay within 20 per person", async () => {
  const user = await person("paul");
  for (let i = 0; i < 16; i++) await command(user, { action: "token.create", name: `T${i}`, scope: "read" });
  const results = await parallel(8, (i) => command(user, { action: "token.create", name: `P${i}`, scope: "read" }));
  const n = Number((await one<{ n: number }>("SELECT count(*) n FROM api_tokens WHERE user_id=?", user.id))!.n);
  assert.equal(n, 20, JSON.stringify(results));
});

test("parallel SCIM tokens stay within 20", async () => {
  const admin = await person("root");
  const before = Number((await one<{ n: number }>("SELECT count(*) n FROM scim_tokens"))!.n);
  for (let i = before; i < 16; i++) await createScimToken(admin.id, `S${i}`);
  const results = await parallel(8, (i) => createScimToken(admin.id, `P${i}`));
  const n = Number((await one<{ n: number }>("SELECT count(*) n FROM scim_tokens"))!.n);
  assert.equal(n, 20, JSON.stringify(results));
});
