import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-limits-"));
const { run } = await import("../lib/db");
const { saveInstanceSettings, instanceSettings } = await import("../lib/instance-settings");
const { command } = await import("../lib/api");
const limits = await import("../lib/user-limits");

const person = async (isAdmin = false) => {
  const id = randomUUID();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", id, `test:${id}`, "Test", `${id}@example.test`);
  return { id, name: "Test", email: `${id}@example.test`, groups: [], isAdmin } as never as Parameters<typeof command>[0];
};
let pageId = "";
const file = async (userId: string, size: number) => {
  if (!pageId) {
    const owner = await person(true);
    const ws = ((await command(owner, { action: "workspace.create", name: "Dateien" })) as { id: string }).id;
    pageId = randomUUID();
    await run("INSERT INTO pages(id,workspace_id,title) VALUES(?,?,'Dateien')", pageId, ws);
  }
  await run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,'f','text/plain',?,?)", randomUUID(), pageId, size, userId);
};

test("own limits win over the defaults; empty means the default, 0 unlimited", async () => {
  const user = await person();
  assert.deepEqual(await limits.effectiveUserLimits(user.id), { storageMb: 0, workspaces: 0, uploadMb: (await instanceSettings()).maxUploadMb });
  await saveInstanceSettings({ ...(await instanceSettings()), defaultUserStorageMb: 50, defaultUserWorkspaces: 2 });
  assert.equal((await limits.effectiveUserLimits(user.id)).storageMb, 50);
  await limits.setUserLimits(user.id, { storageMb: 5, uploadMb: 3 });
  assert.deepEqual(await limits.effectiveUserLimits(user.id), { storageMb: 5, workspaces: 2, uploadMb: 3 });
  await limits.setUserLimits(user.id, { storageMb: null, uploadMb: null });
  assert.equal((await limits.effectiveUserLimits(user.id)).storageMb, 50);
  assert.deepEqual(await limits.storedUserLimits(user.id), {});
});

test("storage per person counts files across workspaces and refuses growth beyond it", async () => {
  const user = await person();
  await limits.setUserLimits(user.id, { storageMb: 1 });
  await file(user.id, 700 * 1024);
  await assert.doesNotReject(async () => await limits.enforceUserStorage(user, 200 * 1024));
  await assert.rejects(async () => await limits.enforceUserStorage(user, 400 * 1024), /Speicher ist voll/);
  const check = await limits.userStorageCheckpoint(user);
  await file(user.id, 400 * 1024);
  await assert.rejects(check, /reicht dafür nicht/);
  // Admins are not limited.
  const admin = await person(true);
  await limits.setUserLimits(admin.id, { storageMb: 1 });
  await assert.doesNotReject(async () => await limits.enforceUserStorage(admin, 5 * 1024 * 1024));
});

test("a person owns at most as many workspaces as allowed", async () => {
  const user = await person();
  await limits.setUserLimits(user.id, { workspaces: 1 });
  await command(user, { action: "workspace.create", name: "Erster" });
  await assert.rejects(async () => await command(user, { action: "workspace.create", name: "Zweiter" }), /höchstens 1 eigene/);
  await limits.setUserLimits(user.id, { workspaces: 0 });
  await assert.doesNotReject(async () => await command(user, { action: "workspace.create", name: "Zweiter" }));
  assert.equal(await limits.ownedWorkspaces(user.id), 2);
});

test("only admins change limits", async () => {
  const user = await person();
  await assert.rejects(async () => await command(user, { action: "admin.userLimits", userId: user.id, limits: { storageMb: 1 } }));
  const admin = await person(true);
  await command(admin, { action: "admin.userLimits", userId: user.id, limits: { storageMb: 10 } });
  assert.equal((await limits.effectiveUserLimits(user.id)).storageMb, 10);
});

test("the administration sees every workspace a person belongs to and the own ones", async () => {
  const owner = await person();
  const guest = await person();
  const ws = ((await command(owner, { action: "workspace.create", name: "Gemeinsam" })) as { id: string }).id;
  await run("INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,'editor')", ws, guest.id);
  const usage = await limits.usersUsage();
  const of = (id: string) => usage.find((u) => u.id === id)!;
  assert.equal(of(owner.id).workspaces, of(owner.id).memberOf.length);
  assert.ok(of(owner.id).memberOf.includes(ws));
  assert.deepEqual(of(guest.id).memberOf, [ws]);
  assert.equal(of(guest.id).workspaces, 0);
});
