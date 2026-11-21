// One container per SQLite data folder (docker/entrypoint.sh): the
// entrypoint holds an exclusive flock on $DATA/.flowplan.lock. With the lock
// free it runs as before (restore, then `litestream replicate -exec`); with
// the lock held by another container the app starts anyway, Litestream and
// the restore wait for the lock, and $DATA/.flowplan-waiting tells
// Administration → Überwachung. Docker is not available in the tests: the
// entrypoint runs in a scratch folder with stubs for id, node and
// litestream, the other container is a shell holding the lock with flock.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const hasFlock = spawnSync("sh", ["-c", "command -v flock"]).status === 0;
const skip = !hasFlock && "flock (util-linux) is not installed";

const stubs: Record<string, string> = {
  id: `case "$1" in -u) echo 1000 ;; -g) echo 1000 ;; *) exit 1 ;; esac`,
  // The app: runs until SIGTERM/SIGINT (exit FAKE_NODE_TERM_CODE) or, with
  // FAKE_NODE_EXIT, exits with that code after a moment.
  // The replica delete (scripts/litestream-replica-reset.mjs) logs and
  // exits with FAKE_DELETE_CODE (default 0).
  node: `echo "node $* pid=$$" >> "$LOG"
case "$1" in */litestream-replica-reset.mjs) exit "\${FAKE_DELETE_CODE:-0}" ;; esac
if [ -n "\${FAKE_NODE_SAY:-}" ]; then echo "$FAKE_NODE_SAY"; echo "$FAKE_NODE_SAY (stderr)" >&2; fi
trap 'echo "node got TERM" >> "$LOG"; exit "\${FAKE_NODE_TERM_CODE:-0}"' TERM
if [ -n "\${FAKE_NODE_EXIT:-}" ]; then sleep 1; echo "node exits $FAKE_NODE_EXIT" >> "$LOG"; exit "$FAKE_NODE_EXIT"; fi
while :; do sleep 0.1; done`,
  // Litestream: restore and reset log and return; replicate -exec runs the
  // app as its child; replicate alone runs until SIGTERM. FAKE_LS_DIE=n:
  // the first n replicate runs without -exec die at once.
  // FAKE_LS_SAY: a line on stdout and one on stderr (restore and replicate).
  litestream: `cmd="$1"; shift
echo "litestream $cmd $*" >> "$LOG"
[ -n "\${LOG_LEVEL:-}" ] && echo "litestream LOG_LEVEL=$LOG_LEVEL" >> "$LOG"
if [ -n "\${FAKE_LS_SAY:-}" ]; then echo "$cmd: $FAKE_LS_SAY"; echo "$cmd: stderr $FAKE_LS_SAY" >&2; fi
case "$cmd" in
  replicate)
    exe=""
    while [ "$#" -gt 0 ]; do [ "$1" = -exec ] && exe="$2"; shift; done
    if [ -n "$exe" ]; then exec sh -c "exec $exe"; fi
    n=$(cat "$LOG.ls-runs" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$LOG.ls-runs"
    if [ "$n" -le "\${FAKE_LS_DIE:-0}" ]; then echo "litestream dies" >> "$LOG"; exit 3; fi
    trap 'echo "litestream got TERM" >> "$LOG"; exit 0' TERM
    while :; do sleep 0.1; done ;;
esac`,
};

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

type Box = { dir: string; data: string; log: string; env: Record<string, string>; script: string };
function box(env: Record<string, string> = {}): Box {
  const dir = mkdtempSync(join(tmpdir(), "flowplan-data-lock-"));
  dirs.push(dir);
  const bin = join(dir, "bin");
  const data = join(dir, "data");
  mkdirSync(bin);
  mkdirSync(data);
  for (const [name, body] of Object.entries(stubs)) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const script = join(dir, "entrypoint.sh");
  copyFileSync("docker/entrypoint.sh", script);
  chmodSync(script, 0o755);
  const log = join(dir, "log");
  writeFileSync(log, "");
  return {
    dir,
    data,
    log,
    script,
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: dir,
      LOG: log,
      FLOWPLAN_DATA_DIR: data,
      FLOWPLAN_LITESTREAM_RESTART_SECONDS: "1",
      ...env,
    },
  };
}
const withS3 = { S3_BUCKET: "bucket", S3_ACCESS_KEY_ID: "x", S3_SECRET_ACCESS_KEY: "y" };
// With Litestream's output saved (ls_log_open), the app runs through the
// entrypoint again to get the container's own stdout back.
const replicateExec = (b: Box) => `litestream replicate -config /etc/litestream.yml -exec sh ${b.script} --exec-app`;

