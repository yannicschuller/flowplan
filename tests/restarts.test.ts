// Unexpected-restart detection (lib/restarts/): the redaction of saved log
// lines, the rotating log file and the capture of this process's output,
// the container's memory from cgroup v1/v2 files, the classification of the
// previous run (clean, crash, likely OOM, killed without trace, first
// start), taking over another container's run on a shared data folder, the
// history in restart_events (30 days), the admin-only view and one alert
// per incident.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-restarts-"));
delete process.env.FLOWPLAN_LOG_FILE;
delete process.env.FLOWPLAN_INSTANCE_ID;
const data = process.env.FLOWPLAN_DATA_DIR;
const logs = join(data, "logs");
const { run, id, one, all } = await import("../lib/db");
const { logSecrets, redactLogLine, maskAddresses } = await import("../lib/restarts/redact");
const logFile = await import("../lib/restarts/log-file");
const tracker = await import("../lib/restarts/tracker");
const history = await import("../lib/restarts/history");
const { activeAlerts, checkHealthAlerts, sweepOpsEvents } = await import("../lib/admin-ops");
after(() => rmSync(data, { recursive: true, force: true }));

const MIN = 60_000,
  HOUR = 60 * MIN,
  DAY = 24 * HOUR;
const GB = 1024 ** 3;

async function account(name: string, isAdmin: boolean): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin, disabled: 0, created_at: "" };
}
const beat = (over: Partial<import("../lib/restarts/tracker").Heartbeat> = {}): import("../lib/restarts/tracker").Heartbeat => ({
  v: 1,
  key: "host-a",
  run: "abc123",
  instance: "host-a-1f2e3d",
  host: "host-a",
  pid: 4242,
  version: "0.9.9",
  startedAt: Date.now() - 2 * HOUR,
  at: Date.now() - 20_000,
  uptimeS: 7200,
  rss: 300 * 1024 ** 2,
  heapUsed: 150 * 1024 ** 2,
  heapTotal: 200 * 1024 ** 2,
  heapLimit: 2 * GB,
  external: 10 * 1024 ** 2,
  memLimit: GB,
  memCurrent: 600 * 1024 ** 2,
  memWorkingSet: 400 * 1024 ** 2,
  oomKills: 0,
  ...over,
});

beforeEach(async () => {
  await run("DELETE FROM restart_events");
  await run("DELETE FROM ops_alerts");
  await run("DELETE FROM audit WHERE action LIKE 'instance.restart%'");
  rmSync(logs, { recursive: true, force: true });
  mkdirSync(logs, { recursive: true });
});

/* ---------- Redaction ---------- */

test("redaction: secret env values, URL credentials, bearer tokens, key=value secrets, e-mail and IP addresses", () => {
  const secrets = logSecrets({
    S3_SECRET_ACCESS_KEY: "s3-secret-0123456789",
    S3_ACCESS_KEY_ID: "AKIAEXAMPLE42",
    FLOWPLAN_ENCRYPTION_KEY_FILE: "/run/secrets/flowplan-key",
    SMTP_PASSWORD: "mail-pass-xyz",
    OIDC_CLIENT_SECRET: "on",
    APP_URL: "https://flowplan.example.org",
  });
  assert.deepEqual(secrets.sort(), ["AKIAEXAMPLE42", "mail-pass-xyz", "s3-secret-0123456789"], "only secret names, no paths, no short switches");
  const line = redactLogLine(
    "upload to s3 with s3-secret-0123456789/AKIAEXAMPLE42 via postgres://flow:pa55@db.internal:5432/x; Authorization: Bearer abcdefghijklmnop; password=hunter22 for anna@example.org from 192.168.1.20 and [2001:db8::1]:443",
    secrets,
  );
  for (const leaked of ["s3-secret-0123456789", "AKIAEXAMPLE42", "pa55", "abcdefghijklmnop", "hunter22", "anna@example.org", "192.168.1.20", "2001:db8::1"]) assert.ok(!line.includes(leaked), `${leaked} in ${line}`);
  assert.match(line, /postgres:\/\/\[redacted\]@db\.internal:5432/);
  assert.match(line, /\[e-mail\] from \[ip\] and \[\[ip\]\]:443/);
});

