// Several Flowplan processes behind one port on one host (#383 wave 5,
// docs/architecture/multi-process.md): the side of each app process.
//
// scripts/processes.mjs (the supervisor, `node processes.mjs` next to
// server.js) starts FLOWPLAN_PROCESSES copies of server.js with node:cluster
// and tells each one who it is in its environment:
//   FLOWPLAN_PROCESS_INDEX   1 … n
//   FLOWPLAN_PROCESS_ROLE    "primary" for process 1, "worker" for the rest
//   FLOWPLAN_PROCESSES_TOTAL n
//   FLOWPLAN_PROCESS_RESPAWN "1" when it was started again after an exit
// Process 1 is started alone first, opens (and migrates) the database and
// says "ready"; only then the others start. It runs everything that must run
// once per host – the timed jobs, Litestream's checks, the restart history,
// a staged restore at the start. The others only answer requests.
//
// The processes talk through the supervisor over node's IPC channel:
//   - the bus (lib/cluster/bus.ts): what one process publishes, the others
//     receive – the same messages and semantics as Redis in cluster mode;
//   - calls answered by the supervisor (shared rate-limit windows, AI slots,
//     the process table) – callIpc();
//   - questions to the other processes (askPeers/answerPeers).
// All of it is best effort: no answer in time is an error the caller
// handles by counting on its own, as a single process does.
//
// Without the supervisor (FLOWPLAN_PROCESSES unset or 1, `node server.js`)
// nothing here is active: multiProcess() is false, primaryProcess() true.
import { clusterMode } from "./config";

type Env = Record<string, string | undefined>;

// This process's number (1 … n), 0 outside a group of processes.
export function processIndex(env: Env = process.env): number {
  const n = Number(env.FLOWPLAN_PROCESS_INDEX);
  return Number.isInteger(n) && n > 0 ? n : 0;
}
// How many processes the supervisor runs (1 outside a group).
export function processTotal(env: Env = process.env): number {
  const n = Number(env.FLOWPLAN_PROCESSES_TOTAL);
  return Number.isInteger(n) && n > 1 ? n : 1;
}
// Whether this process is one of several, with the supervisor's channel.
export function multiProcess(env: Env = process.env): boolean {
  return processTotal(env) > 1 && processIndex(env) > 0 && typeof process.send === "function";
}
// Whether this process runs the duties of the host (always outside a group).
export function primaryProcess(env: Env = process.env): boolean {
  return !multiProcess(env) || env.FLOWPLAN_PROCESS_ROLE === "primary";
}
// Started again by the supervisor after it ended (not at the host's start):
// a staged restore is not applied then – the other processes have the
// database open.
export function respawnedProcess(env: Env = process.env): boolean {
  return multiProcess(env) && env.FLOWPLAN_PROCESS_RESPAWN === "1";
}
// Whether a staged restore (<data>/restore-pending) may be applied when this
// process opens the database: always for a single process; with several,
// only process 1 at the host's start, before the others exist.
export function restoreAtThisStart(env: Env = process.env): boolean {
  if (!multiProcess(env)) return true;
  return primaryProcess(env) && !respawnedProcess(env);
}
// Other processes share what this one counts in memory: other instances
// (cluster mode) or other processes of this host.
export function hasPeers(): boolean {
  return clusterMode() || multiProcess();
}

/* ---------- The channel ---------- */

type Message = { fp?: string; [key: string]: unknown };
type State = {
  listening: boolean;
  handlers: Map<string, Set<(message: Message) => void>>;
  calls: Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>;
  answers: Map<string, (payload: unknown) => unknown>;
  sequence: number;
  sent: number;
  received: number;
  failed: number;
};
const holder = globalThis as unknown as { flowplanProcesses?: State };
const state = (): State =>
  (holder.flowplanProcesses ??= { listening: false, handlers: new Map(), calls: new Map(), answers: new Map(), sequence: 0, sent: 0, received: 0, failed: 0 });

