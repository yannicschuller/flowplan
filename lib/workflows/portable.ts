// JSON export and import of a workflow (docs/specs/workflows.md §11.4):
//
//   export  { format, version, exportedAt, source: {instance, workspace},
//             graph, references: {<id>: {kind, title, fields?, …}} }
//           – the draft for editors, the active version for readers; never
//           runs, credentials (only name, kind and host as a reference to
//           link again), webhook addresses or inbound tokens.
//   import  a new workflow page (or the draft of an existing, empty one) –
//           always a draft, never active. References are matched by id (the
//           same workspace), by title, or by the mapping the person chose;
//           what is left is cleared and listed as `unresolved`. A preview
//           answers what would be unresolved without writing anything.
//
// The file may come from anywhere: it is parsed with the graph schema (1 MB,
// the format version), every mapped id is checked against what the
// importing person may read, and nothing in it runs before a person
// activates the draft.
import { z } from "zod";
import { all, audit, one } from "../db";
import { HttpError, appUrl } from "../auth";
import { pageRole } from "../permissions";
import type { Identity, Page } from "../types";
import { GRAPH_FORMAT, GRAPH_LIMITS, GRAPH_VERSION, parseGraph, type WorkflowGraph } from "./graph";
import { draftOf, replaceDraft, requireWorkflow } from "./store";
import { databaseFields } from "./nodes/data";
import { workflowChatHooks } from "../webhooks";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export const referenceKinds = ["page", "database", "person", "chatHook", "address", "credential", "template", "tag"] as const;
const referenceSchema = z.object({
  kind: z.enum(referenceKinds),
  title: z.string().max(500).default(""),
  pageKind: z.string().max(30).optional(),
  fields: z.array(z.object({ id: z.string().max(100), name: z.string().max(200), type: z.string().max(30) })).max(500).optional(),
  host: z.string().max(300).optional(),
  credentialKind: z.string().max(20).optional(),
});
export type WorkflowReference = z.infer<typeof referenceSchema>;
export const workflowExportSchema = z.object({
  format: z.literal(GRAPH_FORMAT),
  version: z.number().int().min(1),
  exportedAt: z.string().max(40).optional(),
  source: z.object({ instance: z.string().max(500).optional(), workspace: z.object({ id: z.string().max(100), name: z.string().max(500) }).partial().optional() }).partial().optional(),
  title: z.string().max(500).optional(),
  graph: z.unknown(),
  references: z.record(z.string().max(100), referenceSchema).default({}),
});
export type WorkflowExport = z.infer<typeof workflowExportSchema>;

/* ---------- Where ids sit in a graph ---------- */

type Walk = (value: string, at: { node: string; type: string; key: string }) => string;
// Every string of the configuration (and the keys of `values`, which are
// property ids), with the node it belongs to.
function mapStrings(graph: WorkflowGraph, fn: Walk): WorkflowGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      const walk = (v: unknown, key: string): unknown => {
        if (typeof v === "string") return fn(v, { node: n.id, type: n.type, key });
        if (Array.isArray(v)) return v.map((x) => walk(x, key));
        if (v && typeof v === "object")
          return Object.fromEntries(
            Object.entries(v as Record<string, unknown>).map(([k, x]) => [key === "values" ? fn(k, { node: n.id, type: n.type, key: "values.key" }) : k, walk(x, k)]),
          );
        return v;
      };
      return { ...n, config: walk(n.config, "") as Record<string, unknown> };
    }),
  };
}
const idsIn = (graph: WorkflowGraph) => {
  const out = new Set<string>();
  mapStrings(graph, (s) => {
    for (const m of s.matchAll(UUID)) out.add(m[0].toLowerCase());
    return s;
  });
  return out;
};
// Ids of chat webhooks, credentials and inbound addresses (not always UUIDs).
const KEYED: Record<string, "chatHook" | "credential" | "address"> = { webhook: "chatHook", credential: "credential", address: "address" };
const keyedIds = (graph: WorkflowGraph) => {
  const out = new Map<string, "chatHook" | "credential" | "address">();
  for (const n of graph.nodes)
    for (const [key, kind] of Object.entries(KEYED)) {
      const v = (n.config as Record<string, unknown>)[key];
      if (typeof v === "string" && v) out.set(v, kind);
    }
  return out;
};

