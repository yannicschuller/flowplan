// Counters of the workflow engine for the administration's monitoring
// (docs/specs/workflows.md §9.10, §12): what this instance did since it
// started, and the state of the queue from the database (all instances).
import { one } from "../db";

type Counter = "started" | "succeeded" | "failed" | "throttled" | "cascade" | "claimed" | "leaseLost" | "swept" | "dispatched" | "events";
const holder = globalThis as { flowplanWorkflowCounters?: Record<Counter, number> & { since: number } };
const counters = () =>
  (holder.flowplanWorkflowCounters ??= { since: Date.now(), started: 0, succeeded: 0, failed: 0, throttled: 0, cascade: 0, claimed: 0, leaseLost: 0, swept: 0, dispatched: 0, events: 0 });
export function noteWorkflow(counter: Counter, n = 1) {
  counters()[counter] += n;
}
export const workflowCounters = () => ({ ...counters() });

export async function workflowMonitoring(now = Date.now()) {
  const n = async (sql: string, ...params: (string | number)[]) => Number((await one<{ n: number }>(sql, ...params))?.n || 0);
  const oldest = await one<{ due: number | null }>("SELECT MIN(due_at) due FROM workflow_steps WHERE status='queued' AND due_at<=?", now);
  const lastHour = now - 3_600_000;
  const finished = await n("SELECT COUNT(*) n FROM workflow_runs WHERE finished_at>? AND status IN ('succeeded','failed')", lastHour);
  const failed = await n("SELECT COUNT(*) n FROM workflow_runs WHERE finished_at>? AND status='failed'", lastHour);
  return {
    activeWorkflows: await n("SELECT COUNT(*) n FROM workflows WHERE status='active'"),
    runsPerMinute: await n("SELECT COUNT(*) n FROM workflow_runs WHERE created_at>?", now - 60_000),
    queuedSteps: await n("SELECT COUNT(*) n FROM workflow_steps WHERE status='queued'"),
    runningSteps: await n("SELECT COUNT(*) n FROM workflow_steps WHERE status='running'"),
    waitingSteps: await n("SELECT COUNT(*) n FROM workflow_steps WHERE status='waiting'"),
    oldestDueMs: oldest?.due ? now - Number(oldest.due) : 0,
    undispatchedEvents: await n("SELECT COUNT(*) n FROM workflow_events WHERE dispatched_at IS NULL"),
    failureRate: finished ? failed / finished : 0,
    aiTokensToday: await n("SELECT COALESCE(SUM(tokens),0) n FROM workflow_ai_usage WHERE day=?", new Date(now).toISOString().slice(0, 10)),
    instance: workflowCounters(),
  };
}
