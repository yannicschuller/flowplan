// Who runs the container (#193): the image's own user node (UID 1000), any
// UID/GID from Compose's user: "UID:GID", or root (user: "0:0") handing the
// data folder to PUID:PGID and switching to that user with setpriv – the app
// never runs as root. Docker is not available in the tests: the entrypoint
// runs in a scratch folder with stubs for id, stat, chown, setpriv and node.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dockerfile = readFileSync("Dockerfile", "utf8");
const entrypoint = readFileSync("docker/entrypoint.sh", "utf8");
const helmValues = readFileSync("deploy/helm/flowplan/values.yaml", "utf8");

const stubs: Record<string, string> = {
  id: `case "$1" in -u) echo "$FAKE_UID" ;; -g) echo "$FAKE_GID" ;; *) exit 1 ;; esac`,
  // The owner of a path: FAKE_STAGED_OWNER for a staged restore or move,
  // FAKE_OWNER for everything else.
  stat: `path=""; for a in "$@"; do path="$a"; done
case "$path" in */restore-pending | */move-incoming) echo "\${FAKE_STAGED_OWNER:-$FAKE_OWNER}" ;; *) echo "$FAKE_OWNER" ;; esac`,
  chown: `echo "chown $*" >> "$LOG"`,
  setpriv: `uid=""; gid=""; clear=no
while [ "$#" -gt 0 ]; do
  case "$1" in
    --reuid=*) uid="\${1#--reuid=}" ;;
    --regid=*) gid="\${1#--regid=}" ;;
    --clear-groups) clear=yes ;;
    --) shift; break ;;
  esac
  shift
done
echo "setpriv uid=$uid gid=$gid clear-groups=$clear home=$HOME" >> "$LOG"
FAKE_UID="$uid" FAKE_GID="$gid" exec "$@"`,
  node: `echo "node $* uid=$FAKE_UID gid=$FAKE_GID home=$HOME" >> "$LOG"`,
};

type Run = { status: number | null; log: string[]; stderr: string; stdout: string; data: string };

function run(env: Record<string, string>, prepare?: (data: string) => void): Run {
  const dir = mkdtempSync(join(tmpdir(), "flowplan-entrypoint-"));
  try {
    const bin = join(dir, "bin");
    const data = join(dir, "data");
    const home = join(dir, "home");
    mkdirSync(bin);
    mkdirSync(data);
    mkdirSync(home);
    for (const [name, body] of Object.entries(stubs)) {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    }
    const script = join(dir, "entrypoint.sh");
    copyFileSync("docker/entrypoint.sh", script);
    chmodSync(script, 0o755);
    const log = join(dir, "log");
    writeFileSync(log, "");
    prepare?.(data);
    const result = spawnSync("sh", [script], {
      encoding: "utf8",
      env: {
        NODE_ENV: "production",
        PATH: `${bin}:${process.env.PATH}`,
        HOME: home,
        LOG: log,
        FLOWPLAN_DATA_DIR: data,
        FAKE_OWNER: "1000:1000",
        ...env,
      },
    });
    const lines = readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => line.replaceAll(dir, "<dir>"));
    return { status: result.status, log: lines, stderr: result.stderr, stdout: result.stdout, data };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the image keeps USER node, has setpriv and a Next cache any UID can write", () => {
  assert.match(dockerfile, /^USER node$/m);
  assert.doesNotMatch(dockerfile, /^USER (root|0)\b/m);
  assert.match(dockerfile, /RUN setpriv --version/);
  assert.match(dockerfile, /mkdir -p \/app\/\.next\/cache && chown node:node \/app\/\.next\/cache && chmod 1777 \/app\/\.next\/cache/);
  // Only the cache: the app code is never made writable.
  assert.doesNotMatch(dockerfile, /chmod -R [0-7]*7[0-7]* \/app\b|chmod 1?777 \/app(\/data)?\s/);
  assert.match(entrypoint, /exec setpriv --reuid="\$uid" --regid="\$gid" --clear-groups -- "\$0" "\$@"/);
});

test("the Helm chart still runs as UID 1000 without root", () => {
  assert.match(helmValues, /runAsNonRoot: true\s*\n\s+runAsUser: 1000\s*\n\s+runAsGroup: 1000/);
});

