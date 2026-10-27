// Mermaid as editable whiteboard diagrams: flowchart/graph, sequence,
// class, ER and state diagrams and mind maps are parsed here (locally, no
// rendering library) into a diagram graph or sequence model
// (lib/whiteboard-diagram-graph.ts). The common syntax is covered; lines
// that are not understood are collected and reported, never guessed.
import type { ShapeKind } from "./whiteboard-model";
import type { MarkerKind } from "./whiteboard-diagram-model";
import type { LayoutDirection } from "./whiteboard-autolayout";
import {
  DiagramImportError,
  checkCounts,
  cleanLabel,
  sourceLines,
  splitOutside,
  type DiagramEdge,
  type DiagramGraph,
  type DiagramGroup,
  type DiagramNode,
  type DiagramSkip,
  type ParsedDiagram,
  type SequenceEvent,
  type SequenceModel,
} from "./whiteboard-diagram-graph";

type Line = { n: number; raw: string; text: string };
const UNSUPPORTED = /^(gantt|pie|journey|gitGraph|timeline|quadrantChart|sankey(-beta)?|xychart(-beta)?|block(-beta)?|C4\w*|requirementDiagram|architecture(-beta)?|kanban|packet(-beta)?|radar(-beta)?|treemap(-beta)?|zenuml)\b/;
const direction = (value?: string): LayoutDirection =>
  value === "LR" ? "LR" : value === "RL" ? "RL" : value === "BT" ? "BT" : "TB";

export function parseMermaid(text: string): ParsedDiagram {
  const all = sourceLines(text);
  // Front matter (--- … ---), directives (%%{…}%%) and comments are not
  // part of the diagram.
  let lines = all;
  const first = lines.findIndex((l) => l.text);
  if (first >= 0 && lines[first].text === "---") {
    const close = lines.findIndex((l, i) => i > first && l.text === "---");
    lines = lines.slice(close + 1);
  }
  lines = lines.filter((l) => l.text && !l.text.startsWith("%%"));
  const header = lines[0];
  if (!header) throw new DiagramImportError("empty");
  const body = lines.slice(1);
  const h = header.text;
  let m: RegExpMatchArray | null;
  if ((m = h.match(/^(flowchart|graph)(?:\s+(TB|TD|BT|LR|RL))?\s*;?$/))) return flowchart(body, direction(m[2] === "TD" ? "TB" : m[2]));
  if (/^sequenceDiagram\s*$/.test(h)) return sequence(body);
  if (/^classDiagram(-v2)?\s*$/.test(h)) return classDiagram(body);
  if (/^erDiagram\s*$/.test(h)) return erDiagram(body);
  if (/^stateDiagram(-v2)?\s*$/.test(h)) return stateDiagram(body);
  if (/^mindmap\s*$/.test(h)) return mindmap(lines.slice(1));
  if ((m = h.match(UNSUPPORTED))) throw new DiagramImportError("unsupported", m[1]);
  throw new DiagramImportError("unknown", h.slice(0, 60));
}

// ---- flowcharts ----

