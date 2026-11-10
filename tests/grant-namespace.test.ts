// Grants belong to one resource: a page or a space, in one workspace.
// An encrypted space picks its own id in the browser; it must not take the
// id of a page (or space) that exists, and a grant written for a space never
// counts for a page with the same id (and the reverse).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-grant-namespace-"));
const { id, run, one, all, db } = await import("../lib/db");
const { command, pageData, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { requirePage, spaceRole } = await import("../lib/permissions");
const { makeSpaceEncrypted } = await import("../lib/e2ee-server");
const { runDataSteps, GRANT_KINDS_STEP } = await import("../lib/data-steps");
const e2ee = await import("../lib/e2ee");

const onPostgres = /^postgres(ql)?:\/\//i.test(process.env.DATABASE_URL || "");

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const act = async (who: Identity, input: Record<string, unknown>) => (await command(who, input)) as Record<string, unknown>;
const status = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return 200;
  } catch (e) {
    return (e as { status?: number }).status ?? 500;
  }
};

// Workspace A (Alex) with a private space and a page in it; Sam is a viewer
// of A who was never given that page. Robin owns workspace B, where Sam is
// a member too. Robin and Sam have key pairs.
const alex = await user("alex"),
  sam = await user("sam"),
  robin = await user("robin");
const wsA = await createWorkspace(alex.id, "A");
await run("INSERT INTO members VALUES(?,?,?)", wsA, sam.id, "viewer");
const privateSpace = String((await act(alex, { action: "space.create", workspaceId: wsA, name: "Nur Alex", private: true })).id);
const victim = String((await act(alex, { action: "page.create", workspaceId: wsA, spaceId: privateSpace, title: "DUMMY-SECRET-TITLE" })).id);
const victimChild = String((await act(alex, { action: "page.create", workspaceId: wsA, spaceId: privateSpace, title: "Darunter", parentId: victim })).id);
const wsB = await createWorkspace(robin.id, "B");
await run("INSERT INTO members VALUES(?,?,?)", wsB, sam.id, "editor");
const robinKeys = await e2ee.createIdentity("robin dummy passphrase");
await act(robin, { action: "e2ee.identity.setup", ...robinKeys.identity });
const samKeys = await e2ee.createIdentity("sam dummy passphrase");
await act(sam, { action: "e2ee.identity.setup", ...samKeys.identity });

const encryptedFor = async (spaceId: string) => ({
  key: await e2ee.sealKey((await e2ee.newSpaceKey(1)).raw, robinKeys.identity.publicKey, e2ee.spaceKeyContext(spaceId, 1, robin.id)),
  encryptTitles: false,
});
const addSam = async (spaceId: string) =>
  await act(robin, {
    action: "e2ee.member.add",
    spaceId,
    userId: sam.id,
    role: "editor",
    keys: [{ version: 1, sealed: await e2ee.sealKey((await e2ee.newSpaceKey(1)).raw, samKeys.identity.publicKey, e2ee.spaceKeyContext(spaceId, 1, sam.id)) }],
  });

test("an encrypted space cannot take the id of an existing page or space", async () => {
  assert.equal(await status(() => requirePage(sam, victim)), 403);
  // The exact request of the finding: refused, nothing is written.
  assert.equal(
    await status(async () => await act(robin, { action: "space.create", workspaceId: wsB, name: "Kollision", id: victim, encrypted: await encryptedFor(victim) })),
    409,
  );
  assert.equal(await one("SELECT 1 FROM spaces WHERE id=?", victim), undefined);
  assert.equal(await status(() => addSam(victim)), 404);
  assert.equal(await status(() => requirePage(sam, victim)), 403);
  // Nor the id of another space.
  assert.equal(
    await status(async () => await act(robin, { action: "space.create", workspaceId: wsB, name: "Kollision", id: privateSpace, encrypted: await encryptedFor(privateSpace) })),
    409,
  );
  // A fresh id works as before; Sam becomes a member of that space only.
  const own = id();
  assert.equal((await act(robin, { action: "space.create", workspaceId: wsB, name: "Eigen", id: own, encrypted: await encryptedFor(own) })).id, own);
  await addSam(own);
  const space = (await one<{ id: string; workspace_id: string }>("SELECT * FROM spaces WHERE id=?", own))!;
  assert.equal(await spaceRole(sam, space as never), "editor");
  assert.deepEqual(
    await one("SELECT resource_kind,workspace_id FROM grants WHERE resource_id=? AND user_id=?", own, sam.id),
    { resource_kind: "space", workspace_id: wsB },
  );
});

