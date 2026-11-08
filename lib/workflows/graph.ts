// The graph format of workflows (docs/specs/workflows.md §5): the Zod
// schema and the structural check (ids, labels, ports, edges, cycles,
// limits, the For-each body). References to databases, fields, pages and
// rights are checked on the server (lib/workflows/validate.ts).
// Client-safe.
import { z } from "zod";
import { translate, type Locale } from "../i18n";
import { fixedHost, isTrigger, nodeSpec } from "./catalog";
import { parseTemplate, placeholderRoots } from "./placeholders";

export const GRAPH_FORMAT = "flowplan.workflow";
export const GRAPH_VERSION = 1;
export const GRAPH_LIMITS = { triggers: 10, nodes: 150, edges: 300, bytes: 1_000_000 } as const;

export const nodeIdSchema = z.string().regex(/^n_[a-z0-9]{6,12}$/);
export const edgeIdSchema = z.string().regex(/^e_[a-z0-9_]{1,20}$/);
export const labelSchema = z.string().trim().min(1).max(60).regex(/^[^.|{}[\]]+$/);
export const onErrorSchema = z.object({ retry: z.number().int().min(0).max(5).default(0), then: z.enum(["fail", "port", "continue"]).default("fail") });

export const workflowNodeSchema = z.object({
  id: nodeIdSchema,
  type: z.string().min(1).max(60),
  typeVersion: z.number().int().min(1).default(1),
  label: labelSchema,
  note: z.string().max(2000).default(""),
  position: z.object({ x: z.number().finite(), y: z.number().finite() }).default({ x: 0, y: 0 }),
  disabled: z.boolean().default(false),
  config: z.record(z.string(), z.unknown()).default({}),
  onError: onErrorSchema.optional(),
});
export const workflowEdgeSchema = z.object({
  id: edgeIdSchema,
  from: z.object({ node: nodeIdSchema, port: z.string().min(1).max(60) }),
  to: z.object({ node: nodeIdSchema, port: z.literal("in").default("in") }),
});
export const workflowSettingsSchema = z.object({
  timeZone: z.string().min(1).max(100).default("UTC"),
  // Language of the date and number filters (§13); default: the activating person's.
  locale: z.string().max(10).optional(),
  triggerOnOwnChanges: z.boolean().default(false),
  // Lower limits than the instance's (§12): never higher.
  limits: z.object({ runsPerMinute: z.number().int().min(1).max(1000).optional(), stepsPerRun: z.number().int().min(10).max(2000).optional() }).default({}),
});
export const workflowGraphSchema = z.object({
  format: z.literal(GRAPH_FORMAT).default(GRAPH_FORMAT),
  version: z.number().int().min(1).default(GRAPH_VERSION),
  settings: workflowSettingsSchema.default({ timeZone: "UTC", triggerOnOwnChanges: false, limits: {} }),
  nodes: z.array(workflowNodeSchema).max(GRAPH_LIMITS.nodes),
  edges: z.array(workflowEdgeSchema).max(GRAPH_LIMITS.edges),
});
export type WorkflowNode = z.infer<typeof workflowNodeSchema>;
export type WorkflowEdge = z.infer<typeof workflowEdgeSchema>;
export type WorkflowGraph = z.infer<typeof workflowGraphSchema>;
export type WorkflowSettings = z.infer<typeof workflowSettingsSchema>;

export const emptyGraph = (timeZone = "UTC"): WorkflowGraph => ({
  format: GRAPH_FORMAT,
  version: GRAPH_VERSION,
  settings: { timeZone, triggerOnOwnChanges: false, limits: {} },
  nodes: [],
  edges: [],
});

// A problem of the graph: errors keep it from being activated, warnings not.
export type GraphIssue = { level: "error" | "warning"; code: string; nodeId?: string; edgeId?: string; params?: Record<string, string | number> };