test("address masking keeps times, versions with letters and C++-like names", () => {
  assert.equal(maskAddresses("at 14:05:09.123 v26.1.0 Foo::bar"), "at 14:05:09.123 v26.1.0 Foo::bar");
  assert.equal(maskAddresses("::1 fe80::1%eth0 ::ffff:10.1.2.3 2001:0db8:85a3:0000:0000:8a2e:0370:7334"), "[ip] [ip]%eth0 [ip] [ip]");
  assert.equal(maskAddresses("from 10.0.0.5:5432."), "from [ip]:5432.");
});

/* ---------- Log file ---------- */

test("the log rotates to .1 at its line limit and its size limit: at most two files", () => {
  const path = join(logs, "test.log");
  const log = new logFile.RotatingLog(path, { lines: 10, bytes: 1000 });
  for (let i = 0; i < 25; i++) log.append([`2026-11-18T10:00:${String(i).padStart(2, "0")}.000Z r1 out line ${i}`]);
  const current = readFileSync(path, "utf8").trim().split("\n");
  const previous = readFileSync(`${path}.1`, "utf8").trim().split("\n");
  assert.equal(previous.length, 10);
  assert.equal(current.length, 5);
  assert.match(previous[0], /line 10$/);
  assert.match(current.at(-1)!, /line 24$/);
  // By bytes: a few long lines.
  const sized = new logFile.RotatingLog(join(logs, "sized.log"), { lines: 1000, bytes: 1000 });
  for (let i = 0; i < 5; i++) sized.append([`2026-11-18T10:00:00.000Z r1 out ${"x".repeat(400)}`]);
  assert.ok(readFileSync(join(logs, "sized.log"), "utf8").length <= 1000);
  assert.ok(existsSync(join(logs, "sized.log.1")));
  // A fresh writer continues the existing file's count.
  const again = new logFile.RotatingLog(path, { lines: 10, bytes: 1000 });
  for (let i = 25; i < 31; i++) again.append([`2026-11-18T10:01:00.000Z r1 out line ${i}`]);
  assert.match(readFileSync(`${path}.1`, "utf8").trim().split("\n").at(-1)!, /line 29$/);
  assert.deepEqual(readFileSync(path, "utf8").trim().split("\n").length, 1);
  // Read back oldest first, across both files.
  const read = logFile.readLog(path);
  assert.match(read[0].text, /line 20$/);
  assert.match(read.at(-1)!.text, /line 30$/);
});

test("the capture copies this process's stdout and stderr redacted, keeps the original writes, splits partial lines", () => {
  process.env.FLOWPLAN_CAPTURE_TEST_TOKEN = "capture-secret-abc";
  const c = logFile.installLogCapture();
  delete process.env.FLOWPLAN_CAPTURE_TEST_TOKEN;
  assert.ok(c.log, "installed");
  process.stdout.write("restart-test part one ");
  process.stdout.write("and two\n");
  process.stderr.write("\x1b[31mrestart-test error\x1b[0m capture-secret-abc from 10.9.8.7\n");
  const lines = logFile.readLog(logFile.appLogPath()).filter((l) => l.text.includes("restart-test"));
  assert.deepEqual(
    lines.map((l) => [l.run, l.stream, l.text]),
    [
      [logFile.runId(), "out", "restart-test part one and two"],
      [logFile.runId(), "err", "restart-test error [redacted] from [ip]"],
    ],
  );
  assert.ok(Number.isFinite(lines[0].at));
});

/* ---------- Container memory ---------- */