const ID = /^[\p{L}\p{N}_](?:[\p{L}\p{N}_]|[-.](?=[\p{L}\p{N}_]))*/u;
type ShapeSpec = { lib?: string; shape?: ShapeKind };
// Brackets of node shapes, longest first.
const BRACKETS: [string, string, ShapeSpec][] = [
  ["(((", ")))", { shape: "ellipse" }],
  ["([", "])", { lib: "flow:terminator" }],
  ["[[", "]]", { lib: "flow:predefined" }],
  ["[(", ")]", { lib: "flow:database" }],
  ["((", "))", { shape: "ellipse" }],
  ["{{", "}}", { lib: "flow:preparation" }],
  ["[/", "/]", { lib: "flow:data" }],
  ["[\\", "\\]", { lib: "flow:data" }],
  ["[/", "\\]", { lib: "flow:manual-op" }],
  ["[\\", "/]", { lib: "flow:manual-op" }],
  ["[", "]", { lib: "flow:process" }],
  ["(", ")", { shape: "rounded" }],
  ["{", "}", { lib: "flow:decision" }],
  [">", "]", { lib: "flow:process" }],
];
// Shapes of the "@{ shape: … }" syntax.
const NAMED_SHAPES: Record<string, ShapeSpec> = {
  rect: { lib: "flow:process" }, process: { lib: "flow:process" }, proc: { lib: "flow:process" }, rectangle: { lib: "flow:process" },
  rounded: { shape: "rounded" }, event: { shape: "rounded" },
  stadium: { lib: "flow:terminator" }, terminal: { lib: "flow:terminator" }, pill: { lib: "flow:terminator" },
  subroutine: { lib: "flow:predefined" }, subproc: { lib: "flow:predefined" }, "fr-rect": { lib: "flow:predefined" }, "framed-rectangle": { lib: "flow:predefined" },
  cyl: { lib: "flow:database" }, cylinder: { lib: "flow:database" }, database: { lib: "flow:database" }, db: { lib: "flow:database" },
  circle: { shape: "ellipse" }, circ: { shape: "ellipse" }, "dbl-circ": { shape: "ellipse" },
  diam: { lib: "flow:decision" }, diamond: { lib: "flow:decision" }, decision: { lib: "flow:decision" }, question: { lib: "flow:decision" },
  hex: { lib: "flow:preparation" }, hexagon: { lib: "flow:preparation" }, prepare: { lib: "flow:preparation" },
  "lean-r": { lib: "flow:data" }, "lean-l": { lib: "flow:data" }, "in-out": { lib: "flow:data" }, "out-in": { lib: "flow:data" },
  "trap-b": { lib: "flow:manual-op" }, "trap-t": { lib: "flow:manual-op" }, manual: { lib: "flow:manual-op" },
  doc: { lib: "flow:document" }, document: { lib: "flow:document" }, docs: { lib: "flow:multidoc" }, documents: { lib: "flow:multidoc" },
  delay: { lib: "flow:delay" }, "half-rounded-rectangle": { lib: "flow:delay" },
  display: { lib: "flow:display" }, "curv-trap": { lib: "flow:display" },
  "sl-rect": { lib: "flow:manual-input" }, "manual-input": { lib: "flow:manual-input" },
  "f-circ": { lib: "uml:start" }, "filled-circle": { lib: "uml:start" }, start: { lib: "uml:start" },
  "fr-circ": { lib: "uml:end" }, stop: { lib: "uml:end" },
  fork: { lib: "uml:fork" }, join: { lib: "uml:fork" },
  brace: { lib: "flow:annotation" }, comment: { lib: "flow:annotation" }, "brace-r": { lib: "flow:annotation" },
  tri: { lib: "flow:merge" }, triangle: { lib: "flow:merge" }, extract: { lib: "flow:merge" },
  "lin-cyl": { lib: "flow:database" }, "h-cyl": { lib: "flow:database" }, "das": { lib: "flow:database" },
  "notch-rect": { lib: "flow:process" }, card: { lib: "flow:process" }, flag: { lib: "flow:process" }, "lin-rect": { lib: "flow:process" },
  text: { shape: "rectangle" },
};
type Style = { fill?: string; stroke?: string; color?: string };
function parseStyle(text: string): Style {
  const style: Style = {};
  for (const part of text.split(",")) {
    const [key, value] = part.split(":").map((s) => s.trim());
    const color = /^#[0-9a-f]{3,8}$|^[a-z]{3,20}$/i.test(value || "") ? value : undefined;
    if (!color) continue;
    if (key === "fill") style.fill = color;
    else if (key === "stroke") style.stroke = color;
    else if (key === "color") style.color = color;
  }
  return style;
}

