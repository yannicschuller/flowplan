// The workflow tools of the MCP server (lib/mcp.ts, docs/specs/workflows.md
// §11.2): read workflows, their catalogue and runs; save a draft (an
// existing workflow page or a new one), test it, start a workflow with a
// manual trigger. Never activate and never decide approvals (open question
// 6 as decided: a person's decision about rights, not an AI client's). Read
// tokens get the reading tools only. Everything goes through the same
// functions and commands as the interface, as the person of the token.
import { z } from "zod";
import { command } from "../api";
import type { Identity } from "../types";
import { catalogJson, type OutputField } from "./catalog";
import { listRuns, listWorkflows, runDetail, workflowState } from "./store";

// Output fields as placeholder paths ("record.fields", "page.parent.title").
const outputPaths = (fields: OutputField[], prefix = ""): string[] =>
  fields.flatMap((f) => [`${prefix}${f.key}`, ...(f.children && prefix.split(".").length < 3 ? outputPaths(f.children, `${prefix}${f.key}.`) : [])]);
const id = (what: string) => z.uuid().describe(what);
export type WorkflowTool = { name: string; title: string; description: string; input: z.ZodObject; write: boolean; run: (user: Identity, args: never) => unknown };

const GRAPH_HELP =
  'Graph JSON (format "flowplan.workflow", version 1): {"nodes":[{"id":"n_abc123","type":"trigger.manual","label":"Start","config":{}}],"edges":[{"id":"e_1","from":{"node":"n_abc123","port":"out"},"to":{"node":"n_def456","port":"in"}}]}. Node ids n_ + 6–12 of [a-z0-9], unique labels without . | { } [ ]; types and config keys from get_workflow_catalog; placeholders {{<node id>.<output>}}.';

