// The live panels of the settings' start page (#532, lib/admin-monitoring.ts
// monitoringStart, components/settings/admin/live-panels.tsx): accounts per
// day, sign-ins per hour, the backup runs, the AI people count – real data
// only, numbers without names.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-start-glance-"));
delete process.env.FLOWPLAN_METRICS;
const { run, id, one } = await import("../lib/db");
const metrics = await import("../lib/metrics");
const { accountsGlance, signinsGlance, backupsGlance, monitoringGlance, monitoringStart, forgetMonitoringGlance } = await import("../lib/admin-monitoring");
const { backupRuns, runScheduledBackup, BACKUP_RUNS_KEEP } = await import("../lib/scheduled-backup");
const { aiDaily } = await import("../lib/ai-statistics");
const { localDay } = metrics;

const HOUR = 3_600_000,
  DAY = 86_400_000;
const sqliteTime = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);

after(async () => await metrics.clearMetrics());

test("accounts: the new ones per day of 30 days, without demo guests and deleted accounts", async () => {
  const now = Date.now();
  const before = await accountsGlance(now);
  const add = async (at: number, subject = id(), demo = false) =>
    run("INSERT INTO users(id,subject,name,email,created_at,demo_until) VALUES(?,?,?,?,?,?)", id(), subject, "x", `${id()}@example.test`, sqliteTime(at), demo ? now + HOUR : null);
  await add(now - 1000);
  await add(now - 1000);
  await add(now - 2 * DAY);
  await add(now - 40 * DAY);
  await add(now - 1000, id(), true);
  await add(now - 1000, `deleted:${id()}`);
  const a = await accountsGlance(now);
  assert.equal(a.perDay.length, 30);
  assert.equal(a.perDay[29].day, localDay(now));
  const added = (day: string) => (a.perDay.find((d) => d.day === day)?.created ?? 0) - (before.perDay.find((d) => d.day === day)?.created ?? 0);
  assert.equal(added(localDay(now - 1000)), 2);
  assert.equal(added(localDay(now - 2 * DAY)), 1);
  // The one of 40 days ago counts in the total only; demo and deleted nowhere.
  assert.equal(a.total - before.total, 4);
  assert.equal(typeof a.sessions, "number");
});

test("sign-ins per hour of 24 hours: failed always, successful only with the statistics", async () => {
  const now = Date.now();
  const hour = Math.floor(now / HOUR) * HOUR;
  for (const [kind, at] of [
    ["login_success", hour + 1],
    ["login_success", hour - HOUR + 5],
    ["login_failure", hour - HOUR + 6],
    ["login_failure", hour - HOUR + 7],
    ["login_failure", hour - 30 * HOUR],
    ["rate_limited", hour + 2],
  ] as const)
    await run("INSERT INTO ops_events(kind,at) VALUES(?,?)", kind, at);
  const s = await signinsGlance(now, true);
  assert.equal(s.points.length, 24);
  assert.equal(s.points[23].at, hour);
  assert.deepEqual(s.points.slice(-2).map((p) => [p.ok, p.failed]), [
    [1, 2],
    [1, 0],
  ]);
  assert.equal(s.ok, 2);
  assert.equal(s.failed, 2);
  const off = await signinsGlance(now, false);
  assert.equal(off.ok, null);
  assert.ok(off.points.every((p) => p.ok === null));
  assert.equal(off.failed, 2);
});