// Property ids sit in these places: the keys of `values`, `field`, `fields`
// of the record trigger, `left` of "Find", `sort.field`, "field:<id>"
// recipients and placeholders "….record.fields.<id>" / "….fields.<id>".
function mapFieldIds(graph: WorkflowGraph, map: Map<string, string>, drop: Set<string>, seen?: Set<string>): WorkflowGraph {
  if (!map.size && !drop.size && !seen) return graph;
  const sub = (id: string) => (seen?.add(id), map.get(id) ?? (drop.has(id) ? "" : id));
  const placeholder = (s: string) => s.replace(/(\.fields\.)([A-Za-z0-9_-]+)/g, (m, pre: string, id: string) => (seen?.add(id), map.has(id) ? pre + map.get(id) : m));
  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      const c = structuredClone(n.config) as Record<string, unknown>;
      if (c.values && typeof c.values === "object")
        c.values = Object.fromEntries(Object.entries(c.values as Record<string, unknown>).map(([k, v]) => [sub(k), v] as const).filter(([k]) => k));
      if (typeof c.field === "string") c.field = sub(c.field);
      if (Array.isArray(c.fields) && n.type === "trigger.record.changed") c.fields = (c.fields as string[]).map(sub).filter(Boolean);
      if (c.sort && typeof c.sort === "object" && typeof (c.sort as { field?: unknown }).field === "string") (c.sort as { field: string }).field = sub((c.sort as { field: string }).field);
      if (n.type === "action.record.find") {
        const walk = (g: { rules?: { kind: string; left?: string; rules?: unknown[] }[] }) => {
          for (const r of g?.rules || []) if (r.kind === "group") walk(r as never);
          else if (typeof r.left === "string") r.left = sub(r.left);
        };
        walk(c.filter as never);
      }
      for (const key of ["to", "approvers"]) if (Array.isArray(c[key])) c[key] = (c[key] as string[]).map((x) => (typeof x === "string" && x.startsWith("field:") ? (sub(x.slice(6)) ? `field:${sub(x.slice(6))}` : "") : x)).filter((x) => x !== "");
      const deep = (v: unknown): unknown => (typeof v === "string" ? placeholder(v) : Array.isArray(v) ? v.map(deep) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)])) : v);
      return { ...n, config: deep(c) as Record<string, unknown> };
    }),
  };
}

// The property ids a graph names (in the places mapFieldIds knows).
function usedFieldIds(graph: WorkflowGraph): Set<string> {
  const seen = new Set<string>();
  mapFieldIds(graph, new Map(), new Set(), seen);
  return seen;
}

/* ---------- Export ---------- */

export async function exportWorkflow(user: Identity, pageId: string): Promise<WorkflowExport> {
  const page = await requireWorkflow(user, pageId);
  const role = await pageRole(user, page);
  const editor = (role === "editor" || role === "owner") && user.apiScope !== "read";
  const wf = await one<{ active_version_id: string | null }>("SELECT active_version_id FROM workflows WHERE page_id=?", page.id);
  const version = wf?.active_version_id ? await one<{ graph: string }>("SELECT graph FROM workflow_versions WHERE id=?", wf.active_version_id) : undefined;
  // Editors export the draft, readers what runs.
  let graph: WorkflowGraph | null = editor ? await draftOf(page) : version ? parseGraph(JSON.parse(version.graph)) : null;
  if (!graph) throw new HttpError(404, "Dieser Workflow wurde noch nicht aktiviert.");
  const references: Record<string, WorkflowReference> = {};
  for (const ref of idsIn(graph)) {
    const p = await one<Page>("SELECT * FROM pages WHERE id=? AND deleted_at IS NULL", ref);
    if (p && p.workspace_id === page.workspace_id) {
      // Titles only of what the person may read.
      const readable = !!(await pageRole(user, p));
      if (p.kind === "database")
        references[ref] = { kind: "database", title: readable ? p.title : "", ...(readable ? { fields: (await databaseFields(p.id)).map((f) => ({ id: f.id, name: f.name, type: f.type })) } : {}) };
      else references[ref] = { kind: "page", title: readable ? p.title : "", pageKind: p.kind };
      continue;
    }
    const person = await one<{ name: string }>("SELECT u.name FROM members m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? AND m.user_id=?", page.workspace_id, ref);
    if (person) {
      references[ref] = { kind: "person", title: person.name };
      continue;
    }
    const template = await one<{ name: string }>("SELECT name FROM row_templates WHERE id=?", ref);
    if (template) references[ref] = { kind: "template", title: template.name };
  }
  const hooks = new Map((await workflowChatHooks(page.workspace_id)).map((h) => [h.id, h]));
  for (const [ref, kind] of keyedIds(graph)) {
    if (kind === "chatHook") references[ref] = { kind, title: hooks.get(ref)?.host || "", host: hooks.get(ref)?.host };
    if (kind === "address") {
      const a = await one<{ label: string }>("SELECT label FROM inbound_addresses WHERE id=? AND workspace_id=?", ref, page.workspace_id);
      references[ref] = { kind, title: a?.label || "" };
    }
    if (kind === "credential") {
      // Name, kind and host to link again – never the secret.
      const c = await one<{ name: string; kind: string; host: string }>("SELECT name,kind,host FROM workflow_credentials WHERE id=? AND page_id=?", ref, page.id);
      references[ref] = { kind, title: c?.name || "", credentialKind: c?.kind, host: c?.host };
    }
  }
  const ws = await one<{ id: string; name: string }>("SELECT id,name FROM workspaces WHERE id=?", page.workspace_id);
  return {
    format: GRAPH_FORMAT,
    version: GRAPH_VERSION,
    exportedAt: new Date().toISOString(),
    source: { instance: appUrl(), workspace: ws ? { id: ws.id, name: ws.name } : undefined },
    title: page.title,
    graph,
    references,
  };
}

