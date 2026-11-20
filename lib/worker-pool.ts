// Long CPU work off the request thread (#383 #14): the document exports
// (Markdown/ZIP, EPUB, PDF, Word, Jira, Confluence) and the reading of
// imports run in worker threads, so the one event loop that answers every
// request keeps turning while they work. A space export held it for 15–20 s
// before – every other request of the instance waited.
//
// A small pool per process (cluster instances and the single container
// alike): FLOWPLAN_WORKERS threads (default: the cores the process may use
// minus one, at least one; 0 = none, everything runs on the request thread
// as before). Threads start on first use and end after IDLE_MS without
// work. Each runs one job at a time; further jobs wait in a bounded queue
// (QUEUE_PER_WORKER per thread), beyond it the request is answered with 503.
//
// A worker thread reads the database on a connection of its own
// (lib/db-driver/context.ts readerThread: SQLite read-only as a WAL reader,
// PostgreSQL read-only transactions) and writes nothing; audit entries come
// back with the result and are written here (lib/db.ts collectingAudits).
// Work inside a transaction of the caller stays on this thread (a worker
// would not see its uncommitted writes), as does everything when no worker
// starts (a missing file in an unusual build).
//
// Errors keep their kind: an HttpError comes back as an HttpError with its
// status, a ZodError as a ZodError, anything else as an Error (500) – as if
// the work had run here. A job over its time ends its thread and fails like
// any other error. On SIGTERM (lib/cluster/runtime.ts) waiting jobs are
// refused with 503, running ones get until the shutdown deadline.
import { SHARE_ENV, Worker, isMainThread, type WorkerOptions } from "node:worker_threads";
import { availableParallelism } from "node:os";
import { z } from "zod";
import { HttpError } from "./auth";
import { contentLocale } from "./content-locale";
import { currentTx } from "./db-driver/context";
import type { AuditEntry } from "./db";
import type { WorkerJobName } from "./worker-jobs";

const IDLE_MS = 60_000;
export const QUEUE_PER_WORKER = 16;
const MAX_WORKERS = 32;
// Exports of large spaces take minutes on slow machines; the limit only
// ends work that hangs.
export const DEFAULT_JOB_MS = 15 * 60_000;
export const BUSY_MESSAGE = "Der Server ist gerade ausgelastet. Bitte versuche es gleich noch einmal.";
export const TIMEOUT_MESSAGE = "Zeitüberschreitung bei der Hintergrundarbeit.";
export const STOPPING_MESSAGE = "Der Server wird gerade neu gestartet. Bitte versuche es gleich noch einmal.";

// How many worker threads (FLOWPLAN_WORKERS; unset or invalid: cores − 1).
export function workerCount(env: Record<string, string | undefined> = process.env, cores = availableParallelism()) {
  const raw = env.FLOWPLAN_WORKERS?.trim();
  if (raw && /^\d+$/.test(raw)) return Math.min(MAX_WORKERS, Number(raw));
  return Math.min(MAX_WORKERS, Math.max(1, cores - 1));
}

export type SerializedError =
  | { kind: "http"; status: number; message: string }
  | { kind: "zod"; issues: unknown[] }
  | { kind: "error"; message: string; stack?: string }
  // The job tried to write (SQLite's read-only connection, PostgreSQL's
  // read-only transaction): it runs again on the request thread.
  | { kind: "write"; message: string };
const READ_ONLY_WRITE = /attempt to write a readonly database|read-only transaction/i;
export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error && (READ_ONLY_WRITE.test(error.message) || (error as { code?: string }).code === "25006")) return { kind: "write", message: error.message };
  if (error instanceof HttpError) return { kind: "http", status: error.status, message: error.message };
  if (error instanceof z.ZodError) return { kind: "zod", issues: JSON.parse(JSON.stringify(error.issues)) };
  const e = error instanceof Error ? error : new Error(String(error));
  return { kind: "error", message: e.message, stack: e.stack };
}
export function reviveError(error: SerializedError): Error {
  if (error.kind === "http") return new HttpError(error.status, error.message);
  if (error.kind === "zod") return new z.ZodError(error.issues as z.core.$ZodIssue[]);
  const revived = new Error(error.message);
  if (error.stack) revived.stack = error.stack;
  return revived;
}
// Buffers cross the thread as Uint8Arrays: back to Buffers (also in plain
// objects, arrays and maps of the result).
export function revive(value: unknown, depth = 0): unknown {
  if (value instanceof Uint8Array) return Buffer.isBuffer(value) ? value : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (depth > 6 || !value || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = revive(value[i], depth + 1);
    return value;
  }
  if (value instanceof Map) {
    for (const [key, item] of value) value.set(key, revive(item, depth + 1));
    return value;
  }
  if (Object.getPrototypeOf(value) === Object.prototype)
    for (const key of Object.keys(value)) (value as Record<string, unknown>)[key] = revive((value as Record<string, unknown>)[key], depth + 1);
  return value;
}
// Large byte arrays that own their memory move instead of being copied.
export function transferables(value: unknown, into: ArrayBuffer[] = [], depth = 0): ArrayBuffer[] {
  if (value instanceof Uint8Array) {
    if (value.byteLength >= 64 * 1024 && value.byteOffset === 0 && value.byteLength === value.buffer.byteLength && value.buffer instanceof ArrayBuffer && !into.includes(value.buffer))
      into.push(value.buffer);
    return into;
  }
  if (depth > 6 || !value || typeof value !== "object") return into;
  const items = Array.isArray(value) ? value : value instanceof Map ? [...value.values()] : Object.getPrototypeOf(value) === Object.prototype ? Object.values(value) : [];
  for (const item of items) transferables(item, into, depth + 1);
  return into;
}