test("backups: the last runs are kept (outcome and size), the start page gets no error texts", async () => {
  assert.deepEqual(await backupRuns(), []);
  // Before this version only the last run was kept: it counts as the history.
  await run("INSERT INTO instance_state(key,value) VALUES('scheduledBackup',?)", JSON.stringify({ at: 1000, target: "local", name: "old", bytes: 5, error: null }));
  assert.deepEqual((await backupRuns()).map((r) => r.at), [1000]);
  const now = Date.now();
  const first = await runScheduledBackup(now - 2 * HOUR);
  const second = await runScheduledBackup(now - HOUR);
  assert.equal(first.error, null);
  assert.ok(second.bytes > 0);
  assert.deepEqual((await backupRuns()).map((r) => r.at), [1000, now - 2 * HOUR, now - HOUR]);
  // A failed run is kept with its error; the glance only says that it failed.
  const runs = await backupRuns();
  await run("UPDATE instance_state SET value=? WHERE key='scheduledBackupRuns'", JSON.stringify([...runs, { at: now, target: "local", name: "x", bytes: 0, error: "disk full" }]));
  const g = await backupsGlance();
  assert.equal(g.enabled, true);
  assert.equal(g.target, "local");
  assert.deepEqual(g.runs[g.runs.length - 1], { at: now, bytes: 0, failed: true });
  assert.ok(!JSON.stringify(g).includes("disk full"));
  // At most BACKUP_RUNS_KEEP runs.
  await run("UPDATE instance_state SET value=? WHERE key='scheduledBackupRuns'", JSON.stringify(Array.from({ length: BACKUP_RUNS_KEEP }, (_, i) => ({ at: i + 1, target: "local", name: "n", bytes: 1, error: null }))));
  await runScheduledBackup(now + 1000);
  const kept = await backupRuns();
  assert.equal(kept.length, BACKUP_RUNS_KEEP);
  assert.equal(kept[kept.length - 1].at, now + 1000);
  assert.equal(kept[0].at, 2);
});

test("AI per day: the features with the most tokens and how many people – a count, no names", async () => {
  const day = localDay(Date.now());
  for (const [user, feature, tokens] of [
    ["u1", "writer", 300],
    ["u2", "writer", 100],
    ["u2", "summary", 50],
    ["", "embeddings", 20],
  ] as const)
    await run("INSERT INTO metrics_ai_usage(day,model,source,workspace_id,user_id,feature,requests,tokens_in,tokens_out) VALUES(?,?,?,?,?,?,?,?,?)", day, "m", "instance", "", user, feature, 1, tokens, 0);
  const ai = await aiDaily(Date.now(), 14);
  assert.equal(ai.people, 2);
  assert.deepEqual(ai.features.map((f) => [f.feature, f.tokens]), [
    ["writer", 400],
    ["summary", 50],
    ["embeddings", 20],
  ]);
  assert.ok(!JSON.stringify(ai).includes("u1"));
});

test("the live answer carries the glance, cached a minute and per statistics switch", async () => {
  forgetMonitoringGlance();
  await metrics.saveMetricsSetting(true);
  const now = Date.now();
  const d = await monitoringStart(now);
  assert.equal(d.collecting.enabled, true);
  assert.equal(d.glance.accounts.perDay.length, 30);
  assert.equal(d.glance.signins.points.length, 24);
  assert.equal(d.glance.storage.trend.length, 30);
  assert.ok(d.glance.storage.total >= d.glance.storage.databaseBytes);
  assert.equal(d.glance.background.deliveries.days.length, 7);
  assert.equal(typeof d.glance.background.queues.search, "number");
  // Cached: a new account shows within the minute only after the cache goes.
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", id(), id(), "late", "late@example.test");
  assert.equal((await monitoringGlance(now + 1000)).accounts.total, d.glance.accounts.total);
  assert.equal((await monitoringGlance(now + 61_000)).accounts.total, d.glance.accounts.total + 1);
  // Switched off: another answer, without successful sign-ins.
  assert.equal((await monitoringGlance(now + 62_000, false)).signins.ok, null);
  assert.ok(await one("SELECT 1 FROM users WHERE name='late'"));
  // The route answers it for ?view=live and forgets the cache when the switch changes.
  const route = readFileSync(join(import.meta.dirname, "../app/api/admin/monitoring/handler.ts"), "utf8");
  assert.match(route, /view"\) === "live"\) return Response\.json\(await monitoringStart\(/);
  assert.match(route, /forgetMonitoringGlance\(\)/);
});
