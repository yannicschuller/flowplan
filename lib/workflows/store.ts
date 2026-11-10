// Workflow pages on the server (docs/specs/workflows.md §3, §8.11, §10):
// the workflow row of a page, the draft (a Yjs document like a whiteboard,
// merged under a row lock, snapshots at most every 5 minutes), activated
// versions (immutable), activating and pausing with the check, test and
// manual runs, the run list and run details, "open in canvas" for a
// database rule and the rule's replacement when the workflow is activated.
import * as Y from "yjs";
import { createHash } from "node:crypto";
import { z } from "zod";
import { all, audit, id, nowText, one, run, sql } from "../db";
import { HttpError } from "../auth";
import { isGuest, pageRole, requireMember, requirePage } from "../permissions";
import { allow } from "../action-limits";
import { createPage } from "../seed";
import { databaseSettings, storeSettings } from "../database-settings";
import type { Identity, Page } from "../types";
import { contentLocale } from "../content-locale";
import { isTrigger, nodeSpec, triggerScope } from "./catalog";
import { emptyGraph, graphFingerprint, issueMessage, outgoing, parseGraph, type GraphIssue, type WorkflowGraph } from "./graph";
import { draftGraph, graphDoc, graphSummary, writeGraph } from "./draft";
import { automationToGraph } from "./legacy";
import { hasErrors, validateGraph } from "./validate";
import { runsInline } from "./inline";
import { cancelOpenRuns, cancelRun, createRun, holdRuns, resumeRuns, type RunRow, type WorkflowRow } from "./engine";
import { emitWorkflowEvent } from "./events";
import { wakeAfterCommit } from "./queue";
import { graphOf } from "./engine";
import { workflowLimits } from "./limits";
import { mayObserve, runnerIdentity } from "./runner";
import { personValue } from "./nodes/data";
import { outputFor, sampleOutput, triggerOutput } from "./nodes/triggers";
import { notePause } from "./notices";

const uuid = z.string().uuid();

/* ---------- The workflow row and rights ---------- */

// FLOWPLAN_WORKFLOWS=off (or the administration): no new workflow pages.
export async function assertWorkflowsEnabled() {
  if (!(await workflowLimits()).enabled) throw new HttpError(409, "Workflows sind auf dieser Instanz abgeschaltet.");
}

export async function createWorkflowRecord(pageId: string, workspaceId: string, userId: string | null, graph: WorkflowGraph = emptyGraph()) {
  const now = Date.now();
  await run(
    "INSERT INTO workflows(page_id,workspace_id,status,settings,created_at,updated_at) VALUES(?,?,'draft','{}',?,?) ON CONFLICT(page_id) DO NOTHING",
    pageId,
    workspaceId,
    now,
    now,
  );
  const doc = graphDoc(graph);
  await run(
    "INSERT INTO workflow_drafts(page_id,state,generation,updated_by,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(page_id) DO UPDATE SET state=excluded.state,generation=excluded.generation,updated_by=excluded.updated_by,updated_at=excluded.updated_at",
    pageId,
    Y.encodeStateAsUpdate(doc),
    id(),
    userId,
    now,
  );
  await run("UPDATE documents SET html=? WHERE page_id=?", graphSummary(graph), pageId);
  doc.destroy();
}
// A workflow page for `user`: readable (never for guests – 404, §3) and,
// for `write`, editable by a full member (requireMember editor).
export async function requireWorkflow(user: Identity, pageId: string, write = false, allowDeleted = false): Promise<Page> {
  // Guests learn nothing about workflow pages – not even that they exist.
  const seen = await one<Page>("SELECT * FROM pages WHERE id=?", uuid.parse(pageId));
  if (!seen || seen.kind !== "workflow" || (await isGuest(user, seen.workspace_id))) throw new HttpError(404, "Seite nicht gefunden.");
  const page = await requirePage(user, seen.id, write, allowDeleted);
  if (write) await requireMember(user, page.workspace_id, "editor");
  if (!(await one("SELECT 1 FROM workflows WHERE page_id=?", page.id))) await createWorkflowRecord(page.id, page.workspace_id, user.id);
  return page;
}
const workflowRow = async (pageId: string) => (await one<WorkflowRow & { activated_at: number | null; paused_at: number | null; pause_reason: string; last_events: string; updated_at: number }>("SELECT * FROM workflows WHERE page_id=?", pageId))!;

/* ---------- Draft ---------- */

