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

const person = (isAdmin = false) => {
  const id = randomUUID();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", id, `test:${id}`, "Test", `${id}@example.test`);
  return { id, name: "Test", email: `${id}@example.test`, groups: [], isAdmin } as never as Parameters<typeof command>[0];
};
let pageId = "";
const file = (userId: string, size: number) => {
  if (!pageId) {
    const owner = person(true);
    const ws = (command(owner, { action: "workspace.create", name: "Dateien" }) as { id: string }).id;
    pageId = randomUUID();
    run("INSERT INTO pages(id,workspace_id,title) VALUES(?,?,'Dateien')", pageId, ws);
  }
  run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,'f','text/plain',?,?)", randomUUID(), pageId, size, userId);
};

test("own limits win over the defaults; empty means the default, 0 unlimited", () => {
  const user = person();
  assert.deepEqual(limits.effectiveUserLimits(user.id), { storageMb: 0, workspaces: 0, uploadMb: instanceSettings().maxUploadMb });
  saveInstanceSettings({ ...instanceSettings(), defaultUserStorageMb: 50, defaultUserWorkspaces: 2 });
  assert.equal(limits.effectiveUserLimits(user.id).storageMb, 50);
  limits.setUserLimits(user.id, { storageMb: 5, uploadMb: 3 });
  assert.deepEqual(limits.effectiveUserLimits(user.id), { storageMb: 5, workspaces: 2, uploadMb: 3 });
  limits.setUserLimits(user.id, { storageMb: null, uploadMb: null });
  assert.equal(limits.effectiveUserLimits(user.id).storageMb, 50);
  assert.deepEqual(limits.storedUserLimits(user.id), {});
});

test("storage per person counts files across workspaces and refuses growth beyond it", () => {
  const user = person();
  limits.setUserLimits(user.id, { storageMb: 1 });
  file(user.id, 700 * 1024);
  assert.doesNotThrow(() => limits.enforceUserStorage(user, 200 * 1024));
  assert.throws(() => limits.enforceUserStorage(user, 400 * 1024), /Speicher ist voll/);
  const check = limits.userStorageCheckpoint(user);
  file(user.id, 400 * 1024);
  assert.throws(check, /reicht dafür nicht/);
  // Admins are not limited.
  const admin = person(true);
  limits.setUserLimits(admin.id, { storageMb: 1 });
  assert.doesNotThrow(() => limits.enforceUserStorage(admin, 5 * 1024 * 1024));
});

test("a person owns at most as many workspaces as allowed", () => {
  const user = person();
  limits.setUserLimits(user.id, { workspaces: 1 });
  command(user, { action: "workspace.create", name: "Erster" });
  assert.throws(() => command(user, { action: "workspace.create", name: "Zweiter" }), /höchstens 1 eigene/);
  limits.setUserLimits(user.id, { workspaces: 0 });
  assert.doesNotThrow(() => command(user, { action: "workspace.create", name: "Zweiter" }));
  assert.equal(limits.ownedWorkspaces(user.id), 2);
});

test("only admins change limits", () => {
  const user = person();
  assert.throws(() => command(user, { action: "admin.userLimits", userId: user.id, limits: { storageMb: 1 } }));
  const admin = person(true);
  command(admin, { action: "admin.userLimits", userId: user.id, limits: { storageMb: 10 } });
  assert.equal(limits.effectiveUserLimits(user.id).storageMb, 10);
});