test("a space grant never counts for a page with the same id (collision from before the fix)", async () => {
  // The state an older version let Robin create: a space of B with the
  // victim page's id, then Sam added to it.
  await run("INSERT INTO spaces(id,workspace_id,name,visibility,owner_id) VALUES(?,?,?,?,?)", victim, wsB, "Kollision", "private", robin.id);
  await makeSpaceEncrypted(robin, victim, await encryptedFor(victim));
  assert.deepEqual(await addSam(victim), { ok: true });
  assert.deepEqual(
    await one("SELECT resource_kind,workspace_id,role FROM grants WHERE resource_id=? AND user_id=?", victim, sam.id),
    { resource_kind: "space", workspace_id: wsB, role: "editor" },
  );
  // Sam still has no access to the page, nor to the page below it.
  assert.equal(await status(() => requirePage(sam, victim)), 403);
  assert.equal(await status(() => requirePage(sam, victimChild)), 403);
  assert.equal(await status(() => pageData(sam, victim)), 403);
  // The legitimate owner still reads it.
  assert.equal((await requirePage(alex, victim)).title, "DUMMY-SECRET-TITLE");
  // Clean up the collision for the next tests.
  await run("DELETE FROM grants WHERE resource_id=?", victim);
  await run("DELETE FROM e2ee_space_keys WHERE space_id=?", victim);
  await run("DELETE FROM spaces WHERE id=?", victim);
});

test("page grants (direct, inherited, by group) and space grants still work", async () => {
  const lea = await user("lea");
  await run("INSERT INTO members VALUES(?,?,?)", wsA, lea.id, "editor");
  assert.equal(await status(() => requirePage(lea, victim)), 403);
  await act(alex, { action: "grant.set", resourceId: victim, userId: lea.id, role: "viewer" });
  assert.deepEqual(await one("SELECT resource_kind,workspace_id FROM grants WHERE resource_id=? AND user_id=?", victim, lea.id), { resource_kind: "page", workspace_id: wsA });
  assert.equal(await status(() => requirePage(lea, victim)), 200);
  assert.equal(await status(() => requirePage(lea, victimChild)), 200);
  assert.equal(await status(() => requirePage(lea, victim, true)), 403);
  await act(alex, { action: "grant.set", resourceId: victim, userId: lea.id, role: "remove" });
  assert.equal(await status(() => requirePage(lea, victim)), 403);
  // A group grant on the space.
  const gid = String((await act(alex, { action: "group.create", workspaceId: wsA, name: "Team" })).id);
  await run("INSERT INTO group_members VALUES(?,?)", gid, lea.id);
  await act(alex, { action: "grant.set", resourceId: privateSpace, groupId: gid, role: "editor" });
  assert.deepEqual(await one("SELECT resource_kind,workspace_id FROM grants WHERE resource_id=? AND group_id=?", privateSpace, gid), { resource_kind: "space", workspace_id: wsA });
  assert.equal(await status(() => requirePage(lea, victim, true)), 200);
  await act(alex, { action: "grant.set", resourceId: privateSpace, groupId: gid, role: "remove" });
  assert.equal(await status(() => requirePage(lea, victim)), 403);
  // Sharing a page with a person (lib/page-share.ts).
  await run("UPDATE users SET email_verified=1 WHERE id=?", lea.id);
  await act(alex, { action: "page.share", pageId: victim, email: lea.email, role: "viewer" });
  assert.deepEqual(await one("SELECT resource_kind,workspace_id FROM grants WHERE resource_id=? AND user_id=?", victim, lea.id), { resource_kind: "page", workspace_id: wsA });
  assert.equal(await status(() => requirePage(lea, victim)), 200);
  await act(alex, { action: "page.shareUpdate", pageId: victim, userId: lea.id, role: "editor" });
  assert.deepEqual(await one("SELECT resource_kind,workspace_id,role FROM grants WHERE resource_id=? AND user_id=?", victim, lea.id), { resource_kind: "page", workspace_id: wsA, role: "editor" });
  assert.equal(await status(() => requirePage(lea, victim, true)), 200);
});