const files = (map: Record<string, string>) => (path: string) => (path in map ? map[path].trim() : null);
test("container memory from cgroup v2, v1 and none", () => {
  const v2 = tracker.containerMemory(
    files({
      "/sys/fs/cgroup/memory.max": "1073741824\n",
      "/sys/fs/cgroup/memory.current": "900000000\n",
      "/sys/fs/cgroup/memory.stat": "anon 600000000\nfile 300000000\ninactive_file 200000000\nactive_file 100000000\n",
      "/sys/fs/cgroup/memory.events": "low 0\nhigh 0\nmax 12\noom 2\noom_kill 1\noom_group_kill 0\n",
    }),
  );
  assert.deepEqual(v2, { limit: 1073741824, current: 900000000, workingSet: 700000000, oomKills: 1 });
  assert.deepEqual(tracker.containerMemory(files({ "/sys/fs/cgroup/memory.max": "max", "/sys/fs/cgroup/memory.current": "5000" })), { limit: null, current: 5000, workingSet: 5000, oomKills: null });
  const v1 = tracker.containerMemory(
    files({
      "/sys/fs/cgroup/memory/memory.limit_in_bytes": "536870912",
      "/sys/fs/cgroup/memory/memory.usage_in_bytes": "500000000",
      "/sys/fs/cgroup/memory/memory.stat": "cache 100\nrss 400\ntotal_inactive_file 100000000\n",
      "/sys/fs/cgroup/memory/memory.oom_control": "oom_kill_disable 0\nunder_oom 0\noom_kill 3\n",
    }),
  );
  assert.deepEqual(v1, { limit: 536870912, current: 500000000, workingSet: 400000000, oomKills: 3 });
  // v1 without a limit: a huge number.
  assert.equal(tracker.containerMemory(files({ "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712" })).limit, null);
  assert.deepEqual(tracker.containerMemory(files({})), { limit: null, current: null, workingSet: null, oomKills: null });
});

/* ---------- Classification ---------- */

test("classifying the previous run: first start, clean, crash, likely OOM, killed without trace", () => {
  assert.equal(tracker.classifyRun(null), null, "first start: nothing");
  const h = beat();
  const clean = tracker.classifyRun({ heartbeat: h, exit: { kind: "clean", at: h.at + 5000, run: h.run, signal: "SIGTERM", code: 143, finished: true }, oomKillsNow: 0 });
  assert.equal(clean?.reason, "clean");
  assert.equal(clean?.signal, "SIGTERM");
  assert.equal(clean?.uptimeMs, h.at + 5000 - h.startedAt);
  const crash = tracker.classifyRun({ heartbeat: h, exit: { kind: "crash", at: h.at + 1000, run: h.run, code: 1, origin: "uncaughtException", error: "TypeError: x is undefined", stack: "TypeError: x is undefined\n    at boom (lib/x.ts:1:1)" }, oomKillsNow: 0 });
  assert.equal(crash?.reason, "crash");
  assert.match(crash?.error || "", /^TypeError: x is undefined\n.*at boom/s);
  assert.equal(tracker.classifyRun({ heartbeat: h, exit: { kind: "crash", at: h.at, run: h.run, code: 3, origin: null, error: null, stack: null }, oomKillsNow: null })?.error, "exit code 3");
  // Memory at ≥ 90 % of the container's limit at the last heartbeat.
  assert.equal(tracker.classifyRun({ heartbeat: beat({ memWorkingSet: 0.95 * GB }), exit: null, oomKillsNow: 0 })?.reason, "oom");
  assert.equal(tracker.classifyRun({ heartbeat: beat({ rss: 0.92 * GB, memWorkingSet: null, memCurrent: null }), exit: null, oomKillsNow: null })?.reason, "oom");
  // … or V8's heap close to its own limit (no container limit).
  assert.equal(tracker.classifyRun({ heartbeat: beat({ memLimit: null, heapUsed: 1.9 * GB }), exit: null, oomKillsNow: null })?.reason, "oom");
  // … or the whole host nearly out of memory (the global OOM killer, which
  // ended Litestream on a container without a limit of its own).
  assert.equal(tracker.classifyRun({ heartbeat: beat({ memLimit: null, hostTotal: 4 * GB, hostAvailable: 0.1 * GB }), exit: null, oomKillsNow: null })?.reason, "oom");
  assert.equal(tracker.classifyRun({ heartbeat: beat({ memLimit: null, hostTotal: 4 * GB, hostAvailable: 1.5 * GB }), exit: null, oomKillsNow: null })?.reason, "killed");
  assert.deepEqual(tracker.hostMemory((path) => (path === "/proc/meminfo" ? "MemTotal:        3888000 kB\nMemFree:          100000 kB\nMemAvailable:     150000 kB\n" : null)), { total: 3888000 * 1024, available: 150000 * 1024 });
  // … or the cgroup's oom_kill counter went up.
  assert.equal(tracker.classifyRun({ heartbeat: beat({ oomKills: 1 }), exit: null, oomKillsNow: 2 })?.reason, "oom");
  // Nothing: SIGKILL, the host, a failed healthcheck.
  const killed = tracker.classifyRun({ heartbeat: h, exit: null, oomKillsNow: 0 });
  assert.equal(killed?.reason, "killed");
  assert.equal(killed?.endedAt, h.at);
  // An exit marker of another run does not count.
  assert.equal(tracker.classifyRun({ heartbeat: h, exit: { kind: "clean", at: h.at, run: "other", signal: "SIGTERM", code: 0, finished: true }, oomKillsNow: 0 })?.reason, "killed");
});

