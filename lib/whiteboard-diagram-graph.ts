// The common ground of the Mermaid and PlantUML imports
// (lib/whiteboard-mermaid-import.ts, lib/whiteboard-plantuml-import.ts):
// both parse their text into a diagram graph (nodes, edges, groups) or a
// sequence model, which becomes editable board items here – library shapes
// and attached connectors, laid out with lib/whiteboard-autolayout.ts.
import type { BoardDraft } from "./whiteboard-import";
import type { ShapeKind } from "./whiteboard-model";
import type { MarkerKind } from "./whiteboard-diagram-model";
import { markerProps } from "./whiteboard-connector-markers";
import { layeredLayout, type LayoutDirection } from "./whiteboard-autolayout";
import { libraryShapes } from "./whiteboard-shapes-library";

export type DiagramKind = "flowchart" | "sequence" | "class" | "er" | "state" | "mindmap" | "activity" | "usecase" | "component";
export type DiagramNode = {
  id: string;
  label: string;
  // A library shape, or a plain shape kind.
  lib?: string;
  shape?: ShapeKind;
  group?: string;
  fill?: string;
  stroke?: string;
  textColor?: string;
  // Fixed size (start/end dots, fork bars).
  w?: number;
  h?: number;
};
export type DiagramEdge = {
  from: string;
  to: string;
  label?: string;
  dashed?: boolean;
  thick?: boolean;
  start?: MarkerKind;
  end?: MarkerKind;
};
export type DiagramGroup = { id: string; label: string; parent?: string };
export type DiagramGraph = {
  kind: Exclude<DiagramKind, "sequence">;
  direction: LayoutDirection;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  groups: DiagramGroup[];
};
export type SequenceEvent =
  | { type: "message"; from: string; to: string; label: string; dashed?: boolean; start?: MarkerKind; end: MarkerKind }
  | { type: "note"; over: string[]; side: "left" | "right" | "over"; text: string }
  | { type: "block"; kind: string; label: string }
  | { type: "else"; label: string }
  | { type: "end" };
export type SequenceModel = {
  kind: "sequence";
  participants: { id: string; label: string; actor?: boolean }[];
  events: SequenceEvent[];
};
// A line that was not understood (or understood but not shown).
export type DiagramSkip = { line: number; text: string };
export type ParsedDiagram = {
  source: "mermaid" | "plantuml";
  diagram: DiagramGraph | SequenceModel;
  skipped: DiagramSkip[];
};
export type DiagramErrorCode = "empty" | "unknown" | "unsupported" | "too-large" | "too-many";
export class DiagramImportError extends Error {
  constructor(
    public code: DiagramErrorCode,
    public detail = "",
  ) {
    super(`${code}${detail ? `: ${detail}` : ""}`);
  }
}
export const DIAGRAM_LIMITS = {
  chars: 100_000,
  lines: 4000,
  nodes: 400,
  edges: 800,
  participants: 40,
  events: 600,
  label: 500,
};

// ---- text helpers shared by the parsers ----