function listen() {
  const s = state();
  if (s.listening || typeof process.send !== "function") return;
  s.listening = true;
  process.on("message", (raw: unknown) => {
    const message = raw as Message;
    if (!message || typeof message !== "object" || typeof message.fp !== "string") return;
    s.received++;
    if (message.fp === "reply") {
      const call = s.calls.get(Number(message.id));
      if (!call) return;
      s.calls.delete(Number(message.id));
      clearTimeout(call.timer);
      if (message.error) call.reject(new Error(String(message.error)));
      else call.resolve(message.value);
      return;
    }
    if (message.fp === "ask") {
      void answer(message);
      return;
    }
    for (const handler of s.handlers.get(message.fp) ?? [])
      try {
        handler(message);
      } catch (error) {
        console.error(`Processes: handler for ${message.fp} failed`, error);
      }
  });
}

// Sends to the supervisor (fire and forget). False when there is no channel.
export function sendIpc(message: Message): boolean {
  if (typeof process.send !== "function" || !process.connected) return false;
  const s = state();
  listen();
  try {
    process.send(message, undefined, {}, (error) => {
      if (error) s.failed++;
    });
    s.sent++;
    return true;
  } catch {
    s.failed++;
    return false;
  }
}

// Messages of kind `fp` from the supervisor (bus messages of the others).
export function onIpc(fp: string, handler: (message: Message) => void) {
  const s = state();
  listen();
  let set = s.handlers.get(fp);
  if (!set) s.handlers.set(fp, (set = new Set()));
  set.add(handler);
  return () => set.delete(handler);
}

// Asks the supervisor; rejects without a channel or after `timeoutMs`.
export function callIpc<T>(op: string, args: unknown, timeoutMs = 1000): Promise<T> {
  const s = state();
  const id = ++s.sequence;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      s.calls.delete(id);
      reject(new Error(`no answer from the supervisor within ${timeoutMs} ms (${op})`));
    }, timeoutMs);
    timer.unref?.();
    s.calls.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
    if (!sendIpc({ fp: "call", id, op, args })) {
      clearTimeout(timer);
      s.calls.delete(id);
      reject(new Error("no supervisor channel"));
    }
  });
}

// Asks every other process of the host; the answers that came within
// `timeoutMs` (the supervisor collects them; empty without a channel).
export async function askPeers<T>(topic: string, payload: unknown = null, timeoutMs = 1000): Promise<T[]> {
  if (!multiProcess()) return [];
  try {
    const answers = await callIpc<unknown[]>("ask", { topic, payload, timeoutMs }, timeoutMs + 500);
    return Array.isArray(answers) ? (answers as T[]) : [];
  } catch {
    return [];
  }
}
// What this process answers when another one asks about `topic`.
export function answerPeers(topic: string, fn: (payload: unknown) => unknown) {
  state().answers.set(topic, fn);
  listen();
}
async function answer(message: Message) {
  const fn = state().answers.get(String(message.topic));
  let value: unknown = null;
  try {
    value = fn ? await fn(message.payload) : null;
  } catch {
    value = null;
  }
  sendIpc({ fp: "answer", id: message.id, value: value ?? null });
}

// Tells the supervisor that this process has opened the database and the
// others may start (process 1, instrumentation.ts).
export function announceReady() {
  if (multiProcess()) sendIpc({ fp: "ready" });
}

export type ProcessRow = {
  index: number;
  pid: number | null;
  role: "primary" | "worker" | "supervisor";
  running: boolean;
  startedAt: number | null;
  restarts: number;
  lastExit: string | null;
  rss: number | null;
  cpuSeconds: number | null;
};
// The supervisor's table of the processes (Administration → Überwachung,
// the metrics endpoint); null outside a group or without an answer.
export async function processTable(): Promise<ProcessRow[] | null> {
  if (!multiProcess()) return null;
  try {
    return await callIpc<ProcessRow[]>("processes", null, 1000);
  } catch {
    return null;
  }
}

export function ipcStats() {
  const s = state();
  return { sent: s.sent, received: s.received, failed: s.failed, pending: s.calls.size };
}