function flowchart(lines: Line[], dir: LayoutDirection): ParsedDiagram {
  const nodes = new Map<string, DiagramNode>();
  const edges: DiagramEdge[] = [];
  const groups: DiagramGroup[] = [];
  const skipped: DiagramSkip[] = [];
  const stack: string[] = [];
  const classDefs = new Map<string, Style>();
  const classOf = new Map<string, string[]>();
  const styles = new Map<string, Style>();
  let direction = dir;
  const node = (id: string) => {
    let n = nodes.get(id);
    if (!n) {
      n = { id, label: id, ...(stack.length ? { group: stack[stack.length - 1] } : {}) };
      nodes.set(id, n);
      checkCounts(nodes.size, edges.length);
    }
    return n;
  };
  // Reads one node at `pos`: id, optional shape and class.
  const readNode = (s: string, pos: number): { id: string; pos: number } | null => {
    const rest = s.slice(pos);
    const idMatch = rest.match(ID);
    if (!idMatch) return null;
    const id = idMatch[0];
    if (/^(end|subgraph)$/.test(id)) return null;
    let at = pos + id.length;
    const n = node(id);
    // Named inside a subgraph: the node belongs to it.
    if (stack.length) n.group = stack[stack.length - 1];
    // @{ shape: …, label: "…" }
    const meta = s.slice(at).match(/^@\{([^}]*)\}/);
    if (meta) {
      at += meta[0].length;
      const shape = meta[1].match(/shape\s*:\s*([\w-]+)/)?.[1];
      const label = meta[1].match(/label\s*:\s*("(?:[^"\\]|\\.)*"|[^,]+)/)?.[1];
      if (shape) Object.assign(n, NAMED_SHAPES[shape] || { lib: "flow:process" });
      if (label) n.label = cleanLabel(label);
    } else
      for (const [open, close, spec] of BRACKETS) {
        if (!s.startsWith(open, at)) continue;
        const start = at + open.length;
        let end: number;
        if (s[start] === '"') {
          const q = s.indexOf('"', start + 1);
          end = q < 0 ? -1 : s.indexOf(close, q + 1);
        } else end = s.indexOf(close, start);
        if (end < 0) continue;
        n.label = cleanLabel(s.slice(start, end));
        n.lib = spec.lib;
        n.shape = spec.shape;
        at = end + close.length;
        break;
      }
    const cls = s.slice(at).match(/^:::([\w-]+)/);
    if (cls) {
      classOf.set(id, [...(classOf.get(id) || []), cls[1]]);
      at += cls[0].length;
    }
    return { id, pos: at };
  };
  const readGroup = (s: string, pos: number) => {
    const ids: string[] = [];
    let at = pos;
    for (;;) {
      at += s.slice(at).match(/^\s*/)![0].length;
      const one = readNode(s, at);
      if (!one) return ids.length ? { ids, pos: at } : null;
      ids.push(one.id);
      at = one.pos;
      const amp = s.slice(at).match(/^\s*&\s*/);
      if (!amp) return { ids, pos: at };
      at += amp[0].length;
    }
  };
  const head = (c?: string): MarkerKind | undefined => (c === ">" ? "arrow" : c === "o" ? "circle" : c === "x" ? "cross" : c === "<" ? "arrow" : undefined);
  const readEdge = (s: string, pos: number): { edge: Omit<DiagramEdge, "from" | "to">; pos: number } | null => {
    const rest = s.slice(pos);
    const ws = rest.match(/^\s*/)![0].length;
    const r = rest.slice(ws);
    // Text inside the arrow: "-- text -->", "== text ==>", "-. text .->".
    const inline =
      r.match(/^([<ox]?)--\s+(.+?)\s+(-{2,}[>ox]|-{3,})(?=\s|$|[\p{L}\p{N}_])/u) ||
      r.match(/^([<ox]?)==\s+(.+?)\s+(={2,}[>ox]|={3,})(?=\s|$|[\p{L}\p{N}_])/u) ||
      r.match(/^([<ox]?)-\.\s+(.+?)\s+(\.+-[>ox]?)(?=\s|$|[\p{L}\p{N}_])/u);
    if (inline) {
      const close = inline[3];
      return {
        edge: {
          label: cleanLabel(inline[2]),
          dashed: close.includes("."),
          thick: close.startsWith("="),
          start: head(inline[1]) || "none",
          end: head(close.slice(-1)) || "none",
        },
        pos: pos + ws + inline[0].length,
      };
    }
    const plain = r.match(/^([<ox]?)(-{2,}|={2,}|-\.+-)([>ox]?)/);
    if (!plain) return null;
    const [whole, left, body, right] = plain;
    // o and x are heads only when no name continues right after them.
    let used = whole,
      endHead = right,
      startHead = left;
    if ((right === "o" || right === "x") && /^[\p{L}\p{N}_]/u.test(r.slice(whole.length))) {
      used = whole.slice(0, -1);
      endHead = "";
    }
    if ((left === "o" || left === "x") && !body.startsWith("-") && !body.startsWith("=")) startHead = "";
    const solid = !body.includes(".");
    if (solid && body.length < 3 && !endHead && !startHead) return null;
    let at = pos + ws + used.length;
    let label: string | undefined;
    const pipe = s.slice(at).match(/^\s*\|([^|]*)\|/);
    if (pipe) {
      label = cleanLabel(pipe[1]);
      at += pipe[0].length;
    }
    return {
      edge: { label, dashed: !solid, thick: body.startsWith("="), start: head(startHead) || "none", end: head(endHead) || "none" },
      pos: at,
    };
  };
  const statement = (s: string, line: Line) => {
    let m: RegExpMatchArray | null;
    if ((m = s.match(/^subgraph\s+(.+)$/))) {
      const spec = m[1].trim();
      const withTitle = spec.match(/^([\p{L}\p{N}_-]+)\s*\[(.+)\]$/u);
      const id = withTitle ? withTitle[1] : /^[\p{L}\p{N}_-]+$/u.test(spec) ? spec : `sg${groups.length}`;
      groups.push({ id: `group:${id}`, label: cleanLabel(withTitle ? withTitle[2] : spec), ...(stack.length ? { parent: stack[stack.length - 1] } : {}) });
      stack.push(`group:${id}`);
      return;
    }
    if (s === "subgraph") {
      groups.push({ id: `group:sg${groups.length}`, label: "", ...(stack.length ? { parent: stack[stack.length - 1] } : {}) });
      stack.push(groups[groups.length - 1].id);
      return;
    }
    if (s === "end") {
      if (!stack.pop()) skipped.push({ line: line.n, text: line.text });
      return;
    }
    if ((m = s.match(/^direction\s+(TB|TD|BT|LR|RL)$/))) {
      if (!stack.length) direction = m[1] === "TD" ? "TB" : (m[1] as LayoutDirection);
      return;
    }
    if ((m = s.match(/^classDef\s+([\w,-]+)\s+(.+)$/))) {
      for (const name of m[1].split(",")) classDefs.set(name, parseStyle(m[2]));
      return;
    }
    if ((m = s.match(/^class\s+([\p{L}\p{N}_,\s-]+?)\s+([\w-]+)$/u))) {
      for (const id of m[1].split(",").map((x) => x.trim())) classOf.set(id, [...(classOf.get(id) || []), m[2]]);
      return;
    }
    if ((m = s.match(/^style\s+([\p{L}\p{N}_-]+)\s+(.+)$/u))) {
      styles.set(m[1], parseStyle(m[2]));
      return;
    }
    if (/^(linkStyle|click|accTitle|accDescr|title)\b/.test(s)) {
      skipped.push({ line: line.n, text: line.text });
      return;
    }
    const first = readGroup(s, 0);
    if (!first) {
      skipped.push({ line: line.n, text: line.text });
      return;
    }
    let prev = first.ids,
      pos = first.pos;
    const found: DiagramEdge[] = [];
    while (s.slice(pos).trim()) {
      const edge = readEdge(s, pos);
      const next = edge && readGroup(s, edge.pos);
      if (!edge || !next) {
        skipped.push({ line: line.n, text: line.text });
        return;
      }
      for (const a of prev) for (const b of next.ids) found.push({ from: a, to: b, ...edge.edge });
      prev = next.ids;
      pos = next.pos;
    }
    edges.push(...found);
    checkCounts(nodes.size, edges.length);
  };
  for (const line of lines)
    for (const part of splitOutside(line.text, ";")) {
      const s = part.trim();
      if (s) statement(s, line);
    }
  // Edges to a subgraph lead to its frame.
  for (const g of groups) {
    const name = g.id.slice(6);
    const n = nodes.get(name);
    if (!n || n.lib || n.shape || n.label !== name) continue;
    nodes.delete(name);
    for (const e of edges) {
      if (e.from === name) e.from = g.id;
      if (e.to === name) e.to = g.id;
    }
  }
  for (const [id, n] of nodes) {
    const style: Style = {};
    for (const cls of classOf.get(id) || []) Object.assign(style, classDefs.get(cls) || {});
    Object.assign(style, styles.get(id) || {});
    if (style.fill) n.fill = style.fill;
    if (style.stroke) n.stroke = style.stroke;
    if (style.color) n.textColor = style.color;
  }
  return { source: "mermaid", diagram: { kind: "flowchart", direction, nodes: [...nodes.values()], edges, groups }, skipped };
}

