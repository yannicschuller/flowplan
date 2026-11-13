// Storage accounting "owner" (lib/user-limits.ts, hosted offerings): files
// count against the workspace's creator whoever uploads them, the workspace
// limit counts created workspaces, and handing the owner role on moves the
// workspace (and its storage) to the new owner. "uploader" stays as before.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-billing-storage-"));
delete process.env.FLOWPLAN_STORAGE_ACCOUNTING;
const { run, one } = await import("../lib/db");
const { saveInstanceSettings } = await import("../lib/instance-settings");
const { command } = await import("../lib/api");
const limits = await import("../lib/user-limits");
const { isLimitError } = await import("../lib/upgrade-link");
type User = Parameters<typeof command>[0];

const person = async (name = "Test", isAdmin = false) => {
  const id = randomUUID();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", id, `test:${id}`, name, `${id}@example.test`);
  return { id, name, email: `${id}@example.test`, groups: [], isAdmin } as never as User;
};
const workspace = async (owner: User, name = "WS") => ((await command(owner, { action: "workspace.create", name })) as { id: string }).id;
const page = async (wid: string) => {
  const pid = randomUUID();
  await run("INSERT INTO pages(id,workspace_id,title) VALUES(?,?,'Dateien')", pid, wid);
  return pid;
};
const file = async (pageId: string, userId: string | null, size: number) =>
  await run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,'f','text/plain',?,?)", randomUUID(), pageId, size, userId);
const KB = 1024;
const mode = async (storageAccounting: "uploader" | "owner" | null) => await saveInstanceSettings({ storageAccounting });

beforeEach(async () => await mode(null));

test("the mode follows the setting, else FLOWPLAN_STORAGE_ACCOUNTING, else uploader", async () => {
  assert.equal(await limits.storageAccounting(), "uploader");
  process.env.FLOWPLAN_STORAGE_ACCOUNTING = "owner";
  try {
    assert.equal(await limits.storageAccounting(), "owner");
    await mode("uploader");
    assert.equal(await limits.storageAccounting(), "uploader", "the stored setting wins");
  } finally {
    delete process.env.FLOWPLAN_STORAGE_ACCOUNTING;
  }
});

test("owner mode: a member's upload counts against the workspace creator, with a message naming the owner", async () => {
  await mode("owner");
  const owner = await person("Olga");
  const member = await person("Max");
  const wid = await workspace(owner);
  await run("INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,'editor')", wid, member.id);
  const pid = await page(wid);
  await limits.setUserLimits(owner.id, { storageMb: 1 });
  await limits.setUserLimits(member.id, { storageMb: 100 });
  await file(pid, member.id, 700 * KB);
  // Everything in Olga's workspace is hers, whoever uploaded it.
  assert.equal(await limits.accountedBytes(owner.id), 700 * KB);
  assert.equal(await limits.accountedBytes(member.id), 0);
  assert.equal(await limits.userBytes(member.id), 700 * KB, "uploader bytes stay what they were");
  await assert.doesNotReject(limits.enforceUserStorage(member, 200 * KB, wid));
  await assert.rejects(limits.enforceUserStorage(member, 400 * KB, wid), (e: Error) => {
    assert.match(e.message, /Der Speicher von „Olga“ \(Eigentümer dieses Arbeitsbereichs\) ist voll\./);
    assert.equal(isLimitError(e), false, "Max cannot lift Olga's limit by upgrading");
    return true;
  });
  // Olga herself gets her own message, with the upgrade hint.
  await assert.rejects(limits.enforceUserStorage(owner, 400 * KB, wid), (e: Error) => /Dein Speicher ist voll/.test(e.message) && isLimitError(e));
  // Max's own workspace has room: his limit, not Olga's.
  const own = await workspace(member, "Max privat");
  await assert.doesNotReject(limits.enforceUserStorage(member, 50 * 1024 * KB, own));
  // Copies: growth in Olga's workspace is checked against her storage.
  const check = await limits.userStorageCheckpoint(member);
  await file(pid, member.id, 400 * KB);
  await assert.rejects(check, /„Olga“ \(Eigentümer des Arbeitsbereichs\) reicht dafür nicht/);
  const fine = await limits.userStorageCheckpoint(member);
  await file(await page(own), member.id, 400 * KB);
  await assert.doesNotReject(fine);
  // The administration's list counts the same way.
  const usage = await limits.usersUsage();
  assert.equal(usage.find((u) => u.id === owner.id)!.bytes, 1100 * KB);
  assert.equal(usage.find((u) => u.id === member.id)!.bytes, 400 * KB);
});