export type JobMessage = { id: number; name: WorkerJobName; args: unknown[]; locale: string };
export type ResultMessage = { id: number; value: unknown; audits: AuditEntry[] } | { id: number; error: SerializedError } | { ready: true };

type Job = {
  id: number;
  name: WorkerJobName;
  args: unknown[];
  locale: string;
  timeoutMs: number;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  here: () => Promise<unknown>;
};
type Slot = { worker: Worker; job: Job | null; ready: boolean; timer: ReturnType<typeof setTimeout> | null; idle: ReturnType<typeof setTimeout> | null };
type Pool = {
  slots: Set<Slot>;
  queue: Job[];
  next: number;
  broken: boolean;
  stopping: boolean;
  shutdownHooked: boolean;
  // Tests: a stand-in for the worker script, and counters.
  script?: URL | string;
  started: number;
  completed: number;
};
const holder = globalThis as { flowplanWorkerPool?: Pool };
const pool = (): Pool => (holder.flowplanWorkerPool ??= { slots: new Set(), queue: [], next: 1, broken: false, stopping: false, shutdownHooked: false, started: 0, completed: 0 });

function spawn(p: Pool): Slot | null {
  if (p.broken) return null;
  let worker: Worker;
  try {
    // The process's environment, live (tests and the administration change it).
    const options: WorkerOptions = { env: SHARE_ENV, workerData: { flowplanDbReader: true }, name: "flowplan-worker" };
    // Turbopack bundles the entry (and what it imports) as a worker chunk
    // of its own – it needs the literal `new Worker(new URL(…))`; under tsx
    // (tests, scripts) the TypeScript file runs as it is.
    worker = p.script ? new Worker(p.script, options) : new Worker(new URL("./workers/job-worker.ts", import.meta.url), options);
  } catch (error) {
    console.error("Worker threads unavailable, running jobs on the request thread:", (error as Error)?.message);
    p.broken = true;
    return null;
  }
  p.started++;
  const slot: Slot = { worker, job: null, ready: false, timer: null, idle: null };
  p.slots.add(slot);
  hookShutdown(p);
  worker.on("message", (message: ResultMessage) => {
    if ("ready" in message) {
      slot.ready = true;
      return;
    }
    const job = slot.job;
    if (!job || job.id !== message.id) return;
    finish(p, slot);
    if ("error" in message && message.error.kind === "write") {
      // Some path of the job writes after all: done here, as before the
      // workers, and named in the log so that it can be fixed.
      console.warn(`Worker job ${job.name} tried to write (${message.error.message}); it ran on the request thread instead.`);
      job.here().then(job.resolve, job.reject);
    } else if ("error" in message) job.reject(reviveError(message.error));
    else
      void (async () => {
        const { writeAudits } = await import("./db");
        await writeAudits(message.audits);
        return revive(message.value);
      })().then(job.resolve, job.reject);
    pump(p);
  });
  worker.on("error", (error) => {
    const job = slot.job;
    p.slots.delete(slot);
    slot.job = null;
    if (slot.timer) clearTimeout(slot.timer);
    // A thread that fails before it could load (a build without its
    // chunk): no further threads, this job and the rest run here.
    if (!slot.ready) {
      if (!p.broken) console.error("Worker thread failed to start, running jobs on the request thread:", (error as Error)?.message);
      p.broken = true;
      if (job) job.here().then(job.resolve, job.reject);
      for (const waiting of p.queue.splice(0)) waiting.here().then(waiting.resolve, waiting.reject);
      return;
    }
    job?.reject(error instanceof Error ? error : new Error(String(error)));
    pump(p);
  });
  worker.on("exit", () => {
    const job = slot.job;
    p.slots.delete(slot);
    slot.job = null;
    if (slot.timer) clearTimeout(slot.timer);
    if (slot.idle) clearTimeout(slot.idle);
    job?.reject(new Error("Der Worker-Thread wurde beendet."));
    pump(p);
  });
  return slot;
}