const lines = (b: Box) => readFileSync(b.log, "utf8").split("\n").filter(Boolean);
const has = (b: Box, re: RegExp) => lines(b).some((l) => re.test(l));
async function until(what: string, ok: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

type Run = { child: ChildProcess; exit: Promise<number | null>; output: () => string };
function start(b: Box, shell = "sh", cwd?: string): Run {
  const child = spawn(shell, [b.script], { env: b.env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"], cwd });
  let out = "";
  child.stdout!.on("data", (d) => (out += d));
  child.stderr!.on("data", (d) => (out += d));
  const exited = new Promise<number | null>((r) => child.on("exit", (code, signal) => r(code ?? (signal ? -1 : null))));
  // Never hang the run: a container that does not stop is a failure.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const exit = Promise.race([
    exited,
    new Promise<number | null>((_, reject) => {
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`the entrypoint did not exit:\n${out}\n${existsSync(b.log) ? readFileSync(b.log, "utf8") : ""}`));
      }, 10000);
      timer.unref();
    }),
  ]).finally(() => clearTimeout(timer));
  return { child, exit, output: () => out };
}

// The other container: holds the lock until release().
async function holdLock(b: Box) {
  const holder = spawn("sh", ["-c", `exec 9>>"$0"; flock 9; echo locked; read x`, join(b.data, ".flowplan.lock")], { stdio: ["pipe", "pipe", "inherit"] });
  await new Promise<void>((resolve) => holder.stdout!.once("data", () => resolve()));
  const gone = new Promise((r) => holder.on("exit", r));
  return {
    release: async () => {
      holder.stdin!.end();
      await gone;
    },
  };
}

test("lock free with Litestream: restore under the lock, then exec replicate -exec (the app as its child)", { skip }, async () => {
  const b = box(withS3);
  const run = start(b);
  await until("node", () => has(b, /^node server\.js/));
  assert.deepEqual(lines(b).slice(0, 3).map((l) => l.replace(/ pid=\d+$/, "")), [
    `litestream restore -config /etc/litestream.yml -if-db-not-exists -if-replica-exists ${join(b.data, "flowplan.sqlite")}`,
    replicateExec(b),
    "node server.js",
  ]);
  // exec: the entrypoint's PID became Litestream, then the app.
  const pid = Number(/pid=(\d+)/.exec(lines(b)[2])![1]);
  assert.equal(pid, run.child.pid);
  // The lock is held while it runs.
  assert.equal(spawnSync("flock", ["-n", join(b.data, ".flowplan.lock"), "true"]).status, 1);
  assert.equal(existsSync(join(b.data, ".flowplan-waiting")), false);
  run.child.kill("SIGTERM");
  assert.equal(await run.exit, 0);
  assert.equal(spawnSync("flock", ["-n", join(b.data, ".flowplan.lock"), "true"]).status, 0, "the lock goes back with the container");
});

// FLOWPLAN_PROCESSES > 1 (#383): processes.mjs next to server.js instead of
// server.js, on every path; unset or 1 keeps server.js.
for (const [processes, main] of [["3", "processes.mjs"], ["auto", "processes.mjs"], ["1", "server.js"]] as const)
  for (const litestream of [false, true])
    test(`FLOWPLAN_PROCESSES=${processes}${litestream ? " with Litestream" : ""}: node ${main}`, { skip }, async () => {
      const b = box({ ...(litestream ? withS3 : {}), FLOWPLAN_PROCESSES: processes });
      writeFileSync(join(b.dir, "processes.mjs"), "");
      const run = start(b, "sh", b.dir);
      await until("node", () => has(b, /^node /));
      assert.ok(lines(b).some((l) => l.startsWith(`node ${main}`)), lines(b).join("\n"));
      if (litestream) assert.ok(has(b, /^litestream replicate .*-exec/), lines(b).join("\n"));
      run.child.kill("SIGTERM");
      assert.equal(await run.exit, 0);
    });