test("owner mode: files without an uploader and an admin's workspaces", async () => {
  await mode("owner");
  const owner = await person("Ines");
  const wid = await workspace(owner);
  await limits.setUserLimits(owner.id, { storageMb: 1 });
  await file(await page(wid), null, 900 * KB);
  await assert.rejects(limits.enforceUserStorage(owner, 200 * KB, wid), /Speicher ist voll/);
  // A workspace of a (local) admin is not limited, also for its members.
  const admin = await person("Admin", true);
  await run("INSERT INTO local_accounts(user_id,email,password_hash,is_admin,email_verified,created_at) VALUES(?,?,?,1,1,?)", admin.id, admin.email, "x", Date.now());
  await limits.setUserLimits(admin.id, { storageMb: 1 });
  const adminWs = await workspace(admin);
  const member = await person();
  await run("INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,'editor')", adminWs, member.id);
  await assert.doesNotReject(limits.enforceUserStorage(member, 5 * 1024 * KB, adminWs));
});

test("uploader mode stays as before: the uploader's storage, wherever the file goes", async () => {
  const owner = await person("Olga");
  const member = await person("Max");
  const wid = await workspace(owner);
  await run("INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,'editor')", wid, member.id);
  await limits.setUserLimits(owner.id, { storageMb: 1 });
  await limits.setUserLimits(member.id, { storageMb: 1 });
  await file(await page(wid), member.id, 900 * KB);
  await assert.rejects(limits.enforceUserStorage(member, 200 * KB, wid), /Dein Speicher ist voll/);
  await assert.doesNotReject(limits.enforceUserStorage(owner, 200 * KB, wid));
  assert.equal(await limits.accountedBytes(owner.id), 0);
});

test("owner mode: the workspace limit counts created workspaces, not owner roles", async () => {
  await mode("owner");
  const user = await person();
  const other = await person();
  await limits.setUserLimits(user.id, { workspaces: 1 });
  const theirs = await workspace(other);
  // Owner of someone else's workspace: does not count in owner mode …
  await run("INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,'owner')", theirs, user.id);
  assert.equal(await limits.ownedWorkspaces(user.id), 0);
  await command(user, { action: "workspace.create", name: "Eins" });
  await assert.rejects(command(user, { action: "workspace.create", name: "Zwei" }), /höchstens 1 eigene/);
  // … but does in uploader mode (as before).
  await mode("uploader");
  assert.equal(await limits.ownedWorkspaces(user.id), 2);
});

test("owner mode: demoting, leaving and deleting the account move the workspace to another owner", async () => {
  await mode("owner");
  const olga = await person("Olga");
  const max = await person("Max");
  const lea = await person("Lea");
  const wid = await workspace(olga);
  await run("INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,'owner')", wid, max.id);
  await run("INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,'editor')", wid, lea.id);
  await file(await page(wid), lea.id, 300 * KB);
  const creator = async () => (await one<{ created_by: string }>("SELECT created_by FROM workspaces WHERE id=?", wid))!.created_by;
  // Max demotes Olga: the workspace and its storage are his now.
  await command(max, { action: "member.role", workspaceId: wid, userId: olga.id, role: "editor" });
  assert.equal(await creator(), max.id);
  assert.equal(await limits.accountedBytes(max.id), 300 * KB);
  assert.equal(await limits.accountedBytes(olga.id), 0);
  // Lea becomes owner, Max leaves: Lea's.
  await command(max, { action: "member.role", workspaceId: wid, userId: lea.id, role: "owner" });
  await command(max, { action: "workspace.leave", workspaceId: wid, confirmName: "WS" });
  assert.equal(await creator(), lea.id);
  // Promoting someone else changes nothing.
  await command(lea, { action: "member.role", workspaceId: wid, userId: olga.id, role: "owner" });
  assert.equal(await creator(), lea.id);
  // In uploader mode created_by stays where it is.
  await mode("uploader");
  await command(olga, { action: "member.role", workspaceId: wid, userId: lea.id, role: "editor" });
  assert.equal(await creator(), lea.id);
});
