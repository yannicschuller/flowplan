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

function account(name: string, isAdmin = false): Identity {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin, disabled: 0, created_at: "" };
}
const admin = account("summary-admin", true),
  member = account("summary-member");

test("only administrators in the browser get the summary", () => {
  assert.doesNotThrow(() => adminSummaryFor(admin));
  assert.throws(() => adminSummaryFor(member), /Administrator/);
  assert.throws(() => adminSummaryFor({ ...admin, apiScope: "read" }), /API-Token/);
});

test("users, sessions and workspaces are counted; nearly full workspaces are flagged", () => {
  const before = adminSummary();
  const gone = account("summary-disabled");
  run("UPDATE users SET disabled=1 WHERE id=?", gone.id);
  run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", id(), admin.id, "[]", Date.now() + 60_000);
  run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", id(), admin.id, "[]", Date.now() - 60_000);
  const wid = createWorkspace(admin.id, "Voll");
  setWorkspaceQuota(wid, 1);
  const page = id();
  run("INSERT INTO pages(id,workspace_id,space_id,title,kind) VALUES(?,?,(SELECT id FROM spaces WHERE workspace_id=? LIMIT 1),'Datei','document')", page, wid, wid);
  run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", id(), page, "a.bin", "application/octet-stream", 1000 * 1024, admin.id);
  const after = adminSummary();
  assert.equal(after.users.total, before.users.total + 1);
  assert.equal(after.users.disabled, before.users.disabled + 1);
  assert.equal(after.users.sessions, before.users.sessions + 1);
  assert.equal(after.workspaces.total, before.workspaces.total + 1);
  assert.equal(after.workspaces.nearlyFull, before.workspaces.nearlyFull + 1);
});

test("services, monitoring and the activity of the last day", () => {
  audit(admin.id, "summary.test", "x");
  run("INSERT INTO audit(id,actor_id,action,resource_id,created_at) VALUES(?,?,?,?,?)", id(), admin.id, "summary.old", "x", "2000-01-01 00:00:00");
  noteWorkerRun("ai", new Error("kaputt"));
  const s = adminSummary();
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
  assert.equal(adminSummary(Date.now(), { current: "0.1.0", latest: "9.9.9", url: "" }).general.update, "9.9.9");
  assert.deepEqual(Object.keys(s).sort(), ["ai", "audit", "charts", "export", "extensions", "general", "limits", "mail", "maintenance", "monitoring", "push", "security", "securityCenter", "signin", "storage", "users", "workspaces"]);
});

test("limits, extensions and the maintenance notice", async () => {
  const { saveMaintenance } = await import("../lib/admin-ops");
  const s = adminSummary();
  assert.equal(typeof s.limits.uploadMb, "number");
  assert.ok(s.limits.exceptions >= 1);
  assert.equal(s.extensions.plugins, 0);
  assert.equal(s.extensions.domains, 0);
  assert.equal(s.maintenance.state, null);
  const now = Date.now();
  saveMaintenance(admin.id, { message: "Update", start: now + 3_600_000, end: now + 7_200_000 }, now);
  assert.equal(adminSummary(now).maintenance.state, "scheduled");
  assert.equal(adminSummary(now + 4_000_000).maintenance.state, "active");
  assert.equal(adminSummary(now + 8_000_000).maintenance.state, null);
  saveMaintenance(admin.id, null, now);
});