// ---- sequence diagrams ----

function sequence(lines: Line[]): ParsedDiagram {
  const participants = new Map<string, SequenceModel["participants"][number]>();
  const events: SequenceEvent[] = [];
  const skipped: DiagramSkip[] = [];
  const blocks: ("fragment" | "box" | "rect")[] = [];
  const participant = (id: string, label?: string, actor?: boolean) => {
    let p = participants.get(id);
    if (!p) {
      p = { id, label: label || id, ...(actor ? { actor: true } : {}) };
      participants.set(id, p);
    } else if (label) p.label = label;
    return p;
  };
  for (const line of lines) {
    const s = line.text;
    let m: RegExpMatchArray | null;
    if ((m = s.match(/^(?:create\s+)?(participant|actor)\s+(.+?)(?:\s+as\s+(.+))?$/))) {
      participant(m[2].trim(), m[3] ? cleanLabel(m[3]) : undefined, m[1] === "actor");
      continue;
    }
    if ((m = s.match(/^note\s+(left of|right of|over)\s+([^:]+?)\s*:\s*(.*)$/i))) {
      const over = m[2].split(",").map((x) => x.trim()).filter(Boolean);
      over.forEach((id) => participant(id));
      events.push({ type: "note", over, side: m[1].toLowerCase().startsWith("left") ? "left" : m[1].toLowerCase().startsWith("right") ? "right" : "over", text: cleanLabel(m[3]) });
      continue;
    }
    if ((m = s.match(/^(loop|alt|opt|par|critical|break)\b\s*(.*)$/))) {
      blocks.push("fragment");
      events.push({ type: "block", kind: m[1], label: cleanLabel(m[2]) });
      continue;
    }
    if ((m = s.match(/^(else|and|option)\b\s*(.*)$/))) {
      events.push({ type: "else", label: cleanLabel(m[2]) });
      continue;
    }
    if (/^rect\b/.test(s)) {
      blocks.push("rect");
      continue;
    }
    if (/^box\b/.test(s)) {
      blocks.push("box");
      skipped.push({ line: line.n, text: line.text });
      continue;
    }
    if (s === "end") {
      const kind = blocks.pop();
      if (kind === "fragment") events.push({ type: "end" });
      else if (!kind) skipped.push({ line: line.n, text: line.text });
      continue;
    }
    if (/^(autonumber|activate|deactivate|destroy|title|accTitle|accDescr)\b/.test(s)) continue;
    if ((m = s.match(/^([^\s:<>+-][^:<>]*?)\s*(<<)?(--?)(>>|>|x|\))\s*([+-]?)\s*([^\s:+-][^:]*?)\s*(?::\s*(.*))?$/))) {
      const [, from, both, dashes, tip, , to, label] = m;
      participant(from.trim());
      participant(to.trim());
      const end: MarkerKind = tip === ">>" ? "arrow" : tip === "x" ? "cross" : tip === ")" ? "open" : "none";
      events.push({ type: "message", from: from.trim(), to: to.trim(), label: cleanLabel(label || ""), dashed: dashes === "--", end, ...(both ? { start: "arrow" as MarkerKind } : {}) });
      continue;
    }
    skipped.push({ line: line.n, text: line.text });
  }
  return { source: "mermaid", diagram: { kind: "sequence", participants: [...participants.values()], events }, skipped };
}

