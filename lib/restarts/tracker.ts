// Evidence of a restart after the fact (Administration → Überwachung →
// Neustarts; lib/restarts/history.ts stores it). Every 30 s this process
// writes a heartbeat to <data>/logs/run-<key>.json (time, uptime, memory of
// the process and of its container); it ends with an exit marker
// exit-<key>.json:
//   clean – SIGTERM/SIGINT reached the graceful shutdown
//           (lib/cluster/runtime.ts calls noteStopSignal), or the process
//           ended itself with code 0;
//   crash – an uncaught exception that ends the process (no listener for
//           it – under Next.js there always is one, which only logs), or a
//           process.exit with another code; with the last uncaught error
//           (redacted) of the five minutes before.
// Nothing here changes how the process handles errors or signals: the
// exception is watched with "uncaughtExceptionMonitor", the exit with "exit".
//
// The next start reads what the previous run left (claimPreviousRuns) and
// classifies it (classifyRun):
//   clean   – a clean exit marker;
//   crash   – a crash marker;
//   oom     – the last heartbeat showed the memory at ≥ 90 % of the
//             container's limit (or V8's heap at ≥ 90 % of its own limit:
//             "JavaScript heap out of memory" aborts without any handler),
//             or the container's oom_kill counter went up;
//   killed  – nothing: SIGKILL (a failed healthcheck, the host, kill -9,
//             docker stop past its timeout), a power cut, a kernel OOM kill
//             that left no trace.
// A run without a heartbeat (the first start, or heartbeats unwritable)
// classifies as nothing.
//
// Files are named per container or pod (fileKey: FLOWPLAN_INSTANCE_ID or
// the host name), so instances sharing one data folder keep apart. A run
// of another key is only taken over once it ended (its exit marker) or its
// heartbeat is older than STALE_MS – it may still be running elsewhere.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { getHeapStatistics } from "node:v8";
import { resolve } from "node:path";
import { appLogPath, fileKey, flushLogCapture, logsDir, runId, runLines } from "./log-file";
import { logSecrets, redactLogLine } from "./redact";

export const HEARTBEAT_MS = 30_000;
// A heartbeat this old belongs to a run that is gone.
export const STALE_MS = 2 * 60_000;
// Memory share of the limit at the last heartbeat that counts as "likely OOM".
export const OOM_SHARE = 0.9;
// The uncaught error that may explain an exit soon after.
const ERROR_WINDOW_MS = 5 * 60_000;
export const LOG_LINES = 200;

/* ---------- Memory of the container ---------- */

type Read = (path: string) => string | null;
const readText: Read = (path) => {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
};
const num = (text: string | null | undefined) => (text && /^\d+$/.test(text.trim()) ? Number(text.trim()) : null);
const field = (text: string | null, name: string) => num(new RegExp(`^${name} (\\d+)$`, "m").exec(text ?? "")?.[1]);

export type ContainerMemory = {
  // memory.max (v2) or memory.limit_in_bytes (v1); null without a limit.
  limit: number | null;
  // memory.current / memory.usage_in_bytes, and the working set the kernel
  // can not simply drop (usage minus inactive page cache – what Docker and
  // the kubelet count against the limit).
  current: number | null;
  workingSet: number | null;
  // OOM kills in this cgroup so far (memory.events oom_kill; v1
  // memory.oom_control on newer kernels); null where not readable.
  oomKills: number | null;
};
export function containerMemory(read: Read = readText, root = "/sys/fs/cgroup"): ContainerMemory {
  const v2 = read(`${root}/memory.max`);
  if (v2 !== null) {
    const current = num(read(`${root}/memory.current`));
    const inactive = field(read(`${root}/memory.stat`), "inactive_file");
    return {
      limit: num(v2),
      current,
      workingSet: current !== null ? Math.max(0, current - (inactive ?? 0)) : null,
      oomKills: field(read(`${root}/memory.events`), "oom_kill"),
    };
  }
  const v1 = num(read(`${root}/memory/memory.limit_in_bytes`));
  const current = num(read(`${root}/memory/memory.usage_in_bytes`));
  const inactive = field(read(`${root}/memory/memory.stat`), "total_inactive_file");
  return {
    // "No limit" is a huge number (2^63 rounded down to the page size).
    limit: v1 !== null && v1 > 0 && v1 < 2 ** 60 ? v1 : null,
    current,
    workingSet: current !== null ? Math.max(0, current - (inactive ?? 0)) : null,
    oomKills: field(read(`${root}/memory/memory.oom_control`), "oom_kill"),
  };
}