// Parses a graph (throws on a malformed one); a newer format is refused
// with a clear message (§5.3).
export function parseGraph(input: unknown): WorkflowGraph {
  const version = (input as { version?: unknown } | null)?.version;
  if (typeof version === "number" && version > GRAPH_VERSION)
    throw new Error("Dieser Workflow stammt aus einer neueren Flowplan-Version.");
  return workflowGraphSchema.parse(input);
}

export const nodeMap = (graph: WorkflowGraph) => new Map(graph.nodes.map((n) => [n.id, n]));
// Outgoing edges per node and port.
export function outgoing(graph: WorkflowGraph, nodeId: string, port?: string) {
  return graph.edges.filter((e) => e.from.node === nodeId && (port === undefined || e.from.port === port));
}
export const incoming = (graph: WorkflowGraph, nodeId: string) => graph.edges.filter((e) => e.to.node === nodeId);

// The ports a node has: its type's ports plus `error` when errors go to a port.
export function nodePorts(node: WorkflowNode): string[] {
  const s = nodeSpec(node.type);
  if (!s) return [];
  const ports = s.ports(node.config);
  return node.onError?.then === "port" ? [...ports, "error"] : ports;
}

// Nodes on at least one path before `nodeId` (its placeholders may name them).
export function upstreamNodes(graph: WorkflowGraph, nodeId: string): Set<string> {
  const seen = new Set<string>();
  const stack = incoming(graph, nodeId).map((e) => e.from.node);
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of incoming(graph, id)) stack.push(e.from.node);
  }
  return seen;
}

// The bodies of the For-each nodes (§5.1): every node reachable from the
// port `item`. And for every node in a body, its innermost loop.
export function loopBodies(graph: WorkflowGraph): Map<string, Set<string>> {
  const bodies = new Map<string, Set<string>>();
  for (const n of graph.nodes) {
    if (n.type !== "logic.foreach") continue;
    const body = new Set<string>();
    const stack = outgoing(graph, n.id, "item").map((e) => e.to.node);
    while (stack.length) {
      const id = stack.pop()!;
      if (body.has(id) || id === n.id) continue;
      body.add(id);
      for (const e of outgoing(graph, id)) stack.push(e.to.node);
    }
    bodies.set(n.id, body);
  }
  return bodies;
}
export function innermostLoops(graph: WorkflowGraph, bodies = loopBodies(graph)): Map<string, string> {
  const out = new Map<string, string>();
  for (const [loop, body] of bodies)
    for (const id of body) {
      const current = out.get(id);
      // The inner loop is the one inside the other's body.
      if (!current || bodies.get(current)?.has(loop)) out.set(id, loop);
    }
  return out;
}
// How many loops a node sits in.
export function loopDepth(nodeId: string, bodies: Map<string, Set<string>>) {
  let n = 0;
  for (const body of bodies.values()) if (body.has(nodeId)) n++;
  return n;
}

// Every text of a node's configuration (placeholders are looked for in them).
export function configTexts(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) configTexts(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) configTexts(v, out);
  return out;
}