type Stored = { state: Uint8Array; generation: string };
async function storedDraft(page: Page, forUpdate = false): Promise<Stored> {
  const lock = forUpdate ? sql.forUpdate() : "";
  let row = await one<Stored>(`SELECT state,generation FROM workflow_drafts WHERE page_id=?${lock}`, page.id);
  if (!row) {
    await createWorkflowRecord(page.id, page.workspace_id, null);
    row = (await one<Stored>(`SELECT state,generation FROM workflow_drafts WHERE page_id=?${lock}`, page.id))!;
  }
  return row;
}
export async function draftOf(page: Page): Promise<WorkflowGraph> {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, (await storedDraft(page)).state);
    return draftGraph(doc);
  } finally {
    doc.destroy();
  }
}
// Stores a changed draft: a snapshot of the state before at most every 5
// minutes (the version history), the summary for search.
async function saveDraft(user: Identity, page: Page, before: Uint8Array, doc: Y.Doc) {
  if (!(await one("SELECT id FROM snapshots WHERE page_id=? AND created_at>?", page.id, nowText(Date.now() - 300_000)))) {
    const old = new Y.Doc();
    Y.applyUpdate(old, before);
    await run("INSERT INTO snapshots(id,page_id,state,html,title,created_by) VALUES(?,?,?,?,?,?)", id(), page.id, before, graphSummary(draftGraph(old)), page.title, user.id);
    old.destroy();
  }
  await run("UPDATE workflow_drafts SET state=?,updated_by=?,updated_at=? WHERE page_id=?", Y.encodeStateAsUpdate(doc), user.id, Date.now(), page.id);
  await run("UPDATE documents SET html=?,updated_at=? WHERE page_id=?", graphSummary(draftGraph(doc)), nowText(), page.id);
  await run("UPDATE pages SET updated_at=? WHERE id=?", nowText(), page.id);
  await run("UPDATE workflows SET updated_at=? WHERE page_id=?", Date.now(), page.id);
}

const syncInput = z.object({
  pageId: uuid,
  generation: z.string().max(100),
  update: z.string().max(4_000_000).optional(),
  // State vector of the client: the answer holds only what it misses.
  vector: z.string().max(200_000).optional(),
  cursor: z.object({ x: z.number().finite(), y: z.number().finite() }).nullable().optional(),
});
// workflow.sync: the Yjs exchange of the draft (like whiteboard.sync).
export async function syncDraft(user: Identity, raw: unknown) {
  const b = syncInput.parse(raw);
  const page = await requireWorkflow(user, b.pageId, !!b.update);
  const s = await storedDraft(page, !!b.update);
  if (b.generation !== s.generation) throw new HttpError(409, "Eine neue Version des Entwurfs ist verfügbar. Er wird neu geladen.");
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, s.state);
    if (b.update) {
      if (page.locked) throw new HttpError(409, "Diese Seite ist gesperrt.");
      const before = Y.encodeStateVector(doc);
      Y.applyUpdate(doc, Buffer.from(b.update, "base64"));
      if (Y.encodeStateAsUpdate(doc, before).length > 2) {
        if (draftGraph(doc).nodes.length > 150) throw new HttpError(413, "Höchstens 150 Knoten.");
        await saveDraft(user, page, s.state, doc);
      }
    }
    if (b.cursor !== undefined)
      if (b.cursor)
        await run(
          `INSERT INTO whiteboard_presence(page_id,user_id,name,x,y,seen) VALUES(?,?,?,?,?,?)
           ON CONFLICT(page_id,user_id) DO UPDATE SET name=excluded.name,x=excluded.x,y=excluded.y,seen=excluded.seen`,
          page.id,
          user.id,
          user.name,
          b.cursor.x,
          b.cursor.y,
          Date.now(),
        );
      else await run("DELETE FROM whiteboard_presence WHERE page_id=? AND user_id=?", page.id, user.id);
    const vector = b.vector ? Buffer.from(b.vector, "base64") : null;
    return {
      state: Buffer.from(vector ? Y.encodeStateAsUpdate(doc, vector) : Y.encodeStateAsUpdate(doc)).toString("base64"),
      generation: s.generation,
      presence: await all<{ user_id: string; name: string; x: number; y: number }>(
        "SELECT user_id,name,x,y FROM whiteboard_presence WHERE page_id=? AND user_id!=? AND seen>?",
        page.id,
        user.id,
        Date.now() - 8000,
      ),
    };
  } finally {
    doc.destroy();
  }
}

// workflow.draft: replaces the draft by a graph (as changes on the Yjs
// document, so it merges with what others are typing); answers the check.
export async function replaceDraft(user: Identity, raw: unknown) {
  const b = z.object({ pageId: uuid, graph: z.unknown() }).parse(raw);
  const page = await requireWorkflow(user, b.pageId, true);
  if (page.locked) throw new HttpError(409, "Diese Seite ist gesperrt.");
  let graph: WorkflowGraph;
  try {
    graph = parseGraph(b.graph);
  } catch (error) {
    throw new HttpError(400, error instanceof z.ZodError ? "Ungültiger Workflow." : (error as Error).message);
  }
  const s = await storedDraft(page, true);
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, s.state);
    writeGraph(doc, graph);
    await saveDraft(user, page, s.state, doc);
  } finally {
    doc.destroy();
  }
  return { ok: true, issues: await checked(user, page, graph) };
}
async function checked(user: Identity, page: Page, graph: WorkflowGraph, runner: Identity | null = user) {
  const issues = await validateGraph(graph, { workspaceId: page.workspace_id, runner, pageId: page.id });
  const locale = contentLocale();
  return issues.map((i) => ({ ...i, message: issueMessage(i, locale) }));
}

/* ---------- Activate, pause ---------- */

export const hashGraph = (graph: WorkflowGraph) => createHash("sha256").update(graphFingerprint(graph)).digest("hex");

