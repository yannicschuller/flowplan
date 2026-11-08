// Retention of workflow data (docs/specs/workflows.md §4.2), daily on the
// leader in batches: finished runs (with their steps and approvals) after
// FLOWPLAN_WORKFLOW_RUN_DAYS, at most FLOWPLAN_WORKFLOW_RUNS_KEPT runs per
// workflow (oldest first; open runs are never deleted), dispatched events
// after a day, undispatched ones after seven (counted). Versions stay as
// long as the page.
import { all, run, sql } from "../db";
import { workflowLimits } from "./limits";

const BATCH = 500;
const FINISHED = "('succeeded','failed','cancelled')";

export async function workflowRetention(now = Date.now()) {
  const limits = await workflowLimits();
  let runs = 0;
  for (;;) {
    const old = await all<{ id: string }>(`SELECT id FROM workflow_runs WHERE status IN ${FINISHED} AND finished_at<? LIMIT ${BATCH}`, now - limits.runDays * 86_400_000);
    if (!old.length) break;
    runs += (await run(`DELETE FROM workflow_runs WHERE id IN ${sql.jsonValues()}`, JSON.stringify(old.map((r) => r.id)))).changes;
    if (old.length < BATCH) break;
  }
  // Per workflow: the newest finished runs within the limit.
  for (const p of await all<{ page_id: string; n: number }>("SELECT page_id,COUNT(*) n FROM workflow_runs GROUP BY page_id HAVING COUNT(*)>?", limits.runsPerWorkflow)) {
    const extra = Number(p.n) - limits.runsPerWorkflow;
    const victims = await all<{ id: string }>(`SELECT id FROM workflow_runs WHERE page_id=? AND status IN ${FINISHED} ORDER BY created_at,seq LIMIT ${Math.min(extra, 10_000)}`, p.page_id);
    if (victims.length) runs += (await run(`DELETE FROM workflow_runs WHERE id IN ${sql.jsonValues()}`, JSON.stringify(victims.map((r) => r.id)))).changes;
  }
  const dispatched = (await run("DELETE FROM workflow_events WHERE dispatched_at IS NOT NULL AND dispatched_at<?", now - 86_400_000)).changes;
  const stale = (await run("DELETE FROM workflow_events WHERE dispatched_at IS NULL AND created_at<?", now - 7 * 86_400_000)).changes;
  return { runs, events: dispatched, undispatched: stale };
}
