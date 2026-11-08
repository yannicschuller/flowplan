// Workflow events (docs/specs/workflows.md §8.2): the outbox written in
// the transaction of the write that caused them, and the dispatcher that
// turns them into runs. Cheap when nobody listens: before anything else one
// indexed lookup in workflow_triggers (which only holds the triggers of
// active versions), remembered for the request (lib/read-memo.ts).
import { all, id, inSavepoint, one, run, sql, transaction } from "../db";
import { memoized } from "../read-memo";
import type { Page } from "../types";
import { currentRun } from "./context";
import { graphOf, startLiveRun, type WorkflowRow } from "./engine";
import { triggerMatches, type WorkflowEvent } from "./nodes/triggers";
import { noteWorkflow } from "./monitoring";
import { wakeAfterCommit } from "./queue";

const EVENT_LEASE_MS = 2 * 60_000;
export const PAGE_CHANGED_DEBOUNCE_MS = 2 * 60_000;
const holder = globalThis as { flowplanWorkflowLookups?: number };
// How many trigger lookups ran (the "≤ 1 index lookup per event" measurement).
export const triggerLookups = () => holder.flowplanWorkflowLookups ?? 0;

// Which of `kinds` have triggers for this scope (or the whole workspace):
// kind → inline ("immediate part") / queued.
export async function workflowListeners(workspaceId: string, kinds: string[], scopeId = ""): Promise<{ inline: Set<string>; queued: Set<string> }> {
  return await memoized(`wf-listen:${workspaceId}:${kinds.join(",")}:${scopeId}`, async () => {
    holder.flowplanWorkflowLookups = (holder.flowplanWorkflowLookups ?? 0) + 1;
    const rows = await all<{ kind: string; inline: number }>(
      `SELECT DISTINCT kind,inline FROM workflow_triggers WHERE workspace_id=? AND kind IN (${kinds.map(() => "?").join(",")}) AND scope_id IN (?,'')`,
      workspaceId,
      ...kinds,
      scopeId,
    );
    const out = { inline: new Set<string>(), queued: new Set<string>() };
    for (const r of rows) (Number(r.inline) ? out.inline : out.queued).add(r.kind);
    return out;
  });
}
export async function listening(workspaceId: string, kinds: string[], scopeId = "", inline = false) {
  const l = await workflowListeners(workspaceId, kinds, scopeId);
  return kinds.some((k) => (inline ? l.inline : l.queued).has(k));
}

export type EmitInput = {
  workspaceId: string;
  scopeId?: string;
  pageId?: string | null;
  rowId?: string | null;
  payload?: Record<string, unknown>;
  actorId?: string | null;
  // Once only per key (a message id, a schedule slot …).
  dedupeKey?: string;
  // Earliest dispatch (debounce).
  dueAt?: number;
  // page.changed: a later change moves the pending event (dedupeKey required).
  debounce?: boolean;
  // The caller looked up the listeners already.
  checked?: boolean;
};
// Writes an event into the outbox (inside the caller's transaction) when a
// workflow listens. The run that caused it, if any, and its depth go with it.
export async function emitWorkflowEvent(kind: string, input: EmitInput): Promise<string | null> {
  if (!input.checked && !(await listening(input.workspaceId, [kind], input.scopeId ?? ""))) return null;
  const origin = currentRun();
  const now = Date.now();
  const eventId = id();
  const columns = "id,workspace_id,kind,scope_id,page_id,row_id,payload,actor_id,origin_run_id,depth,dedupe_key,due_at,created_at";
  const values = [
    eventId,
    input.workspaceId,
    kind,
    input.scopeId ?? "",
    input.pageId ?? null,
    input.rowId ?? null,
    JSON.stringify(input.payload ?? {}).slice(0, 500_000),
    input.actorId ?? null,
    origin?.runId ?? null,
    origin ? origin.depth + 1 : 0,
    input.dedupeKey ?? null,
    input.dueAt ?? now,
    now,
  ];
  const conflict = input.dedupeKey
    ? input.debounce
      ? " ON CONFLICT(dedupe_key) DO UPDATE SET due_at=excluded.due_at,payload=excluded.payload,actor_id=excluded.actor_id WHERE workflow_events.dispatched_at IS NULL"
      : " ON CONFLICT(dedupe_key) DO NOTHING"
    : "";
  await run(`INSERT INTO workflow_events(${columns}) VALUES(${values.map(() => "?").join(",")})${conflict}`, ...values);
  noteWorkflow("events");
  wakeAfterCommit();
  return eventId;
}