// The triggers of the active version in the lookup table (§4.1).
async function writeTriggers(page: Page, versionId: string, graph: WorkflowGraph) {
  await run("DELETE FROM workflow_triggers WHERE page_id=?", page.id);
  for (const n of graph.nodes) {
    if (!isTrigger(n.type) || n.disabled) continue;
    const spec = nodeSpec(n.type);
    if (!spec?.event) continue;
    const c = n.config as Record<string, unknown>;
    const scope = triggerScope(n.type, c);
    // An immediate part: the trigger leads straight to a node that runs inline.
    const inline = spec.inline && outgoing(graph, n.id, "out").some((e) => {
      const next = graph.nodes.find((x) => x.id === e.to.node);
      return !!next && runsInline(next);
    });
    await run(
      "INSERT INTO workflow_triggers(page_id,node_id,version_id,workspace_id,kind,scope_id,config,inline) VALUES(?,?,?,?,?,?,?,?)",
      page.id,
      n.id,
      versionId,
      page.workspace_id,
      spec.event,
      scope,
      JSON.stringify(c),
      inline ? 1 : 0,
    );
    // A webhook trigger's address follows the active version's mode.
    if (n.type === "trigger.webhook") await run("UPDATE workflow_hooks SET mode=? WHERE page_id=? AND node_id=?", c.mode === "token" ? "token" : "signed", page.id, n.id);
  }
}

// workflow.activate: the draft becomes the next version; the person
// activating runs it from now on (E4); runs held by a pause continue on
// their own version. A rule this workflow extends is replaced in the same
// transaction – never both, never neither (§2).
export async function activateWorkflow(user: Identity, raw: unknown) {
  const b = z.object({ pageId: uuid, note: z.string().trim().max(500).default("") }).parse(raw);
  const page = await requireWorkflow(user, b.pageId, true);
  const limits = await workflowLimits();
  if (!limits.enabled) throw new HttpError(409, "Workflows sind auf dieser Instanz abgeschaltet.");
  const role = await pageRole(user, page);
  if (role !== "editor" && role !== "owner") throw new HttpError(403, "Keine Berechtigung für diese Seite.");
  const graph = await draftOf(page);
  const runner = { ...user, isAdmin: false, groups: [], apiScope: undefined } as Identity;
  const issues = await checked(user, page, graph, runner);
  // Not activated: the answer says why (no error, nothing written).
  if (hasErrors(issues)) return { ok: false, issues };
  const wf = await workflowRow(page.id);
  if (wf.status !== "active") {
    const active = await one<{ n: number }>("SELECT COUNT(*) n FROM workflows WHERE workspace_id=? AND status='active'", page.workspace_id);
    if (Number(active?.n || 0) >= limits.activePerWorkspace) throw new HttpError(409, `Höchstens ${limits.activePerWorkspace} aktive Workflows je Arbeitsbereich.`);
  }
  const hash = hashGraph(graph);
  const previous = wf.active_version_id ? await one<{ graph_hash: string }>("SELECT graph_hash FROM workflow_versions WHERE id=?", wf.active_version_id) : undefined;
  let versionId = wf.active_version_id;
  let number = 0;
  // An unchanged draft keeps its version (activating after a pause).
  if (!previous || previous.graph_hash !== hash) {
    number = Number((await one<{ n: number }>("SELECT COALESCE(MAX(number),0) n FROM workflow_versions WHERE page_id=?", page.id))?.n || 0) + 1;
    versionId = id();
    await run(
      "INSERT INTO workflow_versions(id,page_id,number,graph,graph_hash,activated_by,activated_at,note) VALUES(?,?,?,?,?,?,?,?)",
      versionId,
      page.id,
      number,
      JSON.stringify(graph),
      hash,
      user.id,
      Date.now(),
      b.note,
    );
  }
  const runnerChanged = wf.runner_id && wf.runner_id !== user.id;
  await run(
    "UPDATE workflows SET status='active',active_version_id=?,runner_id=?,activated_at=?,paused_at=NULL,paused_by=NULL,pause_reason='',failure_streak=0,updated_at=? WHERE page_id=?",
    versionId,
    user.id,
    Date.now(),
    Date.now(),
    page.id,
  );
  await writeTriggers(page, versionId!, graph);
  await resumeRuns(page.id);
  // A database rule extended into this workflow: replaced now.
  const settings = JSON.parse(wf.settings || "{}") as { replaces?: { database: string; rule: string } };
  if (settings.replaces) {
    const db = await one<Page>("SELECT * FROM pages WHERE id=?", settings.replaces.database);
    if (db) {
      const current = await databaseSettings(db.id);
      const rules = (current.automations || []).map((a) => (a.id === settings.replaces!.rule ? { ...a, enabled: false, workflow: page.id } : a));
      await storeSettings(db.id, { ...current, automations: rules });
    }
  }
  await audit(user.id, "workflow.activated", page.id, JSON.stringify({ version: number || undefined, versionId, hash, runner: user.id }));
  // Activated again on the same version after a pause.
  if (!number && (wf.status === "paused" || wf.status === "auto_paused")) await audit(user.id, "workflow.resumed", page.id, versionId || "");
  if (runnerChanged) await audit(user.id, "workflow.runner_changed", page.id, `${wf.runner_id} → ${user.id}`);
  wakeAfterCommit();
  return { ok: true, versionId, number: number || undefined, issues };
}

