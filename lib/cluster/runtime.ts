// Start and stop of an instance: the cluster pieces (instrumentation.ts) and
// a graceful shutdown in both modes. Readiness (lib/cluster/health.ts) is
// false while the opening steps run and once the instance is stopping.
//
// Shutdown, in order (SIGTERM/SIGINT; Kubernetes sends SIGTERM after the
// preStop pause):
//   1. at once: readiness turns 503, no new leader rounds start, the open
//      server-sent event streams are closed (browsers reconnect through the
//      load balancer to another instance);
//   2. Next.js, on the same signal, stops accepting connections, finishes
//      the open requests and its after() callbacks and then calls
//      process.exit – which waits here (holdExit) for
//   3. the shutdown tasks (onShutdownTask): running leader rounds and
//      workflow steps finish, the file uploads still under way and the due
//      object storage queue are drained, then the workflow leases, the lead
//      (fenced) and the heartbeat are given back, and the bus and the session
//      connection close.
// Everything is bounded by FLOWPLAN_SHUTDOWN_SECONDS (default 20, below the
// usual 30 s grace period); what is not done by then is left to the other
// instances (leases run out, the queue is claimed again).
//
// Why not NEXT_MANUAL_SIG_HANDLE: then Next.js leaves the signal alone, but
// its own drain – closing the HTTP server and awaiting the after()
// callbacks – is not reachable from the application. Next.js's handler does
// that and ends with process.exit(143); holding that call until Flowplan's
// tasks are done keeps both.
import { clusterMode, instanceId, requireClusterConfig } from "./config";
import { closeBus, startBus } from "./bus";
import { resignLeadership, startLeaderElection, stopDuties, waitForDuties } from "./leader";
import { startHeartbeat, stopHeartbeat } from "./instances";
import { closeSession } from "./pg-session";

// Phases of the shutdown tasks; tasks of one phase run side by side.
export const SHUTDOWN_PHASE = { work: 10, files: 20, release: 30, close: 40 } as const;
type Task = { name: string; phase: number; run: (deadline: number) => Promise<unknown> };
type State = {
  started: boolean;
  stopping: boolean;
  stoppingSince: number | null;
  closers: Set<() => void>;
  tasks: Map<string, Task>;
  shutdown?: Promise<void>;
  finish?: Promise<void>;
  exitHeld?: boolean;
  deadline: number;
};
const holder = globalThis as unknown as { flowplanRuntime?: State };
const state = (): State => (holder.flowplanRuntime ??= { started: false, stopping: false, stoppingSince: null, closers: new Set(), tasks: new Map(), deadline: 0 });

export const shuttingDown = () => state().stopping;
// Open server-sent event streams of this process (metrics).
export const liveStreamCount = () => state().closers.size;

// How long the whole shutdown may take, in ms.
export function shutdownBudgetMs(env: Record<string, string | undefined> = process.env) {
  const seconds = Number(env.FLOWPLAN_SHUTDOWN_SECONDS);
  return Math.round((Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 3600) : 20) * 1000);
}

// Something to end when the instance stops – an open server-sent event
// stream (the browser reconnects, through the load balancer, to another
// instance). Returns the function that forgets it again.
export function onShutdown(close: () => void) {
  const s = state();
  s.closers.add(close);
  return () => s.closers.delete(close);
}

// Work to finish before the process ends (see the order above). `run` gets
// the deadline (epoch ms) and should stop waiting by then; it is not
// awaited beyond it. A task registered again under the same name replaces
// the earlier one.
export function onShutdownTask(name: string, phase: number, run: (deadline: number) => Promise<unknown>) {
  state().tasks.set(name, { name, phase, run });
}

// Waits for `promise`, at most until `deadline`; true when it settled.
export async function untilDeadline(promise: Promise<unknown>, deadline: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const left = Math.max(0, deadline - Date.now());
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), left);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Called first in instrumentation.ts. In cluster mode: the configuration
// check (the process exits with the reasons when something is missing),
// the bus, the leader election and the heartbeat. Both modes: SIGTERM and
// SIGINT end the instance gracefully.
export async function startInstance(options: { pool?: () => { total: number; idle: number; waiting: number } | null; version?: string | null } = {}) {
  const s = state();
  if (s.started) return;
  s.started = true;
  let cluster = false;
  try {
    cluster = requireClusterConfig();
  } catch (error) {
    console.error(String((error as Error).message));
    process.exit(1);
  }
  // Under Next.js's own signal handling (the default) the tasks wait for its
  // drain; with NEXT_MANUAL_SIG_HANDLE this process ends itself afterwards.
  const manual = !!process.env.NEXT_MANUAL_SIG_HANDLE;
  const underNext = process.env.NEXT_RUNTIME === "nodejs" && !manual;
  for (const [signal, code] of [["SIGTERM", 143], ["SIGINT", 130]] as const)
    process.once(signal, () => {
      void stopInstance(signal, { waitForServer: underNext }).then(() => {
        if (manual) process.exit(code);
      });
    });
  holdExit();
  if (!cluster) return;
  console.log(`Cluster mode: instance ${instanceId()}`);
  await startBus();
  startLeaderElection();
  startHeartbeat({
    ready: () => !s.stopping,
    extra: () => ({ pool: options.pool?.() ?? undefined, version: options.version ?? null }),
  });
}

