"use client";
// The canvas of a workflow (docs/specs/workflows.md §10.1, §10.10), with
// @xyflow/react: nodes from the draft, dragged (snapped to a 20 px grid)
// and connected by their outputs; Tab goes from node to node in graph
// order, Enter opens the panel, arrows move the selected node (Shift:
// further), Delete removes it, A appends, C connects, Ctrl/Cmd+Z/Y undo and
// redo, Ctrl/Cmd+D duplicates, L shows the list, F fits the view. Loaded
// with the workflow page only (dynamic import), never on phones.
import "@xyflow/react/dist/base.css";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  MiniMap,
  applyNodeChanges,
  getBezierPath,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeProps,
  type NodeChange,
  type NodeSelectionChange,
} from "@xyflow/react";
import { Plus } from "@phosphor-icons/react";
import { useLocale } from "../i18n";
import { isTrigger } from "@/lib/workflows/catalog";
import { nodePorts, outgoing, type WorkflowGraph } from "@/lib/workflows/graph";
import { displayContext, issuesOf, nodeSummary, orderedNodes, portLabel, typeName, worstLevel, type Issue, type Workspace, useStableT } from "./model";
import { NodeCard, inlineNodes, type CardNode } from "./node-card";
import { DRAG_TYPE } from "./palette";
import { stepStatus } from "./node-panel";

export type NodeStatus = { status: string; duration: string };
export type CanvasProps = {
  graph: WorkflowGraph;
  ws: Workspace;
  issues: Issue[];
  editable: boolean;
  selected: string | null;
  statuses: Map<string, NodeStatus>;
  onSelect: (id: string | null) => void;
  onMove: (moves: { id: string; x: number; y: number }[]) => void;
  onConnect: (from: { node: string; port: string }, to: string) => void;
  onDeleteNode: (id: string) => void;
  onDeleteEdge: (id: string) => void;
  onAdd: (type: string, position: { x: number; y: number }) => void;
  onAppend: (afterId: string | null) => void;
  onInsert: (edgeId: string) => void;
  onConnectDialog: (id: string) => void;
  onDuplicate: (id: string) => void;
  onUndo: () => void;
  onRedo: () => void;
  onList: () => void;
};

const nodeTypes = { wf: NodeCard };

