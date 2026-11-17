// Where the values that choose a recipient, an approver or a target come
// from (docs/specs/workflows.md §9.8): an AI answer, an HTTP answer or the
// data a trigger brings from outside – a form's answers, a webhook's body,
// an inbound e-mail, a comment's text – are written by whoever sends them,
// and text injected there must not decide whom a workflow mails or which
// page it changes. The trace follows placeholders through the nodes in
// between, like tracedSources in ./nodes/ai.ts: a "Set values", a loop's
// $item, a "Find records" whose filter uses the value – conservatively,
// every placeholder in the settings of a node in between counts, except
// for the record or page a node creates or changes (its id comes from the
// node's target alone, not from the values it writes).
//
// Such a value is an error at the check (so a workflow is not activated
// with it) unless the workflow's setting `untrustedTargets` ("KI und
// Auslöser-Daten dürfen Empfänger und Ziele bestimmen") allows it – then a
// warning. Client-safe.
import { AI_TYPES, isTrigger } from "./catalog";
import { configTexts, innermostLoops, type GraphIssue, type WorkflowGraph } from "./graph";
import { parseTemplate, type Path } from "./placeholders";

// The parts of a trigger's output that come from outside (path prefixes).
export const UNTRUSTED_TRIGGER_DATA: Record<string, string[][]> = {
  "trigger.form.submitted": [["answers"], ["record", "fields"], ["record", "title"]],
  "trigger.webhook": [["body"], ["query"], ["headers"]],
  "trigger.mail.received": [["mail"]],
  "trigger.comment.created": [["comment", "text"]],
};
// Nodes whose record or page output is the one named by these settings.
const IDENTITY: Record<string, string[]> = {
  "action.record.create": ["database"],
  "action.record.update": ["record"],
  "action.record.template": ["record"],
  "action.page.create": ["parent"],
  "action.page.append": ["page"],
  "action.page.tag": ["page"],
  "action.page.move": ["page"],
  "action.task.create": ["page"],
};
// The settings that choose recipients, approvers and targets.
export const CHOOSING_SETTINGS: Record<string, { keys: string[]; what: "recipients" | "target" }[]> = {
  "notify.email": [{ keys: ["to"], what: "recipients" }],
  "notify.person": [{ keys: ["to"], what: "recipients" }],
  "logic.approval": [{ keys: ["approvers"], what: "recipients" }],
  "action.task.create": [
    { keys: ["page"], what: "target" },
    { keys: ["assignee"], what: "recipients" },
  ],
  "action.page.append": [{ keys: ["page"], what: "target" }],
  "action.page.create": [{ keys: ["parent"], what: "target" }],
  "action.page.move": [{ keys: ["page", "parent"], what: "target" }],
  "action.page.tag": [{ keys: ["page"], what: "target" }],
  "action.record.update": [{ keys: ["record"], what: "target" }],
  "action.record.template": [{ keys: ["record"], what: "target" }],
};

export type Origin = { nodeId: string; kind: "ai" | "http" | "trigger" };

const startsWith = (keys: string[], prefix: string[]) => keys.length >= prefix.length && prefix.every((k, i) => keys[i] === k);
const isIdentityPath = (keys: string[]) => (keys[0] === "record" || keys[0] === "page") && (keys.length === 1 || ["id", "url", "link"].includes(keys[1]));