test("started as node: no switch, no chown, the server runs as 1000", () => {
  const r = run({ FAKE_UID: "1000", FAKE_GID: "1000" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.log, ["node server.js uid=1000 gid=1000 home=<dir>/home"]);
  assert.equal(r.stderr, "");
});

test("started as root without PUID/PGID: data folder to 1000:1000 if needed, then node via setpriv", () => {
  const r = run({ FAKE_UID: "0", FAKE_GID: "0", FAKE_OWNER: "0:0" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.log.slice(0, 2), [
    "chown -R 1000:1000 <dir>/data",
    "setpriv uid=1000 gid=1000 clear-groups=yes home=/home/node",
  ]);
  // /home/node does not exist outside the image: HOME falls back to /tmp.
  assert.match(r.log[2], /^node server\.js uid=1000 gid=1000 home=/);
  assert.doesNotMatch(r.log.join("\n"), /uid=0 /);
});

test("started as root, data folder already belongs to the target: no chown", () => {
  const r = run({ FAKE_UID: "0", FAKE_GID: "0", FAKE_OWNER: "1000:1000" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.log, [
    "setpriv uid=1000 gid=1000 clear-groups=yes home=/home/node",
    "node server.js uid=1000 gid=1000 home=/tmp",
  ]);
});

test("started as root with PUID/PGID: chown once, then the server as PUID:PGID with HOME in /tmp", () => {
  const r = run({ FAKE_UID: "0", FAKE_GID: "0", FAKE_OWNER: "1000:1000", PUID: "1001", PGID: "1002" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.log, [
    "chown -R 1001:1002 <dir>/data",
    "setpriv uid=1001 gid=1002 clear-groups=yes home=/tmp",
    "node server.js uid=1001 gid=1002 home=/tmp",
  ]);
  const again = run({ FAKE_UID: "0", FAKE_GID: "0", FAKE_OWNER: "1001:1002", PUID: "1001", PGID: "1002" });
  assert.equal(again.log.filter((line) => line.startsWith("chown")).length, 0);
});

test("PGID defaults to PUID", () => {
  const r = run({ FAKE_UID: "0", FAKE_GID: "0", FAKE_OWNER: "1001:1001", PUID: "1001" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.log, [
    "setpriv uid=1001 gid=1001 clear-groups=yes home=/tmp",
    "node server.js uid=1001 gid=1001 home=/tmp",
  ]);
});

test("started as root: a restore staged by root is handed over although the top folder matches", () => {
  const r = run(
    { FAKE_UID: "0", FAKE_GID: "0", FAKE_OWNER: "1001:1001", FAKE_STAGED_OWNER: "0:0", PUID: "1001" },
    (data) => mkdirSync(join(data, "restore-pending")),
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.log[0], "chown -R 1001:1001 <dir>/data/restore-pending");
});

test("PUID/PGID must be numbers other than 0", () => {
  const invalid: Record<string, string>[] = [{ PUID: "0" }, { PGID: "0" }, { PUID: "abc" }, { PUID: "1001", PGID: "-5" }, { PUID: "00" }];
  for (const env of invalid) {
    for (const uid of ["0", "1000"]) {
      const r = run({ FAKE_UID: uid, FAKE_GID: uid, ...env });
      assert.equal(r.status, 1, JSON.stringify(env));
      assert.match(r.stderr, /PUID and PGID must be numeric user and group IDs other than 0/);
      assert.deepEqual(r.log, []);
    }
  }
});

test("started as another user with PUID/PGID: one hint, then the normal start", () => {
  const r = run({ FAKE_UID: "1000", FAKE_GID: "1000", PUID: "1001", PGID: "1001" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr.trim().split("\n").length, 1);
  assert.match(r.stderr, /PUID\/PGID are ignored: the container runs as UID 1000, GID 1000, not as root\. Set user: "0:0" for PUID\/PGID, or simply user: "1001:1001"\./);
  assert.deepEqual(r.log, ["node server.js uid=1000 gid=1000 home=<dir>/home"]);
  // Matching the current user: nothing to say.
  const same = run({ FAKE_UID: "1001", FAKE_GID: "1001", PUID: "1001" });
  assert.equal(same.stderr, "");
});

test("any user: without a home of its own HOME becomes /tmp", () => {
  const r = run({ FAKE_UID: "1234", FAKE_GID: "5678", HOME: "/nonexistent" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.log, ["node server.js uid=1234 gid=5678 home=/tmp"]);
});

test("a data folder the user cannot write: the message names user:, PUID/PGID, chown and named volumes", () => {
  // A file in place of the folder: unwritable also when the tests run as root.
  const r = run({ FAKE_UID: "1001", FAKE_GID: "1001", FAKE_OWNER: "1000:1000" }, (data) => {
    rmSync(data, { recursive: true });
    writeFileSync(data, "");
  });
  assert.equal(r.status, 1);
  assert.deepEqual(r.log, []);
  assert.match(r.stderr, /cannot write to its data folder .* \(running as UID 1001, GID 1001; the folder belongs to 1000:1000\)/);
  assert.match(r.stderr, /user: "1000:1000" in Compose/);
  assert.match(r.stderr, /user: "0:0" with PUID and PGID/);
  assert.match(r.stderr, /sudo chown -R 1000:1000/);
  assert.match(r.stderr, /named Docker volume/);
});

test("the write check's message is in the entrypoint", () => {
  assert.match(entrypoint, /user: \\"0:0\\" with PUID and PGID/);
  assert.match(entrypoint, /docs\.flowplan\.org\/en\/coolify-and-proxy#volume-permissions/);
});
