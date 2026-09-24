import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-ops-"));
const { run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const {
  enforceQuota,
  instanceMetrics,
  workspaceBytes,
  workspaceUsage,
  workspaceQuotaMb,
} = await import("../lib/instance-ops");

function account(name: string, isAdmin = false) {
  const uid = id();
  run(
    "INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)",
    uid,
    uid,
    name,
    `${name}@example.test`,
  );
  return {
    id: uid,
    name,
    email: `${name}@example.test`,
    groups: isAdmin ? ["flowplan-admins"] : [],
    isAdmin,
    disabled: 0,
    created_at: "",
  } as Identity;
}
const admin = account("ops-admin", true),
  owner = account("ops-owner");
const wid = createWorkspace(owner.id, "Speicher");
const page = (
  command(owner, {
    action: "page.create",
    workspaceId: wid,
    spaceId: bootstrap(owner, wid).spaces[0].id,
    title: "Ablage",
  }) as { id: string }
).id;
const addFile = (size: number) =>
  run(
    "INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)",
    id(),
    page,
    "a.bin",
    "application/octet-stream",
    size,
    owner.id,
  );

test("workspace storage counts page files and template files", () => {
  assert.equal(workspaceBytes(wid), 0);
  addFile(600 * 1024);
  assert.equal(workspaceBytes(wid), 600 * 1024);
  const metrics = instanceMetrics();
  assert.ok(metrics.files >= 1);
  assert.ok(metrics.uploadBytes >= 600 * 1024);
  assert.ok(metrics.databaseBytes > 0);
  assert.equal(typeof metrics.searchBacklog, "number");
});

test("quotas come from the environment or an admin override and block uploads beyond them", () => {
  delete process.env.FLOWPLAN_WORKSPACE_QUOTA_MB;
  assert.equal(workspaceQuotaMb(wid), 0);
  assert.doesNotThrow(() => enforceQuota(wid, 10 * 1024 * 1024 * 1024));
  process.env.FLOWPLAN_WORKSPACE_QUOTA_MB = "1";
  assert.equal(workspaceQuotaMb(wid), 1);
  assert.doesNotThrow(() => enforceQuota(wid, 300 * 1024));
  assert.throws(() => enforceQuota(wid, 500 * 1024), /Speicherkontingent/);
  assert.throws(
    () =>
      command(owner, { action: "admin.quota", workspaceId: wid, quotaMb: 5 }),
    /Admin|Berechtigung/i,
  );
  command(admin, { action: "admin.quota", workspaceId: wid, quotaMb: 5 });
  assert.equal(workspaceQuotaMb(wid), 5);
  assert.doesNotThrow(() => enforceQuota(wid, 500 * 1024));
  assert.equal(workspaceUsage().find((u) => u.id === wid)?.quotaMb, 5);
  command(admin, { action: "admin.quota", workspaceId: wid, quotaMb: null });
  assert.equal(workspaceQuotaMb(wid), 1);
  assert.throws(() =>
    command(admin, { action: "admin.quota", workspaceId: wid, quotaMb: -1 }),
  );
  assert.throws(
    () =>
      command(admin, { action: "admin.quota", workspaceId: id(), quotaMb: 1 }),
    /nicht gefunden/,
  );
  delete process.env.FLOWPLAN_WORKSPACE_QUOTA_MB;
});
