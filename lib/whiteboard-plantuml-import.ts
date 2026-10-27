// PlantUML as editable whiteboard diagrams, parsed here – no PlantUML
// server, no Java. Covered: the common syntax of activity diagrams (new
// syntax), sequence, class, use case and component diagrams and mind maps
// (@startmindmap). Styling (skinparam, themes) is left out silently; any
// other line that is not understood is reported.
import type { MarkerKind } from "./whiteboard-diagram-model";
import type { LayoutDirection } from "./whiteboard-autolayout";
import {
  DiagramImportError,
  checkCounts,
  cleanLabel,
  sourceLines,
  type DiagramEdge,
  type DiagramGraph,
  type DiagramGroup,
  type DiagramNode,
  type DiagramSkip,
  type ParsedDiagram,
  type SequenceEvent,
  type SequenceModel,
} from "./whiteboard-diagram-graph";
import { classLabel } from "./whiteboard-mermaid-import";

type Line = { n: number; raw: string; text: string };
// Lines that only change the looks.
const COSMETIC = /^(skinparam\b|!theme\b|!include\b|!pragma\b|hide\b|show\b|scale\b|title\b|header\b|footer\b|caption\b|autonumber\b|left to right direction|top to bottom direction|allowmixing|set namespaceSeparator|'|\/')/i;

export function parsePlantUml(text: string): ParsedDiagram {
  const all = sourceLines(text);
  const start = all.findIndex((l) => /^@start\w+/i.test(l.text));
  const kindToken = start >= 0 ? all[start].text.match(/^@start(\w+)/i)![1].toLowerCase() : "uml";
  const end = all.findIndex((l, i) => i > start && /^@end\w+/i.test(l.text));
  let lines = all.slice(start + 1, end < 0 ? undefined : end);
  // Block comments /' … '/ and line comments.
  let inComment = false;
  lines = lines.filter((l) => {
    if (inComment) {
      if (l.text.includes("'/")) inComment = false;
      return false;
    }
    if (l.text.startsWith("/'")) {
      inComment = !l.text.includes("'/", 2);
      return false;
    }
    return !!l.text && !l.text.startsWith("'");
  });
  if (kindToken === "mindmap") return mindmap(lines);
  if (kindToken !== "uml") throw new DiagramImportError("unsupported", `@start${kindToken}`);
  if (!lines.length) throw new DiagramImportError("empty");
  const leftToRight = lines.some((l) => /^left to right direction$/i.test(l.text));
  const content = lines.filter((l) => !COSMETIC.test(l.text));
  switch (detect(content)) {
    case "activity":
      return activity(content);
    case "sequence":
      return sequence(content);
    case "class":
      return structure(content, "class", leftToRight);
    case "usecase":
      return structure(content, "usecase", leftToRight);
    default:
      return structure(content, "component", leftToRight);
  }
}

type Kind = "activity" | "sequence" | "class" | "usecase" | "component";
function detect(lines: Line[]): Kind {
  const score: Record<Kind, number> = { activity: 0, sequence: 0, class: 0, usecase: 0, component: 0 };
  for (const { text: s } of lines) {
    if (/^(start|stop|end|fork|fork again|end fork|repeat|endif|endwhile|detach|kill)$/.test(s) || /^:.*[;|<>\]/}]$/.test(s) || /^(if|while|elseif)\s*\(/.test(s) || /^repeat while\b/.test(s) || /^:/.test(s)) score.activity += 3;
    if (/^(participant|boundary|control|collections|queue)\b/.test(s) || /^(alt|loop|opt|par|group|critical|break)\b/.test(s) || /^(activate|deactivate|return)\b/.test(s)) score.sequence += 3;
    if (/^[\w"]+\s*-+>>?\s*[\w"]+\s*:/.test(s)) score.sequence += 1;
    if (/^(abstract\s+class|abstract|class|interface|enum|annotation|struct|protocol)\s/.test(s) || /(<\|--|--\|>|\*--|--\*|o--|--o|\.\.\|>|<\|\.\.)/.test(s)) score.class += 3;
    if (/^usecase\b/.test(s) || /\([^)]+\)\s*(?:as\b|-|\.|$)/.test(s) || /(^|\s):[^:]+:(\s|$)/.test(s)) score.usecase += 2;
    if (/^actor\b/.test(s)) {
      score.usecase += 1;
      score.sequence += 1;
    }
    if (/^\[[^\]]+\]/.test(s) || /^(component|node|database|cloud|folder|frame|artifact|storage|port)\b/.test(s) || /\[[^\]]+\]\s*[-.]/.test(s) || /^\(\)\s/.test(s)) score.component += 2;
  }
  const best = (Object.keys(score) as Kind[]).sort((a, b) => score[b] - score[a])[0];
  return score[best] ? best : "sequence";
}

