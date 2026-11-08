// The workflow engine (docs/specs/workflows.md §8): runs, their steps, and
// how one step runs – the effect and the step's end in one transaction,
// fenced by the lease token (exactly once for everything inside Flowplan's
// database, §8.5), successors queued in the same transaction (idempotent
// through UNIQUE(run_id,node_id,iteration,via)), the run finished when no
// step is open any more. Retries with backoff for transient errors; the
// node's onError decides what happens after that.
import { all, id, inSavepoint, lockFor, one, run, transaction } from "../db";
import { redactSecrets } from "../ai/redact";
import { recordUrl } from "../notification-events";
import type { Identity, Page } from "../types";
import { userLocale } from "../user-locale";
import type { Locale } from "../i18n";
import { nodeSpec } from "./catalog";
import { configTexts, outgoing, parseGraph, type WorkflowGraph, type WorkflowNode } from "./graph";
import { NODE_IMPLS, EXTERNAL_NODES } from "./nodes";
import { personValue, recordValue } from "./nodes/data";
import { triggerOutput, type WorkflowEvent } from "./nodes/triggers";
import { StepError, type ErrorKind, type NodeResult, type NodeRun } from "./nodes/types";
import { PlaceholderError, renderText, type RenderScope } from "./placeholders";
import { ValueError } from "./values";
import { withinRun } from "./context";
import { lower, workflowLimits } from "./limits";
import { mayObserve, runnerIdentity, runnerProblem } from "./runner";
import { builtins, flushInline, inlineBatch, walkInline } from "./inline";
import { noteWorkflow } from "./monitoring";
import { pauseWorkflow } from "./store";
import { wakeAfterCommit } from "./queue";

// The lease of a claimed step (§8.3); FLOWPLAN_WORKFLOW_LEASE_MS shortens it for tests.
export const LEASE_MS = Number(process.env.FLOWPLAN_WORKFLOW_LEASE_MS) || 2 * 60_000;
const OUTPUT_LIMIT = 256 * 1024;
const OPEN = "('queued','running','waiting')";

export type WorkflowRow = {
  page_id: string;
  workspace_id: string;
  status: "draft" | "active" | "paused" | "auto_paused";
  active_version_id: string | null;
  runner_id: string | null;
  settings: string;
  failure_streak: number;
  throttled: number;
};
export type RunRow = {
  id: string;
  page_id: string;
  workspace_id: string;
  version_id: string;
  runner_id: string | null;
  mode: "live" | "test" | "dry";
  trigger_node_id: string;
  event_id: string | null;
  status: string;
  depth: number;
  origin_run_id: string | null;
  steps: number;
  error: string | null;
};
export type StepRow = {
  id: string;
  run_id: string;
  node_id: string;
  iteration: string;
  via: string;
  status: string;
  attempt: number;
  due_at: number;
  lease_until: number;
  lease_token: string | null;
  claimed_by: string | null;
};
class LeaseLost extends Error {}

/* ---------- Graphs of versions (immutable, so cached) ---------- */

const graphs = new Map<string, WorkflowGraph>();
export async function graphOf(run: Pick<RunRow, "id" | "version_id">): Promise<WorkflowGraph | null> {
  const cached = graphs.get(run.version_id);
  if (cached) return cached;
  let raw: string | undefined;
  // Test runs run the draft as it was: kept with the run's trigger step.
  if (run.version_id.startsWith("test:"))
    raw = (await one<{ input: string }>("SELECT s.input FROM workflow_steps s JOIN workflow_runs r ON r.id=s.run_id WHERE s.run_id=? AND s.node_id=r.trigger_node_id", run.version_id.slice(5)))?.input;
  else raw = (await one<{ graph: string }>("SELECT graph FROM workflow_versions WHERE id=?", run.version_id))?.graph;
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  const graph = parseGraph(parsed.graph ?? parsed);
  if (graphs.size > 500) graphs.clear();
  graphs.set(run.version_id, graph);
  return graph;
}

/* ---------- Errors ---------- */