// A connection with "+" to insert a node in between.
function InsertEdge(props: EdgeProps<Edge<{ onInsert?: (id: string) => void; label: string }>>) {
  const [path, x, y] = getBezierPath(props);
  return (
    <>
      <BaseEdge id={props.id} path={path} markerEnd={props.markerEnd} style={props.style} />
      {props.data?.onInsert && (
        <EdgeLabelRenderer>
          <button
            type="button"
            className="wf-edge-add nodrag nopan"
            style={{ transform: `translate(-50%, -50%) translate(${x}px,${y}px)` }}
            aria-label={props.data.label}
            title={props.data.label}
            onClick={() => props.data?.onInsert?.(props.id)}
          >
            <Plus weight="bold" aria-hidden />
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
const edgeTypes = { wf: InsertEdge };

function Flow(props: CanvasProps) {
  const t = useStableT();
  const locale = useLocale();
  const { graph, ws, issues, editable, selected, statuses } = props;
  const flow = useReactFlow();
  const ctx = useMemo(() => displayContext(graph, locale, ws), [graph, locale, ws]);
  const inline = useMemo(() => inlineNodes(graph), [graph]);
  const derived = useMemo<CardNode[]>(
    () =>
      orderedNodes(graph).map((n) => {
        const summary = nodeSummary(n, ws, ctx, t);
        const st = statuses.get(n.id);
        const outs = outgoing(graph, n.id).length;
        const level = worstLevel(issuesOf(issues, n.id));
        return {
          id: n.id,
          type: "wf",
          position: n.position,
          selected: n.id === selected,
          deletable: false,
          ariaLabel: [
            `${typeName(n.type, t)}: ${n.label}`,
            summary,
            st ? stepStatus(st.status, t) : "",
            level === "error" ? t("mit Fehlern", "with errors") : level === "warning" ? t("mit Warnungen", "with warnings") : "",
            outs === 1 ? t("1 Verbindung ausgehend", "1 outgoing connection") : t(`${outs} Verbindungen ausgehend`, `${outs} outgoing connections`),
          ]
            .filter(Boolean)
            .join(", "),
          data: {
            node: n,
            typeName: typeName(n.type, t),
            summary,
            level,
            status: st?.status || null,
            statusText: st ? stepStatus(st.status, t) : "",
            duration: st?.duration || "",
            inline: inline.has(n.id),
            inlineText: t("Sofortteil: läuft beim Speichern mit", "Immediate part: runs as the record is saved"),
            ports: nodePorts(n).map((p) => ({ id: p, label: portLabel(p, t) })),
            disabledText: t("abgeschaltet", "switched off"),
          },
        };
      }),
    [graph, ws, ctx, t, statuses, issues, selected, inline],
  );
  const [nodes, setNodes] = useState<CardNode[]>(derived);
  useEffect(
    () =>
      setNodes((prev) => {
        const old = new Map(prev.map((n) => [n.id, n]));
        return derived.map((n) => {
          const o = old.get(n.id);
          return o ? { ...n, measured: o.measured, position: o.dragging ? o.position : n.position, dragging: o.dragging } : n;
        });
      }),
    [derived],
  );
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const edges = useMemo<Edge[]>(() => {
    const labels = new Map(graph.nodes.map((n) => [n.id, n.label]));
    return graph.edges.map((e) => ({
      id: e.id,
      source: e.from.node,
      sourceHandle: e.from.port,
      target: e.to.node,
      targetHandle: "in",
      type: editable ? "wf" : "default",
      ariaLabel: t(`Verbindung von „${labels.get(e.from.node)}“ (${portLabel(e.from.port, t)}) nach „${labels.get(e.to.node)}“`, `Connection from “${labels.get(e.from.node)}” (${portLabel(e.from.port, t)}) to “${labels.get(e.to.node)}”`),
      className: `port-${e.from.port}`,
      selected: e.id === selectedEdge,
      data: { onInsert: editable ? props.onInsert : undefined, label: t("Knoten dazwischen einfügen", "Insert a node in between") },
    }));
  }, [graph, editable, props.onInsert, t, selectedEdge]);

  const onNodesChange = useCallback(
    (changes: NodeChange<CardNode>[]) => {
      setNodes((ns) => applyNodeChanges(changes, ns));
      // Selection by the person (click, Enter, Esc, the pane): the panel follows.
      const picked = changes.find((c): c is NodeSelectionChange => c.type === "select" && c.selected);
      if (picked) props.onSelect(picked.id);
      else if (changes.some((c) => c.type === "select" && !c.selected && c.id === selected)) props.onSelect(null);
      const moves = changes.flatMap((c) => (c.type === "position" && c.position && !c.dragging ? [{ id: c.id, x: Math.round(c.position.x), y: Math.round(c.position.y) }] : []));
      if (moves.length && editable) props.onMove(moves);
    },
    [editable, props, selected],
  );
  const wrapper = useRef<HTMLDivElement>(null);
  const focusedNode = () => {
    const el = document.activeElement?.closest?.(".react-flow__node") as HTMLElement | null;
    return el?.dataset.id || selected;
  };
  const key = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest("input, textarea, select, [contenteditable=true]")) return;
    const mod = e.metaKey || e.ctrlKey;
    const id = focusedNode();
    const k = e.key.toLowerCase();
    if (mod && k === "z" && !e.shiftKey) props.onUndo();
    else if (mod && (k === "y" || (k === "z" && e.shiftKey))) props.onRedo();
    else if (mod && k === "d" && id && editable) props.onDuplicate(id);
    else if (mod || e.altKey) return;
    else if ((e.key === "Delete" || e.key === "Backspace") && editable) {
      const edge = document.activeElement?.closest?.(".react-flow__edge") as HTMLElement | null;
      const edgeId = edge?.dataset.id || selectedEdge;
      if (edgeId && (edge || !id)) {
        props.onDeleteEdge(edgeId);
        setSelectedEdge(null);
      }
      else if (id) props.onDeleteNode(id);
      else return;
    } else if (k === "a" && editable) props.onAppend(id || null);
    else if (k === "c" && id && editable) props.onConnectDialog(id);
    else if (k === "l") props.onList();
    else if (k === "f") void flow.fitView({ padding: 0.2, duration: 0 });
    else if (e.key === "Escape" && selected) props.onSelect(null);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  // Fit the view once the nodes have their sizes.
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current || !nodes.length || !nodes.every((n) => n.measured)) return;
    fitted.current = true;
    void flow.fitView({ padding: 0.25, maxZoom: 1.1, duration: 0 });
  }, [nodes, flow]);
  return (
    <div className="wf-canvas" ref={wrapper} onKeyDown={key}>
      <ReactFlow<CardNode>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={(changes) => {
          for (const c of changes) if (c.type === "select") setSelectedEdge((cur) => (c.selected ? c.id : cur === c.id ? null : cur));
        }}
        onNodeDragStop={(_e, _n, dragged) => editable && props.onMove(dragged.map((n) => ({ id: n.id, x: Math.round(n.position.x), y: Math.round(n.position.y) })))}
        onConnect={(c: Connection) => c.source && c.target && props.onConnect({ node: c.source, port: c.sourceHandle || "out" }, c.target)}
        isValidConnection={(c) => {
          const to = graph.nodes.find((n) => n.id === c.target);
          return !!to && !isTrigger(to.type) && c.source !== c.target && c.targetHandle === "in";
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(DRAG_TYPE)) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
          }
        }}
        onDrop={(e) => {
          const type = e.dataTransfer.getData(DRAG_TYPE);
          if (!type || !editable) return;
          e.preventDefault();
          const p = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
          props.onAdd(type, { x: Math.round(p.x / 20) * 20, y: Math.round(p.y / 20) * 20 });
        }}
        nodesDraggable={editable}
        nodesConnectable={editable}
        elementsSelectable
        nodesFocusable
        edgesFocusable={editable}
        deleteKeyCode={null}
        selectionKeyCode={null}
        multiSelectionKeyCode={null}
        snapToGrid
        snapGrid={[20, 20]}
        minZoom={0.25}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        ariaLabelConfig={{
          "node.a11yDescription.default": t(
            "Enter öffnet die Einstellungen, Pfeiltasten verschieben, Entf löscht, A fügt dahinter an, C verbindet.",
            "Enter opens the settings, arrow keys move, Delete removes, A appends after it, C connects.",
          ),
          "node.a11yDescription.keyboardDisabled": t("Enter öffnet die Einstellungen.", "Enter opens the settings."),
          "edge.a11yDescription.default": t("Entf löscht die Verbindung.", "Delete removes the connection."),
          "controls.ariaLabel": t("Ansicht", "View"),
          "controls.zoomIn.ariaLabel": t("Vergrößern", "Zoom in"),
          "controls.zoomOut.ariaLabel": t("Verkleinern", "Zoom out"),
          "controls.fitView.ariaLabel": t("Alles zeigen", "Fit view"),
          "controls.interactive.ariaLabel": t("Sperren", "Lock"),
          "minimap.ariaLabel": t("Übersichtskarte", "Mini map"),
          "handle.ariaLabel": t("Anschluss", "Handle"),
          "node.a11yDescription.ariaLiveMessage": ({ direction, x, y }: { direction: string; x: number; y: number }) => t(`Verschoben (${direction}) nach ${x}, ${y}`, `Moved ${direction} to ${x}, ${y}`),
        }}
      >
        <Background gap={20} size={1} />
        <Controls showInteractive={false} position="bottom-left" />
        <MiniMap pannable zoomable position="bottom-right" className="wf-minimap" nodeStrokeWidth={2} style={{ width: 160, height: 100 }} />
      </ReactFlow>
    </div>
  );
}

export default function WorkflowCanvas(props: CanvasProps) {
  return (
    <ReactFlowProvider>
      <Flow {...props} />
    </ReactFlowProvider>
  );
}