// Pauses a workflow: no new runs (its triggers leave the lookup table),
// open runs are held – or cancelled when asked (§8.11).
export async function pauseWorkflow(pageId: string, options: { status: "paused" | "auto_paused"; reason: string; by: string | null; cancelRuns?: boolean }) {
  const wf = await one<{ status: string }>("SELECT status FROM workflows WHERE page_id=?", pageId);
  if (!wf) return false;
  await run("DELETE FROM workflow_triggers WHERE page_id=?", pageId);
  if (options.cancelRuns) await cancelOpenRuns(pageId);
  else await holdRuns(pageId);
  if (wf.status === "draft") return false;
  const changed = await run(
    "UPDATE workflows SET status=?,paused_at=?,paused_by=?,pause_reason=?,updated_at=? WHERE page_id=? AND status<>'draft'",
    options.status,
    Date.now(),
    options.by,
    options.reason.slice(0, 500),
    Date.now(),
    pageId,
  );
  if (changed.changes && wf.status === "active") {
    await audit(options.by || "system", options.status === "auto_paused" ? "workflow.auto_paused" : "workflow.paused", pageId, options.reason.slice(0, 300));
    // Paused by itself (rights lost, failures): the people responsible hear it.
    if (!options.by) await notePause(pageId, options.status, options.reason);
  }
  return !!changed.changes;
}
export async function pauseCommand(user: Identity, raw: unknown) {
  const b = z.object({ pageId: uuid, cancelRuns: z.boolean().default(false), reason: z.string().trim().max(300).default("") }).parse(raw);
  const page = await requireWorkflow(user, b.pageId, true);
  await pauseWorkflow(page.id, { status: "paused", reason: b.reason, by: user.id, cancelRuns: b.cancelRuns });
  return { ok: true };
}
// Pages in the trash behave as paused (no new runs, open runs held);
// restored they stay paused (§3).
export async function trashWorkflows(pageIds: string[], by: string) {
  for (const pid of pageIds)
    if (await one("SELECT 1 FROM workflows WHERE page_id=?", pid)) await pauseWorkflow(pid, { status: "paused", reason: "Im Papierkorb.", by });
}

/* ---------- Reading ---------- */

export async function workflowState(user: Identity, pageId: string) {
  const page = await requireWorkflow(user, pageId);
  const wf = await workflowRow(page.id);
  const canEdit = ["editor", "owner"].includes((await pageRole(user, page)) || "") && !(await isGuest(user, page.workspace_id)) && user.apiScope !== "read";
  const version = wf.active_version_id ? await one<{ id: string; number: number; graph: string; activated_by: string; activated_at: number; note: string; graph_hash: string }>("SELECT * FROM workflow_versions WHERE id=?", wf.active_version_id) : undefined;
  const draft = canEdit ? await draftOf(page) : null;
  const stored = canEdit ? await storedDraft(page) : null;
  return {
    pageId: page.id,
    title: page.title,
    status: wf.status,
    pauseReason: wf.pause_reason || null,
    runner: await personValue(wf.runner_id, page.workspace_id),
    activatedAt: wf.activated_at,
    pausedAt: wf.paused_at,
    throttled: wf.throttled,
    canEdit,
    active: version
      ? { id: version.id, number: version.number, graph: JSON.parse(version.graph), activatedBy: await personValue(version.activated_by, page.workspace_id), activatedAt: version.activated_at, note: version.note }
      : null,
    draft: draft
      ? {
          graph: draft,
          generation: stored!.generation,
          state: Buffer.from(stored!.state).toString("base64"),
          changed: !version || version.graph_hash !== hashGraph(draft),
          issues: await checked(user, page, draft),
        }
      : null,
    lastRun: await one("SELECT id,status,mode,created_at,finished_at FROM workflow_runs WHERE page_id=? ORDER BY created_at DESC,seq DESC LIMIT 1", page.id),
  };
}
export async function listWorkflows(user: Identity, workspaceId: string) {
  await requireMember(user, uuid.parse(workspaceId));
  if (await isGuest(user, workspaceId)) return { workflows: [] };
  const rows = await all<{ page_id: string; status: string; runner_id: string | null; title: string; manual: number }>(
    "SELECT w.page_id,w.status,w.runner_id,p.title,(SELECT COUNT(*) FROM workflow_triggers t WHERE t.page_id=w.page_id AND t.kind='manual') manual FROM workflows w JOIN pages p ON p.id=w.page_id WHERE w.workspace_id=? AND p.deleted_at IS NULL ORDER BY p.title",
    workspaceId,
  );
  const out = [];
  for (const r of rows) {
    const page = await one<Page>("SELECT * FROM pages WHERE id=?", r.page_id);
    if (!page || !(await pageRole(user, page))) continue;
    out.push({
      pageId: r.page_id,
      title: r.title,
      status: r.status,
      runner: await personValue(r.runner_id, workspaceId),
      // Has an active manual trigger (a button can start it).
      manual: Number(r.manual) > 0,
      lastRun: await one("SELECT id,status,created_at,finished_at FROM workflow_runs WHERE page_id=? AND mode='live' ORDER BY created_at DESC,seq DESC LIMIT 1", r.page_id),
    });
  }
  return { workflows: out };
}