test("taking over runs: this key's at once, another container's only once it ended or went stale; each once", () => {
  const own = logFile.fileKey();
  const now = Date.now();
  const write = (key: string, h: object, exit?: object) => {
    writeFileSync(join(logs, `run-${key}.json`), JSON.stringify(h));
    if (exit) writeFileSync(join(logs, `exit-${key}.json`), JSON.stringify(exit));
  };
  // The previous process of this container (same key), killed: its own lines only.
  const mine = beat({ key: own, host: hostname(), run: "prev01", pid: 999_999, at: now - 10_000, startedAt: now - HOUR });
  write(own, mine);
  writeFileSync(
    join(logs, `app-${own}.log`),
    [
      `${new Date(now - 50 * MIN).toISOString()} prev01 out Flowplan 0.9.9 started`,
      `${new Date(now - 20_000).toISOString()} prev01 err something failed`,
      `${new Date(now - 1000).toISOString()} new999 out this run's line`,
    ].join("\n") + "\n",
  );
  writeFileSync(
    join(logs, "litestream.log"),
    [
      `${new Date(now - 2 * HOUR).toISOString()} - litestream older run's line`,
      `${new Date(now - 30 * MIN).toISOString()} - litestream compaction failed`,
      `${new Date(now - 5000).toISOString()} - start Flowplan container start`,
      `${new Date(now - 4000).toISOString()} - litestream restoring (the new start)`,
    ].join("\n") + "\n",
  );
  // Another container that still beats, one that went stale, one that stopped cleanly.
  write("other-live", beat({ key: "other-live", host: "other", run: "live01", at: now - 10_000 }));
  write("other-stale", beat({ key: "other-stale", host: "other2", run: "stale1", at: now - 10 * MIN }));
  utimesSync(join(logs, "run-other-stale.json"), new Date(now - 10 * MIN), new Date(now - 10 * MIN));
  write("other-clean", beat({ key: "other-clean", host: "other3", run: "clean1", at: now - 20_000 }), { kind: "clean", at: now - 15_000, run: "clean1", signal: "SIGTERM", code: 143, finished: true });

  const runs = tracker.claimPreviousRuns(now, { ownRun: "new999", read: files({}) });
  assert.deepEqual(runs.map((r) => r.key).sort(), ["other-clean", "other-stale", own].sort());
  const prev = runs.find((r) => r.key === own)!;
  assert.deepEqual(
    prev.lines.map((l) => l.replace(/^\S+ /, "")),
    ["[out] Flowplan 0.9.9 started", "[litestream] compaction failed", "[err] something failed"],
    "its own lines and Litestream's while it ran – not the new start's",
  );
  assert.equal(existsSync(join(logs, `run-${own}.json`)), false);
  assert.equal(existsSync(join(logs, "exit-other-clean.json")), false);
  assert.ok(existsSync(join(logs, "run-other-live.json")), "a running container's file stays");
  assert.deepEqual(tracker.claimPreviousRuns(now, { ownRun: "new999", read: files({}) }), [], "taken once");
});

/* ---------- History, pruning, alert ---------- */

const previous = (over: Partial<import("../lib/restarts/tracker").Heartbeat> = {}, exit: import("../lib/restarts/tracker").ExitMarker | null = null, lines = ["2026-11-18T10:00:00.000Z [err] boom"]) => ({
  key: "host-a",
  heartbeat: beat(over),
  exit,
  oomKillsNow: 0,
  lines,
});

