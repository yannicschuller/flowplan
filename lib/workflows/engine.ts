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
import { configTexts, innermostLoops, outgoing, parseGraph, type WorkflowGraph, type WorkflowNode } from "./graph";
import { NODE_IMPLS, EXTERNAL_NODES } from "./nodes";
import { personValue, recordValue } from "./nodes/data";
import { triggerOutput, type WorkflowEvent } from "./nodes/triggers";
import { FAR, StepError, type ErrorKind, type NodeResult, type NodeRun } from "./nodes/types";
export { FAR };
import { PlaceholderError, renderText, type RenderScope } from "./placeholders";
import { ValueError } from "./values";
import { withinRun } from "./context";
import { lower, workflowLimits } from "./limits";
import { mayObserve, runnerIdentity, runnerProblem } from "./runner";
import { builtins, flushInline, inlineBatch, walkInline } from "./inline";
import { noteWorkflow } from "./monitoring";
import { pauseWorkflow } from "./store";
import { wakeAfterCommit } from "./queue";
import { checkFailureRate, noteLimit, noteRunFailed } from "./notices";

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
const loopsOf = new Map<WorkflowGraph, Map<string, string>>();
// The innermost For-each of every node in a body (cached per graph).
export function loopOf(graph: WorkflowGraph, nodeId: string) {
  let m = loopsOf.get(graph);
  if (!m) {
    if (loopsOf.size > 500) loopsOf.clear();
    m = innermostLoops(graph);
    loopsOf.set(graph, m);
  }
  return m.get(nodeId);
}
// The options of a test run (kept with its trigger step, like its graph).
async function testOptions(runRow: Pick<RunRow, "id" | "version_id">): Promise<NonNullable<NodeRun["options"]>> {
  if (!runRow.version_id.startsWith("test:")) return {};
  const raw = (await one<{ input: string }>("SELECT s.input FROM workflow_steps s JOIN workflow_runs r ON r.id=s.run_id WHERE s.run_id=? AND s.node_id=r.trigger_node_id", runRow.id))?.input;
  try {
    return (JSON.parse(raw || "{}").options as NodeRun["options"]) || {};
  } catch {
    return {};
  }
}
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
// $item and $index of a step in a For-each body: its innermost loop's
// items (on the loop's step, on this step's path) at the iteration's index.
function loopValues(graph: WorkflowGraph, nodeId: string, iteration: string, values: Record<string, unknown>) {
  const loop = loopOf(graph, nodeId);
  if (!loop || !iteration) return {};
  const index = Number(iteration.split(".").at(-1));
  const state = values[loop] as { items?: unknown[] } | undefined;
  return { $item: state?.items?.[index] ?? null, $index: index };
}
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
    `UPDATE workflow_runs SET status='failed',failed_node_id=?,error=?,error_kind=?,finished_at=? WHERE id=? AND status NOT IN ('succeeded','failed','cancelled')`,
    nodeId,
    message.slice(0, 2000),
    kind,
    Date.now(),
    runId,
  );
  if (!changed.changes) return;
  await run("UPDATE workflow_approvals SET decision='cancelled',decided_at=? WHERE run_id=? AND decision IS NULL", Date.now(), runId);
  noteWorkflow("failed");
  if (r.mode !== "live" || kind === "limit") return;
  await run("UPDATE workflows SET failure_streak=failure_streak+1 WHERE page_id=?", r.page_id);
  const wf = await one<{ failure_streak: number; status: string }>("SELECT failure_streak,status FROM workflows WHERE page_id=?", r.page_id);
  // The person it runs as hears of it (§8.6): the first failure after a
  // success, then at most once an hour with a summary.
  await noteRunFailed(r.page_id, message, wf?.failure_streak === 1);
  if (wf && wf.status === "active" && wf.failure_streak >= 10) {
    await pauseWorkflow(r.page_id, { status: "auto_paused", reason: "10 Läufe in Folge fehlgeschlagen.", by: null });
    return;
  }
  // More than half of the last 20 runs within an hour failed.
  if (wf && wf.status === "active" && (await checkFailureRate(r.page_id)))
    await pauseWorkflow(r.page_id, { status: "auto_paused", reason: "Mehr als die Hälfte der letzten Läufe in einer Stunde ist fehlgeschlagen.", by: null });
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
  // Test runs: the draft graph, kept with the trigger step, and their options.
  testGraph?: WorkflowGraph;
  testOptions?: NodeRun["options"];
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
    s.testGraph ? JSON.stringify({ graph: s.testGraph, ...(s.testOptions ? { options: s.testOptions } : {}) }) : null,
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
    await noteLimit(pageId, "cascade");
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
    await noteLimit(pageId, "throttled");
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
  if ("wait" in result) return await waitStep(step, runRow, result, input);
  if ("loop" in result) return await startLoop(step, runRow, graph, node, result, input);
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
  await afterStep(step, runRow, graph, node, result, port);
}
// What follows a finished step (also an approval decided by a person): the
// successors, the For-each bookkeeping, the end of the run.
export async function afterStep(step: Pick<StepRow, "id" | "iteration" | "via">, runRow: RunRow, graph: WorkflowGraph, node: WorkflowNode, result: NodeResult, port: string) {
  const now = Date.now();
  const loop = loopOf(graph, node.id);
  if ("stop" in result) {
    // In a For-each body a stop ends the iteration, not the run.
    if (loop) await loopProgress(runRow, graph, step, node, -1, "output" in result ? result.output : { stopped: result.stop, message: result.message });
    else if (result.stop === "failed") await failRun(runRow.id, node.id, result.message || "Beendet.", "validation");
    else {
      await cancelOpenSteps(runRow.id);
      await run("UPDATE workflow_runs SET status='succeeded',finished_at=?,error=? WHERE id=? AND status IN ('queued','running','waiting')", now, result.message || null, runRow.id);
    }
    return;
  }
  const n = await enqueueSuccessors(runRow.id, graph, node.id, port, step.id, step.iteration);
  if (loop) await loopProgress(runRow, graph, step, node, n - 1, "output" in result ? result.output : null);
  await finishIfDone(runRow.id, runRow.mode === "live" ? { pageId: runRow.page_id } : null);
}
// A wait or an approval: the step waits, no worker holds it (§8.7).
async function waitStep(step: StepRow, runRow: RunRow, result: { wait: number; state: unknown }, input: string) {
  const state = JSON.stringify(result.state ?? {});
  const done = await run(
    "UPDATE workflow_steps SET status='waiting',due_at=?,input=?,output=?,error=NULL,error_kind=NULL,lease_token=NULL,lease_until=0,claimed_by=NULL WHERE id=? AND lease_token=? AND status='running'",
    Math.round(result.wait),
    input,
    state,
    step.id,
    step.lease_token,
  );
  if (!done.changes) throw new LeaseLost();
  await markWaiting(runRow.id);
}
// The run waits when none of its steps is queued or running.
async function markWaiting(runId: string) {
  await run(
    "UPDATE workflow_runs SET status='waiting' WHERE id=? AND status='running' AND NOT EXISTS(SELECT 1 FROM workflow_steps WHERE run_id=? AND status IN ('queued','running'))",
    runId,
    runId,
  );
}