// The versions (activated) and draft snapshots as one timeline (§3, §10.5).
export async function workflowVersions(user: Identity, pageId: string) {
  const page = await requireWorkflow(user, pageId);
  const versions = await all<{ id: string; number: number; activated_by: string | null; activated_at: number; note: string }>(
    "SELECT id,number,activated_by,activated_at,note FROM workflow_versions WHERE page_id=? ORDER BY number DESC",
    page.id,
  );
  const snapshots = await all<{ id: string; created_by: string | null; created_at: string }>("SELECT id,created_by,created_at FROM snapshots WHERE page_id=? ORDER BY created_at DESC,seq DESC LIMIT 200", page.id);
  return {
    versions: await Promise.all(versions.map(async (v) => ({ ...v, activatedBy: await personValue(v.activated_by, page.workspace_id) }))),
    drafts: await Promise.all(snapshots.map(async (s) => ({ id: s.id, createdAt: s.created_at, createdBy: await personValue(s.created_by, page.workspace_id) }))),
  };
}
export async function workflowVersion(user: Identity, pageId: string, versionId: string) {
  const page = await requireWorkflow(user, pageId);
  const v = await one<{ id: string; number: number; graph: string; activated_by: string; activated_at: number; note: string }>("SELECT * FROM workflow_versions WHERE id=? AND page_id=?", versionId, page.id);
  if (v) return { ...v, graph: JSON.parse(v.graph) };
  const snap = await one<{ id: string; state: Uint8Array; created_at: string }>("SELECT id,state,created_at FROM snapshots WHERE id=? AND page_id=?", versionId, page.id);
  if (!snap) throw new HttpError(404, "Version nicht gefunden.");
  const doc = new Y.Doc();
  Y.applyUpdate(doc, snap.state);
  const graph = draftGraph(doc);
  doc.destroy();
  return { id: snap.id, draft: true, createdAt: snap.created_at, graph };
}
// workflow.restore: a version or a draft snapshot becomes the draft – never
// the active version directly.
export async function restoreVersion(user: Identity, raw: unknown) {
  const b = z.object({ pageId: uuid, versionId: uuid }).parse(raw);
  const { graph } = await workflowVersion(user, b.pageId, b.versionId);
  return await replaceDraft(user, { pageId: b.pageId, graph });
}

/* ---------- Runs ---------- */

