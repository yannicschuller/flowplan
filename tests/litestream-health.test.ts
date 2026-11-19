// A stuck Litestream replica (lib/litestream-health.ts): the check every
// 15 minutes lists <prefix>/db/0000/ once; old L0 files while Litestream has
// run here for more than 30 minutes open an incident – warning, one alert,
// an activity log entry and, after a backup, the marker "remote" for the
// entrypoint. Only on the container that replicates (it wrote
// .flowplan-replicating under the lock), never with Litestream off or on
// PostgreSQL; FLOWPLAN_LITESTREAM_AUTOHEAL=off keeps the marker away.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
import { onPostgres } from "./helpers/backend";
import { startFakeS3 } from "./helpers/fake-s3";
import { fakeProc } from "./helpers/fake-proc";

const s3 = await startFakeS3();
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-litestream-health-"));
process.env.S3_ENDPOINT = s3.endpoint;
process.env.S3_BUCKET = "bucket";
process.env.S3_ACCESS_KEY_ID = "test";
process.env.S3_SECRET_ACCESS_KEY = "test";
process.env.S3_PREFIX = "flowplan";
process.env.FLOWPLAN_LITESTREAM_ACTIVE = "1";
delete process.env.FLOWPLAN_LITESTREAM;
delete process.env.FLOWPLAN_LITESTREAM_AUTOHEAL;
const data = process.env.FLOWPLAN_DATA_DIR;
const { run, id, one, all } = await import("../lib/db");
const health = await import("../lib/litestream-health");
const { systemOverview } = await import("../lib/cluster/system");
const { activeAlerts, checkHealthAlerts } = await import("../lib/admin-ops");
after(() => s3.close());

const MIN = 60_000;
const marker = join(data, "litestream-reset");
const replicating = join(data, ".flowplan-replicating");
const waiting = join(data, ".flowplan-waiting");
const replicatingFor = (ms: number, host = hostname(), now = Date.now()) => writeFileSync(replicating, `since=${Math.floor((now - ms) / 1000)}\nhost=${host}\n`);
const listing = (oldestAgeMs: number | null, files = 3, now = Date.now()) => async () => ({ files: oldestAgeMs === null ? 0 : files, oldestAt: oldestAgeMs === null ? null : now - oldestAgeMs, truncated: false });
const listingFails = async () => {
  throw new Error("Liste der Litestream-Replik: HTTP 503");
};
const auditActions = async () => (await all<{ action: string }>("SELECT action FROM audit WHERE action LIKE '%litestream%' ORDER BY rowid")).map((r) => r.action);
const backupsInBucket = () => [...s3.objects.keys()].filter((k) => k.startsWith("/bucket/flowplan/backups/"));

async function account(name: string, isAdmin: boolean): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin, disabled: 0, created_at: "" };
}

beforeEach(async () => {
  rmSync(marker, { force: true });
  rmSync(waiting, { force: true });
  rmSync(replicating, { force: true });
  delete process.env.FLOWPLAN_LITESTREAM_AUTOHEAL;
  process.env.FLOWPLAN_LITESTREAM_ACTIVE = "1";
  delete process.env.FLOWPLAN_LITESTREAM;
  s3.failing.clear();
  await run("DELETE FROM instance_state WHERE key='litestreamReplica'");
  await run("DELETE FROM ops_alerts");
  await run("DELETE FROM audit WHERE action LIKE '%litestream%'");
});

const sqlite = { skip: onPostgres && "SQLite only (Litestream)" };