export function errorKind(error: unknown): ErrorKind {
  if (error instanceof StepError) return error.kind;
  if (error instanceof PlaceholderError || error instanceof ValueError) return "validation";
  const status = (error as { status?: number }).status;
  if (status === 403 || status === 423) return "permission";
  if (status && status >= 400 && status < 500) return "validation";
  return "transient";
}
const errorText = (error: unknown) => redactSecrets(String((error as Error)?.message || error)).slice(0, 2000);
// Backoff (§8.6): 30 s · 2^attempt + up to 20 %, at most an hour; internal
// nodes (database conflicts) retry quickly.
export function backoff(attempt: number, internal: boolean, retryAfterMs?: number) {
  if (retryAfterMs) return Math.min(3_600_000, retryAfterMs);
  const base = (internal ? 1000 : 30_000) * 2 ** attempt;
  return Math.min(3_600_000, Math.round(base * (1 + Math.random() * 0.2)));
}
const defaultRetries = (node: WorkflowNode) => node.onError?.retry ?? (EXTERNAL_NODES.has(node.type) ? 2 : 3);

/* ---------- Scope ---------- */

const truncateValue = (v: unknown): unknown => {
  if (typeof v === "string") return v.length > 2000 ? v.slice(0, 2000) + "…" : v;
  if (Array.isArray(v)) return v.slice(0, 50).map(truncateValue);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).slice(0, 100).map(([k, x]) => [k, truncateValue(x)]));
  return v;
};
// What a node got, shown in the run (placeholders rendered, shortened, §8.9).
function inputPreview(config: Record<string, unknown>, scope: RenderScope, warnings: string[]) {
  const render = (v: unknown): unknown => {
    if (typeof v === "string" && v.includes("{{"))
      try {
        return renderText(v, { ...scope, warn: undefined });
      } catch {
        return v;
      }
    if (Array.isArray(v)) return v.map(render);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, render(x)]));
    return v;
  };
  let text = JSON.stringify({ config: truncateValue(render(config)), ...(warnings.length ? { warnings } : {}) });
  if (text.length > 32_000) text = JSON.stringify({ config: "…", ...(warnings.length ? { warnings } : {}) });
  return text;
}

type RunInfo = { id: string; page: Page; workspaceId: string; mode: RunRow["mode"]; depth: number; triggerNodeId: string; runner: Identity | null; graph: WorkflowGraph };
async function scopeFor(info: RunInfo, values: Record<string, unknown>, warnings: string[]): Promise<RenderScope> {
  const tz = info.graph.settings.timeZone || "UTC";
  const locale = (info.graph.settings.locale as Locale | undefined) || (info.runner ? await userLocale(info.runner.id) : "de");
  return {
    values: {
      ...values,
      $trigger: values[info.triggerNodeId],
      $run: { id: info.id, url: `${recordUrl(info.page.id)}&run=${info.id}`, mode: info.mode },
      $workflow: { id: info.page.id, title: info.page.title, url: recordUrl(info.page.id) },
      $runner: info.runner ? await personValue(info.runner.id, info.workspaceId) : null,
      ...builtins(tz),
    },
    timeZone: tz,
    locale,
    warn: (m) => warnings.length < 20 && warnings.push(m),
  };
}
// The outputs of the steps on this step's path (via pointers back to the
// trigger): a node on another branch has no value here (§7.1).
async function pathValues(runId: string, via: string) {
  const steps = await all<{ id: string; node_id: string; via: string; output: string | null; status: string }>(
    "SELECT id,node_id,via,output,status FROM workflow_steps WHERE run_id=?",
    runId,
  );
  const byId = new Map(steps.map((s) => [s.id, s]));
  const values: Record<string, unknown> = {};
  const seen = new Set<string>();
  let current = byId.get(via);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.output && !(current.node_id in values)) values[current.node_id] = JSON.parse(current.output);
    current = byId.get(current.via);
  }
  return values;
}

/* ---------- Runs ---------- */