type TriggerRow = { page_id: string; node_id: string; version_id: string; kind: string; config: string };

async function claimEvents(now: number, limit = 20) {
  return await all<WorkflowEvent & { due_at: number }>(
    `UPDATE workflow_events SET lease_until=? WHERE id IN (SELECT id FROM workflow_events WHERE dispatched_at IS NULL AND due_at<=? AND lease_until<=? ORDER BY due_at LIMIT ${limit}${sql.skipLocked()}) RETURNING id,workspace_id,kind,scope_id,page_id,row_id,payload,actor_id,origin_run_id,depth,due_at`,
    now + EVENT_LEASE_MS,
    now,
    now,
  );
}

// Turns due events into runs, one transaction per event (§8.2): matching
// triggers, visibility for the person each workflow runs as, cascade and
// rate limits. Returns how many events were dispatched.
export async function dispatchEvents(now = Date.now()) {
  const events = await claimEvents(now);
  let dispatched = 0;
  for (const event of events)
    try {
      if (await transaction(async () => await dispatchOne(event))) dispatched++;
    } catch (error) {
      console.error("Workflow event failed", error);
    }
  if (dispatched) noteWorkflow("dispatched", dispatched);
  return dispatched;
}

async function dispatchOne(event: WorkflowEvent) {
  // Taken once: a second dispatcher (another instance) changes nothing.
  const mine = await run(
    "UPDATE workflow_events SET dispatched_at=?,dedupe_key=CASE WHEN kind='page.changed' THEN NULL ELSE dedupe_key END WHERE id=? AND dispatched_at IS NULL",
    Date.now(),
    event.id,
  );
  if (!mine.changes) return false;
  const payload = JSON.parse(event.payload || "{}") as Record<string, unknown>;
  // Schedules, dates and manual starts are aimed at one trigger.
  const triggers =
    typeof payload.workflow === "string" && typeof payload.node === "string"
      ? await all<TriggerRow>("SELECT page_id,node_id,version_id,kind,config FROM workflow_triggers WHERE page_id=? AND node_id=? AND kind=?", payload.workflow, payload.node, event.kind)
      : await all<TriggerRow>(
          "SELECT page_id,node_id,version_id,kind,config FROM workflow_triggers WHERE workspace_id=? AND kind=? AND scope_id IN (?,'') AND inline=0 ORDER BY page_id,node_id",
          event.workspace_id,
          event.kind,
          event.scope_id,
        );
  const originPage = event.origin_run_id ? (await one<{ page_id: string }>("SELECT page_id FROM workflow_runs WHERE id=?", event.origin_run_id))?.page_id : null;
  for (const t of triggers) {
    const workflow = await one<WorkflowRow>("SELECT * FROM workflows WHERE page_id=?", t.page_id);
    const page = await one<Page>("SELECT * FROM pages WHERE id=?", t.page_id);
    if (!workflow || !page || page.deleted_at || workflow.status !== "active" || workflow.active_version_id !== t.version_id) continue;
    const graph = await graphOf({ id: "", version_id: t.version_id });
    const node = graph?.nodes.find((n) => n.id === t.node_id);
    if (!graph || !node || node.disabled) continue;
    // Mail goes to the one workflow its address names.
    if (event.kind === "mail.received" && payload.workflow !== t.page_id) continue;
    // Own changes do not trigger the own workflow (unless asked to).
    if (originPage === t.page_id && !graph.settings.triggerOnOwnChanges) continue;
    try {
      await inSavepoint(async () => {
        const runner = workflow.runner_id ? ({ id: workflow.runner_id } as never) : null;
        if (!(await triggerMatches(node.type, node.config, event, payload, runner))) return;
        await startLiveRun({ workflow, page, graph, node, event, payload });
      });
    } catch (error) {
      console.error(`Workflow ${t.page_id}: event ${event.kind} failed`, error);
    }
  }
  return true;
}