// A label as written: quotes off, <br> as line breaks, entity codes of
// Mermaid (#quot;) and HTML decoded, length bounded.
export function cleanLabel(raw: string) {
  let text = raw.trim();
  if (/^".*"$/s.test(text)) text = text.slice(1, -1);
  if (/^`.*`$/s.test(text)) text = text.slice(1, -1);
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/\\n/g, "\n")
    .replace(/#quot;/g, '"')
    .replace(/#(\d{1,6});/g, (_, n: string) => String.fromCodePoint(Math.min(0x10ffff, Number(n))))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .slice(0, DIAGRAM_LIMITS.label);
}
// Splits at `sep` outside quotes and brackets.
export function splitOutside(text: string, sep: string) {
  const parts: string[] = [];
  let depth = 0,
    quote = false,
    start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') quote = !quote;
    else if (!quote && "[({".includes(ch)) depth++;
    else if (!quote && "])}".includes(ch)) depth = Math.max(0, depth - 1);
    else if (!quote && !depth && ch === sep) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}
// The source split into lines with their numbers; limits checked.
export function sourceLines(text: string) {
  if (!text.trim()) throw new DiagramImportError("empty");
  if (text.length > DIAGRAM_LIMITS.chars) throw new DiagramImportError("too-large", String(DIAGRAM_LIMITS.chars));
  const lines = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  if (lines.length > DIAGRAM_LIMITS.lines) throw new DiagramImportError("too-large", String(DIAGRAM_LIMITS.chars));
  return lines.map((raw, i) => ({ n: i + 1, raw, text: raw.trim() }));
}
export function checkCounts(nodes: number, edges: number) {
  if (nodes > DIAGRAM_LIMITS.nodes || edges > DIAGRAM_LIMITS.edges)
    throw new DiagramImportError("too-many", String(DIAGRAM_LIMITS.nodes));
}

// ---- sizes ----

const defaults = new Map(libraryShapes.map((s) => [s.id, s]));
const FIXED = new Set(["uml:start", "uml:end", "uml:fork", "uml:merge", "bpmn:start", "bpmn:end", "flow:connector"]);
function measure(node: DiagramNode, kind: DiagramGraph["kind"]) {
  if (node.w && node.h) return { w: node.w, h: node.h };
  const def = node.lib ? defaults.get(node.lib) : undefined;
  if (node.lib && FIXED.has(node.lib) && def) return { w: def.w, h: def.h };
  const lines = node.label.split("\n");
  const longest = Math.max(1, ...lines.map((l) => [...l].length));
  if (node.lib === "uml:class" || node.lib === "uml:interface" || node.lib === "uml:enum" || node.lib === "erd:entity") {
    const rows = lines.filter((l) => !/^\s*-{2,}\s*$/.test(l)).length;
    const separators = lines.length - rows;
    return {
      w: Math.round(Math.max(170, Math.min(420, longest * 8.2 + 36))),
      h: Math.round(Math.max(70, 14 + rows * 21 + separators * 10 + 12)),
    };
  }
  if (node.lib === "uml:actor") return { w: 70, h: 110 };
  if (node.lib === "uml:note") return { w: Math.round(Math.max(140, Math.min(320, longest * 8 + 40))), h: Math.round(Math.max(60, lines.length * 20 + 28)) };
  const wide = node.lib === "flow:decision" || node.shape === "diamond" || node.lib === "erd:relationship";
  const round = node.shape === "ellipse" || node.lib === "uml:usecase";
  let w = Math.max(kind === "mindmap" ? 90 : 120, Math.min(340, longest * 8.4 + 40));
  let h = Math.max(kind === "mindmap" ? 44 : 56, lines.length * 20 + 28);
  if (wide) {
    w = Math.min(380, w * 1.45);
    h = Math.max(80, h * 1.4);
  } else if (round) {
    w = Math.min(380, w * 1.2);
    h = Math.max(60, h * 1.15);
  }
  if (node.shape === "ellipse" && kind === "flowchart") w = h = Math.max(w, h);
  return { w: Math.round(w), h: Math.round(h) };
}

// ---- graph → board items ----

const nodeColors: Partial<Record<DiagramGraph["kind"], string>> = {
  er: "#ffffff",
  class: "#ffffff",
};
const mindmapFills = ["#dbe4ff", "#d3f9d8", "#ffe8cc", "#e5dbff", "#fff3bf", "#ffe3e3", "#c5f6fa"];

export function graphDrafts(graph: DiagramGraph): BoardDraft[] {
  checkCounts(graph.nodes.length, graph.edges.length);
  const sizes = new Map(graph.nodes.map((n) => [n.id, measure(n, graph.kind)]));
  const mindmap = graph.kind === "mindmap";
  // Edges to a group (subgraph, composite state) count for the layout as
  // edges to its first member.
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  const representative = (id: string, seen = new Set<string>()): string | undefined => {
    if (nodeIds.has(id)) return id;
    if (seen.has(id)) return undefined;
    seen.add(id);
    return (
      graph.nodes.find((n) => n.group === id)?.id ??
      graph.groups.filter((g) => g.parent === id).map((g) => representative(g.id, seen)).find(Boolean)
    );
  };
  const layoutEdges = graph.edges
    .map((e) => ({ from: representative(e.from), to: representative(e.to) }))
    .filter((e): e is { from: string; to: string } => !!e.from && !!e.to);
  const layout = layeredLayout(
    graph.nodes.map((n) => ({ id: n.id, ...sizes.get(n.id)!, group: n.group })),
    layoutEdges,
    {
      direction: graph.direction,
      // Frames around groups need room: 24 px padding on each side and
      // the frame title above.
      rankGap: (mindmap ? 60 : graph.kind === "er" || graph.kind === "class" ? 90 : 64) + (graph.groups.length ? 80 : 0),
      nodeGap: (mindmap ? 18 : 44) + (graph.groups.length ? 56 : 0),
    },
  );
  const ids = new Map(graph.nodes.map((n, i) => [n.id, `n${i}`]));
  // Mind maps: every main branch has its colour.
  const branch = new Map<string, string>();
  if (mindmap && graph.nodes.length) {
    const root = graph.nodes[0].id;
    const children = new Map<string, string[]>();
    for (const e of graph.edges) children.set(e.from, [...(children.get(e.from) || []), e.to]);
    (children.get(root) || []).forEach((child, i) => {
      const stack = [child];
      while (stack.length) {
        const id = stack.pop()!;
        if (branch.has(id)) continue;
        branch.set(id, mindmapFills[i % mindmapFills.length]);
        stack.push(...(children.get(id) || []));
      }
    });
  }
  const drafts: BoardDraft[] = [];
  graph.nodes.forEach((node, i) => {
    const p = layout.get(node.id) || { x: 0, y: 0 };
    const size = sizes.get(node.id)!;
    const isRoot = mindmap && i === 0;
    drafts.push({
      id: ids.get(node.id)!,
      type: "shape",
      shape: node.shape || (node.lib ? libraryOutline(node.lib) : "rounded"),
      ...(node.lib ? { lib: node.lib } : {}),
      x: p.x,
      y: p.y,
      w: size.w,
      h: size.h,
      text: node.label,
      fill: node.fill || (isRoot ? "#3b3fd8" : branch.get(node.id)) || nodeColors[graph.kind] || "#ffffff",
      stroke: node.stroke || (isRoot ? "#3b3fd8" : mindmap ? "#868e96" : "#1f2937"),
      strokeWidth: 2,
      fontSize: isRoot ? 18 : 14,
      ...(isRoot ? { textColor: "#ffffff", bold: true } : node.textColor ? { textColor: node.textColor } : {}),
    });
  });
  // Groups (subgraphs, packages, composite states) become frames around
  // their members; inner frames first so they stay above the outer ones.
  const members = (groupId: string): BoardDraft[] => [
    ...graph.nodes.filter((n) => n.group === groupId).map((n) => drafts.find((d) => d.id === ids.get(n.id))!),
    ...graph.groups.filter((g) => g.parent === groupId).flatMap((g) => frames.get(g.id) || []),
  ];
  const frames = new Map<string, BoardDraft[]>();
  const depth = (g: DiagramGroup): number => (g.parent ? 1 + depth(graph.groups.find((x) => x.id === g.parent) || { id: "", label: "" }) : 0);
  const ordered = [...graph.groups].sort((a, b) => depth(b) - depth(a));
  const frameDrafts: BoardDraft[] = [];
  for (const group of ordered) {
    const inside = members(group.id).filter(Boolean);
    if (!inside.length) continue;
    const pad = 24;
    const x = Math.min(...inside.map((d) => d.x)) - pad,
      y = Math.min(...inside.map((d) => d.y)) - pad - (inside.some((d) => d.type === "frame") ? 30 : 0),
      right = Math.max(...inside.map((d) => d.x + d.w)) + pad,
      bottom = Math.max(...inside.map((d) => d.y + d.h)) + pad;
    const frame: BoardDraft = { id: `g${frameDrafts.length}`, type: "frame", x, y, w: right - x, h: bottom - y, text: group.label, fill: "#f8f9fa" };
    frames.set(group.id, [frame]);
    frameDrafts.push(frame);
  }
  const endpoint = (id: string) => (nodeIds.has(id) ? drafts.find((d) => d.id === ids.get(id)) : frames.get(id)?.[0]);
  const connectors: BoardDraft[] = [];
  for (const edge of graph.edges) {
    const a = endpoint(edge.from),
      b = endpoint(edge.to);
    if (!a || !b || a === b) continue;
    connectors.push({
      id: `e${connectors.length}`,
      type: "connector",
      x: 0,
      y: 0,
      w: 0,
      h: 0,
      from: { id: a.id, x: a.x + a.w / 2, y: a.y + a.h / 2 },
      to: { id: b.id, x: b.x + b.w / 2, y: b.y + b.h / 2 },
      stroke: mindmap ? "#868e96" : "#1f2937",
      strokeWidth: edge.thick ? 3 : 2,
      route: mindmap ? "curved" : "straight",
      ...(edge.dashed ? { dashed: true } : {}),
      ...(edge.label ? { text: edge.label } : {}),
      ...markerProps("start", edge.start || "none"),
      ...markerProps("end", edge.end ?? (mindmap ? "none" : "arrow")),
    });
  }
  return [...frameDrafts, ...drafts, ...connectors];
}
function libraryOutline(id: string): ShapeKind {
  if (/decision|gateway|relationship|merge/.test(id)) return "diamond";
  if (/start|end|connector|usecase|attribute|multivalued/.test(id)) return "ellipse";
  if (/terminator|state|task|subprocess/.test(id)) return "rounded";
  return "rectangle";
}

// ---- sequence diagrams ----

export function sequenceDrafts(model: SequenceModel): BoardDraft[] {
  if (model.participants.length > DIAGRAM_LIMITS.participants || model.events.length > DIAGRAM_LIMITS.events)
    throw new DiagramImportError("too-many", String(DIAGRAM_LIMITS.nodes));
  const drafts: BoardDraft[] = [];
  const column = new Map<string, number>();
  let x = 0;
  const widths = model.participants.map((p) => Math.max(130, Math.min(260, Math.max(...p.label.split("\n").map((l) => [...l].length)) * 8.4 + 36)));
  model.participants.forEach((p, i) => {
    column.set(p.id, x + widths[i] / 2);
    x += widths[i] + 70;
  });
  const center = (id: string) => column.get(id) ?? 0;
  let y = 96;
  // Fragments lie below the messages, so those stay easy to grab.
  const fragments: BoardDraft[] = [];
  const blocks: { kind: string; label: string; top: number; used: Set<string>; elses: { y: number; label: string }[] }[] = [];
  const use = (...ids: string[]) => blocks.forEach((b) => ids.forEach((id) => b.used.add(id)));
  const connector = (from: { x: number; y: number }, to: { x: number; y: number }, extra: Partial<BoardDraft>): BoardDraft => ({
    id: `m${drafts.length}`,
    type: "connector",
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    from,
    to,
    stroke: "#1f2937",
    strokeWidth: 2,
    route: "straight",
    ...extra,
  });
  for (const event of model.events) {
    if (event.type === "message") {
      use(event.from, event.to);
      const ends = { ...markerProps("start", event.start || "none"), ...markerProps("end", event.end) };
      const style = { ...(event.dashed ? { dashed: true } : {}), ...ends };
      if (event.from === event.to) {
        // A message to itself: a small loop to the right.
        const cx = center(event.from);
        drafts.push(connector({ x: cx, y }, { x: cx + 44, y }, { ...markerProps("end", "none"), ...(event.dashed ? { dashed: true } : {}), ...(event.label ? { text: event.label } : {}) }));
        drafts.push(connector({ x: cx + 44, y }, { x: cx + 44, y: y + 26 }, { ...markerProps("end", "none"), ...(event.dashed ? { dashed: true } : {}) }));
        drafts.push(connector({ x: cx + 44, y: y + 26 }, { x: cx, y: y + 26 }, style));
        y += 64;
      } else {
        drafts.push(connector({ x: center(event.from), y }, { x: center(event.to), y }, { ...style, ...(event.label ? { text: event.label } : {}) }));
        y += 52;
      }
    } else if (event.type === "note") {
      use(...event.over);
      const lines = event.text.split("\n");
      const h = Math.max(48, lines.length * 20 + 24);
      const xs = event.over.map(center);
      let left: number, w: number;
      if (event.side === "over") {
        left = Math.min(...xs) - 70;
        w = Math.max(140, Math.max(...xs) - Math.min(...xs) + 140);
      } else {
        w = Math.max(130, Math.min(280, Math.max(...lines.map((l) => [...l].length)) * 8 + 36));
        left = event.side === "right" ? xs[0] + 16 : xs[0] - 16 - w;
      }
      drafts.push({ id: `t${drafts.length}`, type: "shape", shape: "rectangle", lib: "uml:note", x: left, y: y - 16, w, h, text: event.text, fill: "#fff9db", stroke: "#1f2937", strokeWidth: 2, fontSize: 14 });
      y += h + 12;
    } else if (event.type === "block") {
      blocks.push({ kind: event.kind, label: event.label, top: y - 22, used: new Set(), elses: [] });
      y += 34;
    } else if (event.type === "else") {
      const block = blocks[blocks.length - 1];
      if (block) {
        block.elses.push({ y: y - 10, label: event.label });
        y += 30;
      }
    } else {
      const block = blocks.pop();
      if (!block) continue;
      const xs = [...(block.used.size ? block.used : new Set(model.participants.map((p) => p.id)))].map(center);
      const left = Math.min(...xs) - 100,
        right = Math.max(...xs) + 100;
      fragments.push({
        id: `f${fragments.length}`,
        type: "shape",
        shape: "rectangle",
        lib: "uml:fragment",
        x: left - blocks.length * 10,
        y: block.top,
        w: right - left + blocks.length * 20,
        h: y - block.top,
        text: `${block.kind}${block.label ? ` [${block.label}]` : ""}`,
        fill: "transparent",
        stroke: "#868e96",
        strokeWidth: 1,
        fontSize: 13,
      });
      for (const part of block.elses)
        drafts.push(connector({ x: left, y: part.y }, { x: right, y: part.y }, { stroke: "#868e96", strokeWidth: 1, dashed: true, ...markerProps("end", "none"), ...(part.label ? { text: `[${part.label}]` } : {}) }));
      y += 18;
    }
  }
  const height = Math.max(240, y + 30);
  model.participants.forEach((p, i) => {
    drafts.unshift({
      id: `p${i}`,
      type: "shape",
      shape: "rectangle",
      lib: p.actor ? "uml:lifeline-actor" : "uml:lifeline",
      x: center(p.id) - widths[i] / 2,
      y: 0,
      w: widths[i],
      h: height,
      text: p.label,
      fill: p.actor ? "transparent" : "#ffffff",
      stroke: "#1f2937",
      strokeWidth: 2,
      fontSize: 14,
    });
  });
  return [...drafts.slice(0, model.participants.length), ...fragments, ...drafts.slice(model.participants.length)];
}
