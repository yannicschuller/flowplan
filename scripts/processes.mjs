// Several Flowplan processes behind one port on one host (#383 wave 5,
// docs/architecture/multi-process.md). Copied next to server.js in the
// image and the archives (/app/processes.mjs); docker/entrypoint.sh starts
// it instead of server.js when FLOWPLAN_PROCESSES is set to more than 1.
//
//   FLOWPLAN_PROCESSES=4 node processes.mjs [server.js]
//
// FLOWPLAN_PROCESSES: unset or 1 – server.js runs in this very process, as
// `node server.js` would (nothing below happens); a number 2–16, or "auto"
// (the cores the container may use, at most 8) – this process becomes the
// supervisor (node:cluster's primary) and starts that many copies of
// server.js. It does not load Flowplan itself (about 45 MB):
//   - Process 1 ("primary") starts alone, opens and migrates the database
//     and says "ready" (lib/cluster/processes.ts announceReady); then the
//     others ("worker") start. Process 1 runs what must run once per host
//     (timed jobs, Litestream's checks, the restart history); all of them
//     answer requests.
//   - One port: node:cluster accepts the connections here and hands them to
//     the processes in turn (round robin; FLOWPLAN_PROCESS_BALANCE=os lets
//     the kernel pick instead).
//   - The bus between the processes: what one sends ({fp:"bus"}) goes to
//     every other one. Calls ({fp:"call"}) are answered here: the shared
//     windows of the rate limits, the AI slots, the process table, and
//     questions to the other processes ("ask").
//   - A process that ends is started again after 1 s, doubling up to 30 s
//     while it keeps ending within a minute. When process 1 ends before it
//     was ever ready (a configuration error, a failed migration), the
//     supervisor ends with its exit code.
//   - SIGTERM/SIGINT: the processes 2 … n get the signal first and drain
//     (Next.js stops accepting, finishes its requests, Flowplan its shutdown
//     tasks); then process 1; then the supervisor exits with 143/130.
//     Bounded by FLOWPLAN_SHUTDOWN_SECONDS (default 20) plus 5 s.
// FLOWPLAN_WORKERS (worker threads) is a figure for the host here: each
// process gets its share (at least 1 unless it is 0).
import cluster from "node:cluster";
import { availableParallelism } from "node:os";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MAX_PROCESSES = 16;
export const AUTO_MAX = 8;

const readText = (path) => {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
};
// The cores this container may use: the CPU quota of its cgroup (v2 or v1),
// at most the cores of the host.
export function usableCores(read = readText, cores = availableParallelism()) {
  let quota = null;
  const v2 = read("/sys/fs/cgroup/cpu.max");
  if (v2 !== null) {
    const [q, period] = v2.split(/\s+/);
    if (/^\d+$/.test(q) && Number(period) > 0) quota = Number(q) / Number(period);
  } else {
    const q = Number(read("/sys/fs/cgroup/cpu/cpu.cfs_quota_us") ?? -1),
      period = Number(read("/sys/fs/cgroup/cpu/cpu.cfs_period_us") ?? 0);
    if (q > 0 && period > 0) quota = q / period;
  }
  return Math.max(1, quota ? Math.min(cores, Math.ceil(quota - 0.05)) : cores);
}
// How many processes FLOWPLAN_PROCESSES asks for (1: no supervisor).
export function processCount(env = process.env, cores = usableCores()) {
  const raw = String(env.FLOWPLAN_PROCESSES ?? "").trim().toLowerCase();
  if (!raw) return 1;
  if (raw === "auto") return Math.max(1, Math.min(AUTO_MAX, cores));
  if (/^\d+$/.test(raw)) return Math.max(1, Math.min(MAX_PROCESSES, Number(raw)));
  console.warn(`FLOWPLAN_PROCESSES=${env.FLOWPLAN_PROCESSES} is neither a number nor "auto": one process.`);
  return 1;
}
// Worker threads per process: FLOWPLAN_WORKERS counts for the host.
export function workersPerProcess(env = process.env, cores = usableCores(), n = 1) {
  const raw = String(env.FLOWPLAN_WORKERS ?? "").trim();
  if (/^\d+$/.test(raw)) return Number(raw) === 0 ? 0 : Math.max(1, Math.floor(Number(raw) / n));
  return Math.max(1, Math.floor((cores - 1) / n));
}

/* ---------- Shared state answered here ---------- */

