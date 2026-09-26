import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-demo-"));
const { run, one, all } = await import("../lib/db");
const { startDemo, endDemo, cleanupDemos, demoAllows } = await import("../lib/demo");
const { saveInstanceSettings, instanceSettings } = await import("../lib/instance-settings");
const { identityFromToken } = await import("../lib/auth");
const { command, bootstrap } = await import("../lib/api");

function session(userId: string, expires = Date.now() + 60_000) {
  const token = randomBytes(16).toString("hex");
  run("INSERT INTO sessions VALUES(?,?,?,?)", createHash("sha256").update(token).digest("hex"), userId, "[]", expires);
  return identityFromToken(token)!;
}
const workspaceOf = (uid: string) =>
  one<{ id: string; quota_mb: number }>(
    "SELECT w.id,w.quota_mb FROM workspaces w JOIN members m ON m.workspace_id=w.id WHERE m.user_id=?",
    uid,
  );

test("the demo is off until an admin switches it on", () => {
  assert.equal(instanceSettings().publicDemo, false);
  assert.throws(() => startDemo("1.2.3.4"), /ausgeschaltet/);
  saveInstanceSettings({ ...instanceSettings(), publicDemo: true });
});

test("a demo gets its own example workspace and cannot reach anyone outside it", () => {
  const uid = startDemo("10.0.0.1");
  const me = session(uid);
  assert.equal(me.demo, true);
  assert.equal(me.isAdmin, false);
  const ws = workspaceOf(uid)!;
  assert.equal(ws.quota_mb, 25);
  const boot = bootstrap(me);
  assert.ok(boot.pages.some((p: { title: string }) => p.title === "Produkt-Roadmap"), "example content");
  assert.equal(boot.workspaces.length, 1);
  const pageId = boot.pages[0].id;
  // Writing inside is fine; reaching outside is not.
  command(me, { action: "page.create", workspaceId: ws.id, spaceId: boot.spaces[0].id, title: "Mein Test", kind: "document" });
  for (const input of [
    { action: "page.publish", pageId, enabled: true },
    { action: "share.create", pageId, role: "viewer" },
    { action: "member.invite", workspaceId: ws.id, email: "x@example.test", role: "editor" },
    { action: "workspace.create", name: "Noch einer" },
    { action: "admin.settings", settings: {} },
  ])
    assert.throws(() => command(me, input), /In der Demo nicht verfügbar/, input.action);
  assert.equal(demoAllows("form.update", { config: { enabled: true } }), false);
  assert.equal(demoAllows("form.update", { config: { enabled: false } }), true);
});

test("ending a demo deletes account, workspace and pages", () => {
  const uid = startDemo("10.0.0.2");
  session(uid);
  const ws = workspaceOf(uid)!.id;
  assert.ok(Number(one<{ n: number }>("SELECT COUNT(*) n FROM pages WHERE workspace_id=?", ws)!.n) > 0);
  assert.equal(endDemo(uid), true);
  assert.equal(one("SELECT 1 FROM users WHERE id=?", uid), undefined);
  assert.equal(one("SELECT 1 FROM workspaces WHERE id=?", ws), undefined);
  assert.equal(one<{ n: number }>("SELECT COUNT(*) n FROM pages WHERE workspace_id=?", ws)!.n, 0);
  assert.equal(one<{ n: number }>("SELECT COUNT(*) n FROM sessions WHERE user_id=?", uid)!.n, 0);
});

test("demos without an active session or past their end are cleaned up; starts are limited", () => {
  const idle = startDemo("10.0.0.3");
  session(idle, Date.now() - 1000);
  const over = startDemo("10.0.0.3");
  session(over);
  run("UPDATE users SET demo_until=? WHERE id=?", Date.now() - 1, over);
  const alive = startDemo("10.0.0.3");
  session(alive);
  cleanupDemos();
  const left = all<{ id: string }>("SELECT id FROM users WHERE demo_until IS NOT NULL").map((u) => u.id);
  assert.ok(!left.includes(idle));
  assert.ok(!left.includes(over));
  assert.ok(left.includes(alive));
  startDemo("10.0.0.3");
  startDemo("10.0.0.3");
  assert.throws(() => startDemo("10.0.0.3"), /Zu viele Demos/);
});

test("operations count running demos and every demo ever started", async () => {
  const { instanceMetrics, prometheusMetrics } = await import("../lib/instance-ops");
  const before = instanceMetrics();
  const uid = startDemo("10.0.0.9");
  session(uid);
  const during = instanceMetrics();
  assert.equal(during.demosActive, before.demosActive + 1);
  assert.equal(during.demosStarted, before.demosStarted + 1);
  endDemo(uid);
  const after = instanceMetrics();
  assert.equal(after.demosActive, before.demosActive);
  assert.equal(after.demosStarted, before.demosStarted + 1, "the total survives deleted demos");
  assert.match(prometheusMetrics(), /flowplan_demos_started_total \d+/);
});
