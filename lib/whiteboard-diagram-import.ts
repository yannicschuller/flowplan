// Mermaid and PlantUML text → editable whiteboard items, and flowcharts on
// the board → Mermaid ("Als Mermaid kopieren").
import type { BoardDraft } from "./whiteboard-import";
import type { WhiteboardItem } from "./whiteboard-model";
import { connectorEnds } from "./whiteboard-connector-markers";
import { mainDirection } from "./whiteboard-autolayout";
import {
  DIAGRAM_LIMITS,
  DiagramImportError,
  graphDrafts,
  sequenceDrafts,
  type DiagramKind,
  type DiagramSkip,
  type ParsedDiagram,
} from "./whiteboard-diagram-graph";
import { parseMermaid } from "./whiteboard-mermaid-import";
import { parsePlantUml } from "./whiteboard-plantuml-import";

export { DiagramImportError, DIAGRAM_LIMITS, type DiagramSkip } from "./whiteboard-diagram-graph";
export type DiagramSource = "mermaid" | "plantuml";

const MERMAID_HEAD =
  /^(flowchart|graph|sequenceDiagram|classDiagram(-v2)?|erDiagram|stateDiagram(-v2)?|mindmap|gantt|pie|journey|gitGraph|timeline|quadrantChart|C4\w+|requirementDiagram)\b/;
// Mermaid or PlantUML, judged by the first meaningful line; null for other text.
export function detectDiagramSource(text: string): DiagramSource | null {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).map((l) => l.trim());
  let i = 0;
  // Code fences as pasted from Markdown.
  while (i < lines.length && (!lines[i] || /^```/.test(lines[i]))) i++;
  if (lines[i] === "---") {
    const close = lines.indexOf("---", i + 1);
    i = close < 0 ? lines.length : close + 1;
  }
  while (i < lines.length && (!lines[i] || lines[i].startsWith("%%"))) i++;
  const first = lines[i] || "";
  if (/^@start\w+/i.test(first)) return "plantuml";
  if (MERMAID_HEAD.test(first)) return "mermaid";
  return null;
}
// Strips a Markdown code fence around the diagram.
function unfence(text: string) {
  const m = text.trim().match(/^```[\w-]*\n([\s\S]*?)\n```$/);
  return m ? m[1] : text;
}

export type DiagramImport = {
  source: DiagramSource;
  kind: DiagramKind;
  drafts: BoardDraft[];
  skipped: DiagramSkip[];
};
export function parseDiagramText(text: string, source?: DiagramSource | null): ParsedDiagram {
  if (!text.trim()) throw new DiagramImportError("empty");
  if (text.length > DIAGRAM_LIMITS.chars) throw new DiagramImportError("too-large", String(DIAGRAM_LIMITS.chars));
  const body = unfence(text);
  const kind = source || detectDiagramSource(body);
  if (!kind) throw new DiagramImportError("unknown", body.trim().split("\n")[0]?.slice(0, 60) || "");
  return kind === "plantuml" ? parsePlantUml(body) : parseMermaid(body);
}
// The board items for a diagram text (local ids; see placeDrafts).
export function importDiagram(text: string, source?: DiagramSource | null): DiagramImport {
  const parsed = parseDiagramText(text, source);
  const diagram = parsed.diagram;
  const drafts = diagram.kind === "sequence" ? sequenceDrafts(diagram) : graphDrafts(diagram);
  if (!drafts.length) throw new DiagramImportError("empty");
  return { source: parsed.source, kind: diagram.kind, drafts, skipped: parsed.skipped };
}

// ---- export ----

const MERMAID_SHAPES: Record<string, [string, string]> = {
  "flow:decision": ["{", "}"],
  "flow:terminator": ["([", "])"],
  "flow:predefined": ["[[", "]]"],
  "flow:database": ["[(", ")]"],
  "flow:data": ["[/", "/]"],
  "flow:preparation": ["{{", "}}"],
  "flow:manual-op": ["[/", "\\]"],
  "flow:connector": ["((", "))"],
  "uml:state": ["(", ")"],
  "uml:start": ["((", "))"],
  "uml:end": ["(((", ")))"],
  "uml:merge": ["{", "}"],
};
const PLAIN_SHAPES: Record<string, [string, string]> = {
  rounded: ["(", ")"],
  ellipse: ["((", "))"],
  diamond: ["{", "}"],
  hexagon: ["{{", "}}"],
  parallelogram: ["[/", "/]"],
};
const NODE_TYPES = new Set(["sticky", "text", "shape", "card", "emoji", "image", "table"]);
const quote = (text: string) => `"${text.replace(/"/g, "#quot;").replace(/\r?\n/g, "<br>").trim() || " "}"`;
// The selected (or all) shapes and their connectors as a Mermaid flowchart;
// null when there is no connected pair to describe.
export function boardToMermaid(items: WhiteboardItem[], ids?: Set<string> | null) {
  const map = new Map(items.map((i) => [i.id, i]));
  const chosen = items.filter((i) => !ids?.size || ids.has(i.id));
  const nodes = chosen.filter((i) => NODE_TYPES.has(i.type) && !i.covered);
  const known = new Set(nodes.map((n) => n.id));
  const edges = items.filter(
    (i) => i.type === "connector" && i.from?.id && i.to?.id && known.has(i.from.id) && known.has(i.to.id),
  );
  if (!nodes.length) return null;
  const name = new Map(nodes.map((n, i) => [n.id, `n${i + 1}`]));
  const lines = [`flowchart ${mainDirection(edges, map)}`];
  for (const n of [...nodes].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const [open, close] = (n.lib && MERMAID_SHAPES[n.lib]) || (n.shape && PLAIN_SHAPES[n.shape]) || ["[", "]"];
    const label = n.text || n.emoji || (n.cells || []).flat().filter(Boolean).join(" ") || "";
    lines.push(`  ${name.get(n.id)}${open}${quote(label)}${close}`);
  }
  for (const e of edges) {
    const ends = connectorEnds(e);
    const sign = (m: string, left: boolean) => (m === "none" ? "" : m === "circle" ? "o" : m === "cross" ? "x" : left ? "<" : ">");
    let from = e.from!.id!,
      to = e.to!.id!,
      head = sign(ends.end, false),
      tail = sign(ends.start, true);
    // Mermaid has no arrow at the start only: the edge turns around.
    if (tail && !head) {
      [from, to] = [to, from];
      head = tail === "<" ? ">" : tail;
      tail = "";
    }
    const body = e.dashed ? "-.-" : (e.strokeWidth ?? 2) >= 3 ? (head ? "==" : "===") : head ? "--" : "---";
    lines.push(`  ${name.get(from)} ${tail}${body}${head}${e.text ? `|${quote(e.text)}|` : ""} ${name.get(to)}`);
  }
  return lines.join("\n") + "\n";
}