// Sliding windows of the rate limits (lib/action-limits.ts): the same
// answer as the Lua script in Redis – 0 while there is room, else the time
// until which the key is full.
export function createLimits(maxKeys = 50_000) {
  const windows = new Map();
  return {
    hit({ key, now, windowMs, max }) {
      if (typeof key !== "string" || !(windowMs > 0) || !(max > 0)) return 0;
      const list = (windows.get(key) || []).filter((at) => at > now - windowMs);
      list.push(now);
      windows.delete(key);
      windows.set(key, list);
      if (windows.size > maxKeys) {
        for (const [k, l] of windows) if (!l.length || l[l.length - 1] <= now - 3_600_000) windows.delete(k);
        while (windows.size > maxKeys) windows.delete(windows.keys().next().value);
      }
      if (list.length < max) return 0;
      return list[list.length - max] + windowMs;
    },
    size: () => windows.size,
  };
}
// Parallel AI answers per person (lib/ai/concurrency.ts): slots with an
// expiry, given back when the answer ends or its process does.
export function createSlots() {
  const keys = new Map();
  const live = (key, now) => {
    const slots = keys.get(key);
    if (!slots) return null;
    for (const [id, slot] of slots) if (slot.until <= now) slots.delete(id);
    if (!slots.size) keys.delete(key);
    return keys.get(key) ?? null;
  };
  return {
    take({ key, max, ttl, slot, now }, owner) {
      const slots = live(key, now) ?? new Map();
      if (slots.size >= max) return 0;
      slots.set(slot, { until: now + ttl, owner });
      keys.set(key, slots);
      return 1;
    },
    renew({ key, slot, ttl, now }) {
      const s = live(key, now)?.get(slot);
      if (s) s.until = now + ttl;
      return s ? 1 : 0;
    },
    release({ key, slot }) {
      const slots = keys.get(key);
      slots?.delete(slot);
      if (slots && !slots.size) keys.delete(key);
      return 1;
    },
    dropOwner(owner) {
      for (const [key, slots] of keys) {
        for (const [id, slot] of slots) if (slot.owner === owner) slots.delete(id);
        if (!slots.size) keys.delete(key);
      }
    },
  };
}

// CPU seconds and resident memory of a process, from /proc.
function procStat(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ");
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    return { cpuSeconds: (Number(stat[11]) + Number(stat[12])) / 100, rss: Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] || 0) * 1024 };
  } catch {
    const usage = pid === process.pid ? process.cpuUsage() : null;
    return { cpuSeconds: usage ? (usage.user + usage.system) / 1e6 : null, rss: pid === process.pid ? process.memoryUsage().rss : null };
  }
}

/* ---------- The supervisor ---------- */