/* ---------- Import ---------- */

export type Unresolved = { id: string; kind: WorkflowReference["kind"] | "field"; title: string; of?: string; types?: string[] };

// The references of an export matched in `workspaceId` for `user`: the
// person's choice (`mapping`) first, then the same id, then the title.
export async function resolveReferences(user: Identity, workspaceId: string, data: WorkflowExport, mapping: Record<string, string> = {}) {
  const graph = parseGraph(data.graph);
  const map = new Map<string, string>();
  const unresolved: Unresolved[] = [];
  const pages = await all<Page>("SELECT * FROM pages WHERE workspace_id=? AND deleted_at IS NULL AND kind<>'workflow'", workspaceId);
  const readable = async (p: Page | undefined) => !!p && p.workspace_id === workspaceId && !!(await pageRole(user, p));
  const members = await all<{ id: string; name: string }>(
    "SELECT u.id,u.name FROM members m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? AND NOT EXISTS(SELECT 1 FROM workspace_guests g WHERE g.workspace_id=m.workspace_id AND g.user_id=m.user_id)",
    workspaceId,
  );
  const hooks = await workflowChatHooks(workspaceId);
  const refs = { ...data.references };
  // Ids in the graph the file says nothing about: matched by id only.
  for (const id of idsIn(graph)) if (!refs[id]) refs[id] = { kind: "page", title: "" };
  for (const [id, kind] of keyedIds(graph)) if (!refs[id]) refs[id] = { kind, title: "" };
  for (const [old, ref] of Object.entries(refs)) {
    const chosen = mapping[old];
    const byTitle = (list: Page[]) => (ref.title ? list.find((p) => p.title.trim().toLowerCase() === ref.title.trim().toLowerCase()) : undefined);
    let target: string | undefined;
    if (ref.kind === "page" || ref.kind === "database") {
      const kindOk = (p: Page) => (ref.kind === "database" ? p.kind === "database" : p.kind !== "database");
      const candidates = pages.filter(kindOk);
      const pick = chosen ? candidates.find((p) => p.id === chosen) : candidates.find((p) => p.id === old) || byTitle(candidates);
      if (pick && (await readable(pick))) target = pick.id;
    } else if (ref.kind === "person") {
      const pick = chosen ? members.find((m) => m.id === chosen) : members.find((m) => m.id === old) || (ref.title ? members.find((m) => m.name.toLowerCase() === ref.title.toLowerCase()) : undefined);
      target = pick?.id;
    } else if (ref.kind === "chatHook") {
      const pick = chosen ? hooks.find((h) => h.id === chosen) : hooks.find((h) => h.id === old) || (ref.host ? hooks.find((h) => h.host === ref.host) : undefined);
      target = pick?.id;
    } else if (ref.kind === "template") {
      const pick = await one<{ id: string; page_id: string }>("SELECT id,page_id FROM row_templates WHERE id=?", chosen || old);
      if (pick && (await readable(pages.find((p) => p.id === pick.page_id)))) target = pick.id;
    }
    // Addresses and credentials belong to one workflow page: always linked again.
    if (target) map.set(old, target);
    else unresolved.push({ id: old, kind: ref.kind, title: ref.title, ...(ref.host ? { types: [ref.host] } : {}) });
  }
  // Properties of the mapped databases: by id, else by name (and type).
  const fieldMap = new Map<string, string>();
  const dropFields = new Set<string>();
  const used = usedFieldIds(graph);
  for (const [old, ref] of Object.entries(refs)) {
    if (ref.kind !== "database" || !map.has(old)) continue;
    const now = await databaseFields(map.get(old)!);
    for (const f of (ref.fields || []).filter((x) => used.has(x.id))) {
      const chosen = mapping[`${old}:${f.id}`];
      const match = (chosen && now.find((x) => x.id === chosen)) || now.find((x) => x.id === f.id && x.type === f.type) || now.find((x) => x.name.toLowerCase() === f.name.toLowerCase() && x.type === f.type) || now.find((x) => x.name.toLowerCase() === f.name.toLowerCase());
      if (match) {
        if (match.id !== f.id) fieldMap.set(f.id, match.id);
      } else {
        dropFields.add(f.id);
        unresolved.push({ id: `${old}:${f.id}`, kind: "field", title: f.name, of: old, types: [f.type] });
      }
    }
  }
  return { graph, map, fieldMap, dropFields, unresolved };
}

