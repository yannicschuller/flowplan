// Several Flowplan processes behind one port (#383 wave 5,
// scripts/processes.mjs, lib/cluster/processes.ts,
// docs/architecture/multi-process.md): the settings, the shared windows and
// slots the supervisor keeps, and a real supervisor with three processes –
// process 1 first and alone, the bus between them (with the sender's
// origin), the leader duties only in process 1, rate limits not multiplied
// by the processes, the AI slots, questions to the others, the process
// table, a crashed process started again, and the shutdown in order
// (2 and 3 first, then 1, then the supervisor with 143), who has a page
// open known to every process.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const supervisor = await import("../scripts/processes.mjs");
const { processIndex, processTotal, multiProcess, primaryProcess, respawnedProcess, restoreAtThisStart } = await import("../lib/cluster/processes");

test("FLOWPLAN_PROCESSES: unset or 1 is one process, a number is capped, auto follows the usable cores", () => {
  assert.equal(supervisor.processCount({}, 4), 1);
  assert.equal(supervisor.processCount({ FLOWPLAN_PROCESSES: "1" }, 4), 1);
  assert.equal(supervisor.processCount({ FLOWPLAN_PROCESSES: "3" }, 4), 3);
  assert.equal(supervisor.processCount({ FLOWPLAN_PROCESSES: "99" }, 4), supervisor.MAX_PROCESSES);
  assert.equal(supervisor.processCount({ FLOWPLAN_PROCESSES: "auto" }, 4), 4);
  assert.equal(supervisor.processCount({ FLOWPLAN_PROCESSES: "AUTO" }, 64), supervisor.AUTO_MAX);
  assert.equal(supervisor.processCount({ FLOWPLAN_PROCESSES: "many" }, 4), 1);
  // The cgroup's CPU quota, not the host's cores.
  const quota = (text: string | null) => (path: string) => (path.endsWith("cpu.max") ? text : null);
  assert.equal(supervisor.usableCores(quota("200000 100000"), 16), 2);
  assert.equal(supervisor.usableCores(quota("150000 100000"), 16), 2);
  assert.equal(supervisor.usableCores(quota("max 100000"), 16), 16);
  assert.equal(supervisor.usableCores(quota("800000 100000"), 4), 4);
  assert.equal(supervisor.usableCores(() => null, 6), 6);
});

test("FLOWPLAN_WORKERS counts for the host: divided between the processes, 0 stays 0", () => {
  assert.equal(supervisor.workersPerProcess({}, 4, 4), 1);
  assert.equal(supervisor.workersPerProcess({}, 8, 2), 3);
  assert.equal(supervisor.workersPerProcess({ FLOWPLAN_WORKERS: "6" }, 8, 3), 2);
  assert.equal(supervisor.workersPerProcess({ FLOWPLAN_WORKERS: "2" }, 8, 4), 1);
  assert.equal(supervisor.workersPerProcess({ FLOWPLAN_WORKERS: "0" }, 8, 4), 0);
});

test("the shared window answers like the Redis script: 0 while there is room, else the time it is full until", () => {
  const limits = supervisor.createLimits();
  const at = 1_000_000;
  for (let i = 0; i < 4; i++) assert.equal(limits.hit({ key: "k", now: at + i, windowMs: 1000, max: 5 }), 0);
  // The fifth fills it: full until the oldest of the last five leaves.
  assert.equal(limits.hit({ key: "k", now: at + 10, windowMs: 1000, max: 5 }), at + 1000);
  assert.equal(limits.hit({ key: "k", now: at + 20, windowMs: 1000, max: 5 }), at + 1 + 1000);
  // Once the window moved on there is room again.
  assert.equal(limits.hit({ key: "k", now: at + 5000, windowMs: 1000, max: 5 }), 0);
  assert.equal(limits.hit({ key: "other", now: at, windowMs: 1000, max: 1 }), at + 1000);
  // Bounded: the oldest keys go first.
  const small = supervisor.createLimits(3);
  for (let i = 0; i < 10; i++) small.hit({ key: `k${i}`, now: at, windowMs: 1000, max: 5 });
  assert.equal(small.size(), 3);
});