test("lock free without Litestream: the lock is taken, node runs as before", { skip }, async () => {
  const b = box();
  const run = start(b);
  await until("node", () => has(b, /^node server\.js/));
  assert.equal(Number(/pid=(\d+)/.exec(lines(b)[0])![1]), run.child.pid);
  assert.equal(spawnSync("flock", ["-n", join(b.data, ".flowplan.lock"), "true"]).status, 1);
  run.child.kill("SIGTERM");
  assert.equal(await run.exit, 0);
  assert.equal(run.output(), "");
});

for (const shell of ["sh", "bash"]) {
  test(`lock held (${shell}): the app starts, no restore and no Litestream; after the release Litestream starts, the marker comes and goes`, { skip }, async () => {
    const b = box(withS3);
    writeFileSync(join(b.data, "flowplan.sqlite"), "");
    const other = await holdLock(b);
    const run = start(b, shell);
    await until("node", () => has(b, /^node server\.js/));
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(has(b, /^litestream/), false, "neither restore nor replicate without the lock");
    const marker = readFileSync(join(b.data, ".flowplan-waiting"), "utf8");
    assert.match(marker, /^since=\d+\nhost=.+\nlitestream=1\n$/);
    assert.match(run.output(), /ANOTHER CONTAINER IS USING THE DATA FOLDER/);
    assert.match(run.output(), /coolify-and-proxy#roll-out-sqlite-without-overlap/);
    // The entrypoint stays the supervisor (the app is not its PID).
    assert.notEqual(Number(/pid=(\d+)/.exec(lines(b)[0])![1]), run.child.pid);

    await other.release();
    await until("litestream replicate", () => has(b, /^litestream replicate/));
    assert.deepEqual(lines(b).filter((l) => l.startsWith("litestream")), ["litestream replicate -config /etc/litestream.yml"]);
    await until("marker removed", () => !existsSync(join(b.data, ".flowplan-waiting")));
    assert.equal(spawnSync("flock", ["-n", join(b.data, ".flowplan.lock"), "true"]).status, 1, "now this container holds the lock");

    // SIGTERM goes to the app, then to Litestream; the app's exit code is the container's.
    run.child.kill("SIGTERM");
    assert.equal(await run.exit, 0);
    const log = lines(b);
    assert.ok(log.includes("node got TERM"), log.join("\n"));
    assert.ok(log.includes("litestream got TERM"), log.join("\n"));
    assert.ok(log.indexOf("node got TERM") < log.indexOf("litestream got TERM"));
  });
}

test("lock held: SIGTERM while still waiting reaches the app, its exit code is the container's, the marker goes", { skip }, async () => {
  const b = box({ ...withS3, FAKE_NODE_TERM_CODE: "7" });
  writeFileSync(join(b.data, "flowplan.sqlite"), "");
  const other = await holdLock(b);
  try {
    const run = start(b);
    await until("node", () => has(b, /^node server\.js/));
    await until("marker", () => existsSync(join(b.data, ".flowplan-waiting")));
    run.child.kill("SIGTERM");
    assert.equal(await run.exit, 7);
    assert.ok(has(b, /^node got TERM$/));
    assert.equal(has(b, /^litestream/), false);
    assert.equal(existsSync(join(b.data, ".flowplan-waiting")), false);
  } finally {
    await other.release();
  }
});

test("lock held: the app exits by itself – Litestream stops, the app's exit code is propagated", { skip }, async () => {
  const b = box({ ...withS3, FAKE_NODE_EXIT: "5" });
  writeFileSync(join(b.data, "flowplan.sqlite"), "");
  const other = await holdLock(b);
  const run = start(b);
  await until("node", () => has(b, /^node server\.js/));
  await other.release();
  assert.equal(await run.exit, 5);
  const log = lines(b);
  // Litestream may or may not have started in that second; if it did, it was stopped.
  if (log.some((l) => l.startsWith("litestream replicate"))) assert.ok(log.includes("litestream got TERM"), log.join("\n"));
});

test("lock held, then free: a Litestream that dies is restarted with backoff while the app keeps running", { skip }, async () => {
  const b = box({ ...withS3, FAKE_LS_DIE: "2" });
  writeFileSync(join(b.data, "flowplan.sqlite"), "");
  const other = await holdLock(b);
  const run = start(b);
  await until("node", () => has(b, /^node server\.js/));
  await other.release();
  await until("third replicate", () => lines(b).filter((l) => l.startsWith("litestream replicate")).length >= 3, 15000);
  assert.equal(lines(b).filter((l) => l === "litestream dies").length, 2);
  assert.match(run.output(), /Litestream stopped \(exit code 3\); the app keeps running, Litestream restarts in 1s/);
  assert.match(run.output(), /restarts in 2s/, "backoff doubles");
  assert.equal(has(b, /^node exits|^node got/), false, "the app kept running");
  // SIGINT reaches the app as SIGTERM (a background job starts with SIGINT ignored).
  run.child.kill("SIGINT");
  assert.equal(await run.exit, 0);
  assert.ok(has(b, /^node got TERM$/));
  assert.ok(has(b, /^litestream got TERM$/));
});

test("lock held and no database yet (the other container may be restoring): nothing starts until the lock is free, then the normal path", { skip }, async () => {
  const b = box(withS3);
  const other = await holdLock(b);
  const run = start(b);
  await until("marker", () => existsSync(join(b.data, ".flowplan-waiting")));
  await new Promise((r) => setTimeout(r, 1500));
  assert.deepEqual(lines(b), [], "no restore, no app while another container holds the lock");
  assert.match(run.output(), /waits for .*\.flowplan\.lock before it starts/);
  await other.release();
  await until("node", () => has(b, /^node server\.js/));
  assert.match(lines(b)[0], /^litestream restore /, "the restore runs only once this container holds the lock");
  assert.equal(existsSync(join(b.data, ".flowplan-waiting")), false);
  run.child.kill("SIGTERM");
  assert.equal(await run.exit, 0);
});

test("lock held and an instance restore pending: the swap waits for the lock (the other container's live database stays)", { skip }, async () => {
  const b = box();
  writeFileSync(join(b.data, "flowplan.sqlite"), "live");
  mkdirSync(join(b.data, "restore-pending"));
  writeFileSync(join(b.data, "restore-pending", "flowplan.sqlite"), "restored");
  writeFileSync(join(b.data, "restore-pending", "READY"), "");
  const other = await holdLock(b);
  const run = start(b);
  await until("marker", () => existsSync(join(b.data, ".flowplan-waiting")));
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(readFileSync(join(b.data, "flowplan.sqlite"), "utf8"), "live");
  assert.deepEqual(lines(b), []);
  await other.release();
  await until("node", () => has(b, /^node server\.js/));
  assert.equal(readFileSync(join(b.data, "flowplan.sqlite"), "utf8"), "restored");
  run.child.kill("SIGTERM");
  assert.equal(await run.exit, 0);
});

test("lock held without Litestream: the app starts at once with the warning, the marker goes once the lock is free", { skip }, async () => {
  const b = box();
  const other = await holdLock(b);
  const run = start(b);
  await until("node", () => has(b, /^node server\.js/));
  assert.match(readFileSync(join(b.data, ".flowplan-waiting"), "utf8"), /litestream=0/);
  assert.match(run.output(), /This container serves anyway/);
  await other.release();
  await until("marker removed", () => !existsSync(join(b.data, ".flowplan-waiting")));
  assert.equal(has(b, /^litestream/), false);
  run.child.kill("SIGTERM");
  assert.equal(await run.exit, 0);
});

test("litestream-reset in the data folder: `litestream reset` runs under the lock, after the restore and before replicate", { skip }, async () => {
  const b = box(withS3);
  writeFileSync(join(b.data, "flowplan.sqlite"), "");
  writeFileSync(join(b.data, "litestream-reset"), "");
  const run = start(b);
  await until("node", () => has(b, /^node server\.js/));
  assert.deepEqual(lines(b).slice(0, 3), [
    `litestream restore -config /etc/litestream.yml -if-db-not-exists -if-replica-exists ${join(b.data, "flowplan.sqlite")}`,
    `litestream reset -config /etc/litestream.yml ${join(b.data, "flowplan.sqlite")}`,
    replicateExec(b),
  ]);
  assert.equal(existsSync(join(b.data, "litestream-reset")), false, "one reset only");
  run.child.kill("SIGTERM");
  await run.exit;
});

// The rebuild of a stuck replica (lib/litestream-health.ts writes the
// marker with "remote"): the bucket's db/ goes first, then the local state,
// then replication starts – all under the lock.
const RESET_SCRIPT = "node /app/scripts/litestream-replica-reset.mjs";
const withoutPid = (b: Box) => lines(b).map((l) => l.replace(/ pid=\d+$/, ""));
test("marker 'remote': the delete script, then the local reset, then replicate; the marker goes", { skip }, async () => {
  const b = box(withS3);
  writeFileSync(join(b.data, "flowplan.sqlite"), "db");
  writeFileSync(join(b.data, "litestream-reset"), "remote\nsource=auto\nat=1763470000\n");
  const run = start(b);
  await until("node server.js", () => has(b, /^node server\.js/));
  assert.deepEqual(withoutPid(b).slice(0, 4), [
    `litestream restore -config /etc/litestream.yml -if-db-not-exists -if-replica-exists ${join(b.data, "flowplan.sqlite")}`,
    RESET_SCRIPT,
    `litestream reset -config /etc/litestream.yml ${join(b.data, "flowplan.sqlite")}`,
    replicateExec(b),
  ]);
  assert.equal(existsSync(join(b.data, "litestream-reset")), false, "removed after both steps");
  assert.match(run.output(), /deleting the replica in the bucket \(flowplan\/db\/\)/);
  // Litestream replicates here from now on: the app's check may run. On
  // the exec path Litestream keeps the entrypoint's PID: the app reads its
  // memory there (lib/litestream-memory.ts).
  assert.match(readFileSync(join(b.data, ".flowplan-replicating"), "utf8"), new RegExp(`^since=\\d+\nhost=.+\npid=${run.child.pid}\n$`));
  assert.ok(has(b, new RegExp(`^node server\\.js pid=${run.child.pid}$`)), "the app runs under that PID after the exec chain");
  assert.equal(readFileSync(join(b.data, "flowplan.sqlite"), "utf8"), "db", "the database is never touched");
  run.child.kill("SIGTERM");
  await run.exit;
});

test("marker 'remote' and the delete fails: no reset, the marker stays, the app still starts with Litestream", { skip }, async () => {
  const b = box({ ...withS3, FAKE_DELETE_CODE: "1" });
  writeFileSync(join(b.data, "flowplan.sqlite"), "db");
  writeFileSync(join(b.data, "litestream-reset"), "remote\n");
  const run = start(b);
  await until("node server.js", () => has(b, /^node server\.js/));
  const log = withoutPid(b);
  assert.ok(log.includes(RESET_SCRIPT));
  assert.equal(log.some((l) => l.startsWith("litestream reset")), false);
  assert.ok(log.includes(replicateExec(b)));
  assert.equal(readFileSync(join(b.data, "litestream-reset"), "utf8"), "remote\n", "kept for the next start");
  assert.match(run.output(), /DELETING THE REPLICA IN THE BUCKET FAILED/);
  run.child.kill("SIGTERM");
  assert.equal(await run.exit, 0);
});

test("an empty marker stays local-only: no delete script", { skip }, async () => {
  const b = box(withS3);
  writeFileSync(join(b.data, "flowplan.sqlite"), "db");
  writeFileSync(join(b.data, "litestream-reset"), "");
  const run = start(b);
  await until("node server.js", () => has(b, /^node server\.js/));
  assert.equal(has(b, /litestream-replica-reset/), false);
  assert.ok(has(b, /^litestream reset /));
  assert.equal(existsSync(join(b.data, "litestream-reset")), false);
  run.child.kill("SIGTERM");
  await run.exit;
});

test("marker 'remote' without a local database: the replica is its only copy and stays", { skip }, async () => {
  const b = box(withS3);
  writeFileSync(join(b.data, "litestream-reset"), "remote\n");
  const run = start(b);
  await until("node server.js", () => has(b, /^node server\.js/));
  assert.equal(has(b, /litestream-replica-reset/), false);
  assert.equal(has(b, /^litestream reset /), false);
  assert.ok(existsSync(join(b.data, "litestream-reset")));
  assert.match(run.output(), /there is no local database; the replica in the bucket is kept/);
  run.child.kill("SIGTERM");
  await run.exit;
});

test("lock held, then free: marker 'remote' is applied before Litestream starts in the waiting container", { skip }, async () => {
  const b = box(withS3);
  writeFileSync(join(b.data, "flowplan.sqlite"), "db");
  writeFileSync(join(b.data, "litestream-reset"), "remote\n");
  writeFileSync(join(b.data, ".flowplan-replicating"), "since=1\nhost=the-old-container\n");
  const other = await holdLock(b);
  const run = start(b);
  await until("node server.js", () => has(b, /^node server\.js/));
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(has(b, /litestream-replica-reset|^litestream/), false, "nothing without the lock");
  assert.match(readFileSync(join(b.data, ".flowplan-replicating"), "utf8"), /host=the-old-container/, "the other container's file stays until this one replicates");
  await other.release();
  await until("litestream replicate", () => has(b, /^litestream replicate/));
  assert.deepEqual(withoutPid(b).filter((l) => l !== "node server.js").slice(0, 3), [
    RESET_SCRIPT,
    `litestream reset -config /etc/litestream.yml ${join(b.data, "flowplan.sqlite")}`,
    "litestream replicate -config /etc/litestream.yml",
  ]);
  assert.doesNotMatch(readFileSync(join(b.data, ".flowplan-replicating"), "utf8"), /the-old-container/);
  run.child.kill("SIGTERM");
  assert.equal(await run.exit, 0);
});

// Litestream's PID among the entrypoint's children (the stub is a shell
// script: "/bin/sh …/bin/litestream replicate …").
function litestreamChild(parent: number): number | null {
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      const cmdline = readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0");
      if (ppid === parent && cmdline.some((a) => a.endsWith("/bin/litestream")) && cmdline.includes("replicate")) return Number(name);
    } catch {}
  }
  return null;
}