// ---- activity diagrams ----

type Tail = { id: string; label?: string };
function activity(lines: Line[]): ParsedDiagram {
  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];
  const skipped: DiagramSkip[] = [];
  let tails: Tail[] = [];
  type Frame =
    | { kind: "if"; decision: string; branches: Tail[][]; pending: string | null; hasElse: boolean }
    | { kind: "while"; decision: string; exitLabel?: string }
    | { kind: "repeat"; start: string }
    | { kind: "fork"; bar: string; branches: Tail[][]; split: boolean };
  const frames: Frame[] = [];
  const add = (node: Omit<DiagramNode, "id">) => {
    const id = `a${nodes.length}`;
    nodes.push({ id, ...node });
    checkCounts(nodes.length, edges.length);
    return id;
  };
  const connect = (to: string, from: Tail[] = tails) => {
    for (const t of from) edges.push({ from: t.id, to, end: "arrow", ...(t.label ? { label: t.label } : {}) });
  };
  const step = (node: Omit<DiagramNode, "id">) => {
    const id = add(node);
    connect(id);
    tails = [{ id }];
    return id;
  };
  let action: { lines: string[]; n: number } | null = null;
  for (const line of lines) {
    const s = line.text;
    let m: RegExpMatchArray | null;
    // Actions may run over several lines until ";".
    if (action) {
      const close = s.match(/^(.*)[;|<>\]/}]$/);
      action.lines.push(close ? close[1] : s);
      if (close) {
        step({ label: cleanLabel(action.lines.join("\n")), lib: "uml:state" });
        action = null;
      }
      continue;
    }
    if ((m = s.match(/^(?:#[\w]+)?:(.*)[;|<>\]/}]$/))) {
      step({ label: cleanLabel(m[1]), lib: "uml:state" });
      continue;
    }
    if ((m = s.match(/^(?:#[\w]+)?:(.*)$/))) {
      action = { lines: [m[1]], n: line.n };
      continue;
    }
    if (s === "start") {
      const id = add({ label: "", lib: "uml:start" });
      tails = [{ id }];
      continue;
    }
    if (s === "stop" || s === "end") {
      step({ label: "", lib: "uml:end" });
      tails = [];
      continue;
    }
    if (s === "detach" || s === "kill") {
      tails = [];
      continue;
    }
    if ((m = s.match(/^if\s*\((.*?)\)\s*(?:then\s*(?:\((.*)\))?)?\s*(?:is\s*\((.*)\)\s*then)?$/))) {
      const decision = step({ label: cleanLabel(m[1]), lib: "flow:decision" });
      frames.push({ kind: "if", decision, branches: [], pending: null, hasElse: false });
      tails = [{ id: decision, label: cleanLabel(m[2] || m[3] || "") || undefined }];
      continue;
    }
    if ((m = s.match(/^(?:else\s*)?elseif\s*\((.*?)\)\s*(?:then\s*(?:\((.*)\))?)?$/))) {
      const frame = frames[frames.length - 1];
      if (frame?.kind !== "if") {
        skipped.push({ line: line.n, text: line.text });
        continue;
      }
      frame.branches.push(tails);
      const decision = add({ label: cleanLabel(m[1]), lib: "flow:decision" });
      edges.push({ from: frame.decision, to: decision, end: "arrow" });
      frame.decision = decision;
      tails = [{ id: decision, label: cleanLabel(m[2] || "") || undefined }];
      continue;
    }
    if ((m = s.match(/^else\s*(?:\((.*)\))?$/))) {
      const frame = frames[frames.length - 1];
      if (frame?.kind !== "if") {
        skipped.push({ line: line.n, text: line.text });
        continue;
      }
      frame.branches.push(tails);
      frame.hasElse = true;
      tails = [{ id: frame.decision, label: cleanLabel(m[1] || "") || undefined }];
      continue;
    }
    if (/^end\s*if$|^endif$/.test(s)) {
      const frame = frames.pop();
      if (frame?.kind !== "if") {
        skipped.push({ line: line.n, text: line.text });
        continue;
      }
      frame.branches.push(tails);
      if (!frame.hasElse) frame.branches.push([{ id: frame.decision }]);
      tails = frame.branches.flat();
      continue;
    }
    if ((m = s.match(/^while\s*\((.*?)\)\s*(?:is\s*\((.*)\))?$/))) {
      const decision = step({ label: cleanLabel(m[1]), lib: "flow:decision" });
      frames.push({ kind: "while", decision });
      tails = [{ id: decision, label: cleanLabel(m[2] || "") || undefined }];
      continue;
    }
    if ((m = s.match(/^end\s*while\s*(?:\((.*)\))?$/))) {
      const frame = frames.pop();
      if (frame?.kind !== "while") {
        skipped.push({ line: line.n, text: line.text });
        continue;
      }
      connect(frame.decision);
      tails = [{ id: frame.decision, label: cleanLabel(m[1] || "") || undefined }];
      continue;
    }
    if (s === "repeat") {
      const start = step({ label: "", lib: "uml:merge" });
      frames.push({ kind: "repeat", start });
      continue;
    }
    if ((m = s.match(/^repeat\s*while\s*\((.*?)\)\s*(?:is\s*\((.*?)\))?\s*(?:not\s*\((.*?)\))?$/))) {
      const frame = frames.pop();
      if (frame?.kind !== "repeat") {
        skipped.push({ line: line.n, text: line.text });
        continue;
      }
      const decision = step({ label: cleanLabel(m[1]), lib: "flow:decision" });
      edges.push({ from: decision, to: frame.start, end: "arrow", ...(m[2] ? { label: cleanLabel(m[2]) } : {}) });
      tails = [{ id: decision, label: cleanLabel(m[3] || "") || undefined }];
      continue;
    }
    if (s === "fork" || s === "split") {
      const bar = s === "fork" ? step({ label: "", lib: "uml:fork" }) : "";
      frames.push({ kind: "fork", bar, branches: [], split: s === "split" });
      if (s === "split") frames[frames.length - 1] = { kind: "fork", bar: "", branches: [], split: true };
      (frames[frames.length - 1] as { start?: Tail[] }).start = tails;
      continue;
    }
    if (s === "fork again" || s === "split again") {
      const frame = frames[frames.length - 1];
      if (frame?.kind !== "fork") {
        skipped.push({ line: line.n, text: line.text });
        continue;
      }
      frame.branches.push(tails);
      tails = frame.bar ? [{ id: frame.bar }] : (frame as { start?: Tail[] }).start || [];
      continue;
    }
    if (/^end\s*(fork|merge|split)(\s*\{.*\})?$/.test(s)) {
      const frame = frames.pop();
      if (frame?.kind !== "fork") {
        skipped.push({ line: line.n, text: line.text });
        continue;
      }
      frame.branches.push(tails);
      if (frame.split) tails = frame.branches.flat();
      else {
        const join = add({ label: "", lib: "uml:fork" });
        connect(join, frame.branches.flat());
        tails = [{ id: join }];
      }
      continue;
    }
    skipped.push({ line: line.n, text: line.text });
  }
  if (action) skipped.push({ line: action.n, text: `:${action.lines.join(" ")}` });
  return { source: "plantuml", diagram: { kind: "activity", direction: "TB", nodes, edges, groups: [] }, skipped };
}

// ---- sequence diagrams ----

function sequence(lines: Line[]): ParsedDiagram {
  const participants = new Map<string, SequenceModel["participants"][number]>();
  const events: SequenceEvent[] = [];
  const skipped: DiagramSkip[] = [];
  let note: { over: string[]; side: "left" | "right" | "over"; text: string[] } | null = null;
  let depth = 0;
  const name = (raw: string) => raw.trim().replace(/^"(.*)"$/, "$1");
  const participant = (raw: string, label?: string, actor?: boolean) => {
    const id = name(raw);
    let p = participants.get(id);
    if (!p) {
      p = { id, label: label || id, ...(actor ? { actor: true } : {}) };
      participants.set(id, p);
    }
    return p;
  };
  let last: string | null = null;
  for (const line of lines) {
    const s = line.text;
    let m: RegExpMatchArray | null;
    if (note) {
      if (/^end\s*note$/i.test(s)) {
        events.push({ type: "note", over: note.over, side: note.side, text: cleanLabel(note.text.join("\n")) });
        note = null;
      } else note.text.push(s);
      continue;
    }
    if ((m = s.match(/^(participant|actor|boundary|control|entity|database|collections|queue)\s+("[^"]+"|[^\s"]+)(?:\s+as\s+("[^"]+"|\S+))?(?:\s+order\s+\d+)?(?:\s+#\w+)?$/))) {
      // "participant "Long name" as L" and "participant L as "Long name"".
      const [a, b] = [m[2], m[3]];
      const quotedFirst = a.startsWith('"');
      const id = b ? (quotedFirst ? b : a) : a;
      const label = b ? cleanLabel(quotedFirst ? a : b) : cleanLabel(a);
      participant(id, label, m[1] === "actor");
      continue;
    }
    if ((m = s.match(/^(?:r|h)?note\s+(left of|right of|over|left|right)\s*([^:]*?)\s*(?::\s*(.*))?$/i))) {
      const side = m[1].toLowerCase().startsWith("left") ? "left" : m[1].toLowerCase().startsWith("right") ? "right" : "over";
      const over = m[2] ? m[2].split(",").map(name).filter(Boolean) : last ? [last] : [];
      if (!over.length) {
        skipped.push({ line: line.n, text: line.text });
        continue;
      }
      over.forEach((id) => participant(id));
      if (m[3] !== undefined) events.push({ type: "note", over, side, text: cleanLabel(m[3]) });
      else note = { over, side, text: [] };
      continue;
    }
    if ((m = s.match(/^(alt|loop|opt|par|break|critical|group)\b\s*(.*)$/))) {
      depth++;
      events.push({ type: "block", kind: m[1], label: cleanLabel(m[2]) });
      continue;
    }
    if ((m = s.match(/^else\b\s*(.*)$/))) {
      events.push({ type: "else", label: cleanLabel(m[1]) });
      continue;
    }
    if (s === "end") {
      if (depth) {
        depth--;
        events.push({ type: "end" });
      } else skipped.push({ line: line.n, text: line.text });
      continue;
    }
    if (/^(activate|deactivate|destroy|create|return|autoactivate|newpage|\.\.\.|\|\|\||==)/.test(s)) {
      if (/^(==|\.\.\.|\|\|\|)/.test(s) || /^return\b/.test(s) || /^newpage\b/.test(s)) skipped.push({ line: line.n, text: line.text });
      continue;
    }
    // A -> B : text, B <-- A, A ->> B, A ->x B, A <-> B
    if ((m = s.match(/^("[^"]+"|[^\s<>\-"/\\]+)\s*([xo]?)(<<?|\/\/?|\\\\?)?(-{1,2})(?:\[#?\w+\])?(>>?|\/\/?|\\\\?)?([xo]?)\s*("[^"]+"|[^\s:<>\-"]+)\s*(?:\+\+|--|\*\*|!!)?\s*(?::\s*(.*))?$/))) {
      const [, a, leftExtra, left, dashes, right, rightExtra, b, label] = m;
      if (!left && !right && !leftExtra && !rightExtra) {
        skipped.push({ line: line.n, text: line.text });
        continue;
      }
      const head = (token?: string, extra?: string): MarkerKind =>
        extra === "x" ? "cross" : extra === "o" ? "circle" : !token ? "none" : token === ">" || token === "<" ? "arrow" : "open";
      const reversed = !!(left || leftExtra) && !(right || rightExtra);
      const from = participant(reversed ? b : a).id,
        to = participant(reversed ? a : b).id;
      last = to;
      events.push({
        type: "message",
        from,
        to,
        label: cleanLabel(label || ""),
        dashed: dashes === "--",
        end: reversed ? head(left, leftExtra) : head(right, rightExtra),
        ...(!reversed && (left || leftExtra) ? { start: head(left, leftExtra) } : {}),
      });
      continue;
    }
    if (/^(ref\s+over|divider|delay|space|box\b|end box)/.test(s)) {
      skipped.push({ line: line.n, text: line.text });
      continue;
    }
    skipped.push({ line: line.n, text: line.text });
  }
  return { source: "plantuml", diagram: { kind: "sequence", participants: [...participants.values()], events }, skipped };
}

// ---- class, use case and component diagrams ----

type Element = { id: string; name: string; lib: string; stereotype?: string; fields: string[]; methods: string[]; group?: string };
const LEFT_HEAD: Record<string, MarkerKind> = { "<|": "triangle", "*": "filledDiamond", o: "diamond", "<": "open", "#": "diamond", x: "cross", "}": "many", "+": "circle", "^": "triangle" };
const RIGHT_HEAD: Record<string, MarkerKind> = { "|>": "triangle", "*": "filledDiamond", o: "diamond", ">": "open", "#": "diamond", x: "cross", "{": "many", "+": "circle", "^": "triangle" };
const OPERAND = String.raw`(\[[^\]]+\]|\([^)]+\)|:[^:]+:|\(\)\s*"?[^"\s-]+"?|"[^"]+"|[\w.$]+(?:<[^>]*>)?)`;
const RELATION = new RegExp(
  String.raw`^${OPERAND}\s*(?:"([^"]*)"\s*)?(<\||\*|o|<|#|x|\}|\+|\^)?(-+|\.+)(?:(?:\[[^\]]*\])?(?:up|down|left|right|u|d|l|r)?(?:\[[^\]]*\])?(-+|\.+))?(\|>|\*|o|>|#|x|\{|\+|\^)?\s*(?:"([^"]*)"\s*)?${OPERAND}\s*(?::\s*(.*))?$`,
);

function structure(lines: Line[], kind: "class" | "usecase" | "component", leftToRight: boolean): ParsedDiagram {
  const elements = new Map<string, Element>();
  const aliases = new Map<string, string>();
  const edges: DiagramEdge[] = [];
  const groups: DiagramGroup[] = [];
  const skipped: DiagramSkip[] = [];
  const containers: (string | null)[] = [];
  let body: Element | null = null;
  let note: { id: string; text: string[]; target?: string } | null = null;
  const group = () => [...containers].reverse().find((c): c is string => !!c);
  const defaultLib = kind === "class" ? "uml:class" : kind === "usecase" ? "uml:usecase" : "uml:component";
  const element = (raw: string, lib?: string, label?: string) => {
    let token = raw.trim(),
      kindLib = lib;
    if (/^\[.*\]$/.test(token)) {
      token = token.slice(1, -1);
      kindLib ||= "uml:component";
    } else if (/^\(\)/.test(token)) {
      token = token.slice(2).trim();
      kindLib ||= "erd:attribute";
    } else if (/^\(.*\)$/.test(token)) {
      token = token.slice(1, -1);
      kindLib ||= "uml:usecase";
    } else if (/^:.*:$/.test(token)) {
      token = token.slice(1, -1);
      kindLib ||= "uml:actor";
    }
    token = token.replace(/^"(.*)"$/, "$1").trim();
    const id = aliases.get(token) || token;
    let e = elements.get(id);
    if (!e) {
      e = { id, name: label || token, lib: kindLib || defaultLib, fields: [], methods: [], ...(group() ? { group: group() } : {}) };
      elements.set(id, e);
      checkCounts(elements.size, edges.length);
    } else if (lib) e.lib = lib;
    if (label) e.name = label;
    return e;
  };
  const DECL: Record<string, string> = {
    class: "uml:class",
    "abstract class": "uml:class",
    abstract: "uml:class",
    interface: "uml:interface",
    enum: "uml:enum",
    annotation: "uml:class",
    struct: "uml:class",
    protocol: "uml:interface",
    entity: kind === "class" ? "uml:class" : "erd:entity",
    actor: "uml:actor",
    usecase: "uml:usecase",
    component: "uml:component",
    node: "uml:node",
    database: "flow:database",
    cloud: "net:cloud",
    artifact: "flow:document",
    storage: "flow:database",
    queue: "cloud:queue",
    file: "flow:document",
    agent: "uml:component",
    boundary: "uml:component",
    control: "uml:component",
    person: "org:person",
    port: "flow:connector",
  };
  const CONTAINERS = /^(package|namespace|rectangle|folder|frame|node|cloud|database|together|card)\s*("[^"]+"|[^\s{]+)?(?:\s+as\s+([\w.]+))?\s*(?:<<[^>]*>>)?\s*(?:#\w+)?\s*\{$/;
  for (const line of lines) {
    const s = line.text;
    let m: RegExpMatchArray | null;
    if (note) {
      if (/^end\s*note$/i.test(s)) {
        const n = element(note.id, "uml:note", cleanLabel(note.text.join("\n")));
        if (note.target) edges.push({ from: n.id, to: note.target, dashed: true, end: "none" });
        note = null;
      } else note.text.push(s);
      continue;
    }
    if (body) {
      if (s === "}") body = null;
      else if (!/^(--|==|\.\.|__)/.test(s)) {
        const text = s.replace(/^\{(static|abstract|field|method)\}\s*/, "").slice(0, 300);
        if (/\(.*\)/.test(text)) body.methods.push(text);
        else body.fields.push(text);
      }
      continue;
    }
    if ((m = s.match(CONTAINERS))) {
      const label = m[2] ? cleanLabel(m[2]) : m[1] === "together" ? "" : m[1];
      if (m[1] === "together") {
        containers.push(null);
        continue;
      }
      const id = `group:${m[3] || label}:${groups.length}`;
      groups.push({ id, label, ...(group() ? { parent: group() } : {}) });
      containers.push(id);
      continue;
    }
    if (s === "}") {
      if (containers.length) containers.pop();
      else skipped.push({ line: line.n, text: line.text });
      continue;
    }
    if ((m = s.match(/^note\s+(?:(?:top|bottom|left|right)\s+of\s+)?("[^"]+"|[\w.]+)?\s*(?:as\s+(\w+))?\s*(?::\s*(.*))?$/i)) && /^note\b/i.test(s)) {
      // note "text" as N / note left of A : text / note right of A … end note
      const target = m[1] && !m[1].startsWith('"') ? element(m[1]).id : undefined;
      const id = m[2] || `note${elements.size}`;
      if (m[1]?.startsWith('"')) element(id, "uml:note", cleanLabel(m[1]));
      else if (m[3] !== undefined) {
        const n = element(id, "uml:note", cleanLabel(m[3]));
        if (target) edges.push({ from: n.id, to: target, dashed: true, end: "none" });
      } else note = { id, text: [], target };
      continue;
    }
    const declaration = s.match(/^(abstract\s+class|abstract|class|interface|enum|annotation|struct|protocol|entity|actor|usecase|component|node|database|cloud|artifact|storage|queue|file|agent|boundary|control|person|port)\s+(.+)$/);
    if (declaration) {
      let rest = declaration[2].trim();
      const open = rest.endsWith("{");
      if (open) rest = rest.slice(0, -1).trim();
      rest = rest.replace(/\s*#[\w]+$/, "").replace(/\s*\{\s*\}$/, "");
      const stereo = rest.match(/\s*<<\s*([^>]+?)\s*>>/);
      if (stereo) rest = rest.replace(stereo[0], "").trim();
      // "Name" as A, A as "Name", (Name) as UC, [Name] as C, :Name: as A
      const as = rest.match(/^(.+?)\s+as\s+(.+)$/);
      let id: string, label: string | undefined;
      if (as) {
        const [a, b] = [as[1].trim(), as[2].trim()];
        const quoted = (v: string) => /^["([:].*["\])]:?$/.test(v);
        if (quoted(a) && !quoted(b)) [id, label] = [b, a];
        else [id, label] = [a, b];
        label = cleanLabel(label.replace(/^[[(:]|[\])]$|:$/g, ""));
        id = id.replace(/^[[(:"]|[\])"]$|:$/g, "");
      } else {
        id = rest.replace(/^[[(:"]|[\])"]$|:$/g, "");
        label = undefined;
      }
      const e = element(id, DECL[declaration[1].replace(/\s+/, " ")], label);
      if (declaration[1].startsWith("abstract")) e.stereotype = "abstract";
      if (stereo) e.stereotype = stereo[1];
      if (open) body = e;
      continue;
    }
    if ((m = s.match(/^(\(\)|\[[^\]]+\]|\([^)]+\)|:[^:]+:)\s*("[^"]+"|[\w.]+)?\s*(?:as\s+([\w.]+))?$/)) && (m[1] !== "()" || m[2])) {
      // "() I", "[A] as B", "(Use) as UC", ":User: as U"
      if (m[1] === "()") element(m[3] || m[2]!, "erd:attribute", cleanLabel(m[2]!));
      else {
        const e = element(m[1]);
        if (m[3]) {
          aliases.set(m[3], e.id);
        }
      }
      continue;
    }
    if ((m = s.match(RELATION))) {
      const [, a, cardA, left, line1, line2, right, cardB, b, label] = m;
      const from = element(a),
        to = element(b);
      const dashed = (line1 + (line2 || "")).includes(".");
      const text = [cardA, label && cleanLabel(label.replace(/\s*[<>]\s*$/, "").replace(/^\s*[<>]\s*/, "")), cardB].filter(Boolean).join(" · ");
      // Use case diagrams: "A --> (B)" is an arrow, "A -- (B)" a line.
      edges.push({
        from: from.id,
        to: to.id,
        dashed,
        start: (left && LEFT_HEAD[left]) || "none",
        end: (right && RIGHT_HEAD[right]) || "none",
        ...(text ? { label: text } : {}),
      });
      checkCounts(elements.size, edges.length);
      continue;
    }
    if ((m = s.match(/^([\w.]+)\s*:\s*(.+)$/)) && elements.has(aliases.get(m[1]) || m[1])) {
      const e = element(m[1]);
      if (/\(.*\)/.test(m[2])) e.methods.push(m[2].trim());
      else e.fields.push(m[2].trim());
      continue;
    }
    skipped.push({ line: line.n, text: line.text });
  }
  const nodes: DiagramNode[] = [...elements.values()].map((e) => ({
    id: e.id,
    label:
      e.lib === "uml:class" || e.lib === "uml:interface" || e.lib === "uml:enum"
        ? classLabel({ ...e, stereotype: e.stereotype || (e.lib === "uml:interface" ? "interface" : e.lib === "uml:enum" ? "enumeration" : undefined) })
        : e.lib === "erd:entity"
          ? [e.name, ...e.fields, ...e.methods].join("\n")
          : e.stereotype && e.lib !== "uml:actor"
            ? `«${e.stereotype}»\n${e.name}`
            : e.name,
    lib: e.lib,
    ...(e.lib === "uml:note" ? { fill: "#fff9db" } : {}),
    ...(e.group ? { group: e.group } : {}),
  }));
  const direction: LayoutDirection = leftToRight || kind === "usecase" ? "LR" : "TB";
  return { source: "plantuml", diagram: { kind, direction, nodes, edges, groups }, skipped };
}

// ---- mind maps ----

function mindmap(lines: Line[]): ParsedDiagram {
  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];
  const skipped: DiagramSkip[] = [];
  const stack: { depth: number; id: string }[] = [];
  let open: { depth: number; text: string[]; n: number } | null = null;
  const addNode = (depth: number, text: string, n: number) => {
    const label = cleanLabel(text);
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
    if (!stack.length && nodes.length) {
      skipped.push({ line: n, text });
      return;
    }
    const id = `m${nodes.length}`;
    nodes.push({ id, label, shape: nodes.length ? "rounded" : "ellipse" });
    if (stack.length) edges.push({ from: stack[stack.length - 1].id, to: id, end: "none" });
    stack.push({ depth, id });
    checkCounts(nodes.length, edges.length);
  };
  for (const line of lines) {
    const s = line.text;
    if (open) {
      if (/;$/.test(s)) {
        open.text.push(s.slice(0, -1));
        addNode(open.depth, open.text.join("\n"), open.n);
        open = null;
      } else open.text.push(s);
      continue;
    }
    const m = s.match(/^([*+-]+)(?:\[#?\w+\])?(_)?\s*(:)?(.*)$/);
    if (!m) {
      if (!COSMETIC.test(s)) skipped.push({ line: line.n, text: line.text });
      continue;
    }
    if (m[3]) {
      if (m[4].endsWith(";")) addNode(m[1].length, m[4].slice(0, -1), line.n);
      else open = { depth: m[1].length, text: [m[4]], n: line.n };
      continue;
    }
    addNode(m[1].length, m[4], line.n);
  }
  if (!nodes.length) throw new DiagramImportError("empty");
  return { source: "plantuml", diagram: { kind: "mindmap", direction: "LR", nodes, edges, groups: [] } as DiagramGraph, skipped };
}