/* ---------- For each (§8.7) ---------- */

type LoopState = {
  items: unknown[];
  count: number;
  mode: "sequential" | "parallel";
  parallel: number;
  // The next item to start, the open paths per running item, how many ended.
  next: number;
  open: Record<string, number>;
  ended: number;
  results: unknown[];
  warning?: string;
};
const shortResult = (v: unknown) => {
  const t = JSON.stringify(v ?? null);
  return t.length > 4000 ? truncateValue(v) : v;
};
// Starts the iterations a loop may run now; returns the paths started.
async function startIterations(runId: string, graph: WorkflowGraph, loopStep: Pick<StepRow, "id" | "iteration">, loopNode: string, state: LoopState) {
  const prefix = loopStep.iteration ? `${loopStep.iteration}.` : "";
  const edges = outgoing(graph, loopNode, "item");
  const room = state.mode === "parallel" ? state.parallel : 1;
  const now = Date.now();
  while (state.next < state.count && Object.keys(state.open).length < room) {
    const i = state.next++;
    if (!edges.length) {
      state.ended++;
      continue;
    }
    state.open[String(i)] = edges.length;
    for (const edge of edges)
      await run(
        "INSERT INTO workflow_steps(id,run_id,node_id,iteration,via,status,due_at,created_at) VALUES(?,?,?,?,?,'queued',?,?) ON CONFLICT(run_id,node_id,iteration,via) DO NOTHING",
        id(),
        runId,
        edge.to.node,
        `${prefix}${i}`,
        loopStep.id,
        now,
        now,
      );
  }
}
async function startLoop(step: StepRow, runRow: RunRow, graph: WorkflowGraph, node: WorkflowNode, result: { loop: unknown[]; warning?: string }, input: string) {
  const c = node.config as { mode?: "sequential" | "parallel"; parallel?: number };
  const state: LoopState = {
    items: result.loop,
    count: result.loop.length,
    mode: c.mode === "parallel" ? "parallel" : "sequential",
    parallel: Math.max(1, Math.min(5, Number(c.parallel) || 5)),
    next: 0,
    open: {},
    ended: 0,
    results: [],
    ...(result.warning ? { warning: result.warning } : {}),
  };
  await startIterations(runRow.id, graph, step, node.id, state);
  const output = JSON.stringify(state);
  if (output.length > OUTPUT_LIMIT) throw new StepError("Ausgabe zu groß.", "limit");
  const done = await run(
    "UPDATE workflow_steps SET status='waiting',due_at=?,input=?,output=?,open_children=?,error=NULL,error_kind=NULL,lease_token=NULL,lease_until=0,claimed_by=NULL WHERE id=? AND lease_token=? AND status='running'",
    FAR,
    input,
    output,
    Object.values(state.open).reduce((a, b) => a + b, 0),
    step.id,
    step.lease_token,
  );
  if (!done.changes) throw new LeaseLost();
  await run("UPDATE workflow_runs SET steps=steps+1 WHERE id=?", runRow.id);
  if (state.ended >= state.count) await endLoop(runRow, graph, step, node, state);
}
// A step in a loop body finished: `delta` paths more (successors − 1) for
// its item. An item whose paths all ended frees a place for the next; when
// every item ended, the loop goes on through "done".
async function loopProgress(runRow: RunRow, graph: WorkflowGraph, step: Pick<StepRow, "id" | "iteration" | "via">, node: WorkflowNode, delta: number, output: unknown) {
  const loopNode = loopOf(graph, node.id);
  if (!loopNode || !step.iteration) return;
  // The loop's step lies on this step's path.
  let via = step.via;
  let loopStep: { id: string; node_id: string; via: string; iteration: string } | undefined;
  for (let hops = 0; via && hops < 2000; hops++) {
    const s = await one<{ id: string; node_id: string; via: string; iteration: string }>("SELECT id,node_id,via,iteration FROM workflow_steps WHERE id=?", via);
    if (!s) break;
    if (s.node_id === loopNode) {
      loopStep = s;
      break;
    }
    via = s.via;
  }
  if (!loopStep) return;
  // Locked until the commit: parallel items count one after the other.
  await run("UPDATE workflow_steps SET open_children=open_children WHERE id=?", loopStep.id);
  const row = await one<{ status: string; output: string }>("SELECT status,output FROM workflow_steps WHERE id=?", loopStep.id);
  if (!row || row.status !== "waiting") return;
  const state = JSON.parse(row.output) as LoopState;
  const index = step.iteration.split(".").at(-1)!;
  if (output !== null && output !== undefined) state.results[Number(index)] = shortResult(output);
  state.open[index] = (state.open[index] ?? 0) + delta;
  if (state.open[index] <= 0) {
    delete state.open[index];
    state.ended++;
    await startIterations(runRow.id, graph, loopStep, loopNode, state);
  }
  const loopGraphNode = graph.nodes.find((n) => n.id === loopNode)!;
  if (state.ended >= state.count && !Object.keys(state.open).length) return await endLoop(runRow, graph, loopStep, loopGraphNode, state);
  await run("UPDATE workflow_steps SET output=?,open_children=? WHERE id=?", JSON.stringify(state), Object.values(state.open).reduce((a, b) => a + b, 0), loopStep.id);
}
async function endLoop(runRow: RunRow, graph: WorkflowGraph, loopStep: Pick<StepRow, "id" | "iteration" | "via">, node: WorkflowNode, state: LoopState) {
  const output = { count: state.count, results: state.results.slice(0, state.count).map((r) => r ?? null), ...(state.warning ? { warning: state.warning } : {}) };
  let text = JSON.stringify(output);
  if (text.length > OUTPUT_LIMIT) text = JSON.stringify({ count: state.count, results: [], warning: "Ergebnisse zu groß." });
  await run("UPDATE workflow_steps SET status='succeeded',port='done',output=?,open_children=0,finished_at=? WHERE id=? AND status='waiting'", text, Date.now(), loopStep.id);
  await afterStep(loopStep, runRow, graph, node, { port: "done", output: JSON.parse(text) }, "done");
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
  const scope = await scopeFor(info, { ...values, ...loopValues(graph, node.id, step.iteration, values) }, warnings);
  // A step taken up again after it waited: what it stored then.
  // (Waits and approvals store their state with "$wait" in the output.)
  const stored = await one<{ output: string | null }>("SELECT output FROM workflow_steps WHERE id=?", step.id);
  const kept = stored?.output ? (JSON.parse(stored.output) as Record<string, unknown>) : null;
  const resume = kept && kept.$wait ? kept : undefined;
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
      stepId: step.id,
      resume,
      options: runRow.mode === "live" ? {} : await testOptions(runRow),
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
      // Outside a transaction (no long write lock), then finished with the
      // lease check; the lease is renewed every 30 s meanwhile (§8.3).
      const renew = setInterval(() => void run("UPDATE workflow_steps SET lease_until=? WHERE id=? AND lease_token=? AND status='running'", Date.now() + LEASE_MS, step.id, step.lease_token).catch(() => {}), Math.min(30_000, LEASE_MS / 3));
      renew.unref?.();
      let result: NodeResult;
      try {
        result = await withinRun(runContext, () => impl(ctx));
      } finally {
        clearInterval(renew);
      }
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
      // An approval or a loop left by an error: nothing of it stays open.
      await run("UPDATE workflow_approvals SET decision='cancelled',decided_at=? WHERE step_id=? AND decision IS NULL", Date.now(), step.id);
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