test("the history: a clean restart is a light row, an unexpected one keeps error, memory and log lines; 30 days", async () => {
  const now = Date.now();
  const h = beat();
  await history.recordPreviousRuns([previous({}, { kind: "clean", at: h.at, run: h.run, signal: "SIGTERM", code: 143, finished: true })], now - 2 * HOUR);
  await history.recordPreviousRuns([previous({ memWorkingSet: 0.97 * GB })], now);
  const list = await history.restartHistory(now);
  assert.deepEqual(
    list.restarts.map((r) => [r.reason, r.lines]),
    [
      ["oom", 1],
      ["clean", 0],
    ],
  );
  assert.equal(list.restarts[0].memory?.share, 0.97);
  assert.equal(list.restarts[0].memory?.limit, GB);
  assert.equal(list.restarts[1].signal, "SIGTERM");
  assert.equal(list.keepDays, 30);
  assert.equal(list.unexpected24h, 1);
  // The list has no lines; the detail does.
  assert.equal("logLines" in list.restarts[0], false);
  const detail = await history.restartDetail(list.restarts[0].id);
  assert.deepEqual(detail.logLines, ["2026-11-18T10:00:00.000Z [err] boom"]);
  assert.equal(detail.heartbeat?.instance, "host-a-1f2e3d");
  const clean = await one<{ log_lines: string | null }>("SELECT log_lines FROM restart_events WHERE reason='clean'");
  assert.equal(clean?.log_lines, null);
  // Pruned after 30 days by the daily operations sweep.
  await run("UPDATE restart_events SET at=? WHERE reason='clean'", now - 31 * DAY);
  await sweepOpsEvents(now);
  assert.deepEqual((await all<{ reason: string }>("SELECT reason FROM restart_events")).map((r) => r.reason), ["oom"]);
  await assert.rejects(history.restartDetail("missing"), /nicht \(mehr\) gespeichert/);
});

test("administrators only, never with an API token", async () => {
  const admin = await account("restart-admin", true);
  const member = await account("restart-member", false);
  await history.recordPreviousRuns([previous()]);
  const rowId = (await history.restartHistory()).restarts[0].id;
  await assert.rejects(history.restartsForAdmin(member), /Administrator/);
  await assert.rejects(history.restartsForAdmin(member, rowId), /Administrator/);
  await assert.rejects(history.restartsForAdmin({ ...admin, apiScope: "read" }), /API-Token/);
  assert.equal(((await history.restartsForAdmin(admin)) as Awaited<ReturnType<typeof history.restartHistory>>).restarts.length, 1);
  assert.equal(((await history.restartsForAdmin(admin, rowId)) as Awaited<ReturnType<typeof history.restartDetail>>).logLines.length, 1);
  await assert.rejects(history.restartsForAdmin(admin, ""), /Ungültige Eingabe/);
  const route = readFileSync(join(import.meta.dirname, "../app/api/admin/monitoring/route.ts"), "utf8");
  const get = route.slice(route.indexOf("export const GET"), route.indexOf("const postSchema"));
  assert.ok(get.indexOf("await admin()") >= 0 && get.indexOf("await admin()") < get.indexOf("restartsForAdmin("), "the route checks the person first");
});