type StepView = { id: string; node_id: string; iteration: string; via: string; status: string; attempt: number; port: string | null; input: string | null; output: string | null; error: string | null; error_kind: string | null; started_at: number | null; finished_at: number | null; due_at: number };
// The person a run ran as sees its inputs and outputs; others its status
// and errors without data (§9.3, open question 1 as decided).
const seesContents = (user: Identity, runRow: RunRow) => !!runRow.runner_id && runRow.runner_id === user.id;
export async function listRuns(user: Identity, pageId: string, query: { status?: string; mode?: string; limit?: number; before?: number; q?: string } = {}) {
  const page = await requireWorkflow(user, pageId);
  const where = ["page_id=?"];
  const params: (string | number)[] = [page.id];
  if (query.status === "failed" || query.status === "succeeded" || query.status === "cancelled") {
    where.push("status=?");
    params.push(query.status);
  } else if (query.status === "open") where.push("status IN ('queued','running','waiting','held')");
  if (query.mode === "test") where.push("mode<>'live'");
  else if (query.mode === "live") where.push("mode='live'");
  if (query.before) {
    where.push("created_at<?");
    params.push(query.before);
  }
  // Search: the run's id, its error, or a step's error (what the list shows).
  const q = query.q?.trim().slice(0, 100).toLowerCase();
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push("(lower(id) LIKE ? ESCAPE '\\' OR lower(COALESCE(error,'')) LIKE ? ESCAPE '\\' OR EXISTS(SELECT 1 FROM workflow_steps s WHERE s.run_id=workflow_runs.id AND lower(COALESCE(s.error,'')) LIKE ? ESCAPE '\\'))");
    params.push(like, like, like);
  }
  if (query.status === "waiting") where.push("status='waiting'");
  const limit = Math.max(1, Math.min(200, query.limit || 50));
  const runs = await all<RunRow & { created_at: number; started_at: number | null; finished_at: number | null; failed_node_id: string | null }>(
    `SELECT * FROM workflow_runs WHERE ${where.join(" AND ")} ORDER BY created_at DESC,seq DESC LIMIT ${limit}`,
    ...params,
  );
  const numbers = new Map((await all<{ id: string; number: number }>("SELECT id,number FROM workflow_versions WHERE page_id=?", page.id)).map((v) => [v.id, v.number]));
  return {
    runs: runs.map((r) => ({
      id: r.id,
      status: r.status,
      mode: r.mode,
      version: numbers.get(r.version_id) ?? null,
      triggerNodeId: r.trigger_node_id,
      steps: r.steps,
      depth: r.depth,
      originRunId: r.origin_run_id,
      failedNodeId: r.failed_node_id,
      error: r.error,
      createdAt: r.created_at,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
    })),
  };
}
export async function runDetail(user: Identity, runId: string) {
  const r = await one<RunRow & { created_at: number; started_at: number | null; finished_at: number | null; failed_node_id: string | null; ai_tokens: number }>("SELECT * FROM workflow_runs WHERE id=?", uuid.parse(runId));
  if (!r) throw new HttpError(404, "Lauf nicht gefunden.");
  const page = await requireWorkflow(user, r.page_id);
  const contents = seesContents(user, r);
  const steps = await all<StepView>("SELECT * FROM workflow_steps WHERE run_id=? ORDER BY created_at,seq", r.id);
  const graph = await graphOf(r);
  const origin = r.origin_run_id ? await one<{ page_id: string; title: string }>("SELECT r.page_id,p.title FROM workflow_runs r JOIN pages p ON p.id=r.page_id WHERE r.id=?", r.origin_run_id) : undefined;
  return {
    id: r.id,
    pageId: page.id,
    status: r.status,
    mode: r.mode,
    versionId: r.version_id.startsWith("test:") ? null : r.version_id,
    graph,
    runner: await personValue(r.runner_id, page.workspace_id),
    contentsVisible: contents,
    triggerNodeId: r.trigger_node_id,
    depth: r.depth,
    origin: origin ? { runId: r.origin_run_id, pageId: origin.page_id, title: (await pageRole(user, (await one<Page>("SELECT * FROM pages WHERE id=?", origin.page_id))!)) ? origin.title : null } : null,
    error: r.error,
    errorKind: (r as { error_kind?: string | null }).error_kind ?? null,
    failedNodeId: r.failed_node_id,
    steps: r.steps,
    aiTokens: r.ai_tokens,
    approvals: (
      await all<{ id: string; step_id: string; decision: string | null; approvers: string; expires_at: number | null; decided_by: string | null }>("SELECT id,step_id,decision,approvers,expires_at,decided_by FROM workflow_approvals WHERE run_id=?", r.id)
    ).map((a) => ({ id: a.id, stepId: a.step_id, decision: a.decision, expiresAt: a.expires_at, canDecide: !a.decision && (JSON.parse(a.approvers) as string[]).includes(user.id) })),
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    timeline: steps.map((s) => ({
      id: s.id,
      nodeId: s.node_id,
      iteration: s.iteration,
      via: s.via,
      status: s.status,
      attempt: s.attempt,
      port: s.port,
      dueAt: s.due_at,
      startedAt: s.started_at,
      finishedAt: s.finished_at,
      errorKind: s.error_kind,
      error: s.error,
      // The test graph sits in the trigger step's input: not shown as data.
      input: contents && s.node_id !== r.trigger_node_id && s.input ? JSON.parse(s.input) : null,
      output: contents && s.output ? JSON.parse(s.output) : null,
    })),
  };
}
export async function cancelRunCommand(user: Identity, raw: unknown) {
  const b = z.object({ runId: uuid }).parse(raw);
  const r = await one<RunRow>("SELECT * FROM workflow_runs WHERE id=?", b.runId);
  if (!r) throw new HttpError(404, "Lauf nicht gefunden.");
  await requireWorkflow(user, r.page_id, true);
  const cancelled = await cancelRun(r.id);
  if (cancelled) await audit(user.id, "workflow.run.cancelled", r.page_id, r.id);
  return { ok: true, cancelled };
}

/* ---------- Test runs, manual runs ---------- */

