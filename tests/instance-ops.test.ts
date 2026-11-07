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

async function account(name: string, isAdmin = false) {
  const uid = id();
  await run(
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
const admin = await account("ops-admin", true),
  owner = await account("ops-owner");
const wid = await createWorkspace(owner.id, "Speicher");
const page = (
  (await command(owner, {
    action: "page.create",
    workspaceId: wid,
    spaceId: (await bootstrap(owner, wid)).spaces[0].id,
    title: "Ablage",
  })) as { id: string }
).id;
const addFile = async (size: number) =>
  await run(
    "INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)",
    id(),
    page,
    "a.bin",
    "application/octet-stream",
    size,
    owner.id,
  );

test("workspace storage counts page files and template files", async () => {
  assert.equal(await workspaceBytes(wid), 0);
  await addFile(600 * 1024);
  assert.equal(await workspaceBytes(wid), 600 * 1024);
  const metrics = await instanceMetrics();
  assert.ok(metrics.files >= 1);
  assert.ok(metrics.uploadBytes >= 600 * 1024);
  assert.ok(metrics.databaseBytes > 0);
  assert.equal(typeof metrics.searchBacklog, "number");
});

test("quotas come from the environment or an admin override and block uploads beyond them", async () => {
  delete process.env.FLOWPLAN_WORKSPACE_QUOTA_MB;
  assert.equal(await workspaceQuotaMb(wid), 0);
  await assert.doesNotReject(async () => await enforceQuota(wid, 10 * 1024 * 1024 * 1024));
  process.env.FLOWPLAN_WORKSPACE_QUOTA_MB = "1";
  assert.equal(await workspaceQuotaMb(wid), 1);
  await assert.doesNotReject(async () => await enforceQuota(wid, 300 * 1024));
  await assert.rejects(async () => await enforceQuota(wid, 500 * 1024), /Speicherkontingent/);
  await assert.rejects(
    async () =>
      await command(owner, { action: "admin.quota", workspaceId: wid, quotaMb: 5 }),
    /Admin|Berechtigung/i,
  );
  await command(admin, { action: "admin.quota", workspaceId: wid, quotaMb: 5 });
  assert.equal(await workspaceQuotaMb(wid), 5);
  await assert.doesNotReject(async () => await enforceQuota(wid, 500 * 1024));
  assert.equal((await workspaceUsage()).find((u) => u.id === wid)?.quotaMb, 5);
  await command(admin, { action: "admin.quota", workspaceId: wid, quotaMb: null });
  assert.equal(await workspaceQuotaMb(wid), 1);
  await assert.rejects(async () =>
    await command(admin, { action: "admin.quota", workspaceId: wid, quotaMb: -1 }),
  );
  await assert.rejects(
    async () =>
      await command(admin, { action: "admin.quota", workspaceId: id(), quotaMb: 1 }),
    /nicht gefunden/,
  );
  delete process.env.FLOWPLAN_WORKSPACE_QUOTA_MB;
});

test("copies are refused atomically when they would exceed the quota", async () => {
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const { all } = await import("../lib/db");
  const dir = join(process.env.FLOWPLAN_DATA_DIR!, "uploads");
  mkdirSync(dir, { recursive: true });
  const source = (
    (await command(owner, {
      action: "page.create",
      workspaceId: wid,
      spaceId: (await bootstrap(owner, wid)).spaces[0].id,
      title: "Große Anlage",
    })) as { id: string }
  ).id;
  const fid = id();
  writeFileSync(join(dir, fid), Buffer.alloc(300 * 1024));
  await run(
    "INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)",
    fid,
    source,
    "gross.bin",
    "application/octet-stream",
    300 * 1024,
    owner.id,
  );
  // 600 KB + 300 KB stored; a copy adds another 300 KB beyond 1 MB.
  process.env.FLOWPLAN_WORKSPACE_QUOTA_MB = "1";
  const pages = async () =>
    (await all("SELECT id FROM pages WHERE workspace_id=?", wid)).length;
  const before = [await pages(), await workspaceBytes(wid)];
  await assert.rejects(
    async () => await command(owner, { action: "page.duplicate", pageId: source }),
    /Speicherkontingent/,
  );
  assert.deepEqual([await pages(), await workspaceBytes(wid)], before);
  delete process.env.FLOWPLAN_WORKSPACE_QUOTA_MB;
  await command(owner, { action: "page.duplicate", pageId: source });
  assert.equal(await workspaceBytes(wid), before[1] + 300 * 1024);
});

test("prometheus metrics need the configured bearer token", async () => {
  const { prometheusMetrics, metricsAuthorized } =
    await import("../lib/instance-ops");
  delete process.env.FLOWPLAN_METRICS_TOKEN;
  assert.equal(metricsAuthorized("Bearer x"), null);
  process.env.FLOWPLAN_METRICS_TOKEN = "short";
  assert.equal(metricsAuthorized("Bearer short"), null);
  process.env.FLOWPLAN_METRICS_TOKEN = "a".repeat(32);
  assert.equal(metricsAuthorized(null), false);
  assert.equal(metricsAuthorized(`Bearer ${"b".repeat(32)}`), false);
  assert.equal(metricsAuthorized(`Bearer ${"a".repeat(32)}`), true);
  delete process.env.FLOWPLAN_METRICS_TOKEN;
  const text = await prometheusMetrics();
  assert.match(text, /^# HELP flowplan_database_bytes /m);
  assert.match(text, /^# TYPE flowplan_pages gauge$/m);
  assert.match(
    text,
    new RegExp(`^flowplan_workspace_bytes\\{workspace="${wid}"\\} \\d+$`, "m"),
  );
  assert.match(text, /^flowplan_uptime_seconds \d+$/m);
  // Only IDs, never workspace names.
  assert.doesNotMatch(text, /Speicher/);
});
