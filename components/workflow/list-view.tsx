"use client";
// The list view (docs/specs/workflows.md §10.2, §10.10): the same graph as
// an ordered outline – triggers first, branches indented below the output
// they start from. Arrow keys move between the nodes, Enter opens the
// settings, Delete removes, A appends behind, C connects. Read-only on
// phones (and for people who may not edit).
import { useMemo, useRef, type KeyboardEvent } from "react";
import { ArrowElbowDownRight, WarningCircle, Warning } from "@phosphor-icons/react";
import { useLocale } from "../i18n";
import type { WorkflowGraph } from "@/lib/workflows/graph";
import { displayContext, issuesOf, nodeSummary, outline, portLabel, typeName, worstLevel, type Issue, type Workspace, useStableT } from "./model";
import { NodeIcon } from "./node-icon";
import { stepStatus } from "./node-panel";
import type { NodeStatus } from "./canvas";

export function ListView({
  graph,
  ws,
  issues,
  statuses,
  selected,
  editable,
  onSelect,
  onDelete,
  onAppend,
  onConnect,
}: {
  graph: WorkflowGraph;
  ws: Workspace;
  issues: Issue[];
  statuses: Map<string, NodeStatus>;
  selected: string | null;
  editable: boolean;
  onSelect: (id: string) => void;
  onDelete?: (id: string) => void;
  onAppend?: (id: string) => void;
  onConnect?: (id: string) => void;
}) {
  const t = useStableT();
  const locale = useLocale();
  const ctx = useMemo(() => displayContext(graph, locale, ws), [graph, locale, ws]);
  const rows = useMemo(() => outline(graph), [graph]);
  const list = useRef<HTMLOListElement>(null);
  const labels = new Map(graph.nodes.map((n) => [n.id, n.label]));
  const move = (from: HTMLElement, by: number) => {
    const items = [...(list.current?.querySelectorAll<HTMLElement>("[data-node]") || [])];
    items[Math.max(0, Math.min(items.length - 1, items.indexOf(from) + by))]?.focus();
  };
  const key = (e: KeyboardEvent<HTMLButtonElement>, id: string) => {
    if (e.key === "ArrowDown") move(e.currentTarget, 1);
    else if (e.key === "ArrowUp") move(e.currentTarget, -1);
    else if (e.key === "Home") move(e.currentTarget, -1000);
    else if (e.key === "End") move(e.currentTarget, 1000);
    else if (editable && (e.key === "Delete" || e.key === "Backspace") && onDelete) onDelete(id);
    else if (editable && e.key.toLowerCase() === "a" && !e.metaKey && !e.ctrlKey && onAppend) onAppend(id);
    else if (editable && e.key.toLowerCase() === "c" && !e.metaKey && !e.ctrlKey && onConnect) onConnect(id);
    else return;
    e.preventDefault();
  };
  if (!rows.length) return <p className="muted wf-empty">{t("Noch keine Knoten.", "No nodes yet.")}</p>;
  return (
    <ol className="wf-list-view" ref={list} aria-label={t("Ablauf als Liste", "The flow as a list")}>
      {rows.map(({ node, depth, port, via }) => {
        const level = worstLevel(issuesOf(issues, node.id));
        const st = statuses.get(node.id);
        const summary = nodeSummary(node, ws, ctx, t);
        return (
          <li key={node.id} style={{ marginInlineStart: depth * 22 }}>
            {port && via && (
              <span className="wf-list-branch muted">
                <ArrowElbowDownRight aria-hidden /> {`${labels.get(via)}: ${portLabel(port, t)}`}
              </span>
            )}
            <button
              type="button"
              data-node={node.id}
              className={`wf-list-node${node.id === selected ? " selected" : ""}${st ? ` status-${st.status}` : ""}`}
              aria-current={node.id === selected || undefined}
              onClick={() => onSelect(node.id)}
              onKeyDown={(e) => key(e, node.id)}
            >
              <NodeIcon type={node.type} />
              <span className="wf-list-text">
                <strong>{node.label}</strong>
                <span className="muted">
                  {typeName(node.type, t)}
                  {summary && ` · ${summary}`}
                  {node.disabled && ` · ${t("abgeschaltet", "switched off")}`}
                </span>
              </span>
              {st && (
                <span className="wf-list-status">
                  {stepStatus(st.status, t)}
                  {st.duration && ` · ${st.duration}`}
                </span>
              )}
              {level === "error" && <WarningCircle weight="fill" className="wf-card-error" aria-label={t("Fehler", "Error")} />}
              {level === "warning" && <Warning className="wf-card-warning" aria-label={t("Warnung", "Warning")} />}
            </button>
          </li>
        );
      })}
    </ol>
  );
}
