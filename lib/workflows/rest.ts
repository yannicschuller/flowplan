// The REST routes of workflows for scripts and integrations
// (docs/specs/workflows.md §11.1): thin paths onto the same commands the
// interface sends to POST /api/command – the same rights, transaction,
// audit and limits. Read tokens never get here (the POST handler refuses
// them first); approvals are decided only when signed in (no token).
//
//   POST /api/workflows/import                  {workspaceId, spaceId, parentId?, title?, data, mapping?, preview?}
//   POST /api/workflows/{pageId}/draft          {graph}
//   POST /api/workflows/{pageId}/validate       {graph?}
//   POST /api/workflows/{pageId}/activate       {note?}
//   POST /api/workflows/{pageId}/pause          {cancelRuns?, reason?}
//   POST /api/workflows/{pageId}/run            {nodeId?, inputs?, mode?}
//   POST /api/workflows/{pageId}/test           {mode, nodeId?, data?, assume?}
//   POST /api/workflows/{pageId}/restore        {versionId}
//   POST /api/workflow-runs/{runId}/retry       {fromNode?}
//   POST /api/workflow-runs/{runId}/cancel
//   POST /api/workflow-approvals/{approvalId}   {decision, comment?}
import { z } from "zod";
import { HttpError } from "../auth";
import { command } from "../api";
import type { Identity } from "../types";
import { parseExport, resolveReferences } from "./portable";

const uuid = z.uuid();
const PAGE_ACTIONS: Record<string, string> = {
  draft: "workflow.draft",
  validate: "workflow.validate",
  activate: "workflow.activate",
  pause: "workflow.pause",
  run: "workflow.run",
  test: "workflow.test",
  restore: "workflow.restore",
};
const object = (body: unknown) => (body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {});

const importNew = z.object({
  workspaceId: uuid,
  spaceId: uuid,
  parentId: uuid.optional(),
  title: z.string().trim().min(1).max(200).optional(),
  data: z.unknown(),
  mapping: z.record(z.string().max(200), z.string().max(100)).default({}),
  preview: z.boolean().default(false),
});

// undefined: not a workflow route.
export async function workflowPost(user: Identity, path: string[], body: unknown): Promise<unknown | undefined> {
  const b = object(body);
  if (path[0] === "workflows" && path.length === 2 && path[1] === "import") {
    const input = importNew.parse(b);
    const data = parseExport(input.data);
    if (input.preview) {
      const { unresolved } = await resolveReferences(user, input.workspaceId, data, input.mapping);
      return { ok: true, preview: true, unresolved, references: data.references, title: data.title || null };
    }
    const title = input.title || data.title || "Workflow";
    const { id } = (await command(user, { action: "page.create", workspaceId: input.workspaceId, spaceId: input.spaceId, parentId: input.parentId, kind: "workflow", title })) as { id: string };
    const result = (await command(user, { action: "workflow.import", pageId: id, data, mapping: input.mapping })) as Record<string, unknown>;
    return { ...result, id };
  }
  if (path[0] === "workflows" && path.length === 3 && PAGE_ACTIONS[path[2]]) {
    const pageId = uuid.parse(path[1]);
    const extra = path[2] === "run" ? { source: "api" } : {};
    return await command(user, { ...b, ...extra, action: PAGE_ACTIONS[path[2]], pageId });
  }
  if (path[0] === "workflow-runs" && path.length === 3 && (path[2] === "retry" || path[2] === "cancel"))
    return await command(user, { ...b, action: path[2] === "retry" ? "workflow.run.retry" : "workflow.run.cancel", runId: uuid.parse(path[1]) });
  if (path[0] === "workflow-approvals" && path.length === 2) {
    if (user.apiScope) throw new HttpError(403, "Freigaben werden nur angemeldet entschieden, nicht mit einem API-Token.");
    return await command(user, { ...b, action: "workflow.approve", approvalId: uuid.parse(path[1]) });
  }
  return undefined;
}