test("AI slots: at most max at once, they lapse, and a process that ends gives its slots back", () => {
  const slots = supervisor.createSlots();
  const now = 5_000;
  assert.equal(slots.take({ key: "u", max: 2, ttl: 1000, slot: "a", now }, 1), 1);
  assert.equal(slots.take({ key: "u", max: 2, ttl: 1000, slot: "b", now }, 2), 1);
  assert.equal(slots.take({ key: "u", max: 2, ttl: 1000, slot: "c", now }, 3), 0);
  slots.release({ key: "u", slot: "a" });
  assert.equal(slots.take({ key: "u", max: 2, ttl: 1000, slot: "c", now }, 3), 1);
  slots.dropOwner(2);
  assert.equal(slots.take({ key: "u", max: 2, ttl: 1000, slot: "d", now }, 1), 1);
  assert.equal(slots.take({ key: "u", max: 2, ttl: 1000, slot: "e", now }, 1), 0);
  // Not renewed: gone after their time.
  assert.equal(slots.renew({ key: "u", slot: "c", ttl: 1000, now: now + 500 }), 1);
  assert.equal(slots.take({ key: "u", max: 2, ttl: 1000, slot: "f", now: now + 1200 }, 1), 1);
});

test("the app side: who a process is, from the supervisor's environment", () => {
  const env = { FLOWPLAN_PROCESS_INDEX: "2", FLOWPLAN_PROCESSES_TOTAL: "3", FLOWPLAN_PROCESS_ROLE: "worker" };
  assert.equal(processIndex(env), 2);
  assert.equal(processTotal(env), 3);
  // Without the IPC channel (this test process) it is not one of several.
  assert.equal(multiProcess(env), false);
  assert.equal(primaryProcess(env), true);
  assert.equal(respawnedProcess(env), false);
  assert.equal(restoreAtThisStart(env), true);
  assert.equal(processIndex({}), 0);
  assert.equal(processTotal({}), 1);
});

/* ---------- A supervisor with three processes ---------- */

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });

type Event = { index: number; event: string; [key: string]: unknown };
function startSupervisor(env: Record<string, string>) {
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/processes.mjs", "tests/helpers/process-worker.ts"], {
    env: { ...process.env, FLOWPLAN_DATA_DIR: mkdtempSync(join(tmpdir(), "flowplan-processes-")), FLOWPLAN_SHUTDOWN_SECONDS: "5", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const events: Event[] = [];
  const lines: string[] = [];
  let buffer = "";
  const waiters: { test: (e: Event) => boolean; resolve: (e: Event) => void }[] = [];
  child.stdout!.on("data", (chunk) => {
    buffer += String(chunk);
    for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      lines.push(line);
      if (!line.startsWith("{")) continue;
      try {
        const e = JSON.parse(line) as Event;
        events.push(e);
        for (const w of [...waiters]) if (w.test(e)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(e);
        }
      } catch {}
    }
  });
  child.stderr!.on("data", (chunk) => {
    const text = String(chunk);
    if (!/ExperimentalWarning|trace-warnings/.test(text)) lines.push(`stderr: ${text.trim()}`);
  });
  const until = (test: (e: Event) => boolean, ms = 30_000) =>
    new Promise<Event>((resolve, reject) => {
      const found = events.find(test);
      if (found) return resolve(found);
      const timer = setTimeout(() => reject(new Error(`timed out; output:\n${lines.join("\n")}`)), ms);
      waiters.push({ test, resolve: (e) => (clearTimeout(timer), resolve(e)) });
    });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  return { child: child as ChildProcess, events, lines, until, exited };
}

