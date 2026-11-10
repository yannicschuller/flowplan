// The queue of workflow steps (docs/specs/workflows.md §8.3): every
// instance claims due steps (FOR UPDATE SKIP LOCKED on PostgreSQL, one
// statement on SQLite) with a lease and a fencing token, runs up to
// FLOWPLAN_WORKFLOW_WORKERS at once, and is woken locally right away, by
// the other instances over the cluster bus, by a timer on the next due
// step and by polling every 5 s (Redis is never needed for correctness).
// A sweeper puts steps whose lease ran out back into the queue; a stopping
// instance gives its leases back at once.
import { randomUUID } from "node:crypto";
import { all, one, run, sql } from "../db";
import { instanceId } from "../cluster/config";
import { onBus, publish } from "../cluster/bus";
import { onShutdown } from "../cluster/runtime";
import { afterTransaction } from "../db-driver/context";
import { backoff, executeStep, LEASE_MS, type StepRow } from "./engine";
import { dispatchEvents } from "./events";
import { workflowLimits } from "./limits";
import { workersPaused } from "../instance-read-only";
import { noteWorkflow } from "./monitoring";

type State = {
  active: number;
  pumping: boolean;
  again: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  poll: ReturnType<typeof setInterval> | null;
  sweep: ReturnType<typeof setInterval> | null;
  started: boolean;
  stopping: boolean;
  running: Set<Promise<void>>;
};
const holder = globalThis as { flowplanWorkflowQueue?: State };
const state = (): State =>
  (holder.flowplanWorkflowQueue ??= { active: 0, pumping: false, again: false, timer: null, poll: null, sweep: null, started: false, stopping: false, running: new Set() });

// Claims up to `limit` due steps of runs that may run (workflow active, or a
// test), at most `parallel` running runs per workflow.
export async function claimSteps(limit: number, now = Date.now()): Promise<StepRow[]> {
  if (limit < 1) return [];
  const parallel = (await workflowLimits()).parallelRuns;
  const token = randomUUID();
  const lock = sql.name === "postgres" ? " FOR UPDATE OF s SKIP LOCKED" : "";
  const rows = await all<StepRow>(
    `UPDATE workflow_steps SET status='running',lease_token=?,lease_until=?,claimed_by=?,started_at=COALESCE(started_at,?)
      WHERE id IN (SELECT s.id FROM workflow_steps s
                     JOIN workflow_runs r ON r.id=s.run_id
                     JOIN workflows w ON w.page_id=r.page_id
                    WHERE s.status IN ('queued','waiting') AND s.due_at<=?
                      AND r.status IN ('queued','running','waiting')
                      AND (w.status='active' OR r.mode<>'live')
                      AND (r.status='running' OR (SELECT COUNT(*) FROM workflow_runs r2 WHERE r2.page_id=r.page_id AND r2.status='running') < ?)
                    ORDER BY s.due_at,s.seq LIMIT ${Math.floor(limit)}${lock})
      RETURNING id,run_id,node_id,iteration,via,status,attempt,due_at,lease_until,lease_token,claimed_by`,
    token,
    now + LEASE_MS,
    instanceId(),
    now,
    now,
    parallel,
  );
  if (rows.length) {
    noteWorkflow("claimed", rows.length);
    await run(`UPDATE workflow_runs SET status='running' WHERE status IN ('queued','waiting') AND id IN ${sql.jsonValues()}`, JSON.stringify([...new Set(rows.map((r) => r.run_id))]));
  }
  return rows;
}

// Steps whose lease ran out (a stopped or hung instance) go back into the
// queue with a new attempt and a backoff.
export async function sweepLeases(now = Date.now()) {
  const expired = await all<{ id: string; attempt: number; lease_token: string }>("SELECT id,attempt,lease_token FROM workflow_steps WHERE status='running' AND lease_until<? LIMIT 500", now);
  let swept = 0;
  for (const s of expired)
    swept += (
      await run(
        "UPDATE workflow_steps SET status='queued',attempt=attempt+1,due_at=?,lease_token=NULL,lease_until=0,claimed_by=NULL WHERE id=? AND lease_token=? AND status='running' AND lease_until<?",
        now + backoff(s.attempt, true),
        s.id,
        s.lease_token,
        now,
      )
    ).changes;
  if (swept) noteWorkflow("swept", swept);
  return swept;
}
// A stopping instance gives its leases back (no attempt used).
export async function releaseLeases() {
  return (await run("UPDATE workflow_steps SET status='queued',lease_token=NULL,lease_until=0,claimed_by=NULL WHERE status='running' AND claimed_by=?", instanceId())).changes;
}