/* ---------- Heartbeat and exit marker ---------- */

export type Heartbeat = {
  v: 1;
  key: string;
  run: string;
  instance: string;
  host: string;
  pid: number;
  version: string | null;
  startedAt: number;
  at: number;
  uptimeS: number;
  rss: number;
  heapUsed: number;
  heapTotal: number;
  heapLimit: number;
  external: number;
  memLimit: number | null;
  memCurrent: number | null;
  memWorkingSet: number | null;
  oomKills: number | null;
};
export type ExitMarker =
  | { kind: "clean"; at: number; run: string; signal: string | null; code: number | null; finished: boolean }
  | { kind: "crash"; at: number; run: string; code: number | null; origin: string | null; error: string | null; stack: string | null };

export const runPath = (key = fileKey()) => resolve(logsDir(), `run-${key}.json`);
export const exitPath = (key = fileKey()) => resolve(logsDir(), `exit-${key}.json`);

function writeJson(path: string, value: unknown) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  renameSync(tmp, path);
}
function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

type State = {
  started: boolean;
  key: string;
  instance: string;
  version: string | null;
  startedAt: number;
  timer?: ReturnType<typeof setInterval>;
  exit: ExitMarker | null;
  lastError: { at: number; origin: string; error: string; stack: string | null } | null;
  snapshot: PreviousRun[];
  secrets: string[];
};
const holder = globalThis as unknown as { flowplanRestartTracker?: State };
const state = () => holder.flowplanRestartTracker;

export function heartbeat(s: State, now = Date.now(), read: Read = readText): Heartbeat {
  const m = process.memoryUsage();
  const c = containerMemory(read);
  return {
    v: 1,
    key: s.key,
    run: runId(),
    instance: s.instance,
    host: hostname().slice(0, 80),
    pid: process.pid,
    version: s.version,
    startedAt: s.startedAt,
    at: now,
    uptimeS: Math.round(process.uptime()),
    rss: m.rss,
    heapUsed: m.heapUsed,
    heapTotal: m.heapTotal,
    heapLimit: getHeapStatistics().heap_size_limit,
    external: m.external,
    memLimit: c.limit,
    memCurrent: c.current,
    memWorkingSet: c.workingSet,
    oomKills: c.oomKills,
  };
}
function beat(now = Date.now()) {
  const s = state();
  if (!s?.started) return;
  try {
    writeJson(runPath(s.key), heartbeat(s, now));
  } catch {}
}

const errorText = (error: unknown, secrets: string[]) => {
  const e = error as { name?: string; message?: string; stack?: string } | null;
  const message = e && typeof e === "object" && "message" in e ? `${e.name || "Error"}: ${e.message}` : String(error);
  const stack = e && typeof e === "object" && typeof e.stack === "string" ? e.stack : null;
  const clean = (text: string, max: number) =>
    text
      .split("\n")
      .slice(0, 30)
      .map((l) => redactLogLine(l, secrets))
      .join("\n")
      .slice(0, max);
  return { error: clean(message, 1000), stack: stack ? clean(stack, 4000) : null };
};
function writeExit(marker: ExitMarker) {
  const s = state();
  if (!s) return;
  s.exit = marker;
  try {
    writeJson(exitPath(s.key), marker);
  } catch {}
}

// SIGTERM/SIGINT reached the graceful shutdown (lib/cluster/runtime.ts).
export function noteStopSignal(signal: string) {
  const s = state();
  if (!s?.started || s.exit) return;
  writeExit({ kind: "clean", at: Date.now(), run: runId(), signal, code: null, finished: false });
}