// Queues the nodes behind a port (one instance per arrival, §5.1).
async function enqueueSuccessors(runId: string, graph: WorkflowGraph, nodeId: string, port: string, stepId: string, iteration: string) {
  const now = Date.now();
  let n = 0;
  for (const edge of outgoing(graph, nodeId, port)) {
    await run(
      "INSERT INTO workflow_steps(id,run_id,node_id,iteration,via,status,due_at,created_at) VALUES(?,?,?,?,?,'queued',?,?) ON CONFLICT(run_id,node_id,iteration,via) DO NOTHING",
      id(),
      runId,
      edge.to.node,
      iteration,
      stepId,
      now,
      now,
    );
    n++;
  }
  return n;
}
// Ends the run when nothing is open any more (inside the step's transaction;
// the run row is locked first, so two branches ending together see each other).
async function finishIfDone(runId: string, live: { pageId: string } | null) {
  await run("UPDATE workflow_runs SET steps=steps WHERE id=?", runId);
  const open = await one<{ n: number }>(`SELECT COUNT(*) n FROM workflow_steps WHERE run_id=? AND status IN ${OPEN}`, runId);
  if (Number(open?.n || 0)) return false;
  const changed = await run(`UPDATE workflow_runs SET status='succeeded',finished_at=? WHERE id=? AND status IN ('queued','running','waiting')`, Date.now(), runId);
  if (changed.changes && live) await run("UPDATE workflows SET failure_streak=0 WHERE page_id=? AND failure_streak>0", live.pageId);
  if (changed.changes) noteWorkflow("succeeded");
  return true;
}
async function cancelOpenSteps(runId: string, except?: string) {
  await run(`UPDATE workflow_steps SET status='cancelled',finished_at=?,lease_token=NULL WHERE run_id=? AND status IN ${OPEN}${except ? " AND id<>?" : ""}`, Date.now(), runId, ...(except ? [except] : []));
}
// The run fails (§8.6): open steps are cancelled; ten failed live runs in a
// row pause the workflow (limit errors do not count).
export async function failRun(runId: string, nodeId: string | null, message: string, kind: ErrorKind, exceptStep?: string) {
  const r = await one<RunRow>("SELECT * FROM workflow_runs WHERE id=?", runId);
  if (!r) return;
  await cancelOpenSteps(runId, exceptStep);
  const changed = await run(
    `UPDATE workflow_runs SET status='failed',failed_node_id=?,error=?,finished_at=? WHERE id=? AND status NOT IN ('succeeded','failed','cancelled')`,
    nodeId,
    message.slice(0, 2000),
    Date.now(),
    runId,
  );
  if (!changed.changes) return;
  noteWorkflow("failed");
  if (r.mode !== "live" || kind === "limit") return;
  await run("UPDATE workflows SET failure_streak=failure_streak+1 WHERE page_id=?", r.page_id);
  const wf = await one<{ failure_streak: number; status: string }>("SELECT failure_streak,status FROM workflows WHERE page_id=?", r.page_id);
  if (wf && wf.status === "active" && wf.failure_streak >= 10) {
    await pauseWorkflow(r.page_id, { status: "auto_paused", reason: "10 Läufe in Folge fehlgeschlagen.", by: null });
  }
}

export type StartRun = {
  workflow: Pick<WorkflowRow, "page_id" | "workspace_id" | "runner_id"> & { settings?: string };
  page: Page;
  versionId: string;
  graph: WorkflowGraph;
  triggerNode: WorkflowNode;
  triggerValue: unknown;
  mode: RunRow["mode"];
  runnerId: string | null;
  eventId?: string | null;
  depth?: number;
  originRunId?: string | null;
  // Test runs: the draft graph, kept with the trigger step.
  testGraph?: WorkflowGraph;
  // The immediate part queues the successors itself.
  noSuccessors?: boolean;
};
// Creates a run with its trigger step done and the next steps queued.
export async function createRun(s: StartRun): Promise<string> {
  const runId = id();
  const now = Date.now();
  const versionId = s.testGraph ? `test:${runId}` : s.versionId;
  await run(
    "INSERT INTO workflow_runs(id,page_id,workspace_id,version_id,runner_id,mode,trigger_node_id,event_id,status,depth,origin_run_id,steps,created_at,started_at) VALUES(?,?,?,?,?,?,?,?,'running',?,?,1,?,?)",
    runId,
    s.page.id,
    s.workflow.workspace_id,
    versionId,
    s.runnerId,
    s.mode,
    s.triggerNode.id,
    s.eventId ?? null,
    s.depth ?? 0,
    s.originRunId ?? null,
    now,
    now,
  );
  const stepId = id();
  const output = JSON.stringify(s.triggerValue ?? {});
  if (output.length > OUTPUT_LIMIT) throw new StepError("Ausgabe zu groß.", "limit");
  await run(
    "INSERT INTO workflow_steps(id,run_id,node_id,iteration,via,status,due_at,port,input,output,started_at,finished_at,created_at) VALUES(?,?,?,'','','succeeded',?,'out',?,?,?,?,?)",
    stepId,
    runId,
    s.triggerNode.id,
    now,
    s.testGraph ? JSON.stringify({ graph: s.testGraph }) : null,
    output,
    now,
    now,
    now,
  );
  if (s.testGraph) graphs.set(versionId, s.testGraph);
  noteWorkflow("started");
  if (!s.noSuccessors && !(await enqueueSuccessors(runId, s.graph, s.triggerNode.id, "out", stepId, ""))) await finishIfDone(runId, s.mode === "live" ? { pageId: s.page.id } : null);
  if (s.mode === "live") {
    // The last real event of each trigger, shortened, for test runs (§4.1).
    const wf = await one<{ last_events: string }>("SELECT last_events FROM workflows WHERE page_id=?", s.page.id);
    const last = JSON.parse(wf?.last_events || "{}") as Record<string, unknown>;
    last[s.triggerNode.id] = { at: now, runId, output: output.length > 20_000 ? null : s.triggerValue };
    await run("UPDATE workflows SET last_events=? WHERE page_id=?", JSON.stringify(last), s.page.id);
  }
  return runId;
}