const testInput = z.object({
  pageId: uuid,
  mode: z.enum(["test", "dry"]).default("dry"),
  // Which trigger (default: the first).
  nodeId: z.string().max(40).optional(),
  // Where the trigger's data comes from (§10.3).
  data: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("sample") }),
      z.object({ kind: z.literal("last") }),
      z.object({ kind: z.literal("record"), rowId: uuid }),
      z.object({ kind: z.literal("page"), pageId: uuid }),
      z.object({ kind: z.literal("custom"), output: z.record(z.string(), z.unknown()) }),
    ])
    .default({ kind: "sample" }),
  // Dry runs: approvals assumed as approved (default) or rejected (§10.3).
  assume: z.enum(["approved", "rejected"]).default("approved"),
});
// workflow.test: a test run (real effects, as the tester) or a dry run of
// the draft. Test runs run as the person testing, never as the runner (§9.2).
export async function startTestRun(user: Identity, raw: unknown) {
  const b = testInput.parse(raw);
  const page = await requireWorkflow(user, b.pageId, true);
  const limits = await workflowLimits();
  if (!allow(`workflow-test:${user.id}`, limits.testRunsPerMinute, 60_000)) throw new HttpError(429, "Zu viele Testläufe. Bitte kurz warten.");
  const graph = await draftOf(page);
  const issues = await checked(user, page, graph);
  if (hasErrors(issues.filter((i) => !["page_not_readable", "page_not_writable"].includes(i.code)))) return { ok: false, runId: null, issues };
  const node = graph.nodes.find((n) => (b.nodeId ? n.id === b.nodeId : isTrigger(n.type)));
  if (!node || !isTrigger(node.type)) throw new HttpError(400, "Kein Auslöser.");
  const spec = nodeSpec(node.type)!;
  const tester = { ...user, isAdmin: false, groups: [] } as Identity;
  let triggerValue: unknown;
  const d = b.data;
  if (d.kind === "custom") triggerValue = d.output;
  else if (d.kind === "sample") {
    triggerValue = sampleOutput(spec.outputs as never);
    // The webhook's expected fields (for the picker) fill the sample body.
    if (node.type === "trigger.webhook")
      (triggerValue as { body: Record<string, unknown> }).body = Object.fromEntries(((node.config.fields as { name: string; type: string }[]) || []).map((f) => [f.name, f.type === "number" ? 1 : f.type === "boolean" ? true : "…"]));
  }
  else if (d.kind === "record") {
    const row = await one<{ id: string; page_id: string }>("SELECT id,page_id FROM rows WHERE id=?", d.rowId);
    if (!row || !(await mayObserve(tester, row.page_id, row.id))) throw new HttpError(404, "Eintrag nicht gefunden.");
    triggerValue = await triggerOutput(node.type, { workspace_id: page.workspace_id, page_id: row.page_id, row_id: row.id, actor_id: user.id }, { via: "app" }, tester);
  } else if (d.kind === "page") {
    if (!(await mayObserve(tester, d.pageId))) throw new HttpError(404, "Seite nicht gefunden.");
    triggerValue = await triggerOutput(node.type, { workspace_id: page.workspace_id, page_id: d.pageId, row_id: null, actor_id: user.id }, {}, tester);
  } else {
    // The last real event – only when the tester may see what it is about.
    const wf = await workflowRow(page.id);
    const last = (JSON.parse(wf.last_events || "{}") as Record<string, { output?: { record?: { id: string; database?: { id: string } }; page?: { id: string } } }>)[node.id];
    const output = last?.output;
    if (!output) throw new HttpError(404, "Noch kein echtes Ereignis.");
    const pageRef = output.record?.database?.id ?? output.page?.id;
    if (pageRef && !(await mayObserve(tester, pageRef, output.record?.id))) throw new HttpError(404, "Noch kein echtes Ereignis.");
    // Built for the runner: rebuilt for the tester, without what their read rules hide.
    triggerValue = await outputFor(node.type, output as Record<string, unknown>, tester, node.config);
  }
  const runId = await createRun({
    workflow: { page_id: page.id, workspace_id: page.workspace_id, runner_id: user.id },
    page,
    versionId: "",
    graph,
    triggerNode: node,
    triggerValue,
    mode: b.mode,
    runnerId: user.id,
    testGraph: graph,
    testOptions: { approval: b.assume },
  });
  wakeAfterCommit();
  return { ok: true, runId, issues };
}

