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

async function session(userId: string, expires = Date.now() + 60_000) {
  const token = randomBytes(16).toString("hex");
  await run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", createHash("sha256").update(token).digest("hex"), userId, "[]", expires);
  return (await identityFromToken(token))!;
}
const workspaceOf = async (uid: string) =>
  await one<{ id: string; quota_mb: number }>(
    "SELECT w.id,w.quota_mb FROM workspaces w JOIN members m ON m.workspace_id=w.id WHERE m.user_id=?",
    uid,
  );

test("the demo is off until an admin switches it on", async () => {
  assert.equal((await instanceSettings()).publicDemo, false);
  await assert.rejects(async () => await startDemo("1.2.3.4"), /ausgeschaltet/);
  await saveInstanceSettings({ ...(await instanceSettings()), publicDemo: true });
});

test("a demo gets its own example workspace and cannot reach anyone outside it", async () => {
  const uid = await startDemo("10.0.0.1");
  const me = await session(uid);
  assert.equal(me.demo, true);
  assert.equal(me.isAdmin, false);
  const ws = (await workspaceOf(uid))!;
  assert.equal(ws.quota_mb, 25);
  const boot = await bootstrap(me);
  assert.ok(boot.pages.some((p: { title: string }) => p.title === "Projekte"), "example content");
  assert.equal(boot.workspaces.length, 1);
  const pageId = boot.pages[0].id;
  // Writing inside is fine; reaching outside is not.
  await command(me, { action: "page.create", workspaceId: ws.id, spaceId: boot.spaces[0].id, title: "Mein Test", kind: "document" });
  for (const input of [
    { action: "page.publish", pageId, enabled: true },
    { action: "share.create", pageId, role: "viewer" },
    { action: "member.invite", workspaceId: ws.id, email: "x@example.test", role: "editor" },
    { action: "workspace.create", name: "Noch einer" },
    { action: "admin.settings", settings: {} },
  ])
    await assert.rejects(async () => await command(me, input), /In der Demo nicht verfügbar/, input.action);
  assert.equal(demoAllows("form.update", { config: { enabled: true } }), false);
  assert.equal(demoAllows("form.update", { config: { enabled: false } }), true);
});

test("ending a demo deletes account, workspace, pages and its activity", async () => {
  const uid = await startDemo("10.0.0.2");
  const me = await session(uid);
  const ws = (await workspaceOf(uid))!.id;
  const space = (await bootstrap(me)).spaces[0].id;
  await command(me, { action: "page.create", workspaceId: ws, spaceId: space, title: "Notiz", kind: "document" });
  await command(me, { action: "space.create", workspaceId: ws, name: "Eigener Bereich", visibility: "private" });
  await command(me, { action: "group.create", workspaceId: ws, name: "Team" });
  assert.ok(Number((await one<{ n: number }>("SELECT COUNT(*) n FROM pages WHERE workspace_id=?", ws))!.n) > 0);
  assert.equal(await endDemo(uid), true);
  assert.equal(await one("SELECT 1 FROM users WHERE id=?", uid), undefined);
  assert.equal(await one("SELECT 1 FROM workspaces WHERE id=?", ws), undefined);
  assert.equal((await one<{ n: number }>("SELECT COUNT(*) n FROM pages WHERE workspace_id=?", ws))!.n, 0);
  assert.equal((await one<{ n: number }>("SELECT COUNT(*) n FROM sessions WHERE user_id=?", uid))!.n, 0);
  assert.equal((await one<{ n: number }>("SELECT COUNT(*) n FROM audit WHERE actor_id=?", uid))!.n, 0);
});

test("demos without an active session or past their end are cleaned up; starts are limited", async () => {
  const idle = await startDemo("10.0.0.3");
  await session(idle, Date.now() - 1000);
  const over = await startDemo("10.0.0.3");
  await session(over);
  await run("UPDATE users SET demo_until=? WHERE id=?", Date.now() - 1, over);
  const alive = await startDemo("10.0.0.3");
  await session(alive);
  await cleanupDemos();
  const left = (await all<{ id: string }>("SELECT id FROM users WHERE demo_until IS NOT NULL")).map((u) => u.id);
  assert.ok(!left.includes(idle));
  assert.ok(!left.includes(over));
  assert.ok(left.includes(alive));
  await startDemo("10.0.0.3");
  await startDemo("10.0.0.3");
  await assert.rejects(async () => await startDemo("10.0.0.3"), /Zu viele Demos/);
});

test("operations count running demos and every demo ever started", async () => {
  const { instanceMetrics, prometheusMetrics } = await import("../lib/instance-ops");
  const before = await instanceMetrics();
  const uid = await startDemo("10.0.0.9");
  await session(uid);
  const during = await instanceMetrics();
  assert.equal(during.demosActive, before.demosActive + 1);
  assert.equal(during.demosStarted, before.demosStarted + 1);
  await endDemo(uid);
  const after = await instanceMetrics();
  assert.equal(after.demosActive, before.demosActive);
  assert.equal(after.demosStarted, before.demosStarted + 1, "the total survives deleted demos");
  assert.match(await prometheusMetrics(), /flowplan_demos_started_total \d+/);
});