// The listeners (exported for the tests).
export function recordExit(code: number) {
  const s = state();
  if (!s?.started) return;
  try {
    flushLogCapture();
  } catch {}
  if (s.exit?.kind === "clean") writeExit({ ...s.exit, code, finished: true });
  else if (s.exit?.kind === "crash") return;
  else if (code === 0) writeExit({ kind: "clean", at: Date.now(), run: runId(), signal: null, code, finished: true });
  else {
    const recent = s.lastError && Date.now() - s.lastError.at < ERROR_WINDOW_MS ? s.lastError : null;
    writeExit({ kind: "crash", at: Date.now(), run: runId(), code, origin: recent?.origin ?? null, error: recent?.error ?? null, stack: recent?.stack ?? null });
  }
}
export function recordUncaught(error: unknown, origin: string) {
  const s = state();
  if (!s?.started) return;
  const text = errorText(error, s.secrets);
  s.lastError = { at: Date.now(), origin, ...text };
  // Nobody handles it: Node.js ends the process right after this monitor.
  if (process.listenerCount("uncaughtException") === 0) {
    try {
      flushLogCapture();
    } catch {}
    writeExit({ kind: "crash", at: Date.now(), run: runId(), code: 1, origin, error: text.error, stack: text.stack });
  }
}

/* ---------- The previous runs ---------- */

export type RestartReason = "clean" | "crash" | "oom" | "killed";
export type PreviousRun = {
  key: string;
  heartbeat: Heartbeat;
  exit: ExitMarker | null;
  // The container's oom_kill counter now (to compare with the heartbeat's).
  oomKillsNow: number | null;
  lines: string[];
};
export type Classified = {
  reason: RestartReason;
  // When the run ended: the exit marker's time, else its last heartbeat.
  endedAt: number;
  uptimeMs: number;
  error: string | null;
  signal: string | null;
  code: number | null;
  memoryShare: number | null;
};

// The share of the container's limit in use at a heartbeat (the larger of
// the process's RSS and the container's working set), or of V8's heap limit
// when that is closer to its end; null without any limit.
export function memoryShare(h: Pick<Heartbeat, "rss" | "memLimit" | "memWorkingSet" | "memCurrent" | "heapUsed" | "heapLimit">): number | null {
  const shares: number[] = [];
  if (h.memLimit && h.memLimit > 0) shares.push(Math.max(h.rss || 0, h.memWorkingSet ?? h.memCurrent ?? 0) / h.memLimit);
  if (h.heapLimit && h.heapLimit > 0) shares.push((h.heapUsed || 0) / h.heapLimit);
  return shares.length ? Math.max(...shares) : null;
}

export function classifyRun(run: Pick<PreviousRun, "heartbeat" | "exit" | "oomKillsNow"> | null): Classified | null {
  const h = run?.heartbeat;
  if (!run || !h || !Number.isFinite(h.startedAt) || !Number.isFinite(h.at)) return null;
  const exit = run.exit && run.exit.run === h.run ? run.exit : null;
  const endedAt = exit?.at ?? h.at;
  const base = { endedAt, uptimeMs: Math.max(0, endedAt - h.startedAt), memoryShare: memoryShare(h) };
  if (exit?.kind === "clean") return { ...base, reason: "clean", error: null, signal: exit.signal, code: exit.code };
  if (exit?.kind === "crash")
    return { ...base, reason: "crash", error: [exit.error || (exit.code !== null ? `exit code ${exit.code}` : null), exit.stack].filter(Boolean).join("\n") || null, signal: null, code: exit.code };
  const oomKilled = h.oomKills !== null && run.oomKillsNow !== null && run.oomKillsNow > h.oomKills;
  if (oomKilled || (base.memoryShare !== null && base.memoryShare >= OOM_SHARE)) return { ...base, reason: "oom", error: null, signal: null, code: null };
  return { ...base, reason: "killed", error: null, signal: null, code: null };
}