// ---- class diagrams ----

type ClassInfo = { id: string; name: string; stereotype?: string; fields: string[]; methods: string[]; group?: string };
export function classLabel(c: ClassInfo) {
  return [
    ...(c.stereotype ? [`«${c.stereotype}»`] : []),
    c.name,
    "--",
    ...c.fields,
    "--",
    ...c.methods,
  ].join("\n");
}
const classMarker = (token: string | undefined): MarkerKind | undefined =>
  token === "<|" || token === "|>" ? "triangle" : token === "*" ? "filledDiamond" : token === "o" ? "diamond" : token === "<" || token === ">" ? "open" : undefined;

function classDiagram(lines: Line[]): ParsedDiagram {
  const classes = new Map<string, ClassInfo>();
  const notes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];
  const groups: DiagramGroup[] = [];
  const skipped: DiagramSkip[] = [];
  let direction: LayoutDirection = "TB";
  let open: ClassInfo | null = null;
  const namespaces: string[] = [];
  const generic = (s: string) => s.replace(/~([^~]*)~/g, "<$1>");
  const cls = (raw: string) => {
    const id = raw.replace(/~.*$/, "").replace(/^`|`$/g, "").trim();
    let c = classes.get(id);
    if (!c) {
      c = { id, name: generic(raw.replace(/^`|`$/g, "").trim()), fields: [], methods: [], ...(namespaces.length ? { group: namespaces[namespaces.length - 1] } : {}) };
      classes.set(id, c);
      checkCounts(classes.size + notes.length, edges.length);
    }
    return c;
  };
  const member = (c: ClassInfo, raw: string) => {
    const text = generic(raw.trim()).slice(0, 300);
    if (!text) return;
    const stereo = text.match(/^<<(.+)>>$/);
    if (stereo) c.stereotype = stereo[1];
    else if (text.includes("(")) c.methods.push(text);
    else c.fields.push(text);
  };
  for (const line of lines) {
    const s = line.text;
    let m: RegExpMatchArray | null;
    if (open) {
      if (s === "}") open = null;
      else member(open, s);
      continue;
    }
    if ((m = s.match(/^direction\s+(TB|TD|BT|LR|RL)$/))) {
      direction = m[1] === "TD" ? "TB" : (m[1] as LayoutDirection);
      continue;
    }
    if ((m = s.match(/^namespace\s+([\w.]+)\s*\{$/))) {
      groups.push({ id: `ns:${m[1]}`, label: m[1] });
      namespaces.push(`ns:${m[1]}`);
      continue;
    }
    if (s === "}" && namespaces.length) {
      namespaces.pop();
      continue;
    }
    if ((m = s.match(/^class\s+([\w`~,<>-]+?)(?:\["([^"]*)"\])?(?:\s*:::\s*[\w-]+)?\s*(\{)?\s*(?:\{\s*\})?$/))) {
      const c = cls(m[1]);
      if (m[2]) c.name = cleanLabel(m[2]);
      if (m[3]) open = c;
      continue;
    }
    if ((m = s.match(/^<<(.+)>>\s+([\w`~-]+)$/))) {
      cls(m[2]).stereotype = m[1];
      continue;
    }
    if ((m = s.match(/^note\s+(?:for\s+([\w-]+)\s+)?"(.*)"$/))) {
      const note: DiagramNode = { id: `note${notes.length}`, label: cleanLabel(m[2]), lib: "uml:note", fill: "#fff9db" };
      notes.push(note);
      if (m[1]) edges.push({ from: note.id, to: cls(m[1]).id, dashed: true, end: "none" });
      continue;
    }
    if ((m = s.match(/^([\w`~-]+)\s*(?:"([^"]*)"\s*)?(<\||\*|o|<)?(--|\.\.)(\|>|\*|o|>)?\s*(?:"([^"]*)"\s*)?([\w`~-]+)\s*(?::\s*(.*))?$/))) {
      const [, a, cardA, left, body, right, cardB, b, label] = m;
      const from = cls(a),
        to = cls(b);
      const text = [cardA, label && cleanLabel(label), cardB].filter(Boolean).join(" · ");
      edges.push({ from: from.id, to: to.id, dashed: body === "..", start: classMarker(left) || "none", end: classMarker(right) || "none", ...(text ? { label: text } : {}) });
      checkCounts(classes.size + notes.length, edges.length);
      continue;
    }
    if ((m = s.match(/^([\w`~-]+)\s*:\s*(.+)$/))) {
      member(cls(m[1]), m[2]);
      continue;
    }
    skipped.push({ line: line.n, text: line.text });
  }
  const nodes: DiagramNode[] = [
    ...[...classes.values()].map((c) => ({
      id: c.id,
      label: classLabel(c),
      lib: c.stereotype?.toLowerCase() === "interface" ? "uml:interface" : c.stereotype?.toLowerCase().startsWith("enum") ? "uml:enum" : "uml:class",
      ...(c.group ? { group: c.group } : {}),
    })),
    ...notes,
  ];
  return { source: "mermaid", diagram: { kind: "class", direction, nodes, edges, groups }, skipped };
}

// ---- ER diagrams ----

const erEnd = (token: string): MarkerKind => {
  const t = token.replace(/[{}]/g, "{");
  if (t === "|o" || t === "o|") return "zeroOrOne";
  if (t === "||") return "onlyOne";
  if (t === "{o" || t === "o{") return "zeroOrMany";
  if (t === "{|" || t === "|{") return "oneOrMany";
  return "none";
};
function erDiagram(lines: Line[]): ParsedDiagram {
  const entities = new Map<string, { id: string; name: string; rows: string[] }>();
  const edges: DiagramEdge[] = [];
  const skipped: DiagramSkip[] = [];
  let direction: LayoutDirection = "TB";
  let open: { id: string; name: string; rows: string[] } | null = null;
  const entity = (raw: string) => {
    const id = raw.replace(/^"|"$/g, "");
    let e = entities.get(id);
    if (!e) {
      e = { id, name: id, rows: [] };
      entities.set(id, e);
      checkCounts(entities.size, edges.length);
    }
    return e;
  };
  for (const line of lines) {
    const s = line.text;
    let m: RegExpMatchArray | null;
    if (open) {
      if (s === "}") open = null;
      else if ((m = s.match(/^([\w()[\],-]+)\s+([\w*-]+)((?:\s+(?:PK|FK|UK)(?:\s*,\s*(?:PK|FK|UK))*)?)\s*(?:"(.*)")?$/))) {
        const keys = m[3].trim().replace(/\s+/g, "");
        open.rows.push(`${m[2]}: ${m[1]}${keys ? ` ${keys}` : ""}${m[4] ? ` (${m[4]})` : ""}`);
      } else skipped.push({ line: line.n, text: line.text });
      continue;
    }
    if ((m = s.match(/^direction\s+(TB|TD|BT|LR|RL)$/))) {
      direction = m[1] === "TD" ? "TB" : (m[1] as LayoutDirection);
      continue;
    }
    if ((m = s.match(/^([\w-]+|"[^"]+")(?:\["([^"]*)"\])?\s*\{$/))) {
      open = entity(m[1]);
      if (m[2]) open.name = cleanLabel(m[2]);
      continue;
    }
    if ((m = s.match(/^([\w-]+|"[^"]+")\s*(\|o|\|\||\}o|\}\||o\||o\{|\|\{)(--|\.\.)(\|o|\|\||\}o|\}\||o\||o\{|\|\{)\s*([\w-]+|"[^"]+")\s*:\s*(.*)$/))) {
      const [, a, left, body, right, b, label] = m;
      edges.push({ from: entity(a).id, to: entity(b).id, start: erEnd(left), end: erEnd(right), dashed: body === "..", label: cleanLabel(label) });
      checkCounts(entities.size, edges.length);
      continue;
    }
    if ((m = s.match(/^([\w-]+|"[^"]+")$/))) {
      entity(m[1]);
      continue;
    }
    skipped.push({ line: line.n, text: line.text });
  }
  const nodes = [...entities.values()].map((e) => ({ id: e.id, label: [e.name, ...e.rows].join("\n"), lib: "erd:entity" }));
  return { source: "mermaid", diagram: { kind: "er", direction, nodes, edges, groups: [] }, skipped };
}

// ---- state diagrams ----

function stateDiagram(lines: Line[]): ParsedDiagram {
  const nodes = new Map<string, DiagramNode>();
  const edges: DiagramEdge[] = [];
  const groups: DiagramGroup[] = [];
  const skipped: DiagramSkip[] = [];
  const scopes: string[] = [];
  let direction: LayoutDirection = "TB";
  let note: { target: string; side: string; text: string[] } | null = null;
  const scope = () => scopes[scopes.length - 1] || "";
  const state = (raw: string, side: "from" | "to") => {
    if (raw === "[*]") {
      const id = `${side === "from" ? "__start" : "__end"}:${scope()}`;
      if (!nodes.has(id)) nodes.set(id, { id, label: "", lib: side === "from" ? "uml:start" : "uml:end", ...(scope() ? { group: scope() } : {}) });
      return id;
    }
    if (!nodes.has(raw)) {
      nodes.set(raw, { id: raw, label: raw, lib: "uml:state", ...(scope() ? { group: scope() } : {}) });
      checkCounts(nodes.size, edges.length);
    }
    return raw;
  };
  for (const line of lines) {
    const s = line.text;
    let m: RegExpMatchArray | null;
    if (note) {
      if (/^end\s+note$/i.test(s)) {
        const id = `note${nodes.size}`;
        nodes.set(id, { id, label: note.text.join("\n"), lib: "uml:note", fill: "#fff9db" });
        edges.push({ from: id, to: state(note.target, "to"), dashed: true, end: "none" });
        note = null;
      } else note.text.push(s);
      continue;
    }
    if ((m = s.match(/^direction\s+(TB|TD|BT|LR|RL)$/))) {
      if (!scopes.length) direction = m[1] === "TD" ? "TB" : (m[1] as LayoutDirection);
      continue;
    }
    if ((m = s.match(/^state\s+"([^"]*)"\s+as\s+([\w-]+)\s*(\{)?$/))) {
      const id = state(m[2], "to");
      nodes.get(id)!.label = cleanLabel(m[1]);
      if (m[3]) {
        groups.push({ id: `state:${id}`, label: cleanLabel(m[1]), ...(scope() ? { parent: scope() } : {}) });
        nodes.delete(id);
        scopes.push(`state:${id}`);
      }
      continue;
    }
    if ((m = s.match(/^state\s+([\w-]+)\s*<<(choice|fork|join)>>$/))) {
      const id = state(m[1], "to");
      Object.assign(nodes.get(id)!, m[2] === "choice" ? { lib: "uml:merge", label: "" } : { lib: "uml:fork", label: "" });
      continue;
    }
    if ((m = s.match(/^state\s+([\w-]+)\s*\{$/))) {
      groups.push({ id: `state:${m[1]}`, label: m[1], ...(scope() ? { parent: scope() } : {}) });
      scopes.push(`state:${m[1]}`);
      continue;
    }
    if (s === "}" && scopes.length) {
      scopes.pop();
      continue;
    }
    if ((m = s.match(/^note\s+(left|right)\s+of\s+([\w-]+)\s*:\s*(.*)$/))) {
      const id = `note${nodes.size}`;
      nodes.set(id, { id, label: cleanLabel(m[3]), lib: "uml:note", fill: "#fff9db" });
      edges.push({ from: id, to: state(m[2], "to"), dashed: true, end: "none" });
      continue;
    }
    if ((m = s.match(/^note\s+(left|right)\s+of\s+([\w-]+)$/))) {
      note = { target: m[2], side: m[1], text: [] };
      continue;
    }
    if ((m = s.match(/^(\[\*\]|[\w-]+)\s*-->\s*(\[\*\]|[\w-]+)\s*(?::\s*(.*))?$/))) {
      const from = state(m[1], "from"),
        to = state(m[2], "to");
      edges.push({ from, to, end: "arrow", ...(m[3] ? { label: cleanLabel(m[3]) } : {}) });
      checkCounts(nodes.size, edges.length);
      continue;
    }
    if ((m = s.match(/^([\w-]+)\s*:\s*(.*)$/))) {
      const id = state(m[1], "to");
      const n = nodes.get(id)!;
      n.label = n.label === id ? `${id}\n${cleanLabel(m[2])}` : `${n.label}\n${cleanLabel(m[2])}`;
      continue;
    }
    if ((m = s.match(/^state\s+([\w-]+)$/)) || (m = s.match(/^([\w-]+)$/))) {
      state(m[1], "to");
      continue;
    }
    skipped.push({ line: line.n, text: line.text });
  }
  // Edges to and from a composite state attach to its frame.
  const groupIds = new Set(groups.map((g) => g.id.slice(6)));
  for (const e of edges) {
    if (groupIds.has(e.from)) e.from = `state:${e.from}`;
    if (groupIds.has(e.to)) e.to = `state:${e.to}`;
  }
  for (const id of groupIds) nodes.delete(id);
  return { source: "mermaid", diagram: { kind: "state", direction, nodes: [...nodes.values()], edges, groups }, skipped };
}

// ---- mind maps ----

const MINDMAP_SHAPES: [RegExp, ShapeSpec][] = [
  [/^\(\((.*)\)\)$/s, { shape: "ellipse" }],
  [/^\)\)(.*)\(\($/s, { shape: "star" }],
  [/^\)(.*)\($/s, { shape: "cloud" }],
  [/^\{\{(.*)\}\}$/s, { shape: "hexagon" }],
  [/^\[(.*)\]$/s, { shape: "rectangle" }],
  [/^\((.*)\)$/s, { shape: "rounded" }],
];
function mindmap(lines: Line[]): ParsedDiagram {
  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];
  const skipped: DiagramSkip[] = [];
  const stack: { indent: number; id: string }[] = [];
  for (const line of lines) {
    const s = line.text;
    if (/^::icon\(/.test(s) || /^:::/.test(s)) continue;
    const indent = line.raw.match(/^\s*/)![0].replace(/\t/g, "    ").length;
    let text = s.replace(/:::\s*[\w\s-]+$/, "").trim();
    let spec: ShapeSpec = { shape: "rounded" };
    const idShape = text.match(/^([\p{L}\p{N}_-]+)(\(\(|\)\)|\)|\{\{|\[|\()(.*)$/su);
    if (idShape) text = idShape[2] + idShape[3];
    for (const [re, shape] of MINDMAP_SHAPES) {
      const m = text.match(re);
      if (m) {
        text = m[1];
        spec = shape;
        break;
      }
    }
    const label = cleanLabel(text);
    if (!label) {
      skipped.push({ line: line.n, text: line.text });
      continue;
    }
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    if (!stack.length && nodes.length) {
      // A second root: kept under the first one.
      skipped.push({ line: line.n, text: line.text });
      continue;
    }
    const id = `m${nodes.length}`;
    nodes.push({ id, label, ...spec, ...(nodes.length === 0 ? { shape: spec.shape === "rounded" ? "ellipse" : spec.shape } : {}) });
    if (stack.length) edges.push({ from: stack[stack.length - 1].id, to: id, end: "none" });
    stack.push({ indent, id });
    checkCounts(nodes.length, edges.length);
  }
  if (!nodes.length) throw new DiagramImportError("empty");
  return { source: "mermaid", diagram: { kind: "mindmap", direction: "LR", nodes, edges, groups: [] }, skipped };
}
