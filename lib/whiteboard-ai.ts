// AI on whiteboards and the sticky → record bridge: the shared, client-safe
// part. Limits, the JSON shapes the model must answer with (zod – nothing
// from a model is rendered or stored unchecked) and the pure layouts that
// turn an answer into board elements:
//
//   cluster   the model names themes and assigns note references ("n1" …);
//             assignGroups() keeps every note in exactly one group, themeLayout()
//             arranges the groups as labelled columns (like clusterItems in
//             lib/whiteboard-tools.ts does for colours and people).
//   generate  a mind map (a tree) or a flowchart (nodes and edges);
//             mindmapPlan() / flowchartPlan() give nodes and connectors at the
//             view centre – the mind map with the board's own mind-map layout.
//   records   colours of notes and select options (guessOption).
//
// The server part is lib/ai/whiteboard.ts (prompts, reading the board) and
// lib/whiteboard-to-records.ts (the command whiteboard.toRecords); the UI is
// components/whiteboard/ai-panel.tsx.
import { z } from "zod";
import { mindmapLayout } from "./whiteboard-tools";
import type { ShapeKind, WhiteboardItem } from "./whiteboard-model";

export const WB_AI_LIMITS = {
  // Notes sent to the model for clustering (the rest is reported).
  notes: 300,
  noteChars: 400,
  groups: 12,
  themeChars: 80,
  // A description for "Mit KI erzeugen".
  prompt: 2000,
  mindmapNodes: 60,
  mindmapDepth: 4,
  flowNodes: 40,
  flowEdges: 80,
  nodeText: 120,
  // Summaries: elements read from a board.
  summaryItems: 2000,
  // Sticky → record: per command and per run.
  batch: 100,
  records: 500,
  // "Mit KI aufteilen": notes per request.
  split: 40,
} as const;

// ---- Cluster ----

const ref = z.union([z.string().trim().max(20), z.number().int().nonnegative()]);
export const clusterAnswerSchema = z.object({
  groups: z
    .array(
      z.object({
        theme: z.string().trim().min(1).max(200),
        notes: z.array(ref).max(WB_AI_LIMITS.notes),
      }),
    )
    .min(1)
    .max(40),
});
export type ClusterAnswer = z.infer<typeof clusterAnswerSchema>;
export type ThemeGroup = { label: string; ids: string[] };

// Note references as the model sees them: n1, n2 … (no ids to invent).
export const noteRef = (index: number) => `n${index + 1}`;