// The graph with the matched ids; unmatched ones cleared (never an id of
// something the person may not reach).
export function applyReferences(graph: WorkflowGraph, map: Map<string, string>, fieldMap: Map<string, string>, dropFields: Set<string>, unresolved: Unresolved[]): WorkflowGraph {
  const cleared = new Set(unresolved.filter((u) => u.kind !== "field").map((u) => u.id.toLowerCase()));
  const keyed = keyedIds(graph);
  let out = mapStrings(graph, (s, at) => {
    if (keyed.has(s) && at.key in KEYED) return map.get(s) ?? "";
    return s.replace(UUID, (m) => map.get(m.toLowerCase()) ?? map.get(m) ?? (cleared.has(m.toLowerCase()) ? "" : m));
  });
  // Cleared people leave the recipient lists; cleared scopes become the workspace.
  out = {
    ...out,
    nodes: out.nodes.map((n) => {
      const c = { ...n.config } as Record<string, unknown>;
      for (const key of ["to", "approvers", "people", "tags"]) if (Array.isArray(c[key])) c[key] = (c[key] as unknown[]).filter((x) => x !== "");
      const scope = c.scope as { kind?: string; pageId?: string; spaceId?: string } | undefined;
      if (scope?.kind === "below" && !scope.pageId) c.scope = { kind: "workspace" };
      if (scope?.kind === "space" && !scope.spaceId) c.scope = { kind: "workspace" };
      return { ...n, config: c };
    }),
  };
  return mapFieldIds(out, fieldMap, dropFields);
}

// workflow.import: the file into the draft of this workflow page (empty,
// or `replace`); `preview` only answers what would stay unresolved.
const importInput = z.object({
  pageId: z.uuid(),
  data: z.unknown(),
  mapping: z.record(z.string().max(200), z.string().max(100)).default({}),
  preview: z.boolean().default(false),
  replace: z.boolean().default(false),
});
export async function importCommand(user: Identity, raw: unknown) {
  const b = importInput.parse(raw);
  const data = parseExport(b.data);
  const page = await requireWorkflow(user, b.pageId, true);
  const resolved = await resolveReferences(user, page.workspace_id, data, b.mapping);
  const graph = applyReferences(resolved.graph, resolved.map, resolved.fieldMap, resolved.dropFields, resolved.unresolved);
  const unresolved = resolved.unresolved;
  if (b.preview) return { ok: true, preview: true, unresolved, references: data.references, title: data.title || null };
  if (!b.replace && (await draftOf(page)).nodes.length) throw new HttpError(409, "Der Entwurf ist nicht leer.");
  const saved = (await replaceDraft(user, { pageId: page.id, graph })) as { issues: unknown[] };
  await audit(user.id, "workflow.imported", page.id, JSON.stringify({ from: data.source?.instance || null, unresolved: unresolved.length }).slice(0, 500));
  return { ok: true, unresolved, issues: saved.issues };
}

export function parseExport(raw: unknown): WorkflowExport {
  if (JSON.stringify(raw ?? null).length > GRAPH_LIMITS.bytes * 2) throw new HttpError(413, "Die Datei ist zu groß.");
  // A bare graph is accepted as well.
  const looksLikeGraph = !!raw && typeof raw === "object" && Array.isArray((raw as { nodes?: unknown }).nodes);
  const data = looksLikeGraph ? { format: GRAPH_FORMAT, version: (raw as { version?: number }).version ?? GRAPH_VERSION, graph: raw, references: {} } : raw;
  const version = (data as { version?: unknown } | null)?.version;
  if (typeof version === "number" && version > GRAPH_VERSION) throw new HttpError(400, "Dieser Workflow stammt aus einer neueren Flowplan-Version.");
  const parsed = workflowExportSchema.safeParse(data);
  if (!parsed.success) throw new HttpError(400, "Keine Workflow-Datei.");
  try {
    parseGraph(parsed.data.graph);
  } catch (error) {
    throw new HttpError(400, error instanceof z.ZodError ? "Ungültiger Workflow." : (error as Error).message);
  }
  return parsed.data;
}
