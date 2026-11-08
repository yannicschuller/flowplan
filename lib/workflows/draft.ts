// The draft of a workflow as a Yjs document (docs/specs/workflows.md §5.4):
// Y.Map("nodes") – id → Y.Map(type, typeVersion, label, note, position,
// disabled, onError, config), Y.Map("edges"), Y.Map("settings"). A node's
// config is a Y.Map of plain values (last writer wins per key); the longer
// texts (message, text, prompt) are Y.Text, so two people can type in them
// at once. Invalid intermediate states are allowed in the draft.
// Client-safe (the canvas uses the same functions).
import * as Y from "yjs";
import { emptyGraph, GRAPH_FORMAT, GRAPH_VERSION, type WorkflowEdge, type WorkflowGraph, type WorkflowNode } from "./graph";

export const TEXT_KEYS = new Set(["message", "text", "prompt"]);
const NODE_KEYS = ["type", "typeVersion", "label", "note", "position", "disabled", "onError"] as const;

// Only the changed middle of a text is replaced, so what someone else
// typed meanwhile at another place of it stays.
export function updateText(text: Y.Text, value: string) {
  const old = text.toString();
  if (old === value) return;
  let start = 0;
  while (start < old.length && start < value.length && old[start] === value[start]) start++;
  let end = 0;
  while (end < old.length - start && end < value.length - start && old[old.length - 1 - end] === value[value.length - 1 - end]) end++;
  if (old.length - start - end) text.delete(start, old.length - start - end);
  if (value.length - start - end) text.insert(start, value.slice(start, value.length - end));
}
function setConfig(map: Y.Map<unknown>, config: Record<string, unknown>) {
  for (const key of [...map.keys()]) if (!(key in config)) map.delete(key);
  for (const [key, value] of Object.entries(config)) {
    if (TEXT_KEYS.has(key) && typeof value === "string") {
      const current = map.get(key);
      if (current instanceof Y.Text) updateText(current, value);
      else map.set(key, new Y.Text(value));
    } else if (JSON.stringify(map.get(key)) !== JSON.stringify(value)) map.set(key, value);
  }
}
// Writes a graph into a draft document as changes against what is there
// (so it merges with what others typed meanwhile).
export function writeGraph(doc: Y.Doc, graph: WorkflowGraph) {
  doc.transact(() => {
    const nodes = doc.getMap<Y.Map<unknown>>("nodes");
    const edges = doc.getMap<unknown>("edges");
    const settings = doc.getMap<unknown>("settings");
    const ids = new Set(graph.nodes.map((n) => n.id));
    for (const key of [...nodes.keys()]) if (!ids.has(key)) nodes.delete(key);
    for (const n of graph.nodes) {
      let map = nodes.get(n.id);
      if (!(map instanceof Y.Map)) {
        map = new Y.Map<unknown>();
        nodes.set(n.id, map);
      }
      for (const key of NODE_KEYS) {
        const value = (n as Record<string, unknown>)[key];
        if (value === undefined) map.delete(key);
        else if (JSON.stringify(map.get(key)) !== JSON.stringify(value)) map.set(key, value);
      }
      let config = map.get("config");
      if (!(config instanceof Y.Map)) {
        config = new Y.Map<unknown>();
        map.set("config", config);
      }
      setConfig(config as Y.Map<unknown>, n.config || {});
    }
    const edgeIds = new Set(graph.edges.map((e) => e.id));
    for (const key of [...edges.keys()]) if (!edgeIds.has(key)) edges.delete(key);
    for (const e of graph.edges) if (JSON.stringify(edges.get(e.id)) !== JSON.stringify({ from: e.from, to: e.to })) edges.set(e.id, { from: e.from, to: e.to });
    for (const [key, value] of Object.entries(graph.settings || {})) if (JSON.stringify(settings.get(key)) !== JSON.stringify(value)) settings.set(key, value);
    for (const key of [...settings.keys()]) if (!(key in (graph.settings || {}))) settings.delete(key);
  });
}
export function graphDoc(graph: WorkflowGraph = emptyGraph()) {
  const doc = new Y.Doc();
  writeGraph(doc, graph);
  return doc;
}
// The draft as graph JSON (§5.1); unchecked – the check reports problems.
export function draftGraph(doc: Y.Doc): WorkflowGraph {
  const nodes: WorkflowNode[] = [];
  doc.getMap<Y.Map<unknown>>("nodes").forEach((map, nodeId) => {
    if (!(map instanceof Y.Map)) return;
    const config: Record<string, unknown> = {};
    const c = map.get("config");
    if (c instanceof Y.Map) c.forEach((value, key) => (config[key] = value instanceof Y.Text ? value.toString() : value instanceof Y.AbstractType ? value.toJSON() : value));
    const node: Record<string, unknown> = { id: nodeId, config };
    for (const key of NODE_KEYS) if (map.has(key)) node[key] = map.get(key);
    nodes.push(node as WorkflowNode);
  });
  const edges: WorkflowEdge[] = [];
  doc.getMap<{ from: WorkflowEdge["from"]; to: WorkflowEdge["to"] }>("edges").forEach((e, edgeId) => e && edges.push({ id: edgeId, from: e.from, to: e.to }));
  const settings = doc.getMap<unknown>("settings").toJSON() as WorkflowGraph["settings"];
  // Stable order: by position, then id (the map has none of its own).
  nodes.sort((a, b) => (a.position?.x ?? 0) - (b.position?.x ?? 0) || (a.position?.y ?? 0) - (b.position?.y ?? 0) || a.id.localeCompare(b.id));
  edges.sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
  return {
    format: GRAPH_FORMAT,
    version: GRAPH_VERSION,
    settings: Object.assign({ timeZone: "UTC", triggerOnOwnChanges: false, limits: {} }, settings),
    nodes,
    edges,
  };
}
// Node titles and notes, for search and the version list (like whiteboardSummary).
export function graphSummary(graph: WorkflowGraph) {
  const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  return graph.nodes
    .map((n) => [n.label, n.note].filter(Boolean).join(" – "))
    .filter(Boolean)
    .map((t) => `<p>${esc(t.slice(0, 2000))}</p>`)
    .join("")
    .slice(0, 400_000);
}