// The tasks of the cluster pieces themselves, besides the registered ones:
// running leader rounds finish first; in cluster mode the lead and the
// heartbeat go back, then the bus and the session connections close.
function builtinTasks(): Task[] {
  const tasks: Task[] = [{ name: "leader-duties", phase: SHUTDOWN_PHASE.work, run: (deadline) => waitForDuties(deadline) }];
  if (clusterMode())
    tasks.push(
      { name: "leader", phase: SHUTDOWN_PHASE.release, run: () => resignLeadership() },
      { name: "heartbeat", phase: SHUTDOWN_PHASE.release, run: () => stopHeartbeat() },
      { name: "bus", phase: SHUTDOWN_PHASE.close, run: () => closeBus() },
      { name: "session", phase: SHUTDOWN_PHASE.close, run: () => closeSession() },
    );
  return tasks;
}

// process.exit during a shutdown (Next.js calls it once its server is
// closed) waits for the shutdown tasks, then exits with the same code.
function holdExit() {
  const s = state();
  if (s.exitHeld) return;
  s.exitHeld = true;
  const exit = process.exit.bind(process);
  process.exit = ((code?: number | string | null) => {
    if (!s.stopping) return exit(code ?? undefined);
    void finishShutdown().finally(() => exit(code ?? process.exitCode ?? undefined));
    return undefined as never;
  }) as typeof process.exit;
}

// Step 1 (above): readiness off, no new leader rounds, streams closed.
// Then the tasks: with `waitForServer` (Next.js drains its server and calls
// process.exit) once that exit comes, or at the latest when half the budget
// is gone; otherwise (scripts, tests, NEXT_MANUAL_SIG_HANDLE) at once.
export function stopInstance(reason = "stop", options: { waitForServer?: boolean } = {}): Promise<void> {
  const s = state();
  return (s.shutdown ??= (async () => {
    s.stopping = true;
    s.stoppingSince = Date.now();
    const budget = shutdownBudgetMs();
    s.deadline = Date.now() + budget;
    console.log(`Stopping (${reason}): closing live streams${clusterMode() ? ", leaving the cluster" : ""}`);
    stopDuties();
    for (const close of [...s.closers])
      try {
        close();
      } catch {}
    s.closers.clear();
    if (options.waitForServer) {
      const timer = setTimeout(() => void finishShutdown(), Math.round(budget / 2));
      timer.unref?.();
      await finishShutdown().finally(() => clearTimeout(timer));
      return;
    }
    await finishShutdown();
  })());
}

// Step 3: the tasks, phase by phase, all within the deadline.
export function finishShutdown(): Promise<void> {
  const s = state();
  if (!s.stopping) {
    s.stopping = true;
    s.stoppingSince = Date.now();
    s.deadline = Date.now() + shutdownBudgetMs();
  }
  return (s.finish ??= (async () => {
    const all = [...builtinTasks(), ...s.tasks.values()];
    const phases = [...new Set(all.map((t) => t.phase))].sort((a, b) => a - b);
    for (const phase of phases) {
      const tasks = all.filter((t) => t.phase === phase);
      // The close phase gets a moment even when the budget is used up.
      const deadline = phase >= SHUTDOWN_PHASE.close ? Math.max(s.deadline, Date.now() + 1000) : s.deadline;
      const results = await Promise.all(
        tasks.map(async (task) => {
          const done = await untilDeadline(
            Promise.resolve()
              .then(() => task.run(deadline))
              .catch((error) => console.error(`Shutdown: ${task.name} failed`, error)),
            deadline,
          );
          return done ? null : task.name;
        }),
      );
      const late = results.filter(Boolean);
      if (late.length) console.warn(`Shutdown: not finished in time: ${late.join(", ")}`);
    }
    console.log(`Stopped after ${Date.now() - (s.stoppingSince ?? Date.now())} ms`);
  })());
}