// The model's groups as item ids: unknown references are dropped, every note
// lands in exactly one group (its first), at most `WB_AI_LIMITS.groups`
// groups (smaller ones beyond that and unassigned notes go to `rest`).
export function assignGroups(ids: string[], answer: ClusterAnswer, rest: string): ThemeGroup[] {
  const byRef = new Map(ids.map((id, i) => [noteRef(i), id]));
  const taken = new Set<string>();
  const groups: ThemeGroup[] = [];
  for (const group of answer.groups) {
    const members: string[] = [];
    for (const raw of group.notes) {
      const key = typeof raw === "number" ? noteRef(raw - 1) : raw.toLowerCase().replace(/^#/, "").replace(/^(\d+)$/, "n$1");
      const id = byRef.get(key);
      if (id && !taken.has(id)) {
        taken.add(id);
        members.push(id);
      }
    }
    if (!members.length) continue;
    const label = group.theme.replace(/\s+/g, " ").trim().slice(0, WB_AI_LIMITS.themeChars);
    const same = groups.find((g) => g.label.toLocaleLowerCase() === label.toLocaleLowerCase());
    if (same) same.ids.push(...members);
    else groups.push({ label, ids: members });
  }
  const unassigned = ids.filter((id) => !taken.has(id));
  const room = WB_AI_LIMITS.groups - (unassigned.length ? 1 : 0);
  let kept = groups,
    leftover = unassigned;
  if (groups.length > room) {
    // The largest groups stay (in the model's order), the rest joins `rest`.
    const largest = new Set([...groups].sort((a, b) => b.ids.length - a.ids.length).slice(0, WB_AI_LIMITS.groups - 1));
    kept = groups.filter((g) => largest.has(g));
    leftover = [...groups.filter((g) => !largest.has(g)).flatMap((g) => g.ids), ...unassigned];
  }
  if (leftover.length) {
    const other = kept.find((g) => g.label === rest);
    if (other) other.ids.push(...leftover);
    else kept.push({ label: rest, ids: leftover });
  }
  return kept;
}

type Box = { x: number; y: number; w: number; h: number };
// Groups as labelled columns, notes in a small grid inside each, wrapping
// into rows so a board with many themes stays roughly square. Starts where
// the notes are now (their top-left corner).
export function themeLayout(list: (Box & { id: string })[], groups: ThemeGroup[], gap = 20) {
  const positions: { id: string; x: number; y: number }[] = [];
  const labels: { text: string; x: number; y: number; w: number }[] = [];
  if (!list.length) return { positions, labels };
  const byId = new Map(list.map((i) => [i.id, i]));
  const x0 = Math.min(...list.map((i) => i.x));
  const y0 = Math.min(...list.map((i) => i.y));
  const size = Math.max(...list.map((i) => Math.max(i.w, i.h)));
  const cell = size + gap;
  const blocks = groups
    .map((g) => ({ ...g, ids: g.ids.filter((id) => byId.has(id)) }))
    .filter((g) => g.ids.length)
    .map((g) => {
      const columns = g.ids.length > 12 ? 3 : g.ids.length > 4 ? 2 : 1;
      const rows = Math.ceil(g.ids.length / columns);
      return { ...g, columns, w: columns * cell - gap, h: 44 + rows * cell - gap };
    });
  const total = blocks.reduce((s, b) => s + b.w * b.h, 0);
  const rowWidth = Math.max(cell * 3, Math.sqrt(total) * 1.6);
  let x = x0,
    y = y0,
    rowHeight = 0;
  for (const block of blocks) {
    if (x > x0 && x + block.w - x0 > rowWidth) {
      x = x0;
      y += rowHeight + gap * 3;
      rowHeight = 0;
    }
    labels.push({ text: block.label, x, y, w: Math.max(block.w, 200) });
    block.ids.forEach((id, n) => positions.push({ id, x: x + (n % block.columns) * cell, y: y + 44 + Math.floor(n / block.columns) * cell }));
    x += block.w + gap * 3;
    rowHeight = Math.max(rowHeight, block.h);
  }
  return { positions, labels };
}

// ---- Generate: mind maps and flowcharts ----

export const GENERATE_KINDS = ["mindmap", "flowchart"] as const;
export type GenerateKind = (typeof GENERATE_KINDS)[number];

type TreeNode = { text: string; children?: TreeNode[] };
const nodeText = z.string().trim().min(1).max(500);
export const mindmapNodeSchema: z.ZodType<TreeNode> = z.lazy(() =>
  z.object({ text: nodeText, children: z.array(mindmapNodeSchema).max(30).optional() }),
);
export const mindmapAnswerSchema = z.object({ root: mindmapNodeSchema });
export const FLOW_NODE_TYPES = ["start", "end", "step", "decision", "input"] as const;
export const flowchartAnswerSchema = z.object({
  nodes: z
    .array(
      z.object({
        id: z.union([z.string().trim().min(1).max(40), z.number()]).transform(String),
        text: nodeText,
        type: z.enum(FLOW_NODE_TYPES).catch("step"),
      }),
    )
    .min(1)
    .max(100),
  edges: z
    .array(
      z.object({
        from: z.union([z.string().trim().max(40), z.number()]).transform(String),
        to: z.union([z.string().trim().max(40), z.number()]).transform(String),
        label: z.string().trim().max(60).nullish(),
      }),
    )
    .max(200)
    .default([]),
});
export type FlowchartAnswer = z.infer<typeof flowchartAnswerSchema>;

// What the server returns and the browser places: plain nodes and links,
// already within the limits.
export type BoardNode = { key: string; text: string; shape: ShapeKind; level: number; w: number; h: number };
export type BoardLink = { from: string; to: string; label?: string };
export type GeneratedStructure = { kind: GenerateKind; nodes: BoardNode[]; links: BoardLink[]; dropped: number };
export const generatedSchema = z.object({
  kind: z.enum(GENERATE_KINDS),
  nodes: z
    .array(
      z.object({
        key: z.string().max(40),
        text: z.string().max(WB_AI_LIMITS.nodeText),
        shape: z.enum(["rectangle", "rounded", "ellipse", "triangle", "diamond", "star", "hexagon", "parallelogram", "arrow", "cloud"]),
        level: z.number().int().min(0).max(10),
        w: z.number().min(40).max(400),
        h: z.number().min(30).max(300),
      }),
    )
    .max(100),
  links: z.array(z.object({ from: z.string().max(40), to: z.string().max(40), label: z.string().max(60).optional() })).max(200),
  dropped: z.number().int().min(0),
});

const clip = (text: string, max: number = WB_AI_LIMITS.nodeText) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};
// Height for a text in a box of this width (roughly 8 px per character at 15 px).
const heightFor = (text: string, w: number, min: number) => Math.min(200, Math.max(min, Math.ceil((text.length * 8) / (w - 24)) * 20 + 24));