// The structural check (§5.1/5.2 without references).
export function checkGraph(graph: WorkflowGraph): GraphIssue[] {
  const issues: GraphIssue[] = [];
  const err = (code: string, more: Omit<GraphIssue, "level" | "code"> = {}) => issues.push({ level: "error", code, ...more });
  const warn = (code: string, more: Omit<GraphIssue, "level" | "code"> = {}) => issues.push({ level: "warning", code, ...more });
  if (JSON.stringify(graph).length > GRAPH_LIMITS.bytes) err("too_large");
  const nodes = nodeMap(graph);
  if (nodes.size !== graph.nodes.length) err("duplicate_node");
  const labels = new Map<string, string>();
  for (const n of graph.nodes) {
    const key = n.label.toLowerCase();
    if (labels.has(key)) err("duplicate_label", { nodeId: n.id, params: { label: n.label } });
    labels.set(key, n.id);
    const s = nodeSpec(n.type);
    if (!s) {
      err("unknown_type", { nodeId: n.id, params: { type: n.type } });
      continue;
    }
    const parsed = s.config.safeParse(n.config);
    if (!parsed.success)
      err("invalid_config", { nodeId: n.id, params: { detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 300) } });
    if (n.disabled && (isTrigger(n.type) || s.ports(n.config).filter((p) => p !== "out").length)) err("disabled_branch", { nodeId: n.id });
  }
  const triggers = graph.nodes.filter((n) => isTrigger(n.type));
  if (!triggers.length) err("no_trigger");
  if (triggers.length > GRAPH_LIMITS.triggers) err("too_many_triggers");
  const edgeIds = new Set<string>();
  const pairs = new Set<string>();
  for (const e of graph.edges) {
    if (edgeIds.has(e.id)) err("duplicate_edge", { edgeId: e.id });
    edgeIds.add(e.id);
    const from = nodes.get(e.from.node),
      to = nodes.get(e.to.node);
    if (!from || !to) {
      err("dangling_edge", { edgeId: e.id });
      continue;
    }
    if (!nodePorts(from).includes(e.from.port)) err("unknown_port", { edgeId: e.id, nodeId: from.id, params: { port: e.from.port } });
    if (isTrigger(to.type)) err("edge_into_trigger", { edgeId: e.id, nodeId: to.id });
    if (from.id === to.id) err("cycle", { nodeId: from.id });
    const pair = `${e.from.node}:${e.from.port}>${e.to.node}`;
    if (pairs.has(pair)) err("duplicate_edge", { edgeId: e.id });
    pairs.add(pair);
  }
  // For-each bodies (§5.1): no edge leaves a body (except into a nested
  // body, which is part of it) and none enters it from outside; at most
  // two levels.
  const bodies = loopBodies(graph);
  for (const [loop, body] of bodies) {
    for (const e of graph.edges) {
      const fromIn = body.has(e.from.node),
        toIn = body.has(e.to.node);
      if (fromIn && !toIn) err("loop_exit", { edgeId: e.id, nodeId: e.from.node });
      if (!fromIn && toIn && !(e.from.node === loop && e.from.port === "item")) err("loop_entry", { edgeId: e.id, nodeId: e.to.node });
    }
    if (loopDepth(loop, bodies) >= 2) err("loop_depth", { nodeId: loop });
  }
  // Wave 2 nodes: their own rules.
  for (const n of graph.nodes) {
    const c = n.config as Record<string, unknown>;
    if (n.type === "logic.switch") {
      const ids = ((c.cases as { id?: string }[]) || []).map((x) => x.id);
      if (new Set(ids).size !== ids.length) err("duplicate_case", { nodeId: n.id });
    }
    if (n.type === "http.request" && typeof c.url === "string" && !fixedHost(c.url)) err("http_host", { nodeId: n.id });
    if (n.type === "ai.classify" && c.source !== "field" && !((c.categories as unknown[]) || []).length) err("no_categories", { nodeId: n.id });
  }
  // No cycles (a For-each body ends; it never leads back).
  const state = new Map<string, 1 | 2>();
  const visit = (id: string): boolean => {
    if (state.get(id) === 2) return false;
    if (state.get(id) === 1) return true;
    state.set(id, 1);
    for (const e of outgoing(graph, id)) if (nodes.has(e.to.node) && visit(e.to.node)) return true;
    state.set(id, 2);
    return false;
  };
  for (const n of graph.nodes)
    if (visit(n.id)) {
      err("cycle", { nodeId: n.id });
      break;
    }
  // Reachable from a trigger; nodes without an incoming edge are orphans.
  const reachable = new Set<string>();
  const stack = triggers.map((t) => t.id);
  while (stack.length) {
    const id = stack.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const e of outgoing(graph, id)) stack.push(e.to.node);
  }
  for (const n of graph.nodes) if (!reachable.has(n.id)) warn("orphan", { nodeId: n.id });
  // Placeholders name only nodes before them, $item/$index only in a For-each body.
  const inLoop = innermostLoops(graph, bodies);
  for (const n of graph.nodes) {
    const before = upstreamNodes(graph, n.id);
    for (const text of configTexts(n.config)) {
      let parsed;
      try {
        parsed = parseTemplate(text);
      } catch (e) {
        err("placeholder_syntax", { nodeId: n.id, params: { detail: String((e as Error).message).slice(0, 200) } });
        continue;
      }
      for (const root of placeholderRoots(parsed)) {
        if (root === "$item" || root === "$index") {
          if (!inLoop.has(n.id)) err("item_outside_loop", { nodeId: n.id });
        }
        else if (root.startsWith("n_")) {
          if (!nodes.has(root)) err("placeholder_unknown_node", { nodeId: n.id, params: { node: root } });
          else if (!before.has(root)) err("placeholder_not_before", { nodeId: n.id, params: { node: nodes.get(root)!.label } });
        }
      }
    }
  }
  return issues;
}