// The limits a live run must pass before it starts (§8.8): cascade depth,
// runs per minute of the workflow and the workspace. Counted under a lock
// per workflow (an advisory lock on PostgreSQL).
export async function admitLiveRun(pageId: string, workspaceId: string, graph: WorkflowGraph, depth: number): Promise<"ok" | "cascade" | "throttled"> {
  const limits = await workflowLimits();
  if (depth > limits.cascadeDepth) {
    noteWorkflow("cascade");
    return "cascade";
  }
  await lockFor(`wf-rate:${pageId}`);
  const since = Date.now() - 60_000;
  const perMinute = lower(limits.runsPerMinute, graph.settings.limits?.runsPerMinute);
  const mine = await one<{ n: number }>("SELECT COUNT(*) n FROM workflow_runs WHERE page_id=? AND created_at>? AND mode='live'", pageId, since);
  const all_ = await one<{ n: number }>("SELECT COUNT(*) n FROM workflow_runs WHERE workspace_id=? AND created_at>? AND mode='live'", workspaceId, since);
  if (Number(mine?.n || 0) >= perMinute || Number(all_?.n || 0) >= limits.workspaceRunsPerMinute) {
    await run("UPDATE workflows SET throttled=throttled+1 WHERE page_id=?", pageId);
    noteWorkflow("throttled");
    return "throttled";
  }
  return "ok";
}

// A live run from an event (the dispatcher, the immediate part, manual
// starts): the person it runs as must still be allowed (else the workflow
// pauses) and see what the event is about.
export async function startLiveRun(input: {
  workflow: WorkflowRow;
  page: Page;
  graph: WorkflowGraph;
  node: WorkflowNode;
  event: Pick<WorkflowEvent, "id" | "workspace_id" | "page_id" | "row_id" | "actor_id" | "depth" | "origin_run_id">;
  payload: Record<string, unknown>;
  // Checked by the caller already (manual starts check their own rights).
  skipObserve?: boolean;
}): Promise<string | null> {
  const runner = await runnerIdentity(input.workflow.runner_id);
  const problem = await runnerProblem(input.page, runner);
  if (problem) {
    await pauseWorkflow(input.page.id, { status: "paused", reason: problem, by: null });
    return null;
  }
  if (!input.skipObserve && !(await mayObserve(runner, input.event.page_id, input.event.row_id))) return null;
  if ((await admitLiveRun(input.page.id, input.workflow.workspace_id, input.graph, input.event.depth)) !== "ok") return null;
  const triggerValue = await triggerOutput(input.node.type, input.event, input.payload, runner);
  return await createRun({
    workflow: input.workflow,
    page: input.page,
    versionId: input.workflow.active_version_id!,
    graph: input.graph,
    triggerNode: input.node,
    triggerValue,
    mode: "live",
    runnerId: runner!.id,
    eventId: input.event.id || null,
    depth: input.event.depth,
    originRunId: input.event.origin_run_id,
  });
}