// The first outside origin of the placeholders in `texts` (settings of the
// node `nodeId`), or null when every value is fixed or comes from Flowplan.
export function untrustedOrigin(graph: WorkflowGraph, nodeId: string, texts: string[]): Origin | null {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const loops = innermostLoops(graph);
  const seen = new Set<string>();
  const fromNode = (id: string, keys: string[]): Origin | null => {
    const n = byId.get(id);
    if (!n) return null;
    if (AI_TYPES.has(n.type)) return { nodeId: id, kind: "ai" };
    if (n.type === "http.request") return { nodeId: id, kind: "http" };
    if (isTrigger(n.type)) {
      const outside = UNTRUSTED_TRIGGER_DATA[n.type];
      return outside && (!keys.length || outside.some((prefix) => startsWith(keys, prefix))) ? { nodeId: id, kind: "trigger" } : null;
    }
    const config = n.config as Record<string, unknown>;
    const target = () => (IDENTITY[n.type] || []).flatMap((k) => configTexts(config[k]));
    // One property of a record a node wrote: that value (and which record).
    const field = (n.type === "action.record.create" || n.type === "action.record.update") && keys[0] === "record" && keys[1] === "fields" && keys.length > 2 ? keys[2] : null;
    const scope = IDENTITY[n.type] && isIdentityPath(keys) ? "id" : field !== null ? `field:${field}` : "all";
    const key = `${id}:${scope}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const values = (config.values as Record<string, unknown>) || {};
    // A property the update leaves as it is on the triggering record: what the trigger brought.
    if (field !== null && n.type === "action.record.update" && !String(config.record || "").trim() && !(field in values)) {
      const o = fromPath({ root: "$trigger", keys }, id);
      if (o) return o;
    }
    const texts = scope === "id" ? target() : field !== null ? [...configTexts(values[field]), ...target()] : configTexts(config);
    return fromTexts(texts, id);
  };
  const fromPath = (p: Path, at: string): Origin | null => {
    const keys = p.keys.map(String);
    if (p.root === "$item" || p.root === "$index") {
      for (let l = loops.get(at); l; l = loops.get(l)) {
        const o = fromNode(l, []);
        if (o) return o;
      }
      return null;
    }
    if (p.root === "$trigger") {
      for (const t of graph.nodes) {
        const o = isTrigger(t.type) ? fromNode(t.id, keys) : null;
        if (o) return o;
      }
      return null;
    }
    return fromNode(p.root, keys);
  };
  const fromTexts = (list: string[], at: string): Origin | null => {
    for (const text of list) {
      let segments;
      try {
        segments = parseTemplate(text);
      } catch {
        continue;
      }
      for (const s of segments) {
        if (typeof s === "string") continue;
        for (const p of [s.path, ...s.filters.flatMap((f) => f.args.flatMap((a) => (a.kind === "path" ? [a.value] : [])))]) {
          const o = fromPath(p, at);
          if (o) return o;
        }
      }
    }
    return null;
  };
  return fromTexts(texts, nodeId);
}

// The texts of a setting: strings, list entries, and `{ value }` entries.
function settingTexts(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((x) => (typeof x === "string" ? [x] : typeof (x as { value?: unknown })?.value === "string" ? [String((x as { value: string }).value)] : []));
  return [];
}

// The check's findings: per node and kind, an error – or a warning when
// the workflow allows it. "field:<id>" recipients read the triggering
// record, which a form fills from outside.
export function untrustedTargetIssues(graph: WorkflowGraph): GraphIssue[] {
  const allowed = !!graph.settings?.untrustedTargets;
  const formTrigger = graph.nodes.find((n) => n.type === "trigger.form.submitted" && !n.disabled);
  const labels = new Map(graph.nodes.map((n) => [n.id, n.label]));
  const issues: GraphIssue[] = [];
  for (const n of graph.nodes) {
    if (n.disabled) continue;
    for (const { keys, what } of CHOOSING_SETTINGS[n.type] || []) {
      const texts = keys.flatMap((k) => settingTexts((n.config as Record<string, unknown>)[k]));
      const origin =
        untrustedOrigin(graph, n.id, texts) ?? (formTrigger && what === "recipients" && texts.some((t) => t.startsWith("field:")) ? { nodeId: formTrigger.id, kind: "trigger" as const } : null);
      if (!origin) continue;
      const code = allowed ? (what === "recipients" ? "ai_to_recipients" : "ai_to_target") : what === "recipients" ? "untrusted_recipients" : "untrusted_target";
      if (issues.some((i) => i.nodeId === n.id && i.code === code)) continue;
      issues.push({ level: allowed ? "warning" : "error", code, nodeId: n.id, params: { node: labels.get(origin.nodeId) || origin.nodeId } });
    }
  }
  return issues;
}
// Whether a graph lets outside data choose recipients or targets – the
// active version of a workflow activated before the check knew it keeps
// running, marked with this (lib/workflows/store.ts workflowState).
export const needsUntrustedSetting = (graph: WorkflowGraph) => !graph.settings?.untrustedTargets && untrustedTargetIssues(graph).length > 0;