export const workflowTools: WorkflowTool[] = [
  {
    name: "list_workflows",
    title: "List workflows",
    description: "The workflows of a workspace you can see: page id, title, status (draft, active, paused, auto_paused), who they run as, the last run, whether they have a manual trigger.",
    input: z.object({ workspaceId: id("Workspace ID") }),
    write: false,
    run: (async (user: Identity, a: { workspaceId: string }) => await listWorkflows(user, a.workspaceId)) as WorkflowTool["run"],
  },
  {
    name: "get_workflow",
    title: "Read a workflow",
    description: "Status, the active version's graph and – for editors – the draft with its check (errors and warnings per node).",
    input: z.object({ pageId: id("Page ID of the workflow") }),
    write: false,
    run: (async (user: Identity, a: { pageId: string }) => {
      const s = await workflowState(user, a.pageId);
      // The Yjs state is for the editor, not for a client.
      return { ...s, draft: s.draft ? { graph: s.draft.graph, changed: s.draft.changed, issues: s.draft.issues } : null };
    }) as WorkflowTool["run"],
  },
  {
    name: "get_workflow_catalog",
    title: "Workflow node catalogue",
    description: "Every node type with its category, ports, outputs (placeholder paths) and configuration schema (JSON Schema). Use it to build graphs for save_workflow_draft. Optionally only some types.",
    input: z.object({ types: z.array(z.string().max(60)).max(50).optional().describe("Only these node types") }),
    write: false,
    run: (async (_user: Identity, a: { types?: string[] }) => ({
      nodes: catalogJson()
        .filter((n) => !a.types?.length || a.types.includes(n.type))
        .map((n) => ({ type: n.type, category: n.category, name: n.name[1], description: n.description[1], inline: n.inline, ports: n.ports, outputs: outputPaths(n.outputs), config: n.config })),
    })) as WorkflowTool["run"],
  },
  {
    name: "save_workflow_draft",
    title: "Save a workflow draft",
    description: `Replaces the draft of a workflow (pageId) or creates a new workflow page with it (workspaceId, spaceId, title, optional parentId). Answers the check. A draft never runs: a person activates it in Flowplan. ${GRAPH_HELP}`,
    input: z.object({
      pageId: id("Workflow page to change").optional(),
      workspaceId: id("Workspace ID (new workflow)").optional(),
      spaceId: id("Space ID (new workflow)").optional(),
      parentId: id("Parent page (new workflow)").optional(),
      title: z.string().trim().min(1).max(200).optional().describe("Title of a new workflow"),
      graph: z.record(z.string(), z.unknown()).describe("The graph"),
    }),
    write: true,
    run: (async (user: Identity, a: { pageId?: string; workspaceId?: string; spaceId?: string; parentId?: string; title?: string; graph: unknown }) => {
      let pageId = a.pageId;
      if (!pageId) {
        if (!a.workspaceId || !a.spaceId || !a.title) throw new z.ZodError([{ code: "custom", path: ["pageId"], message: "pageId, or workspaceId, spaceId and title for a new workflow", input: undefined }]);
        pageId = ((await command(user, { action: "page.create", workspaceId: a.workspaceId, spaceId: a.spaceId, parentId: a.parentId, kind: "workflow", title: a.title })) as { id: string }).id;
      }
      const saved = (await command(user, { action: "workflow.draft", pageId, graph: a.graph })) as { issues: unknown[] };
      return { pageId, issues: saved.issues, note: "Saved as draft. A person activates it in Flowplan." };
    }) as WorkflowTool["run"],
  },
  {
    name: "test_workflow",
    title: "Test a workflow draft",
    description:
      "Runs the draft once: mode \"dry\" (default) only reports what each node would do; \"test\" really acts as you. Data of the trigger: sample (default), the last real event, a record, a page or custom output. Read the result with get_workflow_run.",
    input: z.object({
      pageId: id("Page ID of the workflow"),
      mode: z.enum(["dry", "test"]).optional(),
      nodeId: z.string().max(40).optional().describe("Trigger node (default: the first)"),
      data: z
        .union([
          z.object({ kind: z.literal("sample") }),
          z.object({ kind: z.literal("last") }),
          z.object({ kind: z.literal("record"), rowId: z.uuid() }),
          z.object({ kind: z.literal("page"), pageId: z.uuid() }),
          z.object({ kind: z.literal("custom"), output: z.record(z.string(), z.unknown()) }),
        ])
        .optional(),
    }),
    write: true,
    run: (async (user: Identity, a: Record<string, unknown>) => await command(user, { ...a, action: "workflow.test", mode: a.mode || "dry" })) as WorkflowTool["run"],
  },
  {
    name: "run_workflow",
    title: "Start a workflow",
    description: "Starts an active workflow that has a manual trigger, with its inputs (by name). Runs as the workflow's runner; you are recorded as the one who started it.",
    input: z.object({
      pageId: id("Page ID of the workflow"),
      nodeId: z.string().max(40).optional(),
      inputs: z.record(z.string().max(60), z.unknown()).optional(),
    }),
    write: true,
    run: (async (user: Identity, a: Record<string, unknown>) => await command(user, { ...a, action: "workflow.run", mode: "live", source: "api" })) as WorkflowTool["run"],
  },
  {
    name: "list_workflow_runs",
    title: "List workflow runs",
    description: "The latest runs of a workflow (newest first) with status, version, error and failed node. Filters: status failed|succeeded|cancelled|open|waiting, mode live|test.",
    input: z.object({
      pageId: id("Page ID of the workflow"),
      status: z.enum(["failed", "succeeded", "cancelled", "open", "waiting"]).optional(),
      mode: z.enum(["live", "test"]).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    write: false,
    run: (async (user: Identity, a: { pageId: string; status?: string; mode?: string; limit?: number }) => await listRuns(user, a.pageId, { status: a.status, mode: a.mode, limit: a.limit })) as WorkflowTool["run"],
  },
  {
    name: "get_workflow_run",
    title: "Read a workflow run",
    description: "A run with its steps (status, attempts, errors). Inputs and outputs only when the run ran as you.",
    input: z.object({ runId: id("Run ID") }),
    write: false,
    run: (async (user: Identity, a: { runId: string }) => await runDetail(user, a.runId)) as WorkflowTool["run"],
  },
];