// A workflow's immediate part (lib/workflows/inline.ts): the run is created
// in the write's transaction, its inline nodes run right away (in a
// savepoint: a failing node undoes only this workflow's part), the first
// other node is queued.
export async function startInlineRun(input: {
  trigger: { page_id: string; version_id: string; runner_id: string | null };
  graph: WorkflowGraph;
  node: WorkflowNode;
  event: WorkflowEvent;
  payload: Record<string, unknown>;
  actor: Identity | null;
  record: { page: Page; rowId: string };
}): Promise<boolean> {
  const workflow = await one<WorkflowRow>("SELECT * FROM workflows WHERE page_id=?", input.trigger.page_id);
  const page = await one<Page>("SELECT * FROM pages WHERE id=?", input.trigger.page_id);
  if (!workflow || !page) return false;
  const runner = await runnerIdentity(workflow.runner_id);
  const problem = await runnerProblem(page, runner);
  if (problem) {
    await pauseWorkflow(page.id, { status: "paused", reason: problem, by: null });
    return false;
  }
  if (!(await mayObserve(runner, input.record.page.id, input.record.rowId))) return false;
  if ((await admitLiveRun(page.id, workflow.workspace_id, input.graph, input.event.depth)) !== "ok") return false;
  const triggerValue = await triggerOutput(input.node.type, input.event, input.payload, runner);
  const runId = await createRunWithoutSuccessors({ workflow, page, graph: input.graph, node: input.node, triggerValue, runner: runner!, event: input.event });
  const triggerStep = (await one<{ id: string }>("SELECT id FROM workflow_steps WHERE run_id=? AND node_id=?", runId, input.node.id))!.id;
  const info: RunInfo = { id: runId, page, workspaceId: workflow.workspace_id, mode: "live", depth: input.event.depth, triggerNodeId: input.node.id, runner, graph: input.graph };
  const warnings: string[] = [];
  const values: Record<string, unknown> = { [input.node.id]: triggerValue };
  const scope = await scopeFor(info, values, warnings);
  const batch = await inlineBatch(input.record.page, input.record.rowId);
  if (!batch) return false;
  const stepOf = new Map<string, string>([[input.node.id, triggerStep]]);
  const now = Date.now();
  let outcome: Awaited<ReturnType<typeof walkInline>> | null = null;
  try {
    await inSavepoint(async () => {
      outcome = await withinRun({ runId, pageId: page.id, depth: input.event.depth, mode: "live" }, () =>
        walkInline({
          graph: input.graph,
          triggerNode: input.node,
          triggerValue,
          values: scope.values,
          batch,
          base: {
            scope,
            runner,
            actor: input.actor,
            run: { id: runId, pageId: page.id, workspaceId: workflow.workspace_id, mode: "live", depth: input.event.depth, triggerNodeId: input.node.id },
            workflowPage: page,
            trigger: { pageId: input.record.page.id, rowId: input.record.rowId },
            inline: batch,
            warn: scope.warn!,
          },
        }),
      );
      if (outcome!.failure) throw outcome!.failure;
      await flushInline(batch, runner);
    });
  } catch (error) {
    const failure = (outcome as Awaited<ReturnType<typeof walkInline>> | null)?.failure;
    const message = errorText(failure?.error ?? error);
    const nodeId = failure?.node.id ?? null;
    if (failure)
      await run(
        "INSERT INTO workflow_steps(id,run_id,node_id,iteration,via,status,due_at,error,error_kind,started_at,finished_at,created_at) VALUES(?,?,?,'',?,'failed',?,?,?,?,?,?)",
        id(),
        runId,
        failure.node.id,
        stepOf.get(failure.via) || triggerStep,
        now,
        message,
        errorKind(failure.error),
        now,
        now,
        now,
      );
    await failRun(runId, nodeId, message, failure ? errorKind(failure.error) : "transient");
    return true;
  }
  const o = outcome!;
  for (const r of o.ran) {
    const sid = id();
    stepOf.set(r.node.id, sid);
    await run(
      "INSERT INTO workflow_steps(id,run_id,node_id,iteration,via,status,due_at,port,input,output,started_at,finished_at,created_at) VALUES(?,?,?,'',?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id,node_id,iteration,via) DO NOTHING",
      sid,
      runId,
      r.node.id,
      stepOf.get(r.via) || triggerStep,
      r.node.disabled ? "skipped" : "succeeded",
      now,
      r.port,
      inputPreview(r.node.config, scope, warnings),
      JSON.stringify(r.output ?? {}),
      now,
      now,
      now,
    );
  }
  await run("UPDATE workflow_runs SET steps=steps+? WHERE id=?", o.ran.length, runId);
  if (o.stopped) {
    if (o.stopped.result === "failed") await failRun(runId, null, o.stopped.message || "Beendet.", "validation");
    else {
      await cancelOpenSteps(runId);
      await run("UPDATE workflow_runs SET status='succeeded',finished_at=?,error=? WHERE id=? AND status='running'", Date.now(), o.stopped.message || null, runId);
    }
    return true;
  }
  for (const q of o.queued)
    await run(
      "INSERT INTO workflow_steps(id,run_id,node_id,iteration,via,status,due_at,created_at) VALUES(?,?,?,'',?,'queued',?,?) ON CONFLICT(run_id,node_id,iteration,via) DO NOTHING",
      id(),
      runId,
      q.node.id,
      stepOf.get(q.via) || triggerStep,
      now,
      now,
    );
  if (!o.queued.length) await finishIfDone(runId, { pageId: page.id });
  else wakeAfterCommit();
  return true;
}
async function createRunWithoutSuccessors(s: { workflow: WorkflowRow; page: Page; graph: WorkflowGraph; node: WorkflowNode; triggerValue: unknown; runner: Identity; event: WorkflowEvent }) {
  return await createRun({
    workflow: s.workflow,
    page: s.page,
    versionId: s.workflow.active_version_id!,
    graph: s.graph,
    triggerNode: s.node,
    triggerValue: s.triggerValue,
    mode: "live",
    runnerId: s.runner.id,
    depth: s.event.depth,
    originRunId: s.event.origin_run_id,
    noSuccessors: true,
  });
}