test("three processes: process 1 first, the bus, leader duties, shared limits and slots, questions, the table, respawn, shutdown in order", { timeout: 120_000 }, async () => {
  const port = await freePort();
  const s = startSupervisor({ FLOWPLAN_PROCESSES: "3", PORT: String(port), FLOWPLAN_WORKERS: "4" });
  try {
    // Process 1 alone until it said ready.
    const first = await s.until((e) => e.event === "up");
    assert.equal(first.index, 1);
    await s.until((e) => e.event === "up" && e.index === 2);
    await s.until((e) => e.event === "up" && e.index === 3);
    const origin = `http://127.0.0.1:${port}`;
    const get = async (path: string) => (await (await fetch(`${origin}${path}`, { headers: { connection: "close" } })).json()) as { index: number; value: any };

    // Every process answers on the one port (round robin).
    const who = await Promise.all(Array.from({ length: 9 }, () => get("/whoami")));
    assert.deepEqual([...new Set(who.map((w) => w.index))].sort(), [1, 2, 3]);
    for (const w of who) {
      assert.equal(w.value.multi, true);
      assert.equal(w.value.primary, w.index === 1);
      assert.match(w.value.instance, new RegExp(`-p${w.index}-`));
      // FLOWPLAN_WORKERS=4 for the host: 1 per process.
      assert.equal(w.value.workers, "1");
    }

    // The bus: the others get it, with the sender's instance as origin; the sender does not.
    const sent = await get("/publish?v=hello");
    const got = await Promise.all([1, 2, 3].filter((i) => i !== sent.index).map((i) => s.until((e) => e.event === "got" && e.index === i && e.payload === "hello")));
    assert.equal(got.length, 2);
    const sender = who.find((w) => w.index === sent.index)!.value.instance;
    for (const g of got) assert.equal(g.origin, sender);
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(!s.events.some((e) => e.event === "got" && e.index === sent.index), "the sender does not hear itself");

    // Leader duties run in process 1 only.
    const leaders = await Promise.all(Array.from({ length: 9 }, () => get("/leader")));
    for (const l of leaders) assert.deepEqual(l.value, { leader: l.index === 1, ran: l.index === 1 });

    // A limit of 5 per minute is 5 for the host, not 5 per process.
    let allowed = 0;
    for (let i = 0; i < 15; i++) {
      if ((await get("/limit?key=invite:someone")).value) allowed++;
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.equal(allowed, 5);

    // Two parallel AI answers per person across the processes.
    const ai = [];
    for (let i = 0; i < 4; i++) ai.push((await get("/ai")).value);
    assert.deepEqual(ai, [true, true, false, false]);

    // Who has a page open: seen by one process, known to all.
    await get("/present?user=ada");
    await get("/present?user=bob");
    await new Promise((r) => setTimeout(r, 200));
    for (const seen of await Promise.all(Array.from({ length: 6 }, () => get("/seen")))) assert.deepEqual(seen.value, ["ada", "bob"]);

    // Questions to the other processes.
    const asked = await get("/ask");
    assert.deepEqual(asked.value.map((a: { index: number }) => a.index).sort(), [1, 2, 3].filter((i) => i !== asked.index));

    // The supervisor's table.
    const table = (await get("/table")).value as { index: number; role: string; running: boolean; rss: number | null }[];
    assert.deepEqual(table.map((r) => [r.index, r.role, r.running]), [[0, "supervisor", true], [1, "primary", true], [2, "worker", true], [3, "worker", true]]);
    assert.ok(table.every((r) => r.rss === null || r.rss > 0));

    // A process that crashes is started again, marked as such.
    let crashed = await get("/crash");
    while (crashed.index === 1) crashed = await get("/crash");
    const again = await s.until((e) => e.event === "up" && e.index === crashed.index && e.respawned === true, 15_000);
    assert.equal(again.respawned, true);
    assert.ok(s.lines.some((l) => l.includes(`process ${crashed.index}`) && l.includes("starting it again")), s.lines.join("\n"));

    // SIGTERM: 2 and 3 stop first, then 1, then the supervisor (143).
    s.child.kill("SIGTERM");
    const { code } = await s.exited;
    assert.equal(code, 143);
    const exits = s.events.filter((e) => e.event === "exit").slice(-3);
    assert.equal(exits.length, 3, s.lines.join("\n"));
    assert.equal(exits[2].index, 1);
    for (const e of s.events.filter((x) => x.event === "stopping").slice(-3)) assert.ok(e);
  } finally {
    if (s.child.exitCode === null) s.child.kill("SIGKILL");
  }
});

test("process 1 failing before it is ready stops the supervisor with its code", { timeout: 60_000 }, async () => {
  const port = await freePort();
  const s = startSupervisor({ FLOWPLAN_PROCESSES: "2", PORT: String(port), FAIL_PRIMARY: "1" });
  const { code } = await s.exited;
  assert.equal(code, 3);
  assert.ok(!s.events.some((e) => e.event === "up"), "no other process started");
});