test("stuck: old L0 files and Litestream running for an hour – backup, marker 'remote', warning, log entry", sqlite, async () => {
  replicatingFor(60 * MIN);
  const before = backupsInBucket().length;
  const result = await health.checkLitestreamReplica(Date.now(), listing(2 * 60 * MIN, 120));
  assert.equal(result.state, "stuck");
  assert.ok(result.state === "stuck" && result.opened);
  assert.equal(readFileSync(marker, "utf8").split("\n")[0], "remote");
  assert.match(readFileSync(marker, "utf8"), /^source=auto$/m);
  assert.equal(backupsInBucket().length, before + 1, "a scheduled backup before the marker");
  const status = (await systemOverview()).litestream;
  assert.ok(status?.incident);
  assert.equal(status.incident.repair, "scheduled");
  assert.equal(status.incident.files, 120);
  assert.equal(status.marker, "remote");
  assert.ok(status.incident.backup?.name.startsWith("flowplan-"));
  assert.deepEqual(await auditActions(), ["litestream.replica.reset_scheduled", "litestream.replica.stuck"]);
  // The tiles of the landing page count it; the daily health alerts leave it
  // to the alert per incident.
  assert.ok((await activeAlerts()).some((a) => a.event === "litestream_stuck"));

  // The next check: the same incident, no second backup or log entry.
  const again = await health.checkLitestreamReplica(Date.now() + 15 * MIN, listing(2 * 60 * MIN + 15 * MIN, 150));
  assert.ok(again.state === "stuck" && !again.opened);
  assert.equal(backupsInBucket().length, before + 1);
  assert.deepEqual(await auditActions(), ["litestream.replica.reset_scheduled", "litestream.replica.stuck"]);
});

test("healthy: no old L0 files – nothing happens, an open incident ends", sqlite, async () => {
  replicatingFor(60 * MIN);
  assert.deepEqual(await health.checkLitestreamReplica(Date.now(), listing(2 * MIN, 4)), { state: "healthy", files: 4 });
  assert.deepEqual(await health.checkLitestreamReplica(Date.now(), listing(null)), { state: "healthy", files: 0 });
  assert.equal(existsSync(marker), false);
  assert.equal((await systemOverview()).litestream?.incident, null);
  // An incident that was open: closed once the old files are gone.
  await health.checkLitestreamReplica(Date.now(), listing(3 * 60 * MIN));
  assert.ok((await systemOverview()).litestream?.incident);
  await health.checkLitestreamReplica(Date.now(), listing(MIN));
  assert.equal((await systemOverview()).litestream?.incident, null);
  assert.ok((await auditActions()).includes("litestream.replica.healthy"));
});

test("just started: old L0 files right after a downtime are no alarm in the first 30 minutes", sqlite, async () => {
  replicatingFor(10 * MIN);
  const result = await health.checkLitestreamReplica(Date.now(), listing(5 * 60 * 60_000));
  assert.equal(result.state, "starting");
  assert.equal(existsSync(marker), false);
  assert.equal((await systemOverview()).litestream?.incident, null);
});

test("disabled: Litestream off, not started by the entrypoint, or no S3 – no check, no warning", sqlite, async () => {
  replicatingFor(60 * MIN);
  let listed = false;
  const list = async () => {
    listed = true;
    return { files: 9, oldestAt: 0, truncated: false };
  };
  process.env.FLOWPLAN_LITESTREAM = "off";
  assert.deepEqual(await health.checkLitestreamReplica(Date.now(), list), { state: "inactive" });
  assert.equal(await health.litestreamStatus(), null);
  delete process.env.FLOWPLAN_LITESTREAM;
  delete process.env.FLOWPLAN_LITESTREAM_ACTIVE;
  assert.deepEqual(await health.checkLitestreamReplica(Date.now(), list), { state: "inactive" });
  process.env.FLOWPLAN_LITESTREAM_ACTIVE = "1";
  const bucket = process.env.S3_BUCKET;
  delete process.env.S3_BUCKET;
  try {
    assert.deepEqual(await health.checkLitestreamReplica(Date.now(), list), { state: "inactive" });
  } finally {
    process.env.S3_BUCKET = bucket;
  }
  assert.equal(listed, false);
  assert.equal(existsSync(marker), false);
});

