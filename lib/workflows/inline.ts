// The immediate part (docs/specs/workflows.md §2): what a graph reaches
// from a record trigger through nodes that can run inline runs right away,
// inside the transaction of the write – the database rules entirely (each
// is a small graph, automationToGraph), workflows up to their first other
// node, where a run is created and its next step queued (the rest runs in
// the background, lib/workflows/engine.ts).
//
// Writes on the triggering record are collected and made in one update at
// the end; they cause no further rules or immediate parts (no loops).
import { all, nowText, one, run } from "../db";
import { cellText } from "../cell-text";
import { computedCells } from "../database";
import { databaseSettings } from "../database-settings";
import { doneRule, type Automation } from "../database-settings-schema";
import type { Field, Identity, Page, Row } from "../types";
import { userLocale } from "../user-locale";
import { recordStatusChange } from "../automations";
import { nodeSpec, RECORD_TRIGGERS } from "./catalog";
import { nodeMap, outgoing, parseGraph, type WorkflowGraph, type WorkflowNode } from "./graph";
import { automationToGraph } from "./legacy";
import { NODE_IMPLS } from "./nodes";
import { personValue, recordValue } from "./nodes/data";
import { applyTemplateOnce } from "./nodes/records";
import { triggerMatches, triggerOutput } from "./nodes/triggers";
import type { InlineBatch, NodeRun } from "./nodes/types";
import { currentRun } from "./context";
import { recordEventKinds } from "./hooks";
import { workflowListeners } from "./events";
import { startInlineRun } from "./engine";
import type { RenderScope } from "./placeholders";

type Cells = Record<string, unknown>;
export type RecordEvent = "created" | "form" | "updated" | "overdue";
const text = (v: unknown) => (typeof v === "boolean" ? String(v) : cellText(v));

// Whether a node runs inline here: inline-capable, and record actions only
// on the triggering record.
export function runsInline(node: WorkflowNode) {
  const s = nodeSpec(node.type);
  if (!s?.inline) return false;
  if (node.type === "action.record.update" || node.type === "action.record.template") return !String(node.config.record || "").trim();
  return true;
}

// The rules' trigger check (lib/automations.ts triggered(), unchanged).
function ruleTriggered(a: Automation, event: RecordEvent, before: Cells | null, after: Cells, fields: Field[]) {
  const t = a.trigger;
  if (t.type === "created") return event === "created" || event === "form";
  if (t.type === "form") return event === "form";
  if (t.type === "overdue") return event === "overdue";
  if (t.type === "schedule") return false;
  if (event !== "updated" || !before) return false;
  const field = fields.find((f) => f.id === t.field);
  if (!field || text(before[field.id]) === text(after[field.id])) return false;
  return !t.to || text(after[field.id]) === t.to;
}

// A node of the immediate part failed (the workflow's run records it).
export class InlineFailure extends Error {
  constructor(readonly node: WorkflowNode, readonly error: Error, readonly via: string) {
    super(error.message);
  }
}
type Walk = {
  graph: WorkflowGraph;
  base: Omit<NodeRun, "node" | "config" | "graph" | "iteration" | "attempt">;
  values: Record<string, unknown>;
  // A node that cannot run inline: queued (workflows), or an error (rules never have one).
  queue?: (node: WorkflowNode, viaNode: string) => void;
  // Each node that ran (workflows record them as steps).
  record?: (node: WorkflowNode, port: string, output: unknown, viaNode: string) => void;
};
// Runs the nodes behind `fromNode`'s port, depth first in edge order (the
// rules' actions run in their order).
async function walk(w: Walk, fromNode: string, port: string): Promise<{ stopped?: { result: string; message: string } }> {
  const nodes = nodeMap(w.graph);
  for (const edge of outgoing(w.graph, fromNode, port)) {
    const node = nodes.get(edge.to.node);
    if (!node) continue;
    if (!runsInline(node)) {
      w.queue?.(node, fromNode);
      continue;
    }
    if (node.disabled) {
      w.record?.(node, "out", {}, fromNode);
      const r = await walk(w, node.id, "out");
      if (r.stopped) return r;
      continue;
    }
    const spec = nodeSpec(node.type)!;
    let result;
    try {
      const ctx: NodeRun = { ...w.base, graph: w.graph, node, config: spec.config.parse(node.config) as Record<string, unknown>, iteration: "", attempt: 0 };
      result = await NODE_IMPLS[node.type](ctx);
    } catch (error) {
      if (error instanceof InlineFailure) throw error;
      throw new InlineFailure(node, error as Error, fromNode);
    }
    if ("stop" in result) {
      w.record?.(node, "", result.output ?? { message: result.message }, fromNode);
      return { stopped: { result: result.stop, message: result.message } };
    }
    // Inline nodes never wait or loop.
    if (!("port" in result)) throw new InlineFailure(node, new Error("Dieser Knoten kann nicht im Sofortteil laufen."), fromNode);
    w.values[node.id] = result.output;
    w.record?.(node, result.port, result.output, fromNode);
    const r = await walk(w, node.id, result.port);
    if (r.stopped) return r;
  }
  return {};
}