test("existing grants get their kind and workspace in the data step", async () => {
  const kim = await user("kim");
  await run("INSERT INTO members VALUES(?,?,?)", wsA, kim.id, "editor");
  const team = (await bootstrap(alex, wsA)).spaces.find((s) => s.id !== privateSpace)!.id;
  // Written without kind and workspace (an older instance): taken from the
  // resource when the id is only a page's or only a space's.
  await run("INSERT INTO grants(resource_id,user_id,group_id,role) VALUES(?,?,?,?)", victim, kim.id, "", "viewer");
  await run("INSERT INTO grants(resource_id,user_id,group_id,role) VALUES(?,?,?,?)", privateSpace, kim.id, "", "editor");
  assert.deepEqual(await one("SELECT resource_kind,workspace_id FROM grants WHERE resource_id=? AND user_id=?", victim, kim.id), { resource_kind: "page", workspace_id: wsA });
  assert.deepEqual(await one("SELECT resource_kind,workspace_id FROM grants WHERE resource_id=? AND user_id=?", privateSpace, kim.id), { resource_kind: "space", workspace_id: wsA });
  assert.equal(await status(() => requirePage(kim, victim)), 200);
  // An old collision: a space of B with the id of a page of A, its grants
  // without a kind (Sam's from the e2ee path, a group of A's for the page).
  const collided = String((await act(alex, { action: "page.create", workspaceId: wsA, spaceId: team, title: "Kollidiert" })).id);
  await run("INSERT INTO spaces(id,workspace_id,name,visibility,owner_id) VALUES(?,?,?,?,?)", collided, wsB, "Alt", "private", robin.id);
  const gid = String((await act(alex, { action: "group.create", workspaceId: wsA, name: "Leser" })).id);
  await run("INSERT INTO grants(resource_id,user_id,group_id,role) VALUES(?,?,?,?)", collided, sam.id, "", "editor");
  await run("INSERT INTO grants(resource_id,user_id,group_id,role) VALUES(?,?,?,?)", collided, "", gid, "viewer");
  // A grant written without them on an id that is both stays unbound.
  assert.equal((await one<{ n: number }>("SELECT COUNT(*) n FROM grants WHERE resource_id=? AND resource_kind IS NULL", collided))!.n, 2);
  await run("UPDATE grants SET resource_kind=NULL,workspace_id=NULL WHERE user_id=?", kim.id);
  // Until filled, they count for nothing.
  assert.equal(await status(() => requirePage(kim, victim)), 403);
  await run("DELETE FROM data_migrations WHERE name=?", GRANT_KINDS_STEP);
  await runDataSteps([GRANT_KINDS_STEP]);
  assert.ok(await one("SELECT 1 FROM data_migrations WHERE name=?", GRANT_KINDS_STEP));
  const kinds = async (resource: string) =>
    await all<{ user_id: string; group_id: string; resource_kind: string; workspace_id: string }>(
      "SELECT user_id,group_id,resource_kind,workspace_id FROM grants WHERE resource_id=? ORDER BY user_id,group_id",
      resource,
    );
  assert.deepEqual((await kinds(victim)).find((g) => g.user_id === kim.id), { user_id: kim.id, group_id: "", resource_kind: "page", workspace_id: wsA });
  assert.deepEqual((await kinds(privateSpace)).find((g) => g.user_id === kim.id), { user_id: kim.id, group_id: "", resource_kind: "space", workspace_id: wsA });
  // The person's grant on the colliding id goes to the space (never the
  // page); the group of A keeps the page.
  assert.deepEqual(await kinds(collided), [
    { user_id: "", group_id: gid, resource_kind: "page", workspace_id: wsA },
    { user_id: sam.id, group_id: "", resource_kind: "space", workspace_id: wsB },
  ]);
  assert.equal(await status(() => requirePage(kim, victim)), 200);
  assert.equal(await status(() => requirePage(kim, victimChild)), 200);
  assert.equal(await status(() => requirePage(kim, victimChild, true)), 403);
  await run("DELETE FROM grants WHERE resource_id=?", collided);
  await run("DELETE FROM spaces WHERE id=?", collided);
});

test("the schema migration adds the columns to an existing database and keeps its grants", { skip: onPostgres }, async () => {
  const pat = await user("pat");
  await run("INSERT INTO members VALUES(?,?,?)", wsA, pat.id, "editor");
  await act(alex, { action: "grant.set", resourceId: victim, userId: pat.id, role: "viewer" });
  const space = (await bootstrap(alex, wsA)).spaces.find((s) => s.id !== privateSpace)!.id;
  await act(alex, { action: "grant.set", resourceId: space, userId: pat.id, role: "editor" });
  // Back to the grants table of schema 99.
  const d = db();
  d.exec("DROP TRIGGER grants_resource_kind; DROP INDEX grants_workspace; ALTER TABLE grants DROP COLUMN resource_kind; ALTER TABLE grants DROP COLUMN workspace_id; PRAGMA user_version=99;");
  (globalThis as { flowplanSchema?: number }).flowplanSchema = undefined;
  db();
  const columns = (d.prepare("PRAGMA table_info(grants)").all() as { name: string }[]).map((c) => c.name);
  assert.deepEqual(columns, ["resource_id", "user_id", "group_id", "role", "resource_kind", "workspace_id"]);
  await run("DELETE FROM data_migrations WHERE name=?", GRANT_KINDS_STEP);
  await runDataSteps([GRANT_KINDS_STEP]);
  assert.deepEqual(await one("SELECT resource_kind,workspace_id FROM grants WHERE resource_id=? AND user_id=?", victim, pat.id), { resource_kind: "page", workspace_id: wsA });
  assert.deepEqual(await one("SELECT resource_kind,workspace_id FROM grants WHERE resource_id=? AND user_id=?", space, pat.id), { resource_kind: "space", workspace_id: wsA });
  assert.equal(await status(() => requirePage(pat, victim)), 200);
  assert.ok(await one("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='grants_resource_kind'"));
  assert.equal(await one("SELECT 1 FROM grants WHERE resource_kind IS NULL AND (resource_id IN (SELECT id FROM pages) OR resource_id IN (SELECT id FROM spaces))"), undefined);
});