test("PostgreSQL: never (no Litestream there)", async () => {
  replicatingFor(60 * MIN);
  const before = process.env.DATABASE_URL;
  // On a SQLite run only the check reads it: it stops before any query.
  if (!onPostgres) process.env.DATABASE_URL = "postgres://localhost/none";
  try {
    assert.equal(health.replicatingSince(), null);
    assert.deepEqual(await health.checkLitestreamReplica(Date.now(), listing(5 * 60 * 60_000)), { state: "inactive" });
  } finally {
    if (!onPostgres) {
      if (before === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = before;
    }
  }
  assert.equal(existsSync(marker), false);
});

test("no lock: another container replicates (its file), or this one waits for the lock – no check here", sqlite, async () => {
  replicatingFor(60 * MIN, "the-other-container");
  assert.deepEqual(await health.checkLitestreamReplica(Date.now(), listing(5 * 60 * 60_000)), { state: "inactive" });
  // No file at all: Litestream has not started here.
  rmSync(replicating);
  assert.deepEqual(await health.checkLitestreamReplica(Date.now(), listing(5 * 60 * 60_000)), { state: "inactive" });
  // Same hostname (a fixed hostname:), but this container waits for the lock.
  replicatingFor(60 * MIN);
  writeFileSync(waiting, `since=${Math.floor(Date.now() / 1000)}\nhost=${hostname()}\nlitestream=1\n`);
  assert.deepEqual(await health.checkLitestreamReplica(Date.now(), listing(5 * 60 * 60_000)), { state: "inactive" });
  assert.equal(existsSync(marker), false);
  const status = await health.litestreamStatus();
  assert.equal(status?.active, false);
  assert.equal(status?.incident, null);
});

test("FLOWPLAN_LITESTREAM_AUTOHEAL=off: detection and warning, but no marker and no backup", sqlite, async () => {
  process.env.FLOWPLAN_LITESTREAM_AUTOHEAL = "off";
  replicatingFor(60 * MIN);
  const before = backupsInBucket().length;
  const result = await health.checkLitestreamReplica(Date.now(), listing(2 * 60 * MIN));
  assert.ok(result.state === "stuck" && result.incident.repair === "off");
  assert.equal(existsSync(marker), false);
  assert.equal(backupsInBucket().length, before);
  const status = await health.litestreamStatus();
  assert.equal(status?.autoheal, false);
  assert.equal(status?.incident?.repair, "off");
  assert.deepEqual(await auditActions(), ["litestream.replica.stuck"]);
});

test("the backup before the repair fails: no marker (tried again after six hours)", sqlite, async () => {
  replicatingFor(60 * MIN);
  s3.failing.add("/backups/");
  const now = Date.now();
  const result = await health.checkLitestreamReplica(now, listing(2 * 60 * MIN, 3, now));
  assert.ok(result.state === "stuck" && result.incident.repair === "backup_failed");
  assert.ok(result.state === "stuck" && result.incident.backup?.error);
  assert.equal(existsSync(marker), false);
  // Not every 15 minutes …
  s3.failing.clear();
  await health.checkLitestreamReplica(now + 15 * MIN, listing(2 * 60 * MIN, 3, now + 15 * MIN));
  assert.equal(existsSync(marker), false);
  // … but after six hours.
  await health.checkLitestreamReplica(now + 6 * 60 * MIN, listing(8 * 60 * MIN, 3, now + 6 * 60 * MIN));
  assert.equal(readFileSync(marker, "utf8").split("\n")[0], "remote");
});

test("a bucket that does not answer is no incident", sqlite, async () => {
  replicatingFor(60 * MIN);
  const result = await health.checkLitestreamReplica(Date.now(), listingFails);
  assert.equal(result.state, "error");
  assert.equal(existsSync(marker), false);
  assert.match((await health.litestreamStatus())?.lastCheck?.error || "", /HTTP 503/);
});

test("the real listing: one bounded page of <prefix>/db/0000/ with LastModified", sqlite, async () => {
  const old = Date.now() - 3 * 60 * MIN;
  s3.objects.set("/bucket/flowplan/db/0000/0000000000000001-0000000000000001.ltx", { body: Buffer.from("x"), at: old });
  s3.objects.set("/bucket/flowplan/db/0000/0000000000000002-0000000000000002.ltx", { body: Buffer.from("x"), at: Date.now() });
  s3.objects.set("/bucket/flowplan/db/0001/0000000000000001-0000000000000002.ltx", { body: Buffer.from("x"), at: old - 1 });
  s3.objects.set("/bucket/flowplan/uploads/abc", { body: Buffer.from("x"), at: old - 2 });
  const requests = s3.requests.length;
  const l0 = await health.listLevel0();
  assert.equal(l0.files, 2);
  assert.equal(Math.floor(l0.oldestAt! / 1000), Math.floor(old / 1000));
  assert.equal(l0.truncated, false);
  const sent = s3.requests.slice(requests);
  assert.equal(sent.length, 1, "one list call");
  assert.match(sent[0], /^GET \/bucket\?list-type=2&max-keys=1000&prefix=flowplan%2Fdb%2F0000%2F$/);
  // Detected through the bucket.
  replicatingFor(60 * MIN);
  assert.equal((await health.checkLitestreamReplica()).state, "stuck");
  for (const key of [...s3.objects.keys()]) if (key.includes("/db/")) s3.objects.delete(key);
});

test("the alert goes out once per incident (webhook and chat apps), not with the daily health alerts", sqlite, async () => {
  const { createServer } = await import("node:http");
  const received: string[] = [];
  const hook = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push(body);
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((done) => hook.listen(0, "127.0.0.1", done));
  process.env.FLOWPLAN_WEBHOOK_ALLOW_PRIVATE = "true";
  const { saveAlertSettings, alertSettingsForAdmin } = await import("../lib/admin-ops");
  const admin = await account("alert-admin", true);
  try {
    await saveAlertSettings(admin.id, { url: `http://127.0.0.1:${(hook.address() as { port: number }).port}/hook`, events: ["litestream_stuck"] });
    replicatingFor(60 * MIN);
    await health.checkLitestreamReplica(Date.now(), listing(2 * 60 * MIN));
    await health.checkLitestreamReplica(Date.now() + 15 * MIN, listing(2 * 60 * MIN));
    await checkHealthAlerts(Date.now() + 20 * MIN);
    assert.equal(received.length, 1, received.join("\n"));
    assert.equal(JSON.parse(received[0]).event, "ops.litestream_stuck");
    assert.equal((await alertSettingsForAdmin()).sent.filter((s) => s.event === "litestream_stuck").length, 1);
  } finally {
    await saveAlertSettings(admin.id, { url: "", events: [] });
    await new Promise<void>((done) => hook.close(() => done()));
  }
});

test("alert settings saved before this event get it as well", sqlite, async () => {
  const { alertSettingsForAdmin } = await import("../lib/admin-ops");
  const { sealSecret } = await import("../lib/secret-box");
  await run(
    "INSERT INTO instance_settings(key,value) VALUES('opsAlerts',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    JSON.stringify({ url: "https://alerts.example.test/hook", events: ["backup_failed", "security"], secret: sealSecret("s", "ops-alerts"), version: 2 }),
  );
  assert.deepEqual((await alertSettingsForAdmin()).events, ["backup_failed", "security", "litestream_stuck", "unexpected_restart"]);
  await run("DELETE FROM instance_settings WHERE key='opsAlerts'");
});

test("the button: administrators only, a backup and the marker, audited; cancel; restart only with a marker", sqlite, async () => {
  const admin = await account("ls-admin", true);
  const member = await account("ls-member", false);
  process.env.FLOWPLAN_LITESTREAM_AUTOHEAL = "off";
  replicatingFor(60 * MIN);
  await assert.rejects(health.litestreamAdminAction(member, "litestream.rebuild"), /Administrator/);
  await assert.rejects(health.litestreamAdminAction({ ...admin, apiScope: "write" }, "litestream.rebuild"), /API-Token/);
  assert.equal(existsSync(marker), false);

  let killed = 0;
  const kill = () => killed++;
  // No marker yet: nothing to restart for.
  await assert.rejects(health.litestreamAdminAction(admin, "litestream.restart", { kill }), /keine Reparatur/);

  const before = backupsInBucket().length;
  // Its own time, so the backup gets a name of its own.
  const answer = await health.litestreamAdminAction(admin, "litestream.rebuild", { now: Date.now() + 3 * 60 * MIN });
  assert.equal(answer.litestream?.marker, "remote");
  assert.match(readFileSync(marker, "utf8"), /^remote\nsource=admin\nat=\d+\n$/);
  assert.equal(backupsInBucket().length, before + 1);
  const row = await one<{ actor_id: string; detail: string }>("SELECT actor_id,detail FROM audit WHERE action='admin.litestream.rebuild'");
  assert.equal(row?.actor_id, admin.id);
  assert.match(row?.detail || "", /"backup":"flowplan-/);

  // Cancel takes the marker back (a local-only marker would stay).
  await health.litestreamAdminAction(admin, "litestream.cancel");
  assert.equal(existsSync(marker), false);
  writeFileSync(marker, "");
  await health.litestreamAdminAction(admin, "litestream.cancel");
  assert.equal(existsSync(marker), true, "a local reset marker written by hand stays");

  await health.litestreamAdminAction(admin, "litestream.rebuild");
  const restart = await health.litestreamAdminAction(admin, "litestream.restart", { kill });
  assert.equal(restart.restarting, true);
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(killed, 1, "the process ends after the answer");
  assert.ok((await auditActions()).includes("admin.litestream.restart"));
  await assert.rejects(health.litestreamAdminAction(member, "litestream.restart", { kill }), /Administrator/);
  assert.equal(killed, 1);

  // Not on a container that does not replicate.
  rmSync(replicating);
  await assert.rejects(health.litestreamAdminAction(admin, "litestream.rebuild"), /repliziert in diesem Container nicht/);
});

test("the route forwards the actions to lib, administrators in the browser only", () => {
  const route = readFileSync("app/api/admin/monitoring/handler.ts", "utf8");
  assert.match(route, /z\.object\(\{ action: z\.enum\(litestreamActions\) \}\)/);
  assert.match(route, /litestreamAdminAction\(user, body\.action\)/);
  assert.match(route, /requireOpsAdmin\(await requireUser\(\)\)/);
});

test("an administrator cancels the automatic repair: not written again for this incident", sqlite, async () => {
  const admin = await account("ls-cancel-admin", true);
  replicatingFor(60 * MIN);
  const now = Date.now();
  await health.checkLitestreamReplica(now, listing(2 * 60 * MIN, 3, now));
  assert.equal(health.resetMarker(), "remote");
  await health.litestreamAdminAction(admin, "litestream.cancel");
  assert.equal(existsSync(marker), false);
  const later = await health.checkLitestreamReplica(now + 15 * MIN, listing(2 * 60 * MIN, 3, now + 15 * MIN));
  assert.ok(later.state === "stuck" && later.incident.repair === "cancelled");
  assert.equal(existsSync(marker), false);
});

/* ---------- Litestream's memory (issue #335) ---------- */

const MiB = 1024 * 1024;
const memoryBasis = () => ({ threshold: 512 * MiB, basis: "host" as const, total: 2048 * MiB });
// One sample a minute of Litestream (PID 1, the exec path) at these MiB,
// from `start`.
async function sampleMinutes(mib: number[], start: number, pid = 1) {
  let last: Awaited<ReturnType<typeof health.checkLitestreamMemory>> | undefined;
  for (const [i, m] of mib.entries()) {
    const proc = fakeProc({ [pid]: { comm: "litestream", cmdline: ["litestream", "replicate"], rssKb: m * 1024 }, 40: { comm: "node" } });
    last = await health.checkLitestreamMemory(start + i * MIN, proc, memoryBasis);
  }
  return last!;
}
const climb = (n: number, from = 600, step = 30) => Array.from({ length: n }, (_, i) => from + i * step);

test("memory climbing past the threshold: stuck early – backup, marker 'remote', warning, one log entry; a new Litestream ends it", sqlite, async () => {
  health.resetLitestreamMemory();
  const start = Date.now() + 20 * 60 * MIN;
  writeFileSync(replicating, `since=${Math.floor((start - 60 * MIN) / 1000)}\nhost=${hostname()}\npid=1\n`);
  const before = backupsInBucket().length;
  // Nine samples: above the threshold, but not yet "climbing".
  const early = await sampleMinutes(climb(9), start);
  assert.equal(early.state, "high");
  assert.equal(existsSync(marker), false);
  assert.equal((await systemOverview()).litestream?.memory?.verdict, "high", "the hint in Überwachung");
  // The tenth: a steady climb over nine minutes.
  const result = await sampleMinutes([600 + 9 * 30], start + 9 * MIN);
  assert.ok(result.state === "climbing" && result.opened);
  assert.equal(result.incident?.cause, "memory");
  assert.equal(result.incident?.files, null);
  assert.equal(readFileSync(marker, "utf8").split("\n")[0], "remote");
  assert.equal(backupsInBucket().length, before + 1);
  assert.deepEqual(await auditActions(), ["litestream.replica.reset_scheduled", "litestream.replica.stuck"]);
  assert.ok((await activeAlerts()).some((a) => a.event === "litestream_stuck" && /Litestream \d+ MB/.test(a.detail)));
  const status = (await systemOverview()).litestream;
  assert.equal(status?.incident?.cause, "memory");
  assert.equal(status?.incident?.repair, "scheduled");
  assert.equal(status?.memory?.verdict, "climbing");
  // Still climbing: the same incident, no second backup or log entry.
  const again = await sampleMinutes([900], start + 10 * MIN);
  assert.ok(again.state === "climbing" && !again.opened);
  assert.equal(backupsInBucket().length, before + 1);
  // The bucket check finds no old L0 files (yet): memory keeps it open.
  await health.checkLitestreamReplica(start + 11 * MIN, listing(2 * MIN, 4, start + 11 * MIN));
  assert.equal((await systemOverview()).litestream?.incident?.cause, "memory");
  // After the repair: a new Litestream (another PID) with little memory.
  const fresh = await sampleMinutes([60], start + 12 * MIN, 77);
  assert.equal(fresh.state, "normal");
  assert.equal(fresh.state === "normal" && fresh.incident, null);
  assert.equal((await systemOverview()).litestream?.incident, null);
  assert.ok((await auditActions()).includes("litestream.replica.healthy"));
});

test("memory: high but flat or a saw tooth is only the hint; right after the start a climb waits", sqlite, async () => {
  health.resetLitestreamMemory();
  const start = Date.now() + 30 * 60 * MIN;
  writeFileSync(replicating, `since=${Math.floor((start - 60 * MIN) / 1000)}\nhost=${hostname()}\n`);
  assert.equal((await sampleMinutes(Array(12).fill(900), start)).state, "high");
  assert.equal((await sampleMinutes([600, 650, 700, 750, 800, 620, 700, 780, 850, 900], start + 12 * MIN)).state, "high");
  assert.equal(existsSync(marker), false);
  assert.equal((await systemOverview()).litestream?.incident, null);
  // Litestream started five minutes before the samples: not yet.
  health.resetLitestreamMemory();
  writeFileSync(replicating, `since=${Math.floor((start + 40 * MIN) / 1000)}\nhost=${hostname()}\n`);
  assert.equal((await sampleMinutes(climb(10), start + 45 * MIN)).state, "high");
  assert.equal(existsSync(marker), false);
  // No Litestream in /proc, or not replicating here.
  assert.deepEqual(await health.checkLitestreamMemory(start + 60 * MIN, fakeProc({ 3: { comm: "node" } }), memoryBasis), { state: "not_found" });
  rmSync(replicating);
  assert.deepEqual(await health.checkLitestreamMemory(start + 61 * MIN, fakeProc({ 1: { comm: "litestream", rssKb: 9e6 } }), memoryBasis), { state: "inactive" });
  assert.deepEqual(await auditActions(), []);
});

test("memory with FLOWPLAN_LITESTREAM_AUTOHEAL=off: warning and log entry, no marker", sqlite, async () => {
  health.resetLitestreamMemory();
  process.env.FLOWPLAN_LITESTREAM_AUTOHEAL = "off";
  const start = Date.now() + 40 * 60 * MIN;
  writeFileSync(replicating, `since=${Math.floor((start - 60 * MIN) / 1000)}\nhost=${hostname()}\n`);
  const result = await sampleMinutes(climb(10), start, 31);
  assert.ok(result.state === "climbing" && result.incident?.repair === "off");
  assert.equal(existsSync(marker), false);
  assert.deepEqual(await auditActions(), ["litestream.replica.stuck"]);
});

test("an incident found in the bucket stays open when memory is normal; the bucket check adds L0 to a memory incident", sqlite, async () => {
  health.resetLitestreamMemory();
  const start = Date.now() + 50 * 60 * MIN;
  writeFileSync(replicating, `since=${Math.floor((start - 60 * MIN) / 1000)}\nhost=${hostname()}\n`);
  await health.checkLitestreamReplica(start, listing(2 * 60 * MIN, 50, start));
  assert.equal((await sampleMinutes([80], start + MIN)).state, "normal");
  const status = (await systemOverview()).litestream;
  assert.equal(status?.incident?.cause, "l0");
  assert.equal(status?.incident?.files, 50);
  // Memory climbs as well: the same incident, now with memory.
  const both = await sampleMinutes(climb(10), start + 2 * MIN);
  assert.ok(both.state === "climbing" && !both.opened && both.incident?.memory);
  assert.equal(both.incident?.files, 50);
  // Memory normal again, L0 still old: open.
  await sampleMinutes([80], start + 13 * MIN, 2);
  assert.equal((await systemOverview()).litestream?.incident?.files, 50);
  assert.equal((await systemOverview()).litestream?.incident?.memory, null);
});