// Loads the record and makes the batch the immediate part writes into.
async function batchFor(page: Page, rowId: string): Promise<InlineBatch | null> {
  const raw = await one<Row & { cells: string }>("SELECT * FROM rows WHERE id=? AND page_id=?", rowId, page.id);
  if (!raw) return null;
  const row: Row = { ...raw, cells: JSON.parse(raw.cells) };
  const fields = JSON.parse((await one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", page.id))!.fields) as Field[];
  return { databasePage: page, rowId, fields, row: { id: row.id, created_by: row.created_by || null, cells: row.cells }, cells: computedCells(row, fields), patch: {}, setBy: {}, templates: [] };
}
// The collected writes: one update, the status history, then the templates
// (they see the values just set).
async function flush(batch: InlineBatch, actor: Identity | null) {
  if (Object.keys(batch.patch).length) {
    const settings = await databaseSettings(batch.databasePage.id);
    await run("UPDATE rows SET cells=?,version=version+1,updated_at=? WHERE id=?", JSON.stringify({ ...batch.row.cells, ...batch.patch }), nowText(), batch.rowId);
    // Who set the done rule's field counts (a rule's creator, a workflow's runner).
    const status = doneRule(batch.fields, settings)?.field.id;
    const by = status && status in batch.setBy ? batch.setBy[status] : null;
    await recordStatusChange(batch.databasePage.id, batch.rowId, batch.fields, settings, batch.row.cells, { ...batch.row.cells, ...batch.patch }, by);
  }
  for (const t of batch.templates) await applyTemplateOnce(batch.databasePage, batch.rowId, t.key, t.label, t.template, t.mode, actor, batch.fields, t.by);
}

const scopeOf = (values: Record<string, unknown>, timeZone: string, locale: RenderScope["locale"]): RenderScope => ({
  values,
  timeZone,
  locale,
});
const zonedToday = (timeZone: string) => {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
};
export const builtins = (timeZone: string) => ({ $today: zonedToday(timeZone), $now: new Date().toISOString() });

// The database rules of a record's database for one event, through the
// engine: each rule a graph, all of them writing into one batch (the old
// runAutomations, same results). Returns how many rules fired.
export async function runRuleAutomations(input: { page: Page; rowId: string; actor: Identity | null; event: RecordEvent; before?: Cells | null; only?: string }) {
  const settings = await databaseSettings(input.page.id);
  const automations = (settings.automations || []).filter((a) => a.enabled && (!input.only || a.id === input.only) && !a.workflow);
  if (!automations.length) return 0;
  const batch = await batchFor(input.page, input.rowId);
  if (!batch) return 0;
  let fired = 0;
  const record = { id: batch.rowId, database: { id: input.page.id }, fields: batch.cells };
  for (const a of automations) {
    if (!ruleTriggered(a, input.event, input.before ?? null, batch.row.cells, batch.fields)) continue;
    const graph = automationToGraph(a, input.page.id, batch.fields);
    const trigger = graph.nodes[0];
    const values: Record<string, unknown> = { [trigger.id]: { record }, $trigger: { record }, ...builtins("UTC") };
    // A rule that does not get past its conditions did not fire.
    let passed = !a.conditions.length;
    const w: Walk = {
      graph,
      values,
      base: {
        scope: scopeOf(values, "UTC", "de"),
        runner: input.actor,
        actor: input.actor,
        run: { id: "", pageId: input.page.id, workspaceId: input.page.workspace_id, mode: "live", depth: 0, triggerNodeId: trigger.id },
        workflowPage: null,
        trigger: { pageId: input.page.id, rowId: input.rowId },
        inline: batch,
        legacy: { ruleId: a.id, ruleName: a.name, createdBy: a.createdBy || null, created: { n: 0, ids: [] } },
        warn: () => {},
      },
      record: (node, port) => {
        if (node.type === "logic.if" && port === "true") passed = true;
      },
    };
    try {
      await walk(w, trigger.id, "out");
    } catch (error) {
      // The rules fail as before: with the original error.
      throw error instanceof InlineFailure ? error.error : error;
    }
    if (passed) fired++;
  }
  await flush(batch, input.actor);
  return fired;
}

// A scheduled rule's slot: its graph run once for its creator (the old
// processScheduledAutomations for one rule). The new records' ids.
export async function runScheduledRule(a: Automation, page: Page, who: Identity, slot: { date: string; key: string }, created: { n: number; ids: string[] }) {
  const graph = automationToGraph(a, page.id);
  const trigger = graph.nodes[0];
  const output = { slot: { date: slot.date, time: slot.key.slice(11), key: slot.key } };
  const values: Record<string, unknown> = { [trigger.id]: output, $trigger: output, ...builtins("UTC") };
  const before = created.ids.length;
  // Created records run through the rules of their database like before.
  const w: Walk = {
    graph,
    values,
    base: {
      scope: scopeOf(values, (trigger.config.timeZone as string) || "UTC", "de"),
      runner: who,
      actor: who,
      run: { id: "", pageId: page.id, workspaceId: page.workspace_id, mode: "live", depth: 0, triggerNodeId: trigger.id },
      workflowPage: null,
      trigger: { pageId: page.id, rowId: null },
      legacy: { ruleId: a.id, ruleName: a.name, createdBy: a.createdBy || null, created },
      warn: () => {},
    },
  };
  // action.record.create is not inline elsewhere; for the rules it is their own direct write.
  const nodes = nodeMap(graph);
  let current = trigger.id;
  for (;;) {
    const edge = outgoing(graph, current, "out")[0];
    const node = edge && nodes.get(edge.to.node);
    if (!node) break;
    const ctx: NodeRun = { ...w.base, graph, node, config: nodeSpec(node.type)!.config.parse(node.config) as Record<string, unknown>, iteration: "", attempt: 0 };
    try {
      await NODE_IMPLS[node.type](ctx);
    } catch (error) {
      throw error instanceof InlineFailure ? error.error : error;
    }
    current = node.id;
  }
  return created.ids.slice(before);
}

/* ---------- Workflows with an immediate part ---------- */

type InlineTrigger = { page_id: string; node_id: string; version_id: string; kind: string; config: string; runner_id: string | null; graph: string; settings: string };

// The workflows of this database whose trigger has an immediate part, for a
// record event (and "done" when it just became done). One indexed lookup
// when there are none.
export async function runInlineWorkflows(input: { page: Page; rowId: string; actor: Identity | null; event: RecordEvent; before?: Cells | null; after?: Cells; done?: boolean }) {
  const kinds = recordEventKinds(input.event, input.done);
  if (!kinds.length) return 0;
  if (!(await workflowListeners(input.page.workspace_id, kinds, input.page.id)).inline.size) return 0;
  const triggers = await all<InlineTrigger>(
    `SELECT t.page_id,t.node_id,t.version_id,t.kind,t.config,w.runner_id,v.graph,w.settings FROM workflow_triggers t
       JOIN workflows w ON w.page_id=t.page_id AND w.status='active' AND w.active_version_id=t.version_id
       JOIN workflow_versions v ON v.id=t.version_id
       JOIN pages p ON p.id=t.page_id AND p.deleted_at IS NULL
      WHERE t.workspace_id=? AND t.kind IN (${kinds.map(() => "?").join(",")}) AND t.scope_id=? AND t.inline=1
      ORDER BY t.page_id,t.node_id`,
    input.page.workspace_id,
    ...kinds,
    input.page.id,
  );
  if (!triggers.length) return 0;
  let started = 0;
  const origin = currentRun();
  for (const t of triggers) {
    const graph = parseGraph(JSON.parse(t.graph));
    const node = graph.nodes.find((n) => n.id === t.node_id);
    if (!node || !RECORD_TRIGGERS.has(node.type)) continue;
    // Own changes do not trigger the own workflow (unless asked to).
    if (origin?.pageId === t.page_id && !graph.settings.triggerOnOwnChanges) continue;
    const event = {
      id: "",
      workspace_id: input.page.workspace_id,
      kind: t.kind,
      scope_id: input.page.id,
      page_id: input.page.id,
      row_id: input.rowId,
      payload: "",
      actor_id: input.actor?.id ?? null,
      origin_run_id: origin?.runId ?? null,
      depth: origin ? origin.depth + 1 : 0,
    };
    const payload = { before: input.before || {}, after: input.after || {}, changed: Object.keys({ ...(input.before || {}), ...(input.after || {}) }), via: input.event === "form" ? "form" : "app" };
    if (!(await triggerMatches(node.type, node.config, event, payload, null))) continue;
    if (await startInlineRun({ trigger: t, graph, node, event, payload, actor: input.actor, record: input })) started++;
  }
  return started;
}

// The walk of a workflow's immediate part (used by the engine): returns
// what ran and what was queued.
export async function walkInline(input: {
  graph: WorkflowGraph;
  triggerNode: WorkflowNode;
  triggerValue: unknown;
  values: Record<string, unknown>;
  base: Walk["base"];
  batch: InlineBatch;
}) {
  const ran: { node: WorkflowNode; port: string; output: unknown; via: string }[] = [];
  const queued: { node: WorkflowNode; via: string }[] = [];
  let failure: InlineFailure | null = null;
  let stopped: { result: string; message: string } | undefined;
  try {
    const r = await walk(
      {
        graph: input.graph,
        values: input.values,
        base: input.base,
        queue: (node, via) => queued.push({ node, via }),
        record: (node, port, output, via) => ran.push({ node, port, output, via }),
      },
      input.triggerNode.id,
      "out",
    );
    stopped = r.stopped;
  } catch (error) {
    if (!(error instanceof InlineFailure)) throw error;
    failure = error;
  }
  return { ran, queued, stopped, failure };
}
export { flush as flushInline, batchFor as inlineBatch };
export const runnerLocale = async (userId: string | null | undefined) => (userId ? await userLocale(userId) : "de");
export { personValue, recordValue, triggerOutput };