test("supervised path: a Litestream that dies (an OOM kill) after the app scheduled the repair – reset first, then only Litestream restarts", { skip }, async () => {
  const b = box(withS3);
  writeFileSync(join(b.data, "flowplan.sqlite"), "db");
  const other = await holdLock(b);
  const run = start(b);
  await until("node server.js", () => has(b, /^node server\.js/));
  await other.release();
  await until("litestream replicate", () => has(b, /^litestream replicate/));
  assert.doesNotMatch(readFileSync(join(b.data, ".flowplan-replicating"), "utf8"), /pid=/, "the PID is not known beforehand here: the app looks in /proc");
  let pid: number | null = null;
  await until("Litestream's PID", () => (pid = litestreamChild(run.child.pid!)) !== null);
  // The app's memory check wrote the marker; the kernel then ends Litestream.
  writeFileSync(join(b.data, "litestream-reset"), "remote\nsource=auto\nat=1763470000\n");
  process.kill(pid!, "SIGKILL");
  await until("second replicate", () => lines(b).filter((l) => l.startsWith("litestream replicate")).length >= 2);
  const after = withoutPid(b).slice(withoutPid(b).indexOf("litestream replicate -config /etc/litestream.yml") + 1);
  assert.deepEqual(after.filter((l) => l !== "node server.js"), [
    RESET_SCRIPT,
    `litestream reset -config /etc/litestream.yml ${join(b.data, "flowplan.sqlite")}`,
    "litestream replicate -config /etc/litestream.yml",
  ]);
  assert.equal(existsSync(join(b.data, "litestream-reset")), false);
  assert.match(run.output(), /Litestream stopped \(exit code 137\); the app keeps running/);
  assert.equal(lines(b).filter((l) => /^node server\.js/.test(l)).length, 1, "the app was not restarted");
  assert.equal(has(b, /^node got TERM$/), false);
  run.child.kill("SIGTERM");
  assert.equal(await run.exit, 0);
});

