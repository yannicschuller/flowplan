// Workflow pages in content archives and instance moves (lib/archive.ts,
// docs/specs/workflows.md §3, §11.4): the draft and the activated
// versions, never runs or secrets. Imported workflows are paused (if they
// were active) so nothing starts unexpectedly on another instance; page and
// database ids inside the graphs follow the archive's new ids.
import * as Y from "yjs";
import { z } from "zod";
import { all, id, one, run } from "../db";
import { draftGraph } from "./draft";
import { parseGraph } from "./graph";
import { createWorkflowRecord, hashGraph } from "./store";

export const workflowArchiveSchema = z.object({
  graph: z.unknown(),
  status: z.enum(["draft", "active", "paused", "auto_paused"]).default("draft"),
  versions: z
    .array(z.object({ number: z.number().int().min(1), graph: z.unknown(), note: z.string().max(500).default(""), activatedAt: z.number().int() }))
    .max(1000)
    .default([]),
});
export type WorkflowArchive = z.infer<typeof workflowArchiveSchema>;

export async function workflowArchive(pageId: string): Promise<WorkflowArchive> {
  const draft = await one<{ state: Uint8Array }>("SELECT state FROM workflow_drafts WHERE page_id=?", pageId);
  const doc = new Y.Doc();
  if (draft) Y.applyUpdate(doc, draft.state);
  const graph = draftGraph(doc);
  doc.destroy();
  const wf = await one<{ status: WorkflowArchive["status"] }>("SELECT status FROM workflows WHERE page_id=?", pageId);
  const versions = await all<{ number: number; graph: string; note: string; activated_at: number }>("SELECT number,graph,note,activated_at FROM workflow_versions WHERE page_id=? ORDER BY number", pageId);
  return { graph, status: wf?.status ?? "draft", versions: versions.map((v) => ({ number: v.number, graph: JSON.parse(v.graph), note: v.note, activatedAt: v.activated_at })) };
}

// The draft for exports (Markdown ZIP: .flowplan-workflow.json).
export async function workflowExportGraph(page: { id: string }) {
  return (await workflowArchive(page.id)).graph as ReturnType<typeof draftGraph>;
}

// Ids of pages copied along, inside a graph's JSON.
const remap = (graph: unknown, pages: Map<string, string>) =>
  JSON.parse(JSON.stringify(graph).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (m) => pages.get(m) ?? m));

export async function importWorkflow(pageId: string, workspaceId: string, archive: WorkflowArchive, userId: string, pages: Map<string, string> = new Map()) {
  let draft;
  try {
    draft = parseGraph(remap(archive.graph, pages));
  } catch {
    draft = undefined;
  }
  await createWorkflowRecord(pageId, workspaceId, userId, draft);
  let last: string | null = null;
  for (const v of archive.versions) {
    let graph;
    try {
      graph = parseGraph(remap(v.graph, pages));
    } catch {
      continue;
    }
    last = id();
    await run(
      "INSERT INTO workflow_versions(id,page_id,number,graph,graph_hash,activated_by,activated_at,note) VALUES(?,?,?,?,?,?,?,?)",
      last,
      pageId,
      v.number,
      JSON.stringify(graph),
      hashGraph(graph),
      null,
      v.activatedAt,
      v.note,
    );
  }
  // Never active after an import: paused (with its versions) or a draft.
  if (last && archive.status !== "draft")
    await run("UPDATE workflows SET status='paused',active_version_id=?,pause_reason=?,paused_at=? WHERE page_id=?", last, "Importiert.", Date.now(), pageId);
}