function finish(p: Pool, slot: Slot) {
  if (slot.timer) clearTimeout(slot.timer);
  slot.timer = null;
  slot.job = null;
  p.completed++;
  slot.worker.unref();
  if (slot.idle) clearTimeout(slot.idle);
  slot.idle = setTimeout(() => {
    if (slot.job) return;
    p.slots.delete(slot);
    void slot.worker.terminate().catch(() => {});
  }, IDLE_MS);
  slot.idle.unref?.();
}

function start(p: Pool, slot: Slot, job: Job) {
  if (slot.idle) clearTimeout(slot.idle);
  slot.idle = null;
  slot.job = job;
  // A running job keeps the process alive (scripts, tests); an idle thread does not.
  slot.worker.ref();
  slot.timer = setTimeout(() => {
    if (slot.job !== job) return;
    slot.job = null;
    p.slots.delete(slot);
    job.reject(new Error(TIMEOUT_MESSAGE));
    void slot.worker.terminate().catch(() => {});
    pump(p);
  }, job.timeoutMs);
  slot.timer.unref?.();
  const message: JobMessage = { id: job.id, name: job.name, args: job.args, locale: job.locale };
  try {
    slot.worker.postMessage(message);
  } catch (error) {
    // Arguments that cannot be cloned: a programming error, reported as one.
    if (slot.timer) clearTimeout(slot.timer);
    slot.job = null;
    job.reject(error instanceof Error ? error : new Error(String(error)));
    finish(p, slot);
  }
}

// Gives waiting jobs to free threads, starting threads up to the limit.
function pump(p: Pool) {
  if (p.stopping) return;
  const limit = workerCount();
  while (p.queue.length) {
    let free: Slot | null = null;
    for (const slot of p.slots)
      if (!slot.job) {
        free = slot;
        break;
      }
    if (!free && p.slots.size < limit) free = spawn(p);
    if (!free) {
      if (p.broken) for (const job of p.queue.splice(0)) job.here().then(job.resolve, job.reject);
      return;
    }
    start(p, free, p.queue.shift()!);
  }
}

// Runs a job of lib/worker-jobs.ts in a worker thread; `here` is the same
// work on this thread (no workers, inside the caller's transaction, or
// already in a worker). Arguments and results must be structured-cloneable.
export function offThread<T>(name: WorkerJobName, args: unknown[], here: () => Promise<T>, options: { timeoutMs?: number } = {}): Promise<T> {
  const p = pool();
  if (!isMainThread || p.broken || currentTx() || workerCount() === 0) return here();
  if (p.stopping) return Promise.reject(new HttpError(503, STOPPING_MESSAGE));
  const limit = workerCount();
  const busy = [...p.slots].filter((slot) => slot.job).length;
  if (busy >= limit && p.queue.length >= limit * QUEUE_PER_WORKER) return Promise.reject(new HttpError(503, BUSY_MESSAGE));
  return new Promise<T>((resolve, reject) => {
    p.queue.push({
      id: p.next++,
      name,
      args,
      locale: contentLocale(),
      timeoutMs: options.timeoutMs ?? DEFAULT_JOB_MS,
      resolve: resolve as (value: unknown) => void,
      reject,
      here: here as () => Promise<unknown>,
    });
    pump(p);
  });
}

// Ends the pool: waiting jobs are refused, running ones may finish until
// `deadline` (epoch ms), then every thread is ended.
export async function stopWorkers(deadline = Date.now()) {
  const p = pool();
  p.stopping = true;
  for (const job of p.queue.splice(0)) job.reject(new HttpError(503, STOPPING_MESSAGE));
  while ([...p.slots].some((slot) => slot.job) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  await Promise.all(
    [...p.slots].map(async (slot) => {
      p.slots.delete(slot);
      if (slot.idle) clearTimeout(slot.idle);
      await slot.worker.terminate().catch(() => {});
    }),
  );
}

function hookShutdown(p: Pool) {
  if (p.shutdownHooked) return;
  p.shutdownHooked = true;
  void import("./cluster/runtime")
    .then(({ onShutdownTask, SHUTDOWN_PHASE }) => onShutdownTask("workers", SHUTDOWN_PHASE.work, (deadline) => stopWorkers(deadline)))
    .catch(() => {});
}

// The pool's state (tests, the system view).
export function workerPoolState() {
  const p = pool();
  return {
    size: workerCount(),
    threads: p.slots.size,
    busy: [...p.slots].filter((slot) => slot.job).length,
    queued: p.queue.length,
    started: p.started,
    completed: p.completed,
    broken: p.broken,
    stopping: p.stopping,
  };
}
// Tests: a fresh pool (after stopWorkers), optionally with another script.
export async function resetWorkerPool(script?: URL | string) {
  await stopWorkers();
  holder.flowplanWorkerPool = { slots: new Set(), queue: [], next: 1, broken: false, stopping: false, shutdownHooked: false, started: 0, completed: 0, script };
}
