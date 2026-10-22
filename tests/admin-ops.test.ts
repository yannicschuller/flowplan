import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-admin-ops-"));
process.env.FLOWPLAN_WEBHOOK_ALLOW_PRIVATE = "true";
const { run, id, one, audit, transaction } = await import("../lib/db");
const { HttpError } = await import("../lib/auth");
const { failed } = await import("../lib/local-auth");
const { takeAnonymousBudget } = await import("../lib/anonymous-budget");
const { flushOpsEvents, noteWorkerRun } = await import("../lib/ops-events");
const { createWorkspace } = await import("../lib/seed");
const { setWorkspaceQuota } = await import("../lib/instance-ops");
const ops = await import("../lib/admin-ops");

function account(name: string, isAdmin = false): Identity {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin, disabled: 0, created_at: "" };
}
const admin = account("ops-admin", true),
  member = account("ops-member");

test("only administrators in the browser; API tokens never", () => {
  assert.doesNotThrow(() => ops.requireOpsAdmin(admin));
  assert.throws(() => ops.requireOpsAdmin(member), /Administrator/);
  assert.throws(() => ops.requireOpsAdmin({ ...admin, apiScope: "write" }), /API-Token/);
  assert.throws(() => ops.requireOpsAdmin({ ...admin, apiScope: "read" }), /API-Token/);
});

test("refusals are counted: 429s, failed sign-ins and anonymous uploads over budget (even when rolled back)", async () => {
  new HttpError(429, "Zu viele Versuche.");
  new HttpError(400, "Nein.");
  failed(["ip:203.0.113.9", "email:x@example.test"]);
  assert.throws(() => transaction(() => takeAnonymousBudget("form:test", 500 * 1024 * 1024)), /Tageslimit/);
  // Written right after the synchronous work.
  await new Promise((resolve) => setImmediate(resolve));
  const summary = ops.opsEventSummary();
  assert.equal(summary.totals.rate_limited.day, 1);
  assert.equal(summary.totals.login_failure.day, 1);
  assert.equal(summary.totals.anonymous_refused.week, 1);
  assert.equal(summary.days.length, 14);
  assert.equal(summary.days.at(-1)!.login_failure, 1);
});

test("the daily sweep removes old counters", () => {
  run("INSERT INTO ops_events(kind,at) VALUES('rate_limited',?)", Date.now() - 40 * 86_400_000);
  ops.sweepOpsEvents();
  assert.equal(one<{ n: number }>("SELECT COUNT(*) n FROM ops_events WHERE at<?", Date.now() - 30 * 86_400_000)!.n, 0);
  assert.equal(ops.opsEventSummary().totals.rate_limited.day, 1);
});

test("overview: storage per workspace, webhook failures without paths, worker status", () => {
  const wid = createWorkspace(admin.id, "Agentur");
  setWorkspaceQuota(wid, 1);
  const page = id();
  run("INSERT INTO pages(id,workspace_id,space_id,title,kind) VALUES(?,?,(SELECT id FROM spaces WHERE workspace_id=? LIMIT 1),'Ablage','document')", page, wid, wid);
  run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", id(), page, "a.bin", "application/octet-stream", 1000 * 1024, admin.id);
  const hook = id();
  run("INSERT INTO webhooks(id,workspace_id,url,events,secret,created_at) VALUES(?,?,?,?,?,?)", hook, wid, "https://hooks.example.test/secret/path?token=abc", "[]", "s", Date.now());
  run("INSERT INTO webhook_deliveries(id,webhook_id,body,attempts,next_at,created_at,status,error) VALUES(?,?,?,?,?,?,?,?)", id(), hook, "{}", 6, Date.now(), Date.now(), 500, null);
  noteWorkerRun("ai", new Error("Anbieter nicht erreichbar"));
  const overview = ops.opsOverview();
  const workspace = overview.storage.workspaces.find((w) => w.id === wid)!;
  assert.equal(workspace.quotaMb, 1);
  assert.equal(workspace.bytes, 1000 * 1024);
  assert.equal(overview.webhooks.givenUp, 1);
  assert.equal(overview.webhooks.recent[0].host, "hooks.example.test");
  assert.ok(!JSON.stringify(overview.webhooks).includes("token=abc"));
  const ai = overview.workers.find((w) => w.key === "ai")!;
  assert.equal(ai.error, "Anbieter nicht erreichbar");
  assert.deepEqual(overview.workers.map((w) => w.key), ["backup", "markdown-export", "ai", "calendar-sync", "issue-sync", "ldap-sync"]);
  assert.equal(typeof overview.mail.pending, "number");
  // A later success clears the error.
  noteWorkerRun("ai", undefined, Date.now() + 120_000);
  assert.equal(ops.workerStatuses().find((w) => w.key === "ai")!.error, null);
  // The workspace is 98 % full: the storage alert holds.
  assert.ok(ops.activeAlerts().some((a) => a.event === "storage_high" && a.detail.includes("Agentur")));
});