// Who may start a manual trigger (§10.8, open question 4 as decided):
// editors of the workflow by default; with `who: "members"` every full
// member who sees the workflow page – or the page that carries its button
// (`host`: readable, in the same workspace, its document holds a button for
// this workflow). Never guests, never read tokens. The run always runs as
// the workflow's runner; the starter is `startedBy`.
async function startRights(user: Identity, pageId: string, host?: string) {
  const page = await one<Page>("SELECT * FROM pages WHERE id=? AND deleted_at IS NULL", uuid.parse(pageId));
  if (!page || page.kind !== "workflow" || (await isGuest(user, page.workspace_id))) throw new HttpError(404, "Seite nicht gefunden.");
  await requireMember(user, page.workspace_id);
  const role = await pageRole(user, page);
  let viaHost = false;
  if (!role && host) {
    const hostPage = await one<Page>("SELECT * FROM pages WHERE id=? AND deleted_at IS NULL", uuid.parse(host));
    const html = hostPage && hostPage.workspace_id === page.workspace_id && (await pageRole(user, hostPage)) ? (await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", hostPage.id))?.html || "" : "";
    viaHost = html.includes(`data-workflow-button="${page.id}"`);
  }
  if (!role && !viaHost) throw new HttpError(404, "Seite nicht gefunden.");
  const wf = await workflowRow(page.id);
  const v = wf.status === "active" && wf.active_version_id ? await one<{ graph: string }>("SELECT graph FROM workflow_versions WHERE id=?", wf.active_version_id) : undefined;
  const graph = v ? parseGraph(JSON.parse(v.graph)) : null;
  const nodes = (graph?.nodes || []).filter((n) => n.type === "trigger.manual" && !n.disabled);
  const may = (node: { config: Record<string, unknown> }) =>
    user.apiScope !== "read" && (node.config.who === "members" ? true : !viaHost && (role === "editor" || role === "owner"));
  return { page, wf, role, viaHost, nodes, may };
}
// GET /api/workflows/{id}/start?host=: what the button on a page shows.
export async function manualStartInfo(user: Identity, pageId: string, host?: string) {
  const r = await startRights(user, pageId, host);
  const node = r.nodes[0];
  return {
    pageId: r.page.id,
    // The workflow's own title only for those who may read it.
    title: r.role ? r.page.title : null,
    status: r.wf.status,
    nodeId: node?.id ?? null,
    inputs: node ? ((node.config.inputs as { name: string; type: string; required: boolean }[]) || []) : [],
    may: !!node && r.may(node),
    canEdit: r.role === "editor" || r.role === "owner",
  };
}

// workflow.run: starts a workflow with a manual trigger (§6.1, §10.8).
// `test`/`dry` run the draft as the starter (editors only).
export async function startManualRun(user: Identity, raw: unknown) {
  const b = z
    .object({
      pageId: uuid,
      nodeId: z.string().max(40).optional(),
      inputs: z.record(z.string(), z.unknown()).default({}),
      mode: z.enum(["live", "test", "dry"]).default("live"),
      source: z.enum(["workflow", "block", "api"]).default("workflow"),
      // The page with the button (source "block").
      host: uuid.optional(),
    })
    .parse(raw);
  if (b.mode !== "live") {
    const graph = await draftOf(await requireWorkflow(user, b.pageId, true));
    const node = graph.nodes.find((n) => n.type === "trigger.manual" && (!b.nodeId || n.id === b.nodeId));
    if (!node) throw new HttpError(400, "Kein manueller Auslöser.");
    return await startTestRun(user, { pageId: b.pageId, mode: b.mode, nodeId: node.id, data: { kind: "custom", output: { inputs: b.inputs, startedBy: await personValue(user.id), source: b.source } } });
  }
  if (user.apiScope === "read") throw new HttpError(403, "Dieses API-Token darf nur lesen.");
  const r = await startRights(user, b.pageId, b.source === "block" ? b.host : undefined);
  const page = r.page;
  if (r.wf.status !== "active" || !r.wf.active_version_id) throw new HttpError(409, "Der Workflow ist nicht aktiv.");
  const node = r.nodes.find((n) => !b.nodeId || n.id === b.nodeId);
  if (!node) throw new HttpError(400, "Kein manueller Auslöser.");
  if (!r.may(node)) throw new HttpError(403, "Keine Berechtigung, diesen Workflow zu starten.");
  // Inputs: the trigger's fields, required ones present.
  const inputs: Record<string, unknown> = {};
  for (const field of (node.config.inputs as { name: string; type: string; required: boolean }[]) || []) {
    const value = b.inputs[field.name];
    if (field.required && (value === undefined || value === null || value === "")) throw new HttpError(400, `„${field.name}“ fehlt.`);
    if (value !== undefined) inputs[field.name] = field.type === "number" ? Number(value) : field.type === "boolean" ? value === true || value === "true" : String(value).slice(0, 10_000);
  }
  const eventId = await emitWorkflowEvent("manual", {
    workspaceId: page.workspace_id,
    scopeId: page.id,
    pageId: null,
    actorId: user.id,
    payload: { workflow: page.id, node: node.id, inputs, source: b.source },
    checked: true,
  });
  return { ok: true, eventId };
}

/* ---------- Rules → canvas ---------- */

// "Open in canvas and extend" (§2): a workflow page next to the database
// with the rule as draft; the rule stays active until the workflow is
// activated, then it is replaced (activateWorkflow).
export async function workflowFromRule(user: Identity, raw: unknown) {
  const b = z.object({ pageId: uuid, automationId: z.string().min(1).max(60), timeZone: z.string().max(100).optional() }).parse(raw);
  const db = await requirePage(user, b.pageId, true);
  if (db.kind !== "database") throw new HttpError(400, "Keine Datenbank.");
  await requireMember(user, db.workspace_id, "editor");
  const settings = await databaseSettings(db.id);
  const rule = settings.automations?.find((a) => a.id === b.automationId);
  if (!rule) throw new HttpError(404, "Regel nicht gefunden.");
  if (rule.workflow) throw new HttpError(409, "Diese Regel ist schon als Workflow erweitert.");
  const fields = JSON.parse((await one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", db.id))!.fields);
  const graph = automationToGraph(rule, db.id, fields);
  if (rule.trigger.type !== "schedule" && b.timeZone) graph.settings.timeZone = b.timeZone;
  // Readable labels for the nodes (the rules' graphs use short English ones).
  const names: Record<string, [string, string]> = {};
  for (const n of graph.nodes) names[n.id] = (nodeSpec(n.type)?.name ?? [n.label, n.label]) as [string, string];
  const used = new Map<string, number>();
  const de = !contentLocale().startsWith("en");
  for (const n of graph.nodes) {
    const base = (de ? names[n.id][0] : names[n.id][1]).slice(0, 55);
    const k = (used.get(base) || 0) + 1;
    used.set(base, k);
    n.label = k > 1 ? `${base} ${k}` : base;
  }
  const title = `${rule.name || (de ? "Regel" : "Rule")} (Workflow)`.slice(0, 200);
  const pageId = await createPage(db.workspace_id, db.space_id, user.id, title, "workflow" as never, db.parent_id);
  await createWorkflowRecord(pageId, db.workspace_id, user.id, graph);
  await run("UPDATE workflows SET settings=? WHERE page_id=?", JSON.stringify({ replaces: { database: db.id, rule: rule.id } }), pageId);
  return { id: pageId };
}

/* ---------- Copies ---------- */

// A duplicate copies the draft as a draft – never active, no secrets, no
// hook addresses (§3).
export async function copyWorkflow(source: string, target: string, workspaceId: string, userId: string) {
  const s = await one<{ state: Uint8Array }>("SELECT state FROM workflow_drafts WHERE page_id=?", source);
  const doc = new Y.Doc();
  if (s) Y.applyUpdate(doc, s.state);
  const graph = draftGraph(doc);
  doc.destroy();
  await createWorkflowRecord(target, workspaceId, userId, graph);
}
export type { GraphIssue };