test("the image ships the delete script with its S3 library", () => {
  const dockerfile = readFileSync("Dockerfile", "utf8");
  assert.match(dockerfile, /COPY --chmod=644 scripts\/litestream-replica-reset\.mjs \/app\/scripts\//);
  assert.match(dockerfile, /COPY --from=build --chown=node:node \/app\/node_modules\/aws4fetch \/app\/node_modules\/aws4fetch/);
  assert.ok(readFileSync("docker/entrypoint.sh", "utf8").includes(RESET_SCRIPT));
});

test("PostgreSQL: no data folder lock", { skip }, async () => {
  const b = box({ DATABASE_URL: "postgres://localhost/flowplan" });
  const other = await holdLock(b);
  try {
    const run = start(b);
    await until("node", () => has(b, /^node server\.js/));
    assert.equal(existsSync(join(b.data, ".flowplan-waiting")), false);
    assert.equal(run.output(), "");
    run.child.kill("SIGTERM");
    await run.exit;
  } finally {
    await other.release();
  }
});

test("the image has flock (util-linux) and the lock comes before the instance restore swap and Litestream", () => {
  const dockerfile = readFileSync("Dockerfile", "utf8");
  const entrypoint = readFileSync("docker/entrypoint.sh", "utf8");
  assert.match(dockerfile, /install -y --no-install-recommends ca-certificates util-linux/);
  assert.match(dockerfile, /flock --version/);
  const at = (needle: string) => entrypoint.indexOf(needle);
  assert.ok(at("flock -n -E 75 9") > 0);
  assert.ok(at("flock -n -E 75 9") < at('[ -f "$DATA/restore-pending/READY" ] && [ ! -f'));
  assert.ok(at("flock -n -E 75 9") < at("litestream restore"));
});

// Litestream's own output, also in $DATA/logs/litestream.log (redacted) for
// the restart history: through a FIFO and `tee -p` to the container's
// stdout and to awk. PID 1, signals and exit codes stay as they were; the
// app's own lines never go into that file (it saves them itself).
const SECRET = "ls-secret-value-123";
const logFile = (b: Box) => join(b.data, "logs", "litestream.log");
const fileText = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");
const say = `sync key=${SECRET} to http://user:pw@10.1.2.3:9000 from [2001:db8::7]`;

test("Litestream's lines reach the container log unchanged and logs/litestream.log redacted; the app keeps its own stdout; exec path, PID and exit code as before", { skip }, async () => {
  const b = box({ ...withS3, S3_SECRET_ACCESS_KEY: SECRET, FAKE_LS_SAY: say, FAKE_NODE_SAY: "app line", FAKE_NODE_TERM_CODE: "7" });
  const run = start(b);
  await until("node", () => has(b, /^node server\.js/));
  await until("litestream.log", () => /replicate: stderr/.test(fileText(logFile(b))));
  await until("app line", () => run.output().includes("app line (stderr)"));
  const file = fileText(logFile(b));
  assert.match(file, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z - start /m, "a start mark per container");
  assert.match(file, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z - litestream restore: sync key=\[redacted\] to http:\/\/\[redacted\]@\[ip\]:9000 from \[\[ip\]\]$/m);
  assert.match(file, / - litestream replicate: stderr sync key=\[redacted\]/);
  assert.doesNotMatch(file, new RegExp(`${SECRET}|10\\.1\\.2\\.3|2001:db8|app line`));
  // The container's log has every line as before, the app's too.
  assert.ok(run.output().includes(`restore: ${say}`), run.output());
  assert.ok(run.output().includes(`replicate: stderr ${say}`));
  assert.ok(run.output().includes("app line\n"));
  // exec: the entrypoint's PID became Litestream, then the app.
  assert.equal(Number(/pid=(\d+)/.exec(lines(b).find((l) => l.startsWith("node server.js"))!)![1]), run.child.pid);
  assert.ok(lines(b).includes(replicateExec(b)));
  run.child.kill("SIGTERM");
  assert.equal(await run.exit, 7, "the app's exit code is the container's");
  assert.ok(has(b, /^node got TERM$/));
});

test("exec path with the log copy: an app that exits by itself ends the container with its exit code", { skip }, async () => {
  const b = box({ ...withS3, FAKE_LS_SAY: "hello", FAKE_NODE_EXIT: "5" });
  const run = start(b);
  assert.equal(await run.exit, 5);
  assert.match(fileText(logFile(b)), / - litestream replicate: hello$/m);
});

test("supervised path: Litestream's lines reach the container log and the file; SIGTERM order and exit code unchanged", { skip }, async () => {
  const b = box({ ...withS3, S3_SECRET_ACCESS_KEY: SECRET, FAKE_LS_SAY: say, FAKE_NODE_TERM_CODE: "3" });
  writeFileSync(join(b.data, "flowplan.sqlite"), "");
  const other = await holdLock(b);
  const run = start(b);
  await until("node", () => has(b, /^node server\.js/));
  assert.equal(existsSync(logFile(b)), false, "nothing before the lock is free");
  await other.release();
  await until("litestream.log", () => /replicate: stderr/.test(fileText(logFile(b))));
  assert.ok(run.output().includes(`replicate: ${say}`));
  assert.doesNotMatch(fileText(logFile(b)), new RegExp(SECRET));
  assert.deepEqual(lines(b).filter((l) => l.startsWith("litestream")), ["litestream replicate -config /etc/litestream.yml"], "the plain command line, no wrapper");
  run.child.kill("SIGTERM");
  assert.equal(await run.exit, 3);
  const log = lines(b);
  assert.ok(log.indexOf("node got TERM") >= 0 && log.indexOf("node got TERM") < log.indexOf("litestream got TERM"), log.join("\n"));
});

test("logs folder not writable, or FLOWPLAN_LOG_FILE=off: everything as before, Litestream's output only in the container log", { skip }, async () => {
  for (const variant of ["file", "off"] as const) {
    const b = box({ ...withS3, FAKE_LS_SAY: "hello", ...(variant === "off" ? { FLOWPLAN_LOG_FILE: "off" } : {}) });
    // A file where the folder would be: mkdir fails (root ignores modes).
    if (variant === "file") writeFileSync(join(b.data, "logs"), "");
    const run = start(b);
    await until("node", () => has(b, /^node server\.js/));
    assert.ok(lines(b).includes("litestream replicate -config /etc/litestream.yml -exec node server.js"), lines(b).join("\n"));
    assert.ok(run.output().includes("replicate: hello"));
    if (variant === "file") assert.match(run.output(), /logs is not writable; Litestream's output is not saved there/);
    else assert.equal(existsSync(join(b.data, "logs")), false);
    run.child.kill("SIGTERM");
    assert.equal(await run.exit, 0);
  }
});

test("the copy rotates at 1,000 lines into litestream.log.1", { skip }, () => {
  const awk = /^ls_awk='\n([\s\S]*?)'$/m.exec(readFileSync("docker/entrypoint.sh", "utf8"))![1];
  const dir = mkdtempSync(join(tmpdir(), "flowplan-ls-awk-"));
  dirs.push(dir);
  const file = join(dir, "litestream.log");
  const input = Array.from({ length: 2500 }, (_, i) => `line ${i}`).join("\n") + "\n";
  const result = spawnSync("awk", ["-v", `file=${file}`, awk], { input, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const current = readFileSync(file, "utf8").trim().split("\n");
  const previous = readFileSync(`${file}.1`, "utf8").trim().split("\n");
  assert.equal(previous.length, 1000);
  assert.equal(current.length, 500);
  assert.match(current.at(-1)!, / - litestream line 2499$/);
  assert.match(previous[0], / - litestream line 1000$/);
  // Seconds since the epoch as an ISO time (no date command per line).
  const at = Date.parse(current[0].split(" ")[0]);
  assert.ok(Math.abs(at - Date.now()) < 10_000, current[0]);
});

test("FLOWPLAN_LITESTREAM_LOG_LEVEL becomes Litestream's LOG_LEVEL; an unknown value is ignored with a note", { skip }, async () => {
  const quiet = box({ ...withS3, FLOWPLAN_LITESTREAM_LOG_LEVEL: "WARN" });
  const a = start(quiet);
  await until("node", () => has(quiet, /^node server\.js/));
  assert.ok(has(quiet, /^litestream LOG_LEVEL=warn$/), lines(quiet).join("\n"));
  a.child.kill("SIGTERM");
  await a.exit;
  const odd = box({ ...withS3, FLOWPLAN_LITESTREAM_LOG_LEVEL: "loud" });
  const b = start(odd);
  await until("node", () => has(odd, /^node server\.js/));
  assert.equal(has(odd, /LOG_LEVEL=/), false);
  b.child.kill("SIGTERM");
  await b.exit;
  assert.match(b.output(), /FLOWPLAN_LITESTREAM_LOG_LEVEL=loud is ignored/);
});
