// The workflow actions of POST /api/command (lib/api.ts) and the reads of
// GET /api/workflows… (app/api/[...path]/route.ts) – the API contract is in
// docs/specs/workflows.md §11.1 ("Vertrag Welle 1").
import { z } from "zod";
import { audit, run } from "../db";
import { HttpError } from "../auth";
import { requireAdmin, requireMember } from "../permissions";
import type { Identity } from "../types";
import { catalogJson } from "./catalog";
import { envLimits, storedWorkflowLimits, workflowLimits, workflowLimitsSchema } from "./limits";
import { workflowMonitoring } from "./monitoring";
import {
  activateWorkflow,
  cancelRunCommand,
  listRuns,
  listWorkflows,
  manualStartInfo,
  pauseCommand,
  replaceDraft,
  requireWorkflow,
  restoreVersion,
  runDetail,
  startManualRun,
  startTestRun,
  syncDraft,
  workflowFromRule,
  workflowState,
  workflowVersion,
  workflowVersions,
  draftOf,
} from "./store";
import { validateGraph } from "./validate";
import { issueMessage, parseGraph } from "./graph";
import { contentLocale } from "../content-locale";
import { exportWorkflow, importCommand } from "./portable";
import { approvalDetail, decideApproval, hookCommand, listApprovals, listCredentials, listHooks, removeCredential, retryRun, setCredential, workflowResources } from "./actions";

export const WORKFLOW_ACTIONS = [
  "workflow.sync",
  "workflow.draft",
  "workflow.validate",
  "workflow.activate",
  "workflow.pause",
  "workflow.test",
  "workflow.run",
  "workflow.run.cancel",
  "workflow.restore",
  "workflow.fromRule",
  "workflow.run.retry",
  "workflow.approve",
  "workflow.hook",
  "workflow.credential.set",
  "workflow.credential.remove",
  "workflow.import",
] as const;

export async function workflowCommand(user: Identity, action: string, b: Record<string, unknown>): Promise<unknown> {
  switch (action) {
    case "workflow.sync":
      return await syncDraft(user, b);
    case "workflow.draft":
      return await replaceDraft(user, b);
    case "workflow.validate": {
      // The draft (or a given graph) checked as the caller would run it.
      const page = await requireWorkflow(user, z.string().parse(b.pageId), true);
      const graph = b.graph === undefined ? await draftOf(page) : parseGraph(b.graph);
      const locale = contentLocale();
      return { issues: (await validateGraph(graph, { workspaceId: page.workspace_id, runner: user, pageId: page.id })).map((i) => ({ ...i, message: issueMessage(i, locale) })) };
    }
    case "workflow.activate":
      return await activateWorkflow(user, b);
    case "workflow.pause":
      return await pauseCommand(user, b);
    case "workflow.test":
      return await startTestRun(user, b);
    case "workflow.run":
      return await startManualRun(user, b);
    case "workflow.run.cancel":
      return await cancelRunCommand(user, b);
    case "workflow.restore":
      return await restoreVersion(user, b);
    case "workflow.fromRule":
      return await workflowFromRule(user, b);
    case "workflow.run.retry":
      return await retryRun(user, b);
    case "workflow.approve":
      return await decideApproval(user, b);
    case "workflow.hook":
      return await hookCommand(user, b);
    case "workflow.credential.set":
      return await setCredential(user, b);
    case "workflow.credential.remove":
      return await removeCredential(user, b);
    case "workflow.import":
      return await importCommand(user, b);
    case "admin.workflowLimits": {
      // Administration → Limits → Workflows (§12): null follows the environment.
      requireAdmin(user);
      const next = workflowLimitsSchema.parse(b.limits ?? {});
      const merged = { ...(await storedWorkflowLimits()), ...next };
      await run("INSERT INTO instance_settings(key,value) VALUES('workflowLimits',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify(merged));
      await audit(user.id, "admin.workflowLimits", "", JSON.stringify(next).slice(0, 500));
      return await adminWorkflows(user);
    }
  }
  throw new HttpError(400, "Unbekannte Aktion.");
}

// GET /api/admin/workflows: the limits in force, what is stored, the
// environment's defaults, and the monitoring counters.
export async function adminWorkflows(user: Identity) {
  requireAdmin(user);
  return { limits: await workflowLimits(), stored: await storedWorkflowLimits(), defaults: envLimits(), monitoring: await workflowMonitoring() };
}

// GET /api/workflows…: path after "workflows" (or "workflow-runs").
export async function workflowGet(user: Identity, path: string[], url: URL): Promise<unknown | undefined> {
  if (path[0] === "workflows") {
    if (path.length === 1) return await listWorkflows(user, z.string().uuid().parse(url.searchParams.get("workspaceId")));
    if (path.length === 2 && path[1] === "catalog") {
      // Members of some workspace (the catalogue is the same everywhere).
      const workspaceId = url.searchParams.get("workspaceId");
      if (workspaceId) await requireMember(user, workspaceId);
      return { nodes: catalogJson() };
    }
    const pageId = path[1];
    if (path.length === 2) return await workflowState(user, pageId);
    if (path.length === 3 && path[2] === "runs")
      return await listRuns(user, pageId, {
        status: url.searchParams.get("status") || undefined,
        mode: url.searchParams.get("mode") || undefined,
        limit: Number(url.searchParams.get("limit") || 50),
        before: Number(url.searchParams.get("before") || 0) || undefined,
        q: url.searchParams.get("q") || undefined,
      });
    if (path.length === 3 && path[2] === "approvals") return await listApprovals(user, { pageId });
    if (path.length === 3 && path[2] === "credentials") return await listCredentials(user, pageId);
    if (path.length === 3 && path[2] === "hooks") return await listHooks(user, pageId);
    if (path.length === 3 && path[2] === "resources") return await workflowResources(user, pageId);
    if (path.length === 3 && path[2] === "versions") return await workflowVersions(user, pageId);
    if (path.length === 3 && path[2] === "export") return await exportWorkflow(user, pageId);
    if (path.length === 3 && path[2] === "start") return await manualStartInfo(user, pageId, url.searchParams.get("host") || undefined);
    if (path.length === 4 && path[2] === "versions") return await workflowVersion(user, pageId, z.string().uuid().parse(path[3]));
  }
  if (path[0] === "workflow-runs" && path.length === 2) return await runDetail(user, path[1]);
  if (path[0] === "workflow-approvals" && path.length === 1) return await listApprovals(user, { mine: true, workspaceId: url.searchParams.get("workspaceId") || undefined });
  if (path[0] === "workflow-approvals" && path.length === 2) return await approvalDetail(user, path[1]);
  if (path[0] === "admin" && path[1] === "workflows" && path.length === 2) return await adminWorkflows(user);
  return undefined;
}