// A mind map answer within the limits: breadth first, so cutting keeps the
// upper levels.
export function mindmapStructure(root: TreeNode): GeneratedStructure {
  const nodes: BoardNode[] = [];
  const links: BoardLink[] = [];
  let total = 0;
  const queue: { node: TreeNode; level: number; parent?: string }[] = [{ node: root, level: 0 }];
  while (queue.length) {
    const { node, level, parent } = queue.shift()!;
    total++;
    if (nodes.length >= WB_AI_LIMITS.mindmapNodes || level >= WB_AI_LIMITS.mindmapDepth) continue;
    const key = `m${nodes.length}`;
    const text = clip(node.text);
    const w = level === 0 ? 220 : 180;
    nodes.push({ key, text, shape: level === 0 ? "ellipse" : "rounded", level, w, h: heightFor(text, w, level === 0 ? 72 : 52) });
    if (parent) links.push({ from: parent, to: key });
    for (const child of node.children || []) queue.push({ node: child, level: level + 1, parent: key });
  }
  return { kind: "mindmap", nodes, links, dropped: total - nodes.length };
}

const FLOW_SHAPES: Record<(typeof FLOW_NODE_TYPES)[number], ShapeKind> = {
  start: "ellipse",
  end: "ellipse",
  step: "rounded",
  decision: "diamond",
  input: "parallelogram",
};
export function flowchartStructure(answer: FlowchartAnswer): GeneratedStructure {
  const seen = new Set<string>();
  const nodes: BoardNode[] = [];
  let dropped = 0;
  for (const node of answer.nodes) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    if (nodes.length >= WB_AI_LIMITS.flowNodes) {
      dropped++;
      continue;
    }
    const text = clip(node.text);
    const decision = node.type === "decision";
    const w = decision ? 200 : 180;
    nodes.push({ key: node.id, text, shape: FLOW_SHAPES[node.type], level: 0, w, h: decision ? Math.max(96, heightFor(text, w, 96)) : heightFor(text, w, 60) });
  }
  const keys = new Set(nodes.map((n) => n.key));
  const pairs = new Set<string>();
  const links: BoardLink[] = [];
  for (const edge of answer.edges) {
    const pair = `${edge.from}→${edge.to}`;
    if (!keys.has(edge.from) || !keys.has(edge.to) || edge.from === edge.to || pairs.has(pair)) continue;
    if (links.length >= WB_AI_LIMITS.flowEdges) break;
    pairs.add(pair);
    links.push({ from: edge.from, to: edge.to, ...(edge.label ? { label: clip(edge.label, 40) } : {}) });
  }
  return { kind: "flowchart", nodes, links, dropped };
}