test("the alert: one per incident – a crash at once, two unexpected restarts within an hour; webhook, landing tile, activity log", async () => {
  const { createServer } = await import("node:http");
  const received: { event: string; detail: string }[] = [];
  const hook = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push(JSON.parse(body));
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((done) => hook.listen(0, "127.0.0.1", done));
  process.env.FLOWPLAN_WEBHOOK_ALLOW_PRIVATE = "true";
  const { saveAlertSettings, alertSettingsForAdmin } = await import("../lib/admin-ops");
  const admin = await account("alert-admin-restarts", true);
  const incidents = async () => (await all<{ action: string }>("SELECT action FROM audit WHERE action='instance.restart.incident'")).length;
  try {
    await saveAlertSettings(admin.id, { url: `http://127.0.0.1:${(hook.address() as { port: number }).port}/hook`, events: ["unexpected_restart"] });
    const t0 = Date.now() - 3 * HOUR;
    // One restart without trace: no incident yet.
    await history.recordPreviousRuns([previous()], t0);
    assert.equal(received.length, 0);
    assert.equal((await activeAlerts(t0)).some((a) => a.event === "unexpected_restart"), false);
    // A second within the hour: the incident, once.
    await history.recordPreviousRuns([previous()], t0 + 20 * MIN);
    assert.equal(received.length, 1);
    assert.equal(received[0].event, "ops.unexpected_restart");
    assert.match(received[0].detail, /2 unerwartete Neustarts|2 unexpected restarts/);
    assert.equal(await incidents(), 1);
    // A third in the same chain: no new alert.
    await history.recordPreviousRuns([previous()], t0 + 50 * MIN);
    assert.equal(received.length, 1);
    assert.equal(await incidents(), 1);
    // The landing page's tile shows it; the daily alerts leave it to this one.
    assert.ok((await activeAlerts(t0 + 51 * MIN)).some((a) => a.event === "unexpected_restart"));
    await checkHealthAlerts(t0 + 52 * MIN);
    assert.equal(received.length, 1);
    // A clean restart is no incident.
    const h = beat();
    await history.recordPreviousRuns([previous({}, { kind: "clean", at: h.at, run: h.run, signal: "SIGTERM", code: 143, finished: true })], t0 + 2 * HOUR + 30 * MIN);
    assert.equal(received.length, 1);
    // Later, a single crash: a new incident at once, with its error.
    await history.recordPreviousRuns([previous({}, { kind: "crash", at: h.at, run: h.run, code: 1, origin: "uncaughtException", error: "Error: database is locked", stack: null })], t0 + 3 * HOUR);
    assert.equal(received.length, 2);
    assert.match(received[1].detail, /database is locked/);
    assert.equal(await incidents(), 2);
    assert.equal((await alertSettingsForAdmin()).sent.filter((s) => s.event === "unexpected_restart").length, 2);
    // Shown for a day.
    assert.equal((await activeAlerts(t0 + 3 * HOUR + 25 * HOUR)).some((a) => a.event === "unexpected_restart"), false);
  } finally {
    await saveAlertSettings(admin.id, { url: "", events: [] });
    await new Promise<void>((done) => hook.close(() => done()));
  }
});

test("the exit markers: SIGTERM writes 'clean', an exit with another code 'crash' with the last uncaught error", async () => {
  tracker.resetTrackerForTests();
  const s = tracker.startRestartTracker({ instance: "test-instance", version: "0.9.9" });
  const key = logFile.fileKey();
  const h = JSON.parse(readFileSync(join(logs, `run-${key}.json`), "utf8"));
  assert.equal(h.run, logFile.runId());
  assert.equal(h.instance, "test-instance");
  assert.ok(h.rss > 0 && h.heapLimit > 0);
  assert.ok(s.started);
  tracker.noteStopSignal("SIGTERM");
  assert.deepEqual(
    (({ kind, signal, finished }) => ({ kind, signal, finished }))(JSON.parse(readFileSync(join(logs, `exit-${key}.json`), "utf8"))),
    { kind: "clean", signal: "SIGTERM", finished: false },
  );
  // The monitor only watches (Node.js's handling stays as it is).
  tracker.resetTrackerForTests();
  rmSync(join(logs, `exit-${key}.json`), { force: true });
  tracker.startRestartTracker({ instance: "test-instance" });
  const keep = () => {};
  process.on("uncaughtException", keep);
  try {
    tracker.recordUncaught(new Error("token=abc123secret boom"), "uncaughtException");
    assert.equal(existsSync(join(logs, `exit-${key}.json`)), false, "handled by a listener: not the end yet");
    tracker.recordExit(1);
    const crash = JSON.parse(readFileSync(join(logs, `exit-${key}.json`), "utf8"));
    assert.equal(crash.kind, "crash");
    assert.equal(crash.code, 1);
    assert.match(crash.error, /^Error: token=\[redacted\] boom$/);
  } finally {
    process.off("uncaughtException", keep);
    tracker.resetTrackerForTests();
  }
});
