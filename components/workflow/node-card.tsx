"use client";
// A node on the canvas (docs/specs/workflows.md §10.2): symbol, label, one
// line about its settings, a dot for the check's findings, ⚡ for the
// immediate part, labelled outputs; during a test or in a run a status ring
// with a symbol (never the colour alone) and the duration.
import { memo } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { Lightning, Warning, WarningCircle, Check, X, Clock, MinusCircle } from "@phosphor-icons/react";
import { isTrigger, nodeSpec } from "@/lib/workflows/catalog";
import { outgoing, type WorkflowGraph, type WorkflowNode } from "@/lib/workflows/graph";
import { NodeIcon } from "./node-icon";

export type CardData = {
  node: WorkflowNode;
  typeName: string;
  summary: string;
  level: "error" | "warning" | null;
  status: string | null;
  statusText: string;
  duration: string;
  inline: boolean;
  inlineText: string;
  ports: { id: string; label: string }[];
  disabledText: string;
  mark?: "added" | "changed" | null;
  markText?: string;
  // Tablets: tapping an output starts a connection (canvas.tsx).
  onPortTap?: (port: string) => void;
  pending?: string | null;
};
export type CardNode = Node<CardData, "wf">;

// Whether a node runs in the immediate part (lib/workflows/inline.ts
// runsInline, reached from an inline-capable trigger through such nodes).
const runsInline = (n: WorkflowNode) => {
  const s = nodeSpec(n.type);
  if (!s?.inline) return false;
  if (n.type === "action.record.update" || n.type === "action.record.template") return !String(n.config.record || "").trim();
  return true;
};
export function inlineNodes(graph: WorkflowGraph) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const out = new Set<string>();
  const stack = graph.nodes.filter((n) => isTrigger(n.type) && nodeSpec(n.type)?.inline).map((n) => n.id);
  while (stack.length) {
    const id = stack.pop()!;
    for (const e of outgoing(graph, id)) {
      const next = byId.get(e.to.node);
      if (next && !out.has(next.id) && runsInline(next)) {
        out.add(next.id);
        stack.push(next.id);
      }
    }
  }
  return out;
}
export const runsInlineHere = (graph: WorkflowGraph, node: WorkflowNode) => inlineNodes(graph).has(node.id);

const STATUS_ICON: Record<string, typeof Check> = { succeeded: Check, failed: X, running: Clock, queued: Clock, waiting: Clock, held: Clock, skipped: MinusCircle, cancelled: MinusCircle };

function NodeCardView({ data, selected }: NodeProps<CardNode>) {
  const { node } = data;
  const trigger = isTrigger(node.type);
  const S = data.status ? STATUS_ICON[data.status] : null;
  return (
    <div className={`wf-card wf-cat-${nodeSpec(node.type)?.category || "logic"}${selected ? " selected" : ""}${node.disabled ? " off" : ""}${data.status ? ` status-${data.status}` : ""}${data.mark ? ` wf-mark-${data.mark}` : ""}${data.ports.length > 1 ? " many-ports" : ""}`}>
      {data.mark && <span className="wf-card-mark">{data.markText}</span>}
      {!trigger && <Handle type="target" position={Position.Left} id="in" className="wf-handle-in" />}
      <div className="wf-card-head">
        <NodeIcon type={node.type} />
        <span className="wf-card-type">{data.typeName}</span>
        {data.inline && <Lightning weight="fill" className="wf-card-inline" aria-label={data.inlineText} />}
        {data.level === "error" && <WarningCircle weight="fill" className="wf-card-error" aria-hidden />}
        {data.level === "warning" && <Warning className="wf-card-warning" aria-hidden />}
      </div>
      <div className="wf-card-label">{node.label}</div>
      {data.summary && <div className="wf-card-summary">{data.summary}</div>}
      {node.disabled && <div className="wf-card-summary">{data.disabledText}</div>}
      {S && (
        <div className="wf-card-status">
          <S weight="bold" aria-hidden /> {data.statusText}
          {data.duration && <span> · {data.duration}</span>}
        </div>
      )}
      <div className="wf-card-ports">
        {data.ports.map((p, i) => (
          <div key={p.id} className="wf-port" style={{ top: data.ports.length > 1 ? `${((i + 1) / (data.ports.length + 1)) * 100}%` : undefined }}>
            {data.onPortTap ? (
              <button type="button" className={`wf-port-label wf-port-tap nodrag${data.pending === p.id ? " pending" : ""}`} aria-pressed={data.pending === p.id} onClick={(e) => (e.stopPropagation(), data.onPortTap!(p.id))}>
                {p.label}
              </button>
            ) : data.ports.length > 1 || p.id !== "out" ? (
              <span className="wf-port-label">{p.label}</span>
            ) : null}
            <Handle type="source" position={Position.Right} id={p.id} className={`wf-handle-out port-${p.id}`} />
          </div>
        ))}
      </div>
    </div>
  );
}
export const NodeCard = memo(NodeCardView);