// Layers top to bottom by the longest path from a start (back edges of
// loops are ignored), each layer centred.
export function flowchartLayout(nodes: BoardNode[], links: BoardLink[], hGap = 50, vGap = 70) {
  const keys = nodes.map((n) => n.key);
  const outgoing = new Map<string, string[]>(keys.map((k) => [k, []]));
  const incoming = new Map<string, number>(keys.map((k) => [k, 0]));
  // Drop edges that close a loop (depth-first from the nodes in order).
  const state = new Map<string, 0 | 1 | 2>();
  const forward: BoardLink[] = [];
  const adjacency = new Map<string, string[]>(keys.map((k) => [k, []]));
  for (const l of links) adjacency.get(l.from)?.push(l.to);
  const visit = (k: string) => {
    state.set(k, 1);
    for (const next of adjacency.get(k) || []) {
      if (state.get(next) === 1) continue;
      forward.push({ from: k, to: next });
      if (!state.get(next)) visit(next);
    }
    state.set(k, 2);
  };
  for (const k of keys) if (!state.get(k)) visit(k);
  for (const l of forward) {
    outgoing.get(l.from)!.push(l.to);
    incoming.set(l.to, (incoming.get(l.to) || 0) + 1);
  }
  // Longest path layering (Kahn).
  const layer = new Map<string, number>(keys.map((k) => [k, 0]));
  const queue = keys.filter((k) => !incoming.get(k));
  const left = new Map(incoming);
  while (queue.length) {
    const k = queue.shift()!;
    for (const next of outgoing.get(k)!) {
      layer.set(next, Math.max(layer.get(next)!, layer.get(k)! + 1));
      left.set(next, left.get(next)! - 1);
      if (!left.get(next)) queue.push(next);
    }
  }
  const layers: BoardNode[][] = [];
  for (const node of nodes) (layers[layer.get(node.key)!] ||= []).push(node);
  const out = new Map<string, { x: number; y: number }>();
  let y = 0;
  for (const row of layers.filter(Boolean)) {
    const width = row.reduce((s, n) => s + n.w, 0) + (row.length - 1) * hGap;
    let x = -width / 2;
    const height = Math.max(...row.map((n) => n.h));
    for (const node of row) {
      out.set(node.key, { x: Math.round(x), y: Math.round(y + (height - node.h) / 2) });
      x += node.w + hGap;
    }
    y += height + vGap;
  }
  return out;
}

export const MINDMAP_FILLS = ["#dbe4ff", "#d3f9d8", "#fff3bf", "#ffe8cc", "#e5dbff", "#ffe3e3"];
// Board elements for a structure, centred on `at`: shapes with text and
// connectors between them (keys stand for the ids the board will give).
export function structureItems(structure: GeneratedStructure, at: { x: number; y: number }) {
  const boxes = new Map(structure.nodes.map((n) => [n.key, { x: 0, y: 0, w: n.w, h: n.h }]));
  let positions: Map<string, { x: number; y: number }>;
  if (structure.kind === "mindmap" && structure.nodes.length) {
    positions = mindmapLayout(structure.nodes[0].key, boxes, structure.links, 70, 18);
  } else positions = flowchartLayout(structure.nodes, structure.links);
  const placed = structure.nodes.map((n) => ({ ...n, ...(positions.get(n.key) || { x: 0, y: 0 }) }));
  const minX = Math.min(...placed.map((n) => n.x)),
    minY = Math.min(...placed.map((n) => n.y)),
    maxX = Math.max(...placed.map((n) => n.x + n.w)),
    maxY = Math.max(...placed.map((n) => n.y + n.h));
  const dx = Math.round(at.x - (minX + maxX) / 2),
    dy = Math.round(at.y - (minY + maxY) / 2);
  // Branches of a mind map share the colour of their first-level node.
  const branch = new Map<string, number>();
  if (structure.kind === "mindmap") {
    const parent = new Map(structure.links.map((l) => [l.to, l.from]));
    structure.nodes.forEach((n) => {
      let k = n.key;
      while (parent.has(k) && parent.get(k) !== structure.nodes[0].key) k = parent.get(k)!;
      branch.set(n.key, structure.nodes.findIndex((m) => m.key === k));
    });
  }
  const shapes = placed.map((n) => {
    const fill =
      structure.kind === "mindmap"
        ? n.level === 0
          ? "#1971c2"
          : MINDMAP_FILLS[(branch.get(n.key)! - 1 + MINDMAP_FILLS.length) % MINDMAP_FILLS.length]
        : n.shape === "diamond"
          ? "#fff3bf"
          : n.shape === "ellipse"
            ? "#d3f9d8"
            : "#ffffff";
    const item: Omit<WhiteboardItem, "id" | "z"> = {
      type: "shape",
      shape: n.shape,
      x: n.x + dx,
      y: n.y + dy,
      w: n.w,
      h: n.h,
      text: n.text,
      fill,
      stroke: structure.kind === "mindmap" && n.level === 0 ? "#1971c2" : "#1f2937",
      strokeWidth: 2,
      fontSize: n.level === 0 && structure.kind === "mindmap" ? 18 : 15,
      ...(n.level === 0 && structure.kind === "mindmap" ? { bold: true, textColor: "#ffffff" } : {}),
    };
    return { key: n.key, item };
  });
  const connectors = structure.links.map((l) => ({
    from: l.from,
    to: l.to,
    item: {
      type: "connector",
      x: 0,
      y: 0,
      w: 0,
      h: 0,
      stroke: structure.kind === "mindmap" ? "#868e96" : "#1f2937",
      strokeWidth: 2,
      route: structure.kind === "mindmap" ? "curved" : "elbow",
      endArrow: structure.kind !== "mindmap",
      ...(l.label ? { text: l.label } : {}),
    } as Omit<WhiteboardItem, "id" | "z">,
  }));
  return { shapes, connectors };
}