/* ---------- One step ---------- */

// Checks the step still belongs to this claim and renews its lease; locks
// the step row until the commit (PostgreSQL). Throws LeaseLost otherwise.
async function fence(step: StepRow, leaseMs = LEASE_MS) {
  const ok = await run("UPDATE workflow_steps SET lease_until=? WHERE id=? AND lease_token=? AND status='running'", Date.now() + leaseMs, step.id, step.lease_token);
  if (!ok.changes) throw new LeaseLost();
}
async function completeStep(step: StepRow, runRow: RunRow, graph: WorkflowGraph, node: WorkflowNode, result: NodeResult, input: string, status: "succeeded" | "skipped" = "succeeded") {
  const now = Date.now();
  const output = JSON.stringify(("output" in result ? result.output : null) ?? {});
  if (output.length > OUTPUT_LIMIT) throw new StepError("Ausgabe zu groß.", "limit");
  const port = "port" in result ? result.port : "";
  const done = await run(
    "UPDATE workflow_steps SET status=?,port=?,input=?,output=?,error=NULL,error_kind=NULL,finished_at=?,lease_token=NULL,lease_until=0 WHERE id=? AND lease_token=? AND status='running'",
    status,
    port,
    input,
    output,
    now,
    step.id,
    step.lease_token,
  );
  if (!done.changes) throw new LeaseLost();
  await run("UPDATE workflow_runs SET steps=steps+1 WHERE id=?", runRow.id);
  if ("stop" in result) {
    if (result.stop === "failed") await failRun(runRow.id, node.id, result.message || "Beendet.", "validation");
    else {
      await cancelOpenSteps(runRow.id);
      await run("UPDATE workflow_runs SET status='succeeded',finished_at=?,error=? WHERE id=? AND status IN ('queued','running','waiting')", now, result.message || null, runRow.id);
    }
    return;
  }
  await enqueueSuccessors(runRow.id, graph, node.id, port, step.id, step.iteration);
  await finishIfDone(runRow.id, runRow.mode === "live" ? { pageId: runRow.page_id } : null);
}
// Puts a claimed step back (paused workflow, held run): no attempt used.
async function release(step: StepRow) {
  await run("UPDATE workflow_steps SET status='queued',lease_token=NULL,lease_until=0,claimed_by=NULL WHERE id=? AND lease_token=? AND status='running'", step.id, step.lease_token);
}