// i18n-table: 1 – [German, English] pairs (messages of the check)
const ISSUE_TEXT: Record<string, [string, string]> = {
  too_large: ["Der Workflow ist größer als 1 MB.", "The workflow is larger than 1 MB."],
  duplicate_node: ["Eine Knoten-ID kommt doppelt vor.", "A node id occurs twice."],
  duplicate_label: ["Die Bezeichnung „{label}“ kommt doppelt vor.", "The label “{label}” occurs twice."],
  unknown_type: ["Unbekannter Knotentyp {type}.", "Unknown node type {type}."],
  invalid_config: ["Ungültige Einstellungen: {detail}", "Invalid settings: {detail}"],
  disabled_branch: ["Auslöser und Verzweigungen lassen sich nicht abschalten.", "Triggers and branches cannot be switched off."],
  no_trigger: ["Der Workflow braucht einen Auslöser.", "The workflow needs a trigger."],
  too_many_triggers: ["Höchstens 10 Auslöser.", "At most 10 triggers."],
  duplicate_edge: ["Eine Verbindung kommt doppelt vor.", "A connection occurs twice."],
  dangling_edge: ["Eine Verbindung führt ins Leere.", "A connection leads nowhere."],
  unknown_port: ["Unbekannter Ausgang {port}.", "Unknown output {port}."],
  edge_into_trigger: ["Auslöser haben keinen Eingang.", "Triggers have no input."],
  cycle: ["Der Workflow enthält einen Kreis.", "The workflow contains a loop."],
  orphan: ["Dieser Knoten ist von keinem Auslöser aus erreichbar.", "No trigger leads to this node."],
  placeholder_syntax: ["Platzhalter fehlerhaft: {detail}", "Malformed placeholder: {detail}"],
  item_outside_loop: ["$item und $index gibt es nur in „Für jedes“.", "$item and $index exist only inside “For each”."],
  placeholder_unknown_node: ["Ein Platzhalter nennt einen gelöschten Knoten.", "A placeholder names a deleted node."],
  placeholder_not_before: ["Der Platzhalter auf „{node}“ liegt nicht vor diesem Knoten.", "The placeholder on “{node}” is not before this node."],
  unknown_database: ["Die Datenbank gibt es nicht (mehr).", "The database does not exist (any more)."],
  unknown_field: ["Die Eigenschaft gibt es nicht (mehr).", "The property does not exist (any more)."],
  unknown_page: ["Die Seite gibt es nicht (mehr).", "The page does not exist (any more)."],
  page_not_readable: ["Diese Seite darf die ausführende Person nicht sehen.", "The person running it may not see this page."],
  page_not_writable: ["Diese Seite darf die ausführende Person nicht bearbeiten.", "The person running it may not edit this page."],
  unknown_template: ["Die Vorlage gibt es nicht (mehr).", "The template does not exist (any more)."],
  unknown_person: ["Die Person ist kein Mitglied.", "The person is not a member."],
  encrypted: ["Ende-zu-Ende-verschlüsselte Bereiche sind für Workflows gesperrt.", "End-to-end encrypted spaces are closed to workflows."],
  inline_target: ["Im Sofortteil nur auf dem auslösenden Eintrag.", "In the immediate part only on the triggering record."],
  no_record_trigger: ["Ohne Eintragsauslöser braucht es einen Eintrag.", "Without a record trigger a record is needed."],
  loop_exit: ["Eine Verbindung verlässt den Körper von „Für jedes“ – dahinter geht es über „fertig“ weiter.", "A connection leaves the body of “For each” – continue after it from “done”."],
  loop_entry: ["Eine Verbindung führt von außen in den Körper von „Für jedes“.", "A connection leads into the body of “For each” from outside."],
  loop_depth: ["„Für jedes“ lässt sich höchstens zweimal verschachteln.", "“For each” nests at most two levels deep."],
  duplicate_case: ["Ein Fall kommt doppelt vor.", "A case occurs twice."],
  http_host: ["Die Adresse muss mit https:// und einem festen Host beginnen (ohne Platzhalter).", "The address must start with https:// and a fixed host (no placeholders)."],
  no_categories: ["Mindestens eine Kategorie angeben.", "Give at least one category."],
  unknown_credential: ["Die Zugangsdaten gibt es nicht (mehr).", "The credential does not exist (any more)."],
  credential_host: ["Diese Zugangsdaten gelten nur für {host}.", "This credential only applies to {host}."],
  http_off: ["HTTP-Anfragen sind auf dieser Instanz abgeschaltet.", "HTTP requests are switched off on this instance."],
  http_host_not_allowed: ["Der Host {host} ist auf dieser Instanz nicht erlaubt.", "The host {host} is not allowed on this instance."],
  ai_unavailable: ["KI steht der ausführenden Person nicht zur Verfügung.", "AI is not available to the person running it."],
  unknown_webhook: ["Der Chat-Webhook gibt es nicht oder er ist nicht für Workflows freigegeben.", "The chat webhook does not exist or is not released for workflows."],
  unknown_address: ["Die E-Mail-Adresse gibt es nicht oder sie geht nicht an diesen Workflow.", "The e-mail address does not exist or does not go to this workflow."],
  external_mail_off: ["E-Mails an Adressen außerhalb der Mitglieder sind auf dieser Instanz abgeschaltet.", "E-mails to addresses outside the members are switched off on this instance."],
  token_webhook: ["„Nur Token“: Wer die Adresse kennt, kann den Workflow starten. Signiert ist sicherer.", "“Token only”: anyone who knows the address can start the workflow. Signed is safer."],
  ai_to_recipients: ["Eine KI-Ausgabe bestimmt hier die Empfänger – prüfen, ob das gewollt ist.", "An AI output decides the recipients here – check that this is intended."],
  ai_to_url: ["Eine KI-Ausgabe bestimmt hier den URL-Pfad – prüfen, ob das gewollt ist.", "An AI output decides the URL path here – check that this is intended."],
  ai_to_target: ["Eine KI-Ausgabe bestimmt hier das Ziel – prüfen, ob das gewollt ist.", "An AI output decides the target here – check that this is intended."],
  unknown_journal: ["Das Journal gibt es nicht oder es hat eine PIN.", "The journal does not exist or has a PIN."],
};
export function issueMessage(issue: GraphIssue, locale: Locale) {
  const tr = translate(locale);
  const pair = ISSUE_TEXT[issue.code];
  const text = pair ? tr(pair[0], pair[1]) : issue.code;
  return text.replace(/\{(\w+)\}/g, (_, k) => String(issue.params?.[k] ?? ""));
}

// A node id like n_k3f9a2 (§5.1).
export function newNodeId(random: () => number = Math.random) {
  let s = "n_";
  for (let i = 0; i < 8; i++) s += "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(random() * 36)];
  return s;
}

// A stable hash of a graph's behaviour (positions and notes left out), for
// the version list and "changed since the active version".
export function graphFingerprint(graph: WorkflowGraph) {
  const strip = {
    settings: graph.settings,
    nodes: [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id)).map(({ position: _p, note: _n, ...n }) => n),
    edges: [...graph.edges].sort((a, b) => a.id.localeCompare(b.id)),
  };
  return stableJson(strip);
}
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(value ?? null);
}