async function pump() {
  const s = state();
  if (s.stopping) return;
  if (s.pumping) {
    s.again = true;
    return;
  }
  s.pumping = true;
  try {
    // Not while the instance moves (lib/instance-read-only.ts): the steps
    // stay queued for the new instance.
    if (await workersPaused()) return;
    do {
      s.again = false;
      await dispatchEvents();
      const workers = (await workflowLimits()).workers;
      const free = workers - s.active;
      if (free <= 0) break;
      const steps = await claimSteps(free);
      for (const step of steps) {
        s.active++;
        const p = executeStep(step)
          .catch((error) => console.error("Workflow step failed", error))
          .finally(() => {
            s.active--;
            s.running.delete(p);
            wake();
          });
        s.running.add(p);
      }
      if (steps.length === free) s.again = true;
    } while (s.again && !s.stopping);
  } catch (error) {
    console.error("Workflow queue", error);
  } finally {
    s.pumping = false;
  }
  await armTimer();
}
// A timer on the next due step or event (waits, backoffs, debounced events).
async function armTimer() {
  const s = state();
  if (s.stopping || !s.started) return;
  const next = await one<{ at: number | null }>(
    "SELECT MIN(at) at FROM (SELECT MIN(due_at) at FROM workflow_steps WHERE status IN ('queued','waiting') UNION ALL SELECT MIN(due_at) at FROM workflow_events WHERE dispatched_at IS NULL) x",
  ).catch(() => undefined);
  if (s.timer) clearTimeout(s.timer);
  s.timer = null;
  if (!next?.at) return;
  const wait = Math.max(50, Math.min(60_000, Number(next.at) - Date.now()));
  s.timer = setTimeout(() => wake(), wait);
  s.timer.unref?.();
}

// Wakes this instance's queue (soon, not inside the caller's transaction).
export function wake() {
  const s = state();
  if (!s.started || s.stopping) return;
  setTimeout(() => void pump(), 0).unref?.();
}
// After a write that queued something: this instance and the others – once
// the caller's transaction has ended (right away without one). Sent before
// the COMMIT, the others would claim before the row is visible, find
// nothing and sleep until their next poll.
export function wakeAfterCommit() {
  afterTransaction(() => {
    const s = state();
    if (s.started) setTimeout(() => void pump(), 0).unref?.();
    publish("workflow:wake", 1);
  });
}

export function startWorkflowWorker() {
  const s = state();
  if (s.started) return;
  s.started = true;
  onBus("workflow:wake", () => wake());
  s.poll = setInterval(() => wake(), Number(process.env.FLOWPLAN_WORKFLOW_POLL_MS) || 5_000);
  s.poll.unref?.();
  s.sweep = setInterval(
    () =>
      void workersPaused()
        .then(async (paused) => {
          if (!paused) await sweepLeases();
        })
        .catch(() => {}),
    Number(process.env.FLOWPLAN_WORKFLOW_SWEEP_MS) || 60_000,
  );
  s.sweep.unref?.();
  onShutdown(() => void stopWorkflowWorker());
  void import("./schedules").then((m) => m.startWorkflowSchedules());
  wake();
}
export async function stopWorkflowWorker() {
  const s = state();
  s.stopping = true;
  for (const t of [s.poll, s.sweep]) if (t) clearInterval(t);
  if (s.timer) clearTimeout(s.timer);
  await releaseLeases().catch(() => {});
}

// Tests and scripts: dispatch events and run steps until nothing is due.
export async function drainWorkflows(options: { workers?: number; maxRounds?: number; now?: () => number } = {}) {
  const workers = options.workers ?? 4;
  let total = 0;
  for (let round = 0; round < (options.maxRounds ?? 1000); round++) {
    const now = options.now?.() ?? Date.now();
    const dispatched = await dispatchEvents(now);
    const steps = await claimSteps(workers, now);
    if (!steps.length && !dispatched) break;
    await Promise.all(steps.map((step) => executeStep(step)));
    total += steps.length;
  }
  return total;
}