// Runs one claimed step to its end (lib/workflows/queue.ts claims it).
export async function executeStep(step: StepRow): Promise<void> {
  const runRow = await one<RunRow>("SELECT * FROM workflow_runs WHERE id=?", step.run_id);
  if (!runRow || ["succeeded", "failed", "cancelled"].includes(runRow.status)) {
    await run("UPDATE workflow_steps SET status='cancelled',finished_at=?,lease_token=NULL WHERE id=? AND lease_token=?", Date.now(), step.id, step.lease_token);
    return;
  }
  if (runRow.status === "held") return await release(step);
  const page = await one<Page>("SELECT * FROM pages WHERE id=?", runRow.page_id);
  const workflow = await one<WorkflowRow>("SELECT * FROM workflows WHERE page_id=?", runRow.page_id);
  if (!page || !workflow) return;
  if (runRow.mode === "live" && (workflow.status !== "active" || page.deleted_at)) {
    await transaction(async () => {
      await run(`UPDATE workflow_runs SET status='held' WHERE id=? AND status IN ${OPEN}`, runRow.id);
      await release(step);
    });
    return;
  }
  const graph = await graphOf(runRow);
  const node = graph?.nodes.find((n) => n.id === step.node_id);
  if (!graph || !node) {
    await transaction(async () => failRun(runRow.id, step.node_id, "Knoten oder Version nicht gefunden.", "validation"));
    return;
  }
  // Who it runs as, checked before every step (§8.10); test runs as the tester.
  const runner = await runnerIdentity(runRow.mode === "live" ? workflow.runner_id : runRow.runner_id);
  if (runRow.mode === "live") {
    const problem = await runnerProblem(page, runner);
    if (problem) {
        await transaction(async () => {
        await pauseWorkflow(page.id, { status: "paused", reason: problem, by: null });
        await release(step);
      });
      return;
    }
  } else if (!runner) {
    await transaction(async () => failRun(runRow.id, node.id, "Die testende Person gibt es nicht mehr.", "permission"));
    return;
  }
  const limits = await workflowLimits();
  if (runRow.steps >= lower(limits.stepsPerRun, graph.settings.limits?.stepsPerRun)) {
    await transaction(async () => {
      await run("UPDATE workflow_steps SET status='failed',error=?,error_kind='limit',finished_at=?,lease_token=NULL WHERE id=? AND lease_token=?", "Schrittgrenze erreicht.", Date.now(), step.id, step.lease_token);
      await failRun(runRow.id, node.id, "Schrittgrenze erreicht.", "limit");
    });
    return;
  }
  const info: RunInfo = { id: runRow.id, page, workspaceId: runRow.workspace_id, mode: runRow.mode, depth: runRow.depth, triggerNodeId: runRow.trigger_node_id, runner, graph };
  const warnings: string[] = [];
  const values = await pathValues(runRow.id, step.via);
  const scope = await scopeFor(info, values, warnings);
  const triggerValue = values[runRow.trigger_node_id] as { record?: { id?: string; database?: { id: string } }; page?: { id?: string } } | undefined;
  const trigger = {
    pageId: triggerValue?.record?.database?.id ?? triggerValue?.page?.id ?? null,
    rowId: triggerValue?.record?.id ?? null,
  };
  const actorId = (triggerValue as { actor?: { id?: string }; startedBy?: { id?: string } } | undefined)?.actor?.id ?? (triggerValue as { startedBy?: { id?: string } })?.startedBy?.id;
  const actor = actorId ? await runnerIdentity(actorId) : null;
  const spec = nodeSpec(node.type);
  const impl = NODE_IMPLS[node.type];
  try {
    if (!spec || !impl) throw new StepError(`Knotentyp ${node.type} ist hier nicht verfügbar.`, "validation");
    const parsedConfig = spec.config.safeParse(node.config);
    if (!parsedConfig.success) throw new StepError("Ungültige Einstellungen.", "validation");
    const ctx: NodeRun = {
      graph,
      node,
      config: parsedConfig.data as Record<string, unknown>,
      scope,
      runner,
      actor,
      run: { id: runRow.id, pageId: page.id, workspaceId: runRow.workspace_id, mode: runRow.mode, depth: runRow.depth, triggerNodeId: runRow.trigger_node_id },
      workflowPage: page,
      trigger,
      warn: scope.warn!,
      attempt: step.attempt,
      iteration: step.iteration,
    };
    const runContext = { runId: runRow.id, pageId: page.id, depth: runRow.depth, mode: runRow.mode };
    if (node.disabled) {
      await transaction(async () => {
        await fence(step);
        await completeStep(step, runRow, graph, node, { port: "out", output: {} }, inputPreview(node.config, scope, warnings), "skipped");
      });
      return;
    }
    if (EXTERNAL_NODES.has(node.type)) {
      // Outside a transaction (no long write lock), then finished with the lease check.
      const result = await withinRun(runContext, () => impl(ctx));
      await transaction(async () => {
        await fence(step);
        await completeStep(step, runRow, graph, node, result, inputPreview(node.config, scope, warnings));
      });
    } else
      await transaction(async () => {
        await fence(step);
        const result = await withinRun(runContext, () => impl(ctx));
        await completeStep(step, runRow, graph, node, result, inputPreview(node.config, scope, warnings));
      });
  } catch (error) {
    if (error instanceof LeaseLost) return;
    await handleFailure(step, runRow, graph, node, error, inputPreview(node.config, scope, warnings)).catch((e) => {
      if (!(e instanceof LeaseLost)) throw e;
    });
  }
}