test("activity log export with a date filter, as CSV and JSON", () => {
  audit(admin.id, "page.create", "p1", "=cmd");
  run("INSERT INTO audit(id,actor_id,action,resource_id,detail,created_at) VALUES(?,?,?,?,?,?)", id(), admin.id, "old.action", "p0", "", "2020-01-05 10:00:00");
  const json = ops.auditExport({ from: "2020-01-01", to: "2020-01-31", format: "json" });
  const rows = JSON.parse(json.body) as { action: string; at: string }[];
  assert.deepEqual(rows.map((r) => r.action), ["old.action"]);
  assert.equal(rows[0].at, "2020-01-05T10:00:00Z");
  const csv = ops.auditExport({ from: new Date().toISOString().slice(0, 10) });
  assert.ok(csv.body.startsWith("﻿"));
  assert.ok(csv.body.includes("page.create"));
  assert.ok(!csv.body.includes("old.action"));
  assert.ok(csv.body.includes("\"'=cmd\""));
  assert.throws(() => ops.auditExport({ from: "2020-02-01", to: "2020-01-01" }), /Startdatum/);
});

test("health alerts: signed, only configured events, once per event and day", async () => {
  const received: { body: string; signature: string; event: string }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ body, signature: String(req.headers["x-flowplan-signature"]), event: String(req.headers["x-flowplan-event"]) });
      res.end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/alerts`;
  process.env.FLOWPLAN_WEBHOOK_ALLOW_PRIVATE = "false";
  assert.throws(() => ops.saveAlertSettings(admin.id, { url, events: ["storage_high"] }), /https/);
  process.env.FLOWPLAN_WEBHOOK_ALLOW_PRIVATE = "true";
  const saved = ops.saveAlertSettings(admin.id, { url, events: ["storage_high", "login_failures"] });
  assert.ok(saved.secret.length >= 20);
  // The secret stays when the settings are saved again.
  assert.equal(ops.saveAlertSettings(admin.id, { url, events: ["storage_high", "login_failures"] }).secret, saved.secret);
  for (let i = 0; i < ops.LOGIN_ALERT_THRESHOLD; i++) run("INSERT INTO ops_events(kind,at) VALUES('login_failure',?)", Date.now());
  noteWorkerRun("ai", new Error("kaputt"), Date.now() + 240_000);
  const sent = await ops.checkHealthAlerts();
  // Only the configured events are sent (worker_error is not among them).
  assert.deepEqual(sent.map((s) => s.event).sort(), ["login_failures", "storage_high"]);
  assert.ok(sent.every((s) => s.status === 200 && !s.error));
  assert.equal(received.length, 2);
  for (const r of received) {
    assert.equal(r.signature, `sha256=${createHmac("sha256", saved.secret).update(r.body).digest("hex")}`);
    assert.equal(JSON.parse(r.body).event, r.event);
  }
  assert.equal((await ops.checkHealthAlerts()).length, 0);
  assert.equal(received.length, 2);
  // A test message is never de-duplicated.
  assert.equal((await ops.sendTestAlert(admin.id)).status, 200);
  assert.equal(received.at(-1)!.event, "ops.test");
  assert.equal(ops.alertSettingsForAdmin().sent.length, 2);
  ops.saveAlertSettings(admin.id, { url: "", events: [] });
  assert.equal(ops.alertSettingsForAdmin().url, "");
});

test("maintenance notice: shown until its end, then hidden", () => {
  const now = Date.now();
  assert.throws(() => ops.saveMaintenance(admin.id, { message: "Update", start: now + 2000, end: now + 1000 }), /nach dem Beginn/);
  assert.throws(() => ops.saveMaintenance(admin.id, { message: "Update", start: now - 5000, end: now - 1000 }), /Vergangenheit/);
  ops.saveMaintenance(admin.id, { message: "Update auf 0.6", start: now + 3600_000, end: now + 7200_000 });
  assert.equal(ops.maintenanceNotice(now)!.message, "Update auf 0.6");
  assert.equal(ops.maintenanceNotice(now + 7200_001), null);
  assert.ok(one("SELECT 1 FROM audit WHERE action='admin.ops.maintenance'"));
  ops.saveMaintenance(admin.id, null);
  assert.equal(ops.maintenanceNotice(now), null);
  flushOpsEvents();
});
