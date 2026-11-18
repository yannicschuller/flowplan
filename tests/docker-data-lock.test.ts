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
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
trap 'echo "node got TERM" >> "$LOG"; exit "\${FAKE_NODE_TERM_CODE:-0}"' TERM
if [ -n "\${FAKE_NODE_EXIT:-}" ]; then sleep 1; echo "node exits $FAKE_NODE_EXIT" >> "$LOG"; exit "$FAKE_NODE_EXIT"; fi
while :; do sleep 0.1; done`,
  // Litestream: restore and reset log and return; replicate -exec runs the
  // app as its child; replicate alone runs until SIGTERM. FAKE_LS_DIE=n:
  // the first n replicate runs without -exec die at once.
  litestream: `cmd="$1"; shift
echo "litestream $cmd $*" >> "$LOG"
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
function start(b: Box, shell = "sh"): Run {
  const child = spawn(shell, [b.script], { env: b.env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout!.on("data", (d) => (out += d));
  child.stderr!.on("data", (d) => (out += d));
  const exited = new Promise<number | null>((r) => child.on("exit", (code, signal) => r(code ?? (signal ? -1 : null))));
  // Never hang the run: a container that does not stop is a failure.
  const exit = Promise.race([
    exited,
    new Promise<number | null>((_, reject) =>
      setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`the entrypoint did not exit:\n${out}\n${readFileSync(b.log, "utf8")}`));
      }, 10000).unref(),
    ),
  ]);
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
    "litestream replicate -config /etc/litestream.yml -exec node server.js",
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
    "litestream replicate -config /etc/litestream.yml -exec node server.js",
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
    "litestream replicate -config /etc/litestream.yml -exec node server.js",
  ]);
  assert.equal(existsSync(join(b.data, "litestream-reset")), false, "removed after both steps");
  assert.match(run.output(), /deleting the replica in the bucket \(flowplan\/db\/\)/);
  // Litestream replicates here from now on: the app's check may run.
  assert.match(readFileSync(join(b.data, ".flowplan-replicating"), "utf8"), /^since=\d+\nhost=.+\n$/);
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
  assert.ok(log.includes("litestream replicate -config /etc/litestream.yml -exec node server.js"));
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