export function supervise(entry, n, env = process.env) {
  const cores = usableCores();
  const threads = workersPerProcess(env, cores, n);
  const budget = (() => {
    const seconds = Number(env.FLOWPLAN_SHUTDOWN_SECONDS);
    return Math.round((Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 3600) : 20) * 1000);
  })();
  if (String(env.FLOWPLAN_PROCESS_BALANCE || "").trim().toLowerCase() === "os") cluster.schedulingPolicy = cluster.SCHED_NONE;
  else cluster.schedulingPolicy = cluster.SCHED_RR;
  cluster.setupPrimary({ exec: entry, args: process.argv.slice(3) });
  const limits = createLimits();
  const slots = createSlots();
  const asks = new Map();
  let askSequence = 0;
  let stopping = false;
  let exitCode = 0;
  // Per process number: the worker, its start, how often it was started again.
  const table = new Map();
  for (let i = 1; i <= n; i++) table.set(i, { worker: null, startedAt: null, restarts: 0, lastExit: null, backoff: 1000, ready: false, timer: null });
  let othersStarted = false;
  console.log(
    `Processes: ${n} Flowplan processes on one port (${cores} cores${threads ? `, ${threads} worker thread${threads === 1 ? "" : "s"} each` : ", no worker threads"}, ${cluster.schedulingPolicy === cluster.SCHED_NONE ? "connections picked by the kernel" : "connections round robin"}).`,
  );

  const send = (worker, message) => {
    if (!worker?.isConnected()) return;
    try {
      worker.send(message, undefined, {}, () => {});
    } catch {}
  };
  const others = (index) => [...table.entries()].filter(([i, e]) => i !== index && e.worker?.isConnected()).map(([, e]) => e.worker);
  const rows = () => {
    const out = [{ index: 0, pid: process.pid, role: "supervisor", running: true, startedAt: Date.now() - Math.round(process.uptime() * 1000), restarts: 0, lastExit: null, ...procStat(process.pid) }];
    for (const [index, e] of table) {
      const pid = e.worker?.process.pid ?? null;
      out.push({ index, pid, role: index === 1 ? "primary" : "worker", running: !!e.worker && !e.worker.isDead(), startedAt: e.startedAt, restarts: e.restarts, lastExit: e.lastExit, ...(pid ? procStat(pid) : { rss: null, cpuSeconds: null }) });
    }
    return out;
  };
  const calls = {
    limit: (a) => limits.hit({ ...a, now: Number(a?.now) || Date.now() }),
    "ai-take": (a, index) => slots.take({ ...a, now: Date.now() }, index),
    "ai-renew": (a) => slots.renew({ ...a, now: Date.now() }),
    "ai-release": (a) => slots.release(a),
    processes: () => rows(),
  };

  function onMessage(index, worker, message) {
    if (!message || typeof message !== "object" || typeof message.fp !== "string") return;
    if (message.fp === "bus") {
      for (const other of others(index)) send(other, message);
      return;
    }
    if (message.fp === "ready") {
      const e = table.get(index);
      e.ready = true;
      if (index === 1 && !othersStarted && !stopping) {
        othersStarted = true;
        for (let i = 2; i <= n; i++) start(i);
      }
      return;
    }
    if (message.fp === "answer") {
      const ask = asks.get(String(message.id));
      if (!ask) return;
      if (message.value !== null && message.value !== undefined) ask.values.push(message.value);
      if (--ask.waiting <= 0) ask.done();
      return;
    }
    if (message.fp !== "call") return;
    const reply = (value, error) => send(worker, { fp: "reply", id: message.id, value, error });
    if (message.op === "ask") {
      const targets = others(index);
      const a = message.args || {};
      if (!targets.length) return reply([]);
      const id = `${index}:${++askSequence}`;
      const ask = {
        values: [],
        waiting: targets.length,
        done: () => {
          if (!asks.has(id)) return;
          asks.delete(id);
          clearTimeout(ask.timer);
          reply(ask.values);
        },
      };
      ask.timer = setTimeout(() => ask.done(), Math.min(10_000, Math.max(50, Number(a.timeoutMs) || 1000)));
      asks.set(id, ask);
      for (const target of targets) send(target, { fp: "ask", id, topic: a.topic, payload: a.payload ?? null });
      return;
    }
    const fn = calls[message.op];
    if (!fn) return reply(null, `unknown call ${message.op}`);
    try {
      reply(fn(message.args, index) ?? null);
    } catch (error) {
      reply(null, String(error?.message || error));
    }
  }

  function start(index) {
    const e = table.get(index);
    if (stopping || (e.worker && !e.worker.isDead())) return;
    e.timer = null;
    const worker = cluster.fork({
      FLOWPLAN_PROCESS_INDEX: String(index),
      FLOWPLAN_PROCESS_ROLE: index === 1 ? "primary" : "worker",
      FLOWPLAN_PROCESSES_TOTAL: String(n),
      FLOWPLAN_PROCESS_RESPAWN: e.restarts > 0 ? "1" : "0",
      FLOWPLAN_WORKERS: String(threads),
    });
    e.worker = worker;
    e.startedAt = Date.now();
    e.ready = false;
    worker.on("message", (message) => onMessage(index, worker, message));
    worker.on("exit", (code, signal) => {
      if (e.worker !== worker) return;
      const ran = Date.now() - (e.startedAt ?? Date.now());
      e.lastExit = signal ? signal : `code ${code}`;
      slots.dropOwner(index);
      if (stopping) return;
      if (index === 1 && !othersStarted) {
        console.error(`Processes: process 1 ended before it was ready (${e.lastExit}); stopping.`);
        exitCode = typeof code === "number" && code !== 0 ? code : 1;
        void stop(null);
        return;
      }
      e.backoff = ran >= 60_000 ? 1000 : Math.min(30_000, e.restarts ? e.backoff * 2 : 1000);
      e.restarts++;
      console.error(`Processes: process ${index} (pid ${worker.process.pid}) ended (${e.lastExit}); starting it again in ${Math.round(e.backoff / 1000)} s.`);
      e.timer = setTimeout(() => start(index), e.backoff);
    });
  }

  const exited = (worker) => new Promise((done) => (!worker || worker.isDead() ? done() : worker.once("exit", () => done())));
  async function stop(signal) {
    if (stopping) return;
    stopping = true;
    if (signal) exitCode = signal === "SIGINT" ? 130 : 143;
    for (const e of table.values()) if (e.timer) clearTimeout(e.timer);
    const deadline = Date.now() + budget + 5000;
    const until = (promise, at) => Promise.race([promise, new Promise((r) => setTimeout(r, Math.max(0, at - Date.now())).unref())]);
    const kill = (e, sig) => {
      try {
        if (e.worker && !e.worker.isDead()) e.worker.process.kill(sig);
      } catch {}
    };
    // The processes that only answer requests first, then process 1 (its
    // timed jobs run until the end); each drains on its own.
    const workers = [...table.entries()].filter(([i]) => i !== 1).map(([, e]) => e);
    for (const e of workers) kill(e, signal || "SIGTERM");
    await until(Promise.all(workers.map((e) => exited(e.worker))), Date.now() + Math.round((budget + 5000) * 0.6));
    const primary = table.get(1);
    kill(primary, signal || "SIGTERM");
    await until(exited(primary.worker), deadline);
    for (const e of table.values())
      if (e.worker && !e.worker.isDead()) {
        console.error(`Processes: process ${[...table.entries()].find(([, x]) => x === e)?.[0]} did not stop in time; killed.`);
        kill(e, "SIGKILL");
      }
    process.exit(exitCode);
  }
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
  start(1);
  return { table, stop };
}

const here = dirname(fileURLToPath(import.meta.url));
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const given = process.argv[2];
  const entry = given ? (isAbsolute(given) ? given : resolve(process.cwd(), given)) : resolve(here, "server.js");
  const n = cluster.isPrimary ? processCount() : 1;
  if (n <= 1) await import(pathToFileURL(entry).href);
  else supervise(entry, n);
}
