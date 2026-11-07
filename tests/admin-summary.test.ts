// The facts behind the administration's tiles (lib/admin-summary.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-admin-summary-"));
delete process.env.SMTP_HOST;
delete process.env.OIDC_ISSUER;
const { run, id, audit } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { setWorkspaceQuota } = await import("../lib/instance-ops");
const { noteWorkerRun } = await import("../lib/ops-events");
const { adminSummary, adminSummaryFor } = await import("../lib/admin-summary");

async function account(name: string, isAdmin = false): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin, disabled: 0, created_at: "" };
}
const admin = await account("summary-admin", true),
  member = await account("summary-member");

test("only administrators in the browser get the summary", async () => {
  await assert.doesNotReject(async () => await adminSummaryFor(admin));
  await assert.rejects(async () => await adminSummaryFor(member), /Administrator/);
  await assert.rejects(async () => await adminSummaryFor({ ...admin, apiScope: "read" }), /API-Token/);
});

test("users, sessions and workspaces are counted; nearly full workspaces are flagged", async () => {
  const before = await adminSummary();
  const gone = await account("summary-disabled");
  await run("UPDATE users SET disabled=1 WHERE id=?", gone.id);
  await run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", id(), admin.id, "[]", Date.now() + 60_000);
  await run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", id(), admin.id, "[]", Date.now() - 60_000);
  const wid = await createWorkspace(admin.id, "Voll");
  await setWorkspaceQuota(wid, 1);
  const page = id();
  await run("INSERT INTO pages(id,workspace_id,space_id,title,kind) VALUES(?,?,(SELECT id FROM spaces WHERE workspace_id=? LIMIT 1),'Datei','document')", page, wid, wid);
  await run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", id(), page, "a.bin", "application/octet-stream", 1000 * 1024, admin.id);
  const after = await adminSummary();
  assert.equal(after.users.total, before.users.total + 1);
  assert.equal(after.users.disabled, before.users.disabled + 1);
  assert.equal(after.users.sessions, before.users.sessions + 1);
  assert.equal(after.workspaces.total, before.workspaces.total + 1);
  assert.equal(after.workspaces.nearlyFull, before.workspaces.nearlyFull + 1);
});

test("services, monitoring and the activity of the last day", async () => {
  await audit(admin.id, "summary.test", "x");
  await run("INSERT INTO audit(id,actor_id,action,resource_id,created_at) VALUES(?,?,?,?,?)", id(), admin.id, "summary.old", "x", "2000-01-01 00:00:00");
  await noteWorkerRun("ai", new Error("kaputt"));
  const s = await adminSummary();
  assert.ok(s.audit.day >= 1);
  // Only workers that are switched on count (AI is off here).
  assert.deepEqual(s.monitoring.failingWorkers, []);
  assert.ok(Array.isArray(s.monitoring.alerts));
  assert.equal(s.mail.configured, false);
  // The push relay as last checked – the summary itself makes no request.
  assert.equal(s.push.enabled, true);
  assert.equal(s.push.health, null);
  assert.equal(s.push.tone, "info");
  assert.equal(s.signin.oidc, false);
  assert.equal(typeof s.general.version, "string");
  assert.equal(s.general.update, null);
  assert.equal((await adminSummary(Date.now(), { current: "0.1.0", latest: "9.9.9", url: "" })).general.update, "9.9.9");
  assert.deepEqual(Object.keys(s).sort(), ["ai", "audit", "charts", "export", "extensions", "general", "limits", "mail", "maintenance", "monitoring", "push", "security", "securityCenter", "signin", "storage", "users", "workspaces"]);
});

test("limits, extensions and the maintenance notice", async () => {
  const { saveMaintenance } = await import("../lib/admin-ops");
  const s = await adminSummary();
  assert.equal(typeof s.limits.uploadMb, "number");
  assert.ok(s.limits.exceptions >= 1);
  assert.equal(s.extensions.plugins, 0);
  assert.equal(s.extensions.domains, 0);
  assert.equal(s.maintenance.state, null);
  const now = Date.now();
  await saveMaintenance(admin.id, { message: "Update", start: now + 3_600_000, end: now + 7_200_000 }, now);
  assert.equal((await adminSummary(now)).maintenance.state, "scheduled");
  assert.equal((await adminSummary(now + 4_000_000)).maintenance.state, "active");
  assert.equal((await adminSummary(now + 8_000_000)).maintenance.state, null);
  await saveMaintenance(admin.id, null, now);
});

test("a failed Markdown export only counts while the export is on (#73)", async () => {
  const set = async (key: string, value: unknown) =>
    await run("INSERT INTO instance_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, JSON.stringify(value));
  const page = id();
  await set("markdownExportRuns", [{ pageId: page, name: "x.zip", at: Date.now(), bytes: 0, error: "push refused" }]);
  // On, with the failed run as the latest: the tile shows it.
  await set("markdownExport", { userId: admin.id, pageIds: [page] });
  assert.equal((await adminSummary()).export.failed, true);
  // Switched off: the old error is history.
  await set("markdownExport", { userId: admin.id, pageIds: [] });
  assert.equal((await adminSummary()).export.failed, false);
  // On again, the failed run still the latest: it counts until the next good run.
  await set("markdownExport", { userId: admin.id, pageIds: [page] });
  assert.equal((await adminSummary()).export.failed, true);
  await set("markdownExportRuns", [{ pageId: page, name: "y.zip", at: Date.now() + 1, bytes: 10, error: null }]);
  assert.equal((await adminSummary()).export.failed, false);
});