async function handleFailure(step: StepRow, runRow: RunRow, graph: WorkflowGraph, node: WorkflowNode, error: unknown, input: string) {
  const kind = errorKind(error);
  const message = errorText(error);
  const retries = defaultRetries(node);
  await transaction(async () => {
    await fence(step);
    if (kind === "transient" && step.attempt < retries) {
      await run(
        "UPDATE workflow_steps SET status='queued',attempt=attempt+1,due_at=?,lease_token=NULL,lease_until=0,claimed_by=NULL,error=?,error_kind=? WHERE id=?",
        Date.now() + backoff(step.attempt, !EXTERNAL_NODES.has(node.type), (error as StepError).retryAfterMs),
        message,
        kind,
        step.id,
      );
      return;
    }
    const then = node.onError?.then ?? "fail";
    if (then === "port" || then === "continue") {
      await completeStep(step, runRow, graph, node, then === "port" ? { port: "error", output: { error: message, kind } } : { port: "out", output: {} }, input);
      await run("UPDATE workflow_steps SET error=?,error_kind=? WHERE id=?", message, kind, step.id);
      return;
    }
    await run("UPDATE workflow_steps SET status='failed',input=?,error=?,error_kind=?,finished_at=?,lease_token=NULL,lease_until=0 WHERE id=?", input, message, kind, Date.now(), step.id);
    await failRun(runRow.id, node.id, message, kind, step.id);
  });
}

/* ---------- Pause, hold, cancel ---------- */

export async function holdRuns(pageId: string) {
  await run(`UPDATE workflow_runs SET status='held' WHERE page_id=? AND mode='live' AND status IN ${OPEN}`, pageId);
}
export async function resumeRuns(pageId: string) {
  await run("UPDATE workflow_runs SET status='running' WHERE page_id=? AND status='held'", pageId);
}
export async function cancelRun(runId: string) {
  await cancelOpenSteps(runId);
  const changed = await run("UPDATE workflow_runs SET status='cancelled',finished_at=? WHERE id=? AND status NOT IN ('succeeded','failed','cancelled')", Date.now(), runId);
  await run("UPDATE workflow_approvals SET decision='cancelled',decided_at=? WHERE run_id=? AND decision IS NULL", Date.now(), runId);
  return !!changed.changes;
}
export async function cancelOpenRuns(pageId: string) {
  for (const r of await all<{ id: string }>(`SELECT id FROM workflow_runs WHERE page_id=? AND status IN ('queued','running','waiting','held')`, pageId)) await cancelRun(r.id);
}

// A record's output as the run sees it (for test runs and the API).
export { recordValue, configTexts };