// Takes over what ended runs left in the logs folder (this key's at once,
// others' once they ended or went stale): heartbeat, exit marker and the
// last lines; their files go. Each run is taken by one process only (the
// rename of its heartbeat file).
export function claimPreviousRuns(now = Date.now(), options: { read?: Read; ownKey?: string; ownRun?: string } = {}): PreviousRun[] {
  const own = options.ownKey ?? fileKey();
  const ownRun = options.ownRun ?? runId();
  const out: PreviousRun[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(logsDir());
  } catch {
    return out;
  }
  const oomKillsNow = containerMemory(options.read).oomKills;
  for (const name of names) {
    const m = /^run-(.+)\.json$/.exec(name);
    if (!m) continue;
    const key = m[1];
    const path = resolve(logsDir(), name);
    const h = readJson<Heartbeat>(path);
    if (!h || h.v !== 1) {
      rmSync(path, { force: true });
      continue;
    }
    if (h.run === ownRun) continue;
    const exit = readJson<ExitMarker>(exitPath(key));
    const ended = !!exit && exit.run === h.run;
    let seenAt = h.at;
    try {
      seenAt = Math.max(seenAt, statSync(path).mtimeMs);
    } catch {}
    const stale = now - seenAt > STALE_MS;
    // Another process with this key that still beats (a second process in
    // the same container): not ours.
    const alive = key === own && h.pid !== process.pid && h.host === hostname() && !ended && !stale && pidAlive(h.pid) && h.pid !== 1;
    if (!(ended || stale || (key === own && !alive))) continue;
    const claimed = `${path}.claimed-${runId()}`;
    try {
      renameSync(path, claimed);
    } catch {
      continue;
    }
    const until = ended ? exit!.at + 5_000 : Math.min(now, h.at + HEARTBEAT_MS + 5_000);
    let lines: string[] = [];
    try {
      lines = runLines(key, h.run, h.startedAt, until, LOG_LINES);
    } catch {}
    out.push({ key, heartbeat: h, exit: ended ? exit : null, oomKillsNow, lines });
    rmSync(claimed, { force: true });
    if (exit) rmSync(exitPath(key), { force: true });
  }
  return out;
}
function pidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Logs of keys that no longer write (old containers): gone after 30 days.
export function sweepLogFiles(now = Date.now(), keepMs = 30 * 86_400_000) {
  try {
    for (const name of readdirSync(logsDir())) {
      if (!/^(app-.+\.log(\.1)?|exit-.+\.json|run-.+\.json\.claimed-.+|.+\.tmp)$/.test(name)) continue;
      const path = resolve(logsDir(), name);
      if (path === appLogPath() || path === `${appLogPath()}.1`) continue;
      try {
        if (now - statSync(path).mtimeMs > keepMs) rmSync(path, { force: true });
      } catch {}
    }
  } catch {}
}

// First in instrumentation.ts, before the app writes anything to the
// database: what the previous runs left is kept in memory
// (takePreviousRuns), then this run's heartbeat begins. No database here.
export function startRestartTracker(options: { instance?: string; version?: string | null; now?: number } = {}) {
  if (state()?.started) return state()!;
  const now = options.now ?? Date.now();
  const s: State = {
    started: true,
    key: fileKey(),
    instance: options.instance ?? "",
    version: options.version ?? null,
    startedAt: now - Math.round(process.uptime() * 1000),
    exit: null,
    lastError: null,
    snapshot: [],
    secrets: logSecrets(),
  };
  holder.flowplanRestartTracker = s;
  try {
    if (!existsSync(logsDir())) mkdirSync(logsDir(), { recursive: true, mode: 0o700 });
    s.snapshot = claimPreviousRuns(now, { ownKey: s.key, ownRun: runId() });
    rmSync(exitPath(s.key), { force: true });
  } catch {}
  beat(now);
  s.timer = setInterval(() => beat(), HEARTBEAT_MS);
  s.timer.unref?.();
  process.on("uncaughtExceptionMonitor", recordUncaught);
  process.on("exit", recordExit);
  return s;
}
// The instance id is only known once the cluster pieces have started.
export function setTrackerInstance(instance: string) {
  const s = state();
  if (s) s.instance = instance;
  beat();
}
// What the previous runs left (once; lib/restarts/history.ts stores it).
export function takePreviousRuns(): PreviousRun[] {
  const s = state();
  if (!s) return [];
  const runs = s.snapshot;
  s.snapshot = [];
  return runs;
}
export const trackerStarted = () => !!state()?.started;
// For the tests: forget this process's tracker (listeners off).
export function resetTrackerForTests() {
  const s = state();
  if (s?.timer) clearInterval(s.timer);
  process.off("uncaughtExceptionMonitor", recordUncaught);
  process.off("exit", recordExit);
  holder.flowplanRestartTracker = undefined;
}