// Where generated content goes: at `box` when that is free, else moved right
// past whatever it would cover (a few steps at most), so it never lands on
// top of notes that are already there. Returns the shift.
export function freeSpot(box: Box, items: Box[], gap = 60) {
  const hits = (x: number) => items.filter((i) => i.w > 0 && i.h > 0 && x < i.x + i.w + gap && x + box.w + gap > i.x && box.y < i.y + i.h + gap && box.y + box.h + gap > i.y);
  let x = box.x;
  for (let step = 0; step < 50; step++) {
    const covered = hits(x);
    if (!covered.length) break;
    x = Math.max(...covered.map((i) => i.x + i.w)) + gap;
  }
  return { dx: Math.round(x - box.x), dy: 0 };
}

// ---- Sticky notes → records (command whiteboard.toRecords) ----

export const toRecordsInput = z.object({
  action: z.literal("whiteboard.toRecords"),
  pageId: z.uuid().describe("Page ID of the whiteboard"),
  databaseId: z.uuid().describe("Page ID of the database the records go to"),
  colorField: z.string().max(200).nullish().describe("A select property for the note colour (property ID)"),
  colorOptions: z.record(z.string().max(20), z.string().max(200)).optional().describe("Note colour (hex) → option of `colorField`"),
  personField: z.string().max(200).nullish().describe("A person property for the note's author (property ID)"),
  records: z
    .array(
      z.object({
        rowId: z.uuid().describe("ID of the new record, chosen by the caller (idempotent)"),
        itemId: z.string().min(1).max(100).describe("ID of the note on the board"),
        text: z.string().max(10_000),
        color: z.string().max(20).nullish(),
        author: z.string().max(100).nullish(),
        cells: z.record(z.string(), z.unknown()).optional().describe("Further property values by property ID (e.g. filled in by the AI)"),
      }),
    )
    .min(1)
    .max(WB_AI_LIMITS.batch),
});

// ---- Sticky colours and select options ----

// i18n-table: 1 – [German, English] pairs
export const STICKY_COLOR_NAMES: Record<string, readonly [string, string]> = {
  "#fff6b6": ["Gelb", "Yellow"],
  "#ffd8a8": ["Orange", "Orange"],
  "#ffc9c9": ["Rot", "Red"],
  "#fcc2d7": ["Rosa", "Pink"],
  "#d0bfff": ["Lila", "Purple"],
  "#bac8ff": ["Indigo", "Indigo"],
  "#a5d8ff": ["Blau", "Blue"],
  "#b2f2bb": ["Grün", "Green"],
  "#d8f5a2": ["Hellgrün", "Lime"],
  "#e9ecef": ["Grau", "Grey"],
};
const FRENCH: Record<string, string> = {
  "#fff6b6": "jaune",
  "#ffd8a8": "orange",
  "#ffc9c9": "rouge",
  "#fcc2d7": "rose",
  "#d0bfff": "violet",
  "#bac8ff": "indigo",
  "#a5d8ff": "bleu",
  "#b2f2bb": "vert",
  "#d8f5a2": "vert clair",
  "#e9ecef": "gris",
};
// An existing option named like the colour (German, English or French), or "".
export function guessOption(color: string, options: string[]) {
  const names = [...(STICKY_COLOR_NAMES[color] || []), FRENCH[color], ...(color === "#e9ecef" ? ["Gray"] : [])].filter(Boolean).map((n) => n!.toLocaleLowerCase());
  return options.find((o) => names.includes(o.trim().toLocaleLowerCase())) || "";
}
// A note's text as a record: the first line is the title, the rest the
// record's document.
export function noteTitle(text: string) {
  const lines = text.replace(/\r/g, "").split("\n").map((l) => l.trim());
  const first = lines.findIndex(Boolean);
  if (first < 0) return { title: "", body: "" };
  return { title: lines[first].slice(0, 500), body: lines.slice(first + 1).join("\n").trim() };
}
