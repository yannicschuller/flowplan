// What a marketplace needs to show a workflow without Flowplan's own code
// (docs: Marketplace): `payload/workflow-meta.json` next to
// payload/workflow.json in every workflow package, the workflow itself left
// unchanged so imports keep working –
//
//   { format: "flowplan.workflow-meta", version: 1,
//     nodes: { <type>: { name: {de, en}, description: {de, en}, group,
//                        icon: <SVG path data, viewBox 0 0 256 256, filled>,
//                        ports?: {<port>: {de, en}},
//                        external?: true, ai?: true, email?: true } },
//     gaps: [ { id, label: {de, en}, kind, optional? } ] }
//
// `nodes` holds exactly the node types the graph uses. `gaps` are what the
// person importing it sets: a gallery workflow's "$ask:<id>" tokens, or the
// references of a published one (databases, pages, people … by their id;
// the names of people and addresses are never in it). Only catalogue texts,
// symbols and reference titles go in – never a value of a node's settings,
// so no secret can end up here. Package text, not interface text: German
// and English only (kept out of the language catalogues).
import { AI_TYPES, nodeSpec, PORT_TEXT } from "./workflows/catalog";
import { NODE_ICON_PATHS } from "./workflows/node-icon-paths";
import type { WorkflowGraph } from "./workflows/graph";
import type { WorkflowExport } from "./workflows/portable";

export const WORKFLOW_META_FORMAT = "flowplan.workflow-meta";
export const WORKFLOW_META_VERSION = 1;
export const WORKFLOW_META_PATH = "payload/workflow-meta.json";
export const WORKFLOW_META_GAPS = 100;

type Text = { de: string; en: string };
export type WorkflowMetaNode = { name: Text; description: Text; group: string; icon: string; ports?: Record<string, Text>; external?: true; ai?: true; email?: true };
export type WorkflowMetaGap = { id: string; label: Text; kind: string; optional?: true };
export type WorkflowMeta = { format: typeof WORKFLOW_META_FORMAT; version: number; nodes: Record<string, WorkflowMetaNode>; gaps: WorkflowMetaGap[] };

// Nodes that talk to or take input from outside Flowplan.
const EXTERNAL = new Set(["http.request", "notify.chat", "trigger.webhook"]);
const EMAIL = new Set(["notify.email", "trigger.mail.received"]);
const pair = ([de, en]: [string, string]): Text => ({ de, en });

export function workflowMeta(graph: WorkflowGraph, gaps: WorkflowMetaGap[] = []): WorkflowMeta {
  const nodes: Record<string, WorkflowMetaNode> = {};
  for (const type of [...new Set(graph.nodes.map((n) => n.type))].sort()) {
    const s = nodeSpec(type);
    if (!s) continue;
    // The type's own outputs and those its nodes use here (switch cases are named in their settings).
    const used = graph.edges.filter((e) => graph.nodes.some((n) => n.id === e.from.node && n.type === type)).map((e) => e.from.port);
    const ports = Object.fromEntries([...new Set([...s.ports({}), ...used, "error"])].filter((p) => PORT_TEXT[p]).map((p) => [p, pair(PORT_TEXT[p])]));
    nodes[type] = {
      name: pair(s.name),
      description: pair(s.description),
      group: s.category,
      icon: NODE_ICON_PATHS[s.icon] ?? NODE_ICON_PATHS.Circle,
      ...(Object.keys(ports).length ? { ports } : {}),
      ...(EXTERNAL.has(type) ? { external: true as const } : {}),
      ...(AI_TYPES.has(type) ? { ai: true as const } : {}),
      ...(EMAIL.has(type) ? { email: true as const } : {}),
    };
  }
  return { format: WORKFLOW_META_FORMAT, version: WORKFLOW_META_VERSION, nodes, gaps: gaps.slice(0, WORKFLOW_META_GAPS) };
}

// What a reference is, when its title is not shared.
// Tuples, not {de, en} objects: package text stays out of the language catalogues.
const REFERENCE_KIND: Record<string, [string, string]> = {
  page: ["Seite", "Page"],
  database: ["Datenbank", "Database"],
  person: ["Person", "Person"],
  chatHook: ["Chat-Webhook", "Chat webhook"],
  address: ["E-Mail-Adresse", "E-mail address"],
  credential: ["Zugangsdaten", "Credential"],
  template: ["Vorlage", "Template"],
  tag: ["Tag", "Tag"],
  field: ["Eigenschaft", "Property"],
};
// The references of a published workflow (after publicWorkflow) as gaps:
// the import matches them by title or asks for them. Of a database's
// properties only those the graph names.
export function referenceGaps(data: WorkflowExport, graph: WorkflowGraph): WorkflowMetaGap[] {
  const text = JSON.stringify(graph.nodes);
  const out: WorkflowMetaGap[] = [];
  for (const [id, ref] of Object.entries(data.references)) {
    const kind = pair(REFERENCE_KIND[ref.kind] ?? [ref.kind, ref.kind]);
    const title = ref.kind === "person" || ref.kind === "address" ? "" : ref.title.trim().slice(0, 200);
    out.push({ id, kind: ref.kind, label: title ? pair([`${kind.de} „${title}“`, `${kind.en} “${title}”`]) : kind });
    for (const f of ref.fields ?? []) {
      if (!f.id || !text.includes(f.id)) continue;
      const name = f.name.trim().slice(0, 200);
      out.push({ id: f.id, kind: "field", label: pair(name ? [`Eigenschaft „${name}“`, `Property “${name}”`] : REFERENCE_KIND.field) });
    }
  }
  return out;
}

export const workflowMetaBytes = (meta: WorkflowMeta) => Buffer.from(`${JSON.stringify(meta, null, 2)}\n`);
